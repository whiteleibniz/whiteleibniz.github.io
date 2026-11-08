---
title: "netTV HW Decode (40): Packaging the Second-IDR Forensic Trio — Test the Verdict Code Before the Verdict"
date: 2026-11-09 02:40:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Hardware Decode
  - Debugging
categories:
  - [Project Notes, netTV HW Decode]
  - [Embedded, Spreadtrum Platform]
  - [Engineering Practice, Debugging Methods]
copyright: "Original work by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduction must credit whiteleibniz.github.io"
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/11/09/nettv-40-forensic-toolkit-second-idr/) · [繁體中文](https://whiteleibniz.github.io/2026/11/09/zh-tw/nettv-40-forensic-toolkit-second-idr-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/09/nettv-40-forensic-toolkit-second-idr-en/)

> Part 40 of the series. The device stayed offline for the 12th round in a row, so online
> experiments remain queued. Last round (39) cleared our own code of the second-IDR
> SIGSEGV via static audit. This round was pure tooling: the "online forensic trio"
> defined on 11-08 is now **two ready-to-run, zero-code-change tools** — the moment the
> device powers up, we can run them.

## 1. What the trio is and why

The top open issue is the deterministic second-IDR SIGSEGV (fault address 0x747474).
Part 39 ruled out any out-of-bounds write in our code, leaving two suspects: the vendor
library internals and trusting the input-buffer header. Splitting further requires either
online evidence or more guessing. Guessing is worthless, so the forensic plan became tools:

1. **Crash PC → symbol mapping**: the SIGSEGV handler's `pc-off` + `lib=` output is only
   a library-relative offset; attribution needs the enclosing function;
2. **`NETTV_IDRREPLAY=K` replay bisection**: a diagnostic switch already built into v32
   (added 2026-10-19, never yet exercised). After capturing the first IDR it re-feeds the
   same IDR K times with zero accumulation — a crash during replay means a "component
   state" problem (A), a crash only after replay completes means "accumulated drift" (B).
   The fixes are entirely different;
3. **`[inbuf]` / `[split]` input-side logs**: to test the hypothesis that the input buffer
   header gets rewritten after a port reconfiguration.

Key prerequisite verified: **all three probes are already compiled into the deployed v32
binary**, so the whole forensic run needs no new code — consistent with the project rule
"offline rounds may only produce zero-code-change measurement tools".

## 2. Tool 1: `_pcmap.py` (PC-side symbol mapper)

It parses the raw segv log:

```
*** SIGSEGV sig=b addr=00747474 step: feed-idr
  >>> pc-off=0x3d7c lib=/system/lib/libstagefright_sprd_h264dec.so
```

For each `(lib, pc-off)` pair it binary-searches the local ELF's dynamic symbol table
(reusing the minimal parser from part 38) for the nearest symbol with value ≤ off:

```
pc-off=0x3d7c lib=libstagefright_sprd_h264dec.so
  → _ZN7android14SPRDAVCDecoder20onPortFlushCompletedEj+0x0 [inside symbol]
```

A missing library is reported loudly ("must be pulled from the device") instead of being
silently skipped — **missing evidence must be announced**, a principle this round kept
repeating. Self-test against a real library: `SPRDAVCDecoder::onPortFlushCompleted` at
0x3d7c is hit exactly; an invented library name correctly reports as missing.

## 3. Tool 2: `_ntseg2.sh` (device-side two-arm orchestrator)

One script runs both arms (default 600s each ≈ 4×150s fault periods, honoring the Poisson
observation rule):

- **Arm A0 baseline** (`IDRREPLAY=0`): the historically crash-reproducing configuration,
  **must crash** — otherwise the whole round is `NOT_REPRODUCED` and no conclusion is
  allowed. This directly ports the 11-03 methodology: "when the control arm fails to
  reproduce, the experiment arms' 'clean' results carry no verdict";
- **Arm R replay** (`IDRREPLAY=3`, tunable via `NTSEG2_K`): re-feeds the first IDR 3 times.

Bonus forensics (not used in the verdict): per-thread SigBlk mask patrol every 20s
(H2-criterion hit count), a worker `maps` snapshot every 90s (the process is gone after a
crash; lib base addresses survive only in the snapshot), and per-arm archival of segv.log.

The verdict is a pure function; all 8 simulated branches pass self-test: state A, state B,
R survives, baseline fails to reproduce, zero-frame invalidation, env-not-applied
invalidation, long-delayed crash after replay completes, and gates-before-results. After
both arms finish, the PC side only polls one file: `/tmp/ntseg2.log`. Teardown is always
SIGTERM + usleep 900ms — never touch a decoding process.

## 4. The most valuable lesson this round: verdict code lies too

My first sampler version used a shell `case "$sb" in ????)` length guard for SigBlk
values — matching only 4- or 8-character strings. But the real `/proc/.../status` SigBlk
is a **32-hex-digit string** (e.g. `00000000000000000000000000000400`). The guard would
route every real value into `*) continue`, making the mask patrol **silently sample a
constant zero** — and "maskedhit=0" in the log would then be read as "no thread masks
SIGSEGV": a textbook false negative.

This is the same class of bug as the 11-07 case where the curl probe only accepted HTTP
200 and killed every 206-responding healthy source: **a parsing bug in the measurement
tool masquerades as normal behavior of the system under test**. The fix is the same too —
the tool's value-extraction logic must be tested against real data shapes (SigBlk tested
with the 32-digit form), not with whatever short string you assumed. The code now carries
the comment: `# real SigBlk is a 32-hex string; a case length guard silently skips them`.

## 5. How to run next time the device is online (~22 minutes)

```
# after uploading outputs/_ntseg2.sh, on the device:
sh /tmp/_ntseg2.sh 600
# poll /tmp/ntseg2.log: check both arms' GATE V=1 first, then VERDICT
# once a crash site is captured, on the PC:
python outputs/_pcmap.py <segv log>
```

On INVALID: rerun the whole round, no code changes. On NOT_REPRODUCED: extend arm A0 to
1200s. The verdict decides the direction — GOP-boundary soft reset (A) or leak hunt (B).

---

*Original work by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduction must credit whiteleibniz.github.io*
