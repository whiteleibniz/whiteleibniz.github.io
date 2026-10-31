---
title: "netTV Hardware Decode (34): The SIGSEGV Handler Never Ran — Turning Guesses Into Falsifiable Measurements"
date: 2026-11-01 02:30:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP decode
  - Crash forensics
  - Linux signals
categories:
  - [Project Notes, netTV Hardware Decode]
  - [Embedded, Spreadtrum Platform]
copyright: Original article under CC BY-NC-SA 4.0. Republish with attribution: whiteleibniz.github.io
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/11/01/nettv-34-sigsegv-handler-never-ran-forensics/) · [繁體中文](https://whiteleibniz.github.io/2026/11/01/nettv-34-sigsegv-handler-never-ran-forensics-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/01/nettv-34-sigsegv-handler-never-ran-forensics-en/)

> Post 34 in the series. After the previous round falsified the "fork earlier than the VSP" hypothesis, one clue was left: **the worker gets killed by SIGSEGV every 4000–5000 frames, and our SIGSEGV handler never once executed**. This post fixes no bugs. It explains at the kernel level why the handler cannot run, then turns the remaining possibilities into measurements that each carry their own falsification condition — plus a zero-code-change forensics toolkit.

## 1. The clue left over from last round

Three times in a ten-minute regression:

```
*** monitor: 子进程自退 st=0xb ***
*** monitor: 重启 (子进程 @4215 帧)
```

`st=0xb` means killed by SIGSEGV. Three things are odd:

1. It is not a startup failure — the worker runs a solid four to five thousand frames (~150 s) before dying;
2. `/tmp/nettv_segv.log` does not exist at all — the handler was never entered;
3. Adding `sigaltstack` + `SA_ONSTACK` still produced zero output, which rules out **stack overflow**.

## 2. Kernel level: why the handler cannot possibly run

Once "the handler itself crashed" is ruled out, one systemic explanation remains: **the faulting thread has SIGSEGV blocked**.

The key is the kernel's `force_sig_info()`. A hardware synchronous fault (page fault, out-of-bounds) raises a **thread-directed** signal. If that thread has the signal blocked, the kernel does not let the process hang; instead it:

- **forces the signal's action back to `SIG_DFL`**;
- **clears that bit** in the thread's mask;
- then kills the whole process by the default action, immediately.

Which produces exactly the observed behaviour: **the process dies of SIGSEGV, but the userspace handler is never invoked.** That single semantic explains the symptom completely, and it shifts the investigation from "where did we stomp memory" to "which thread is blocking SIGSEGV".

A cheap way to read it: each thread's signal mask sits in `SigBlk:` in `/proc/<pid>/task/<tid>/status`, a 16-hex-digit mask where signal n maps to bit (n-1). SIGSEGV = 11 → bit 10 → `0x400`. Splitting the last four hex digits:

| Last-four position | Signals covered | Where SIGSEGV lands |
|---|---|---|
| d1 (4th from right) | 13–16 | — |
| **d2 (3rd from right)** | **9–12** | **this one** |
| d3 (2nd from right) | 5–8 | — |
| d4 (1st from right) | 1–4 | — |

So the entire test fits in one sentence: **if the 3rd character from the right falls in `{4,5,6,7,c,d,e,f}`, that thread blocks SIGSEGV.**

## 3. Three mutually exclusive hypotheses, each with a falsification criterion

| Hypothesis | Content | Evidence that confirms it | What falsifies it |
|---|---|---|---|
| H1 | Resource leak hitting a ceiling (per frame / segment / GOP) | Thread count / RSS / VSZ / fd / ION clients climb monotonically, death lands near the peak | Flat curves, random death point |
| H2 | Some thread blocks SIGSEGV (typical of vendor-library threads) | A thread whose `SigBlk` matches the rule above | Every thread's `SigBlk` is zero |
| H3 | Genuinely random memory stomping | Both H1 and H2 falsified | — |

Writing all three in falsifiable form is the point: **one experiment advances the case no matter which way it goes.** Far cheaper than "guess another cause, ship another build".

## 4. Why this round insists on zero code changes

- **Changing the code changes the thing under observation.** Last round's v33 moved the fork point to test a hypothesis; it fixed nothing and introduced a hard-to-reproduce kernel reset.
- **Logging is not cheap here.** The player is bare bionic (`nostdlib` + `--entry=main`), so logging means hand-written `write`; unchecked logging once filled the disk to 1 GB.
- **Online time is the scarcest resource.** The device is frequently offline (several rounds in a row it simply had no power), so when it *is* reachable, the first moves should be zero-compile, zero-deploy, definite-result actions.

So this round ships two scripts and touches zero lines of C:

### `_hw34.sh`: a pure `/proc` sampler

One sample every 3 seconds into three logs:

- `nettv_health.log`: one line per nettv process — thread count, RSS, VSZ, fd count;
- `nettv_thr.log`: every 18 s, a **per-thread** dump of the worker — tid, thread name, `SigBlk`, `SigCgt`;
- `nettv_sys.log`: system view — `MemFree`, `CmaFree`, ION client count.

All three rotate at a 400 KB cap so history does not repeat itself.

### `_crash34.sh`: one-command orchestration and automatic summary

Start sampler → clear leftovers → start the player → wait → summarize. The summary prints:

- the worker's **first / last / peak** sample (one glance tells you whether the curve climbs);
- the thread-count timeline;
- thread-name distribution (a new name appearing is the fingerprint of a thread leak);
- **threads whose mask matches the SIGSEGV rule (deduplicated)**;
- the full thread snapshot closest to the crash.

It runs unattended on the device: the script returns within 2 seconds and the PC side just short-polls `/tmp/cr34.log` — a habit forced by the connection constraints (the local sandbox SIGTERMs long-running SSH calls, leaking sessions until dropbear runs out).

## 5. Verdict table: what to do with the numbers

| Measured result | Verdict | Next move |
|---|---|---|
| A vendor thread's `SigBlk` matches | H2 confirmed: the crash is silenced | Explicitly reset signal masks in forked children; interpose `pthread_create` if reachable |
| Threads / fd / ION climb to a threshold and then death | H1 confirmed: leak exhaustion | Chase the allocator for whichever counter climbed; keep "respawn every N segments" as a stopgap |
| Everything flat, nobody blocks SIGSEGV | H3 | Only now bring out the shm black box (per-frame phase id / frame no / segment no, dumped by the monitor after death) |
| ION clients climbing throughout | Same family as H1, but sharper | Audit dmabuf fd inheritance on the reclaim path (the render pool hit this before) |

## 6. Three methodology notes

1. **"The handler never ran" is itself the strongest clue.** It compresses the cause space from "every possible memory stomp" to "the execution flow that has the signal blocked".
2. **Do falsifiable measurements before writing code.** With falsification conditions written up front, one run always teaches something.
3. **Prefer zero-code-change forensics.** Leaving the binary untouched means the result is comparable against the live baseline — and the tooling can be written even while the device is offline.

## Appendix: artefacts from this round

- `outputs/_hw34.sh` — resource trend + per-thread signal mask sampler (pure `/proc`, no build needed)
- `outputs/_crash34.sh` — forensics orchestration and automatic summary (defaults to the live v32 wrapper, so it is baseline-comparable)
- No binary and no source changes; nothing committed on the device-side git

Next round (device online): run `sh /tmp/_crash34.sh 900` for 15 minutes and match the result against the table above.
