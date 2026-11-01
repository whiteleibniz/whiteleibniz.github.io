---
title: "netTV Hardware Decoding (35): A Thread That Blocks SIGSEGV Never Reaches Your Handler — v34 Mask Hygiene and a Vendor-Thread Hook"
date: 2026-11-02 02:30:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Crash Forensics
  - Linux Signals
categories:
  - [Project Notes, netTV Hardware Decoding]
  - [Embedded, Spreadtrum Platform]
copyright: Original work licensed under CC BY-NC-SA 4.0. Source: whiteleibniz.github.io
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/11/02/nettv-35-signal-mask-blocks-sigsegv-handler/) · [繁體中文](https://whiteleibniz.github.io/2026/11/02/nettv-35-signal-mask-blocks-sigsegv-handler-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/02/nettv-35-signal-mask-blocks-sigsegv-handler-en/)

> Post 35 in the series. Last round I turned "why did our SIGSEGV handler never run" into a *falsifiable hypothesis* at kernel level. This round I turn it into *code*: a binary probe that tells us whether the handler was entered at all, a mask cleanup for every execution flow we create ourselves, and a `pthread_create` hook so threads created by the vendor library get cleaned up too. Along the way I nearly walked into a classic trap: **`setjmp` must not be wrapped in a function**.

## 1. The symptom, restated

The player dies roughly every 150 seconds with `st=0xb` (SIGSEGV), and:

* `/tmp/nettv_segv.log` is never created;
* stdout (redirected into `child.log`) contains no dump line from the handler;
* adding `sigaltstack` + `SA_ONSTACK` changed nothing, which rules out "stack overflow, no stack to run on".

The only self-consistent kernel-level explanation: a hardware synchronous fault is delivered as a **thread-directed** signal. If the faulting thread has that signal **blocked**, `force_sig_info()` forcibly resets the action to `SIG_DFL`, clears the mask bit, and kills the process immediately — **the user-space handler is never invoked**. The process dies of SIGSEGV and leaves zero bytes behind.

So the question changes from "which memory got stomped" to "which execution flow blocks SIGSEGV".

## 2. How blocking spreads

The one thing worth remembering from this round: **a signal mask is inherited by every execution flow you create**.

* `fork()` — the child inherits the parent's mask;
* `clone()` (and `CLONE_THREAD` threads) — the new thread inherits the creator's mask;
* `pthread_create()` — POSIX states the new thread inherits the creating thread's signal mask.

Anything created while SEGV is blocked carries that block until it dies. And we do have such code:

```c
static void rp_block_sig(void) {          /* blocks SEGV/BUS/ILL/ALRM/TERM/INT/PIPE */
    syscall(175 /* rt_sigprocmask */, 0 /* SIG_BLOCK */, set, 0, 8);
}
static void render_child(void) {
    rp_block_sig();
    signal(SIGSEGV, SIG_DFL);             /* resets the ACTION, never the MASK */
    ...
}
```

`signal(..., SIG_DFL)` changes the disposition; the mask stays blocked. Any fault inside that forked pool child is textbook silent death, and the parent only sees `[rpool] child lost -> fall back to serial forever`. Threads created by the vendor library behave the same way, except we don't even know what they block — hence either sampling `SigBlk` from `/proc/<pid>/task/<tid>/status`, or…

## 3. Four changes in v34 (all behaviour-neutral)

### ① A binary probe at handler entry

The first thing the handler does is emit one line, using only `write` / `open` / `close` — no heap, no TLS:

```c
static void segv(int sig, siginfo_t *si, void *uc) {
    {   static const char m0[] = "\n*** SIGSEGV-HANDLER-ENTERED ***\n";
        write(1, m0, (int)sizeof m0 - 1);
        int sf0 = open("/tmp/nettv_segv.log", O_WRONLY|O_CREAT|O_APPEND, 0644);
        if (sf0 >= 0) { write(sf0, m0, (int)sizeof m0 - 1); close(sf0); } }
    ...
```

That single line turns "did the handler run?" from reasoning into **reading one log line**. I also added `tid=` to the dump so the faulting thread is obvious.

### ② Unblocking: `nt_unblock_fatal()`

```c
static void nt_unblock_fatal(void) {
    int sg[] = { SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP, 0 };
    syscall(175 /* rt_sigprocmask */, 1 /* SIG_UNBLOCK */, set, 0, 8);
}
```

Called at the entry of every raw-`clone` thread (`thread_start`), in `render_child()`, and in `pan_thread()`. The latter two used blocking as a way to avoid cross-thread `siglongjmp`; with the guard in ④ that is no longer necessary.

### ③ A `pthread_create` hook for vendor threads

Under dynamic linking the executable's symbols come first, so a dependent library's PLT entry for `pthread_create` binds to our exported copy (the build already passes `-Wl,--export-dynamic`).

**Trap 1: don't use `RTLD_NEXT` to fetch the real implementation.** Line 289 of this very source already records "bionic has no RTLD_NEXT", and `RTLD_DEFAULT` would hand us *our own* symbol — infinite recursion. Use an **explicit handle** instead: `dlopen("libc.so")` searches only that object and its dependencies, so it can never see our override:

```c
int pthread_create(void *tid, const void *attr, nt_pcfn_t fn, void *arg) {
    if (!g_pc_inited) {
        g_pc_inited = 1;
        void *lc = dlopen("/system/lib/libc.so", 2);
        if (lc) g_real_pc = (...)__dlsym_bionic(lc, "pthread_create");
    }
    if (!g_real_pc) return 11;                               /* never recurse */
    if (!nt_hook_on()) return g_real_pc(tid, attr, fn, arg);  /* default: passthrough */
    ...
    return g_real_pc(tid, attr, nt_pc_tramp, w);              /* trampoline unblocks */
}
```

Default is `NETTV_PCHOOK=0` (pure passthrough, byte-identical behaviour to v33); set it to 1 for the experiment. Anything unverified on-device must not be on by default.

### ④ A cross-thread `siglongjmp` guard

The handler ends with `siglongjmp(g_jb, 1)`, and `g_jb` holds the stack context of **the thread that set it**. A fault on a vendor thread that longjmps into the worker's context means two threads sharing one stack — guaranteed corruption. Line 4425 of this file already states that rule, but only `pan_thread` and `render_child` were protected; vendor threads ran naked.

Fix: record which thread set `g_jb`, compare tids in the handler, and if they differ **do not jump** — log the scene and `_exit(88)` (trivially distinguishable from signal 11).

**Trap 2 (I almost shipped this): do not wrap `setjmp` in a function.** My first version was

```c
static int nt_setjmp(void) { int r = sigsetjmp(g_jb, 1); if (r == 0) g_jb_tid = nt_tid(); return r; }
```

That cannot work: the `setjmp` family saves the **frame of the call site**. Wrapped in a function, that frame is dead the moment the function returns, and a later `siglongjmp` into it is explicitly undefined behaviour (the slot holding the saved LR has long been reused). It has to be a macro, so everything stays inside the caller's frame:

```c
#define SETJB() (g_jb_tid = nt_tid(), sigsetjmp(g_jb, 1))
```

All 11 occurrences of `sigsetjmp(g_jb,1)` were mechanically replaced with `SETJB()`.

## 4. Offline static audit (H1 falsified inside our own code)

The device was offline again this round, so I killed off everything that can be ruled out statically for the "resource leak hits a limit" hypothesis:

| Suspect | Verdict |
| --- | --- |
| A ~4096-entry table indexed by frame number (4200 frames ≈ 150 s — suspiciously neat) | Does not exist; every `4096` in the file is page alignment, `g_chunk`, or an shm size |
| Per-frame `mmap` without `munmap` (VMA leak) | The only per-frame mmap sits inside `if (g_dump)` and is paired with `munmap`; player mode runs with `g_dump=0` |
| Per-frame `open` leaking fds | Same, dump branch only |
| ION record array | `ionrec_add()` checks `g_ionrec_n >= IONRECN`, bounded |
| m3u8 segment array | `g_segs[HLS_SEG_MAX]` guarded by `g_segs_n < HLS_SEG_MAX`, bounded |
| Handler faulting a second time before printing (e.g. `g_last` dangling) | `static char g_last[64]` — always a valid address, ruled out |

Conclusion: **nothing in our own code grows monotonically with time**, so H1 is reduced to "the vendor library leaks", which is exactly what `_hw34.sh` measures with RSS / threads / fd / ION curves.

## 5. Decision table (one online round should settle it)

Run `sh /tmp/_r34.sh 900` (v34 + `NETTV_PCHOOK=1`, same source as production) together with `sh /tmp/_hw34.sh 900 3`:

| Observation | Verdict | Next step |
| --- | --- | --- |
| `HANDLER-ENTERED` appears in `segv.log` | The handler ran | Read `pc/lr/sp/addr/tid`; the crash point is pinned in one shot |
| No `HANDLER-ENTERED`, but `[rpool]` shows `signal=11` | Our forked pool child is dying | Fix the pool; vendor threads are innocent |
| Neither, still dying every ~150 s | The block is outside our coverage | Check per-thread `SigBlk` from `_hw34.sh` |
| Curves climb monotonically | H1 (vendor library leak) | Chase the leak, or respawn every N segments as a stopgap |

## 6. Still to verify

* Whether v34 even compiles on the device (exporting our own `pthread_create` plus `dlopen("libc.so")` is the single build/runtime risk);
* Whether the vendor library still creates threads correctly with `NETTV_PCHOOK=1` (if the hook fails the player won't start, which is why it defaults to off);
* All three language versions published together.

---

> **Copyright**: Original article by whiteleibniz (written with AI assistance). All rights reserved. Reuse requires attribution and a link to https://whiteleibniz.github.io
