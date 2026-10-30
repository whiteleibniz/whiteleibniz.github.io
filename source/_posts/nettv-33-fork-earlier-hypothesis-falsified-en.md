---
title: "netTV Hardware Decode (33): Forking Before the VSP — A Falsified Hypothesis, and the One Clue That Paid for the Night"
date: 2026-10-31 02:40:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP decode
  - Multiprocess
  - Crash forensics
categories:
  - [Project Notes, netTV Hardware Decode]
  - [Embedded, Spreadtrum Platform]
copyright: Original article under CC BY-NC-SA 4.0. Republish with attribution: whiteleibniz.github.io
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/10/31/nettv-33-fork-earlier-hypothesis-falsified/) · [繁體中文](https://whiteleibniz.github.io/2026/10/31/nettv-33-fork-earlier-hypothesis-falsified-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/31/nettv-33-fork-earlier-hypothesis-falsified-en/)

> Post 33 in the series. The last post was the parallel render pool's report card (20 fps → 28 fps), but that 10-minute regression hid one unresolved blemish: **the worker was killed by SIGSEGV roughly every 150 seconds — three times in ten minutes**. This post is the full record of "I thought I knew why, and I didn't" — plus one clue that turned out to be worth more than the fix.

## 1. The blemish behind the report card

The regression numbers looked great: 28.2 fps, pool render 13–14 ms, zero ION leaks, zero leftover processes. But three lines were sitting in stdout:

```
*** monitor: 子进程自退 st=0xb ***
*** monitor: 重启 (子进程 @4215 帧)
```

Every generation of the worker ran four to five thousand frames before dying, so this was not a startup problem. And the way it died was strange: **SIGSEGV, with the handler leaving behind nothing at all** — no `/tmp/nettv_segv.log`, no crash dump on stdout.

## 2. Hypothesis: when you fork matters more than that you fork

Our render pool is a set of *resident* child processes: fork N of them at startup, then send jobs over pipes. The original fork point was **the first frame** — by which time the OMX component is initialised and the VSP is open and actively decoding.

So the natural hypothesis: **forking while the VSP is working makes the child inherit a copy of the VSP's user-space state** (buffer queues, register shadows, vendor-heap context). Both processes then believe they own the hardware, the states drift apart, and eventually the parent walks off a stale pointer.

There was supporting evidence too. This project already has a hard rule: any child born from `fork` must reset SEGV/BUS/ILL to `SIG_DFL`, because the parent's handler ends in `siglongjmp(g_jb)` — and `g_jb` lives on the **parent's stack**. If the child ever faults, it long-jumps into the parent's stack and effectively becomes a "second decoder" fighting for the same VSP. We had already been burned once by "the child inherits the parent's execution context"; "the child inherits VSP state" looked like round two.

## 3. Plan A: move the pool to before the VSP

The change itself is small. The hard part is **three prerequisites**:

| Prerequisite | Why it must come first |
|---|---|
| `render_cfg_init()` | Render config (band height / NEON / LUT) is handed to children by fork inheritance; children never call `getenv` |
| `stage_ensure()` | The staging buffer must be `mmap MAP_SHARED` and must exist **before** the fork, or children render a frozen copy (wrong picture, no error) |
| `fb_init()` | Children write to the address produced by the fb mapping; the mapping must already exist |

The first one is easy — an existing function, just called explicitly early instead of lazily at the first frame. The second needs restructuring: staging used to be a `static` local inside the decode loop, created on the first frame. As long as it lived there, the pool *had* to fork late. So it became a file-scope `g_stage` plus `stage_ensure()` — same behaviour (still created exactly once), just earlier.

The third is an old trap on this board. Fork the pool early and everything `exec`'d afterwards — mplayer, the async audio pump — inherits the pipe write ends. If a pool child then dies, the parent's `read()` never sees EOF because somebody else still holds the write end: the frame hangs forever instead of falling back to serial rendering. So all four pipes get `FD_CLOEXEC` (which only takes effect across `exec`, leaving the forked pool children unaffected).

## 4. First, overturn the "last words"

Digging through child.log, the final line before every crash was the same:

```
Parent process disappeared, exiting cache process.
```

The reflex read is "mplayer crashed and took us with it." Walk the process tree and the causality is backwards:

```
worker dies (SIGSEGV)
  -> dl killed by PDEATHSIG
    -> mplayer killed (its PDEATHSIG is set the same way)
      -> mplayer's cache child notices its parent is gone, prints that line, exits
```

That line is a **consequence, not a cause**, and it only appears in our log because stdout is inherited. Had we chased mplayer, the whole night would have been wasted.

General lesson: **when debugging a crash, first ask "is this log line the cause of death or a post-mortem artefact?"** The tell for an artefact: it is printed by *someone else's child process*, downstream of you on the same death chain.

## 5. Result: falsified

Same board, same source, same three env vars (`NETTV_RPOOL=2` + `NETTV_AUDIO_ASYNC=1` + `NETTV_HLSBUF=1`), five minutes:

| Metric | v32 (baseline, 10 min) | v33 (Plan A, 5 min) |
|---|---|---|
| monitor restarts | 3 | **1** |
| fps_x10 | 265–282 | 282 |
| pool render wall clock | 14 ms | 13–14 ms |
| first-frame self-check | pass | pass |
| ION clients / leftovers | 0 / 0 | 0 / 0 |
| audio skip ratio | 0.29 | 0 |

Normalised: **the baseline is 1.5 restarts per 5 minutes, v33 is 1**. On a crash statistic with single-digit samples, that is "no change." Plan A is falsified — fork timing is not the cause.

(One more thing: the board also reset once during this session, at the two-minute mark of the earlier v33 run; the later five-minute run did not reproduce it. Too few samples to attribute it to v33, so it is recorded as a suspicion, not a conclusion.)

**v33 is not deployed.** If it does not fix the problem, it has no business touching production — that principle outranks "newer is better."

## 6. The clue that paid for the night: the handler never ran

Plan A also carried a pure-forensics change: reserve a 64 KB alternate stack with `sigaltstack` and register the handler with `SA_ONSTACK`. The reasoning: three SIGSEGVs with zero handler output most likely mean **stack overflow** — the handler has no stack to run on, so the kernel applies the default action and the scene is lost.

That path is now closed too: **with altstack in place, still zero output**, and the string `SIGSEGV` appears **zero times** in child.log.

If the handler never ran, only a few possibilities remain:

1. Stack overflow (largely excluded by altstack);
2. The handler itself crashed (but its first statements are pure computation followed by a `write` — no opportunity);
3. **The signal is blocked** — the faulting thread had SIGSEGV blocked, the kernel found no thread able to take it, and applied the default action to the whole process.

Option 3 is not speculation; this project has precedent. The old hand-rolled `clone` render thread called `rp_block_sig()` to block SIGSEGV, and when it crashed the signature was exactly this: zero handler output, no `/tmp/nettv_segv.log`. That episode produced the rule "render work is `fork`, never bare `clone`."

The difference now: both of *our* signal-blocking threads (the vsync page-flip thread and the stage-2 render child) are off by default. So suspicion falls on **threads the vendor library creates itself** — `libstagefright`'s ALooper and decoder threads — which we can neither inspect nor protect.

## 7. Next: put the black box in shared memory

If the handler cannot help, stop expecting anything at the moment of death and start recording continuously:

- Every frame, the worker writes "current step id / frame number / segment number" into the existing `g_cnt_shm` page (`mmap MAP_SHARED`; the monitor holds a mapping too);
- When the child dies, the monitor simply prints the last set of values.

The key property is **zero I/O cost** — writing shared memory is a few instructions, unlike `ph()`, which does an O_SYNC write of ~15 ms each time. The trade-off is coarse granularity (step level), but that is enough to tell "died inside the vendor DRIVE" from "died in frame read or render."

In parallel, a two-arm bisect: `NETTV_RPOOL=0 + AF=1` and `RPOOL=2 + AF=0`, five minutes each, to rule out the two components added most recently — the render pool and the async audio pump.

## 8. Three methods from this night

1. **Record falsification too.** A hypothesis that was disproved but not written down gets re-derived from scratch next session. The "fork timing" hypothesis had a complete reasoning chain and a supporting precedent, and it was still wrong. Write it down so the next run can skip it.
2. **Separate cause of death from post-mortem artefacts.** `Parent process disappeared` looked like mplayer's fault; it was the far downstream end of the death chain.
3. **Do the cheap forensics upgrade first.** `sigaltstack` is ten lines and killed the stack-overflow hypothesis outright — cheaper than any amount of reasoning.

## Appendix: this round's changes (v33, not deployed)

- `outputs/sprd_msg_np_v33.c` (450172 B, md5 `93fc5967`; binary 156576 B, md5 `18ed767b`)
- Pool fork moved to right after `fb_init()`, before the OMX component init
- `g_stage` promoted to file scope, with `stage_ensure()` creating staging early
- `FD_CLOEXEC` on all four pool pipes
- `sigaltstack(64 KB)` + `SA_ONSTACK` (forensics only)
- Scripts: `outputs/_b33.sh` (build), `outputs/_r33.sh` (regression, criteria in the header)

Production stays on v32 (md5 `0b6a4840`).
