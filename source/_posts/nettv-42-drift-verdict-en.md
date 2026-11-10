---
title: "netTV HW Decode (42): 2400-Second Verdict Pending — First-IDR Replay Is Innocent, the Periodic SIGSEGV Is Accumulated Drift"
date: 2026-11-10 16:00:00
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
copyright: "Original works by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduce with attribution to whiteleibniz.github.io"
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/11/10/nettv-42-drift-verdict/) · [繁體中文](https://whiteleibniz.github.io/2026/11/10/zh-tw/nettv-42-drift-verdict-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/10/nettv-42-drift-verdict-en/)

> Part 42 of the series. The device is finally back online. This round did exactly one
> thing: ran the prepared forensics script `_ntseg2.sh` on real hardware to reach a
> data-backed verdict on the periodic SIGSEGV (roughly one crash every 3 minutes).

## Verdict first

**State B: accumulated drift.** First-IDR replay (IDRREPLAY) is innocent — the baseline
arm with zero replays and the experimental arm with 3 replays crashed at exactly the
same cadence. The crash point is not on the replay path; it lives in the subsequent
real-IDR / advance path. The investigation now moves to **leak / pool exhaustion**.

## Experiment design

Two arms, 1200 seconds each, same 1080p live source:

- **A0 arm**: baseline configuration (IDRREPLAY=0), the historically stable repro config;
- **R arm**: baseline plus replaying the first IDR 3 times (creating "replay window"
  pressure).

The verdict reads three things: per-arm GATEs (residue zeroed, exactly one env line,
frame evidence ≥5fps, crash counts from `mon-child-signal=11` in phase.log), and the
crash-count comparison between the two arms.

## Data

| Arm | Replays | Crashes | Interval | Peak fps | GATE |
|-----|---------|---------|----------|----------|------|
| A0  | 0       | 6       | ~157s    | 283      | V=1  |
| R   | 3       | 7       | ~152-186s| 279      | V=1  |

Both arms crashed on the same rhythm (151-186 seconds, strictly periodic) with healthy
fps. If replay were the trigger, R should crash more or sooner; instead 6≈7. **The
replay variable is cleanly eliminated.** That is the whole point of an A/B pair: one
variable, one verdict, no guessing.

## Two details worth recording

**The first 600-second run reported NOT_REPRODUCED** — the baseline arm never crashed.
With one fault cycle every 3 minutes, 600 seconds covers only 2 cycles; Poisson variance
makes zero hits entirely plausible. Extending to 1200 seconds (4 cycles) reproduced
immediately. The old rule holds again: **the observation window must span ≥4-5 fault
cycles**, otherwise "it didn't crash" is not evidence.

**The measurement tool had its own bug**: the ARM header printed the literal
`IDRREPLAY=NETTV_IDRREPLAY`. The cause: `env_key_ok` wrote its parameters directly into
the global variable `k` (no `local`), clobbering the caller's counter. Fortunately
`mkarm` had already built the arm with the correct value before the clobber, so the
**experiment configuration was unaffected** — but had the order been reversed, this
would have been a "tool bug masquerading as a result" incident. Fixed (all parameters
now `local`) and verified with mutation self-tests.

## Side observation

Both arms produced zero segv.log entries: the SIGSEGV handler never ran once. This is
consistent with the earlier root-cause chain (signal-mask inheritance → force_sig_info
forcing SIG_DFL) — the fault lands on a masked execution flow, so the handler never gets
a chance. `maskedhit` sampling peaked at 0, meaning the sampling interval never
coincided with a masked window; that thread is still open.

## Next steps

State B offers two discriminators: **the exponential signature of a leak** (crash
intervals shrinking over time) vs **a constant beat** (a fixed slot / timer stomp). Next
round: fix the CmaFree/ION fields in the sampler, extend the baseline arm to 2400
seconds, and see whether the crashes accelerate or stay metronomic.

---
*Copyright: original work by whiteleibniz, licensed under CC BY-NC-SA 4.0. Attribution to whiteleibniz.github.io required when reproducing.*
