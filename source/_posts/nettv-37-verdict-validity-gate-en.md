---
title: "netTV Hardware Decoding (37): The Experiment Finished, but the Verdict May Be Fake — Adding a Validity Gate to Automated A/B Tests"
date: 2026-11-04 02:30:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Crash Forensics
  - Experiment Design
  - Observability
categories:
  - [Project Notes, netTV Hardware Decoding]
  - [Embedded, Spreadtrum Platform]
  - [Engineering Practice, Experiment Design]
copyright: "Original work by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduction must credit the source - whiteleibniz.github.io"
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/11/04/nettv-37-verdict-validity-gate/) · [繁體中文](https://whiteleibniz.github.io/2026/11/04/zh-tw/nettv-37-verdict-validity-gate-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/04/nettv-37-verdict-validity-gate-en/)

> Part 37 of the series. Last round I designed a three-arm environment-variable bisect intended to settle, in 40 minutes, whether the periodic crash comes from the render pool. The device is still unpowered this round, so instead of writing new code I audited that script end to end — and found that **it was quite capable of producing a verdict that looks authoritative and is completely wrong**. This post records the six holes and one rule worth more than the code.

## 1. Background: an experiment that prints its own verdict

The production player is killed by SIGSEGV roughly every 150 seconds; a watchdog respawns it and the cycle repeats. Last round established that "is the crash caused by the pool?" had never actually been measured, so I designed a zero-code-change three-arm experiment that only varies environment variables:

| Arm | Config | What it isolates |
| --- | --- | --- |
| C (control) | pool on | production as-is, expected to reproduce |
| A | pool off | no child processes at all |
| B | pool on + idle children | forking happens, but children only ack and never render |

C crashes / A clean / B clean ⇒ the crash is in the child's render code. A clean / B crashes ⇒ forking itself is toxic. A also crashes ⇒ unrelated to the pool. The script runs unattended on the device and prints a `VERDICT` block at the end; a human only has to read that one line.

That last property is exactly where the trouble starts.

## 2. The six holes

### 2.1 The crash metric reads the wrong file

The script counted `child respawn` separator markers in `child.log` as crashes. But this project has a standing ruling: **crash forensics reads `phase.log`; `child.log` is not used to judge crashes**. `respawn` is a marker printed on *every* worker respawn, including normal exits (end of stream, frame-count self-exit, shutdown signal). It is not a crash.

More ironically, the script terminates each arm with `timeout -s TERM`, and **that shutdown itself creates at least one respawn**. So the script manufactures a baseline, guesses at it, and subtracts it again with a `> 1` threshold.

The correct quantity is `mon-child-signal=11` in `phase.log`, written with `O_SYNC` appends so it survives a crash — and a shutdown TERM is never recorded as signal 11. The hardened version switches to that and demotes `respawn` to a printed auxiliary figure.

### 2.2 A permanently-zero piece of fake evidence

The script also counted `signal=11` occurrences in `nettv_segv.log` and printed them in the verdict. Earlier rounds established that **the SIGSEGV handler never ran at all and that file does not exist**. All three numbers are therefore always zero. They change no branch, yet they quietly suggest "no segv scene = no crash" to anyone reading the report.

A known-constant zero field in a verdict is more dangerous than no field at all. The hardened version states explicitly: file known to be absent, not used as a criterion.

### 2.3 No hard gate for "did this arm actually play?"

This is the worst of the six. The project has an iron rule: **two arms both at zero frames means an environment problem, not an experimental result**. When the ION carveout pool is exhausted, this player can run over a thousand generations producing zero frames; a dead source or degraded uptime does the same.

If all three arms produce zero frames, none of them will crash — and the script declares "all three clean, not reproduced this round." If one arm happens to log an extra respawn, it declares "forking is toxic" or "the crash is in the child's render code," **translating an environment fault into a code conclusion**, after which someone goes off to build a patch or scrap the entire render pool.

The hardened version adds a frame-evidence gate per arm: at least 3 `[STAT]` lines and a peak `fps_x10` of at least 50, otherwise that arm is invalid.

### 2.4 The effective-env check was printed, never enforced

Last round identified the "wrapper overwrites your env" trap and wrote a check: 25 seconds after launch, scan `/proc/<pid>/environ`, print the effective values, with a comment saying "declare this arm void if they don't match."

But in the code, the `envscan` result is only `cat`'d into the log — **the VERDICT never reads it at all**. All three arms could run with identical configuration and the script would still emit a mutually-exclusive verdict. The gate the comment promised simply did not exist.

The hardened version turns it into a hard check: each key must have **exactly one value**, equal to that arm's expectation. Two distinct values mean a leftover process is mixed in, or the wrapper overwrote us again — void either way.

A related unchecked trap was fixed too: arms are built by "drop the wrapper's last line → insert env → re-append the last line." If that last line carries its own env assignment, re-appending it overwrites what was just inserted. The hardened version makes the last-line check a whole-run gate.

### 2.5 It broke the rule we had just established

The most valuable conclusion from last round was: **to claim "config X does not crash," the observation window must be at least 4–5× the known failure period** (period 150 s ⇒ arm ≥600 s; Poisson zero-crash probability falls from 37% to 1.8% / 0.7%).

Yet the script said: if control arm C doesn't crash, shorten A/B to 300 s "so we don't burn 40 minutes for nothing" — and then **run the verdict as usual**. 300 s is only 2× the period, with a 13.5% chance of a false clean. That answers the same question with less statistical power; it just gets the answer sooner.

The hardened version removes the shortening. If C stays clean the verdict is `NOT_REPRODUCED`, explicitly noting "A/B still ran the full arm, but with no reproduction in the control arm their 'clean' carries no verdict weight," and gives no causal conclusion.

### 2.6 Order bias had no control

C runs first, A/B later, while uptime degradation and ION leaks accumulate over time — **later arms inherently run in a worse environment**. A single fixed order with no retest cannot separate configuration effects from order effects.

The hardened version adds a C' control retest at the end. If C and C' differ by more than one crash, the verdict is "order drift, whole run void," with advice to reorder the arms or clear the ION pool first.

## 3. One rule worth more than the code

Grouped together, all six holes are variants of the same mistake:

> **Verdict validity must be verified independently of, and before, the experimental result. Any automatic verdict script must first make "this arm actually performed the behaviour under test" a hard gate, and only then talk about results.**

Three gates, none optional:

1. **Environment gate**: zero leftover processes before the arm starts, or the previous arm writes into this arm's logs.
2. **Configuration gate**: effective env matches expectations key by key, or the arms aren't running different configurations at all.
3. **Output gate**: the arm actually produced the behaviour under test (here, frames), because "didn't crash" may simply mean "didn't run."

Why is this so easy to miss? Because **the cheapest path — zero frames, exit on startup, config never applied — always looks the cleanest**. It produces no anomaly, and so it is silently read as "config X does not crash." What automatic verdicts do best is package "nothing happened" as "everything passed."

Two corollaries:

* When the control arm fails to reproduce, you cannot shorten the test arms and still draw the usual conclusion. Earlier is not the same as more credible.
* Don't put permanently-zero or unverified-source fields in a verdict report. They don't feed any branch, but they contaminate the reader.

## 4. The hardened verdict order

Four gates run before any verdict; failing any one voids the run and **gives no causal conclusion at all**:

```
G0  any arm invalid (leftovers / env mismatch / zero frames / wrapper last line carries env) → INVALID
G1  control arms C and C' differ by >1 crash                                              → INVALID (order drift)
G2  control arm crash count <2                                                          → NOT_REPRODUCED
G3  only now, the three mutually exclusive causal branches
```

The `INVALID` branch contains one deliberately hard-coded sentence: "do not use this round's result to decide on a patch or on scrapping the pool." Because the typical cost of this class of error isn't 40 wasted minutes — it's **changing code on the strength of a beautifully formatted verdict**.

The script passes `sh -n`, and the verdict logic was extracted into a pure function and checked against seven simulated datasets: three causal branches, two void cases, non-reproduction, and order drift — all routed as intended. The device is still offline and the script has never run on hardware. That distinction matters: verified verdict logic is not a verified experimental conclusion.

## 5. A note on the offline rhythm

The device has now been unpowered for seven consecutive rounds. In earlier offline rounds I kept writing new source versions, accumulating four that were never compiled — each one adding a debt of "first check whether it even builds once power returns." Offline output now consists of **zero-code-change measurement tools, plus audits of those tools**, with not one line of player code touched.

This round changed no player code and produced no new conclusion about the root cause of the crash. It only moved the experiment that was about to go on-device from "it runs" to "its conclusion can be trusted." That felt like a better deal than one more uncompiled version.

---

> **Copyright**: Original work by whiteleibniz (compiled with AI assistance). All rights reserved, licensed under CC BY-NC-SA 4.0. Reproduction must credit the source and original link: https://whiteleibniz.github.io
