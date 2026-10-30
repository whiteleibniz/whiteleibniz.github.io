---
title: "netTV Hardware Decode (31): The Parallel Rewrite That Bricked the Board — A Child Process Inherited the Parent's siglongjmp"
date: 2026-10-30 21:30:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP decode
  - Multiprocess
  - Debug forensics
categories:
  - [Project Notes, netTV Hardware Decode]
  - [Embedded, Spreadtrum Platform]
copyright: Original article under CC BY-NC-SA 4.0. Republish with attribution: whiteleibniz.github.io
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/10/30/nettv-31-fork-inherited-siglongjmp-crash/) · [繁體中文](https://whiteleibniz.github.io/2026/10/30/nettv-31-fork-inherited-siglongjmp-crash-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/30/nettv-31-fork-inherited-siglongjmp-crash/)

> Post 31 in the series. This time it was not offline reasoning: the parallel render pool went onto real hardware for the first time — and it took the board down with it. The culprit was not parallelism itself, but the fact that **a forked child inherited the parent's crash-recovery context**. This post explains that trap, and also two operational mishaps from the same day that look completely unrelated.

## 1. What happened

The previous rounds had all been offline coding: cut the renderer into bands, hand them to a few resident children, render in parallel. Written, statically audited, compiled — and for this kind of change, the first time it had actually been compiled. Then a four-arm A/B on the device: 0 workers (baseline), 2, 4, 8.

Results:

| Arm | Outcome |
|---|---|
| 0 (baseline) | healthy, 21.7 fps, segv=0, ION=0 |
| 2 | **worker died with SIGSEGV every generation, monitor restarted forever, 0 frames** |
| 4 / 8 | never ran (the script killed itself, see §3) |

And it was not just the player: **every user-space service on the board turned into connection refused** (22/23/80/8080 all refusing, ICMP still answering), did not recover for several minutes, and the only remedy was a power cycle.

When a program crashes *and* takes the machine with it, the usual diagnosis is not a logic bug but an **ownership** bug.

## 2. The real culprit: the child inherited the parent's siglongjmp recovery context

The player has always had a custom SIGSEGV handler: on a crash it dumps the faulting context, then calls `siglongjmp(g_jb, 1)` to jump back into the main loop and keep the live stream going — after all, a player that dies on every hiccup is useless.

The problem is *where* `g_jb` lives. It is a global, sure, but it points at a saved context **on the parent's stack**. And `fork()` copies the entire address space — including the contents of that `jmp_buf`.

So:

```c
/* the pool child (as written in v30/v31) */
static void rpool_child(int rfd, int wfd) {
    for (;;) {
        read(rfd, &job, sizeof job);
        fb_render_range(job.nv, job.dst, job.y0, job.y1);   /* fault here → SIGSEGV */
        write(wfd, &ack, 1);
    }
    _exit(0);
}
```

The child inherited the parent's SIGSEGV handler, and with it that `jmp_buf`. The moment the child faults, the handler `longjmp`s **to a saved point on the parent's stack**, and the child **continues executing the parent's code** — decode loop, feeding IDRs, touching the VSP.

A process that was only supposed to draw pixels turned into a second decoder competing for the same hardware. The parent's state got ripped away, the vendor driver's global state got mutated by two processes at once, and from there a parent crash and a dead board follow naturally.

### The fix: reset the signal dispositions to default in the child

```c
static void rpool_child(int rfd, int wfd) {
    /* The parent's handler ends in siglongjmp(g_jb); g_jb is parent stack
       context ⇒ longjmp'ing to it from the child executes the parent's
       stack in the child ⇒ guaranteed boom. So the child dies cleanly. */
    signal(SIGSEGV, SIG_DFL);
    signal(SIGBUS,  SIG_DFL);
    signal(SIGILL,  SIG_DFL);
    signal(SIGFPE,  SIG_DFL);
    signal(SIGABRT, SIG_DFL);
    ...
}
```

With `SIG_DFL`, a faulting child is simply killed by the signal. The parent sees EOF on its `read()`, understands "a child died", redoes that one frame through the serial path, and **falls back to serial for good** — playback continues, just not in parallel.

This also produced a lesson worth more than the fix: **an older implementation in the same project (the other forked render child) had already written this rule down in a comment**, and I failed to carry it into the new pool. *A forked child is not a thread: it is a separate process that inherited the parent's entire address space — signal dispositions and jump contexts included.*

Two smaller fixes came along: when a child dies, close the pipes, `SIGTERM` the survivors and `waitpid` them (otherwise zombies pile up); and the parent must **drain every dispatched ack before redoing the frame serially** — otherwise parent and child write the same rows of memory at the same time.

## 3. The second trap of the day: the test script killed itself

The baseline arm finished, the script was about to start the 2-worker arm, and then the script **exited on its own**. The log stopped at the baseline arm's last line; the remaining three arms never ran.

Old friend: the cleanup used

```sh
ps -ef | grep "[n]ettv_player" | awk '{print $1}' | xargs kill -TERM
```

The `[n]ettv_player` trick exists to stop `grep` from matching itself, but **it fools `grep`, not `ps`** — the script's own command line contains `BIN=/tmp/nettv_player.v31`, so it matched itself and killed itself.

This project has now hit that same trap five times; this was the sixth. The fix is to stop matching command-line text entirely:

```sh
for d in /proc/[0-9]*; do
    p=${d#/proc/}
    e=$(readlink "$d/exe" 2>/dev/null)
    case "$e" in *nettv_player*|*mplayer*) kill -TERM "$p" 2>/dev/null ;; esac
done
```

Match on the **executable path**; then it does not matter what the command line says.

Lesson: **for any script that finds processes by name and kills them, ask first whether the script can match itself.** If the script's contents contain the search string — and they almost always do, since the path and the variable name are right there — then `/proc/<pid>/exe` is the only way.

## 4. The third trap: a performance number that grew on its own

Also fixed a log line that had been lying for a while:

```
[perf] fb_render mean 983ms (ceiling 1 fps) | convert 19ms write-fb 0ms
```

983 milliseconds per frame? Impossible — the real figure is about 22 ms, and "convert 19 ms" on the same line is correct. The bogus one is the mean: the accumulator added each frame's **cumulative** total again, so by frame 100 it was reporting "1+2+…+100 times the single-frame cost". The number grew linearly with runtime, until it poisoned the A/B conclusion.

The fix is one line: zero the accumulator each round and report "this round's total ÷ this round's count". **Any metric shaped as "cumulative ÷ count" becomes a self-mad number if you forget to reset the accumulator** — such fake data is worse than no data.

## 5. The genuinely good news from this round

It crashed, but two results must be recorded:

1. **Baseline arm: 21.7 fps**, identical to the same-source reference from before the change ⇒ the rework did not slow down the serial path.
2. **The parallel first-frame self-check passed**: `serial/parallel identical 39937ac1` — the FNV hash of the whole page rendered serially equals the hash rendered in parallel, **bit for bit**.

The second one matters most. It proves the bug fixed in the previous round's offline audit (split points not aligned to the band height, letting the last child write past its band — tearing and an out-of-bounds write) was a **real bug, really fixed**, and that the geometry of the fork-based pool is correct. The crash happened *after* the self-check, in the decode stage, and has nothing to do with the parallel rendering logic.

Also decided on the spot: a **bisection switch**.

```c
if (!g_rp_idle) fb_render_range(job.nv, job.dst, job.y0, job.y1);   /* NETTV_RPOOL_IDLE=1: ack only */
```

Children accept the job and acknowledge it, but render nothing. Then:

- `RPOOL=2` crashes but `RPOOL=2 + IDLE` does not ⇒ the bug is in the rendering code;
- both crash ⇒ the bug is "forking inside a process that owns hardware handles" itself.

One switch, and an entire class of hypotheses splits in half. A switch like this does not have to be elegant; it only has to default to off and not disturb the normal path.

## 6. Wrap-up

None of the four lessons from this day had anything to do with parallelism, and all four blocked it:

1. **A forked child must decide how it dies**: reset crash-recovery signal dispositions to `SIG_DFL` so the child exits cleanly and the parent handles the fallback.
2. **Never find-and-kill processes by command-line text**; use `/proc/<pid>/exe`.
3. **Reset cumulative counters**, or they will go mad on their own.
4. **The correctness gate for a parallel change is a hash self-check**, not "it did not crash".

There is another round after the power cycle: reproduce with a single arm, then bisect, then the four-arm A/B. No rushing — stacking arms amplifies a crash loop into a dead board, which was today's most expensive lesson.
