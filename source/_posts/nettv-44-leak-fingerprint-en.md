---
title: "netTV HW Decode (44): Building a Scale for \"Leaks\" — Crash-Interval Fingerprints and Validity Gates"
date: 2026-11-11 02:00:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Hardware Decode
  - Debugging Methods
categories:
  - [Project Notes, netTV HW Decode]
  - [Embedded, Spreadtrum Platform]
  - [Engineering Practice, Debugging Methods]
copyright: "Original works by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduce with attribution to whiteleibniz.github.io"
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/11/11/nettv-44-leak-fingerprint/) · [繁體中文](https://whiteleibniz.github.io/2026/11/11/zh-tw/nettv-44-leak-fingerprint-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/11/nettv-44-leak-fingerprint-en/)

> Part 44. The previous round labelled the recurring crash "cumulative drift", i.e. look for a leak.
> But "leak" is a word far too cheap to act on. This round touches zero lines of the player and
> does one thing only: **build a scale that can tell which kind of leak it is.**

## After the label, the question becomes "which kind"

The device was offline again, so this had to be done offline. Bringing back the last result: two
1200-second arms crashed 6 and 7 times, intervals 151–186 s, frame rate normal, crash point moving
forward with the real stream. The verdict was "cumulative drift" — but that verdict supports at
least three mutually exclusive next steps:

- If the interval **shrinks**, that is the classic leak curve: less headroom each cycle, hitting
  the wall sooner and sooner.
- If the interval is **constant**, it looks more like a fixed slot or timer — every N frames, every
  N segments, every N seconds something crosses a boundary.
- If memory drains while the interval stays flat, those are **two independent phenomena** and should
  not be bundled into one explanation.

The fixes do not overlap at all. So what was missing was never a sampler (per-thread signal masks,
RSS and ION polling already existed) — it was a **decision tool** that turns an interval series plus
a memory series into a named conclusion with explicit preconditions.

## Division of labour: the device only collects, the PC decides

The design rule is: anything that can stay silent, stays silent.

- The device runs a single 2400-second arm (about 40 minutes) and every 10 seconds writes one line
  of `MemFree / CmaFree / ION / per-process threads, RSS, fd`, while copying newly appeared
  `mon-child-signal=11` lines from `phase.log` into a crash ledger together with wall-clock time.
- All decisions happen on the PC: there is no Python on the device, and an SSH session must never
  sit idle for 40 minutes — long work has to be split into a device-side background script plus
  short polling.

The collector also does something easy to forget: it emits **its own integrity gate**. At the end it
writes `GATE=OK` or `GATE=FAIL reason=...`, covering start residue, end residue, frame statistics,
sample count and time span. The PC then **recomputes that gate independently**.

## Prove the observation is valid before discussing trends

This is the most expensive lesson in the whole methodology, and one I keep re-learning: **the laziest
run always looks the cleanest**. Decoder never starts, source is dead, a leftover process blocks the
arm — crash count is of course zero, and zero gets read as "this configuration is stable".

So the first stage of the decision tool is not statistics, it is a gate:

| Gate | Criterion | What failure means |
| --- | --- | --- |
| Start residue | 0 | Previous round not cleaned, config may not be in effect |
| Frame rate | `fps_x10 ≥ 50`, ≥3 stat lines | No decoding at all; zero crashes means nothing |
| End residue | 0 | Shutdown unclean, next round polluted |
| Sample count / span | ≥80% of expected | Sampling truncated; trend is half a dataset |
| Sampling gap | consecutive samples ≤ max(60 s, 5×interval) | A whole chunk missing; not a continuous trend |

If any gate fails, the verdict is `INVALID` with an explicit "do not change any code based on this".

Better still: the gate and the verdict are **each written twice**. The device side has a shell
`gate_eval`; the PC side has a Python `_gates()`. Two independent implementations, and if they
disagree the verdict is `INVALID (cross-check mismatch)`. That is not pedantry — this round it caught
one of my own bugs (below).

## Verdict levels: split "leak" into things you can act on

The interval trend ignores variance and looks at "relative first-to-last change plus linear-fit r²".
The memory trend looks at the `CmaFree` slope, its r², and total drop, split into "leak magnitude"
and "drift magnitude".

| VERDICT | Trigger | What to inspect next |
| --- | --- | --- |
| `LEAK_CONFIRMED` | shrinking intervals + leak-magnitude memory drain | objects allocated per crash cycle and never freed |
| `LEAK_LIKELY` | shrinking intervals + drift-magnitude drain | treat as leak, check whether fd/thread growth scales with crash rate |
| `LEAK_SUSPECTED` | shrinking intervals, flat memory | non-memory accumulation: fd, threads, pool slots, vendor handles |
| `PERIODIC_WITH_DRIFT` | constant interval but memory draining | fixed slot/timer, drain is a side effect |
| `PERIODIC_TIMER` | constant interval, flat memory | every N frames/segments/seconds action (reconnect, re-init, pointer wrap) |
| `SLOWING` | intervals growing | may correlate with source switching or GOP length changes |
| `RANDOM` | no pattern | random memory corruption; go back to pc mapping and buffer bounds |
| `STABLE` | zero crashes over a long window | **does not mean fixed**; needs ≥4–5 failure periods |

That last row deserves its own paragraph: claiming "configuration X does not crash" requires
observing 4–5 failure periods. Poisson gives the numbers — one period still leaves a 37% chance of
"not reproduced", five periods brings it to 0.7%.

## Four bugs, all of the "tool disguises itself as a conclusion" kind

The valuable part of this round is not the two scripts, it is what the self-tests caught:

**① A greedy regex turned every interval into zero.**
Crash lines look like `t=1117000 mon-child-signal=11 st=0x8b`. To extract the millisecond stamp I
wrote `sub(/^.*t=/,"")` — but `st=` at the end of the line also contains `t=`, greedy matching ate
all the way there, and the remaining `0x8b` was stripped to `0`. Four crashes produced three
intervals, all zero, which reads as "extremely stable cadence". Fixed by splitting the first field.

**② Windows text mode wrote CRLF into a shell script.**
A Python patch script used `open(p,"w")`, which on Windows translates `\n` to `\r\n`. dash then
reported `"|" unexpected` at line 46 — the preceding line ended in a backslash continuation, and the
backslash was followed by `\r` instead of a newline, so the continuation broke. The reported line was
250 lines away from the actual problem. The device has no CRLF converter; such a script simply fails
everywhere.

**③ The cross-check always reported a mismatch, and the mismatch never demoted the verdict.**
A meta line `GATE=OK` is split at the first `=` into `key=GATE, value=OK`, while the check used
`value.startswith("GATE=OK")` — always false. So **every** run reported "cross-check mismatch".
Worse, the mismatch only appended a reason and never set `ok = False`: the verdict came out as
`PERIODIC_WITH_DRIFT` while its own explanation said the cross-check disagreed. A conclusion
contradicting its precondition is more dangerous than having no check at all.

**④ Using variance to detect acceleration mislabelled 186→128 as constant.**
A small `cv` can mean a constant cadence, or it can mean **uniformly accelerating** crashes. The demo
data 186, 179, 168, 155, 141, 128 s has `cv=0.13` (very "stable") and `r²=0.99` (a beautiful straight
decline), yet matched `PERIODIC` first because `cv ≤ 0.20`. The rule now requires both a small
first-to-last change and small cv for "constant", leaving direction to r² and relative slope.

The common thread: **none of these crash the program; they make it produce a plausible wrong answer.**
Three countermeasures, none novel but all mandatory:

1. Self-tests must assert the **expected verdict name**, not merely "no FAIL lines" — the earlier
   lesson was a phase function that failed to load, leaving its counter at zero so the test harness
   became "always passing".
2. Write critical criteria twice and reconcile two independent implementations.
3. Add **mutation cases**: set the frame rate to 0, set end residue to 2 in the same dataset; the
   verdict must fall into `INVALID`. If the verdict survives the mutation, the gate is not wired in.

## Status and next step

Nothing was compiled, deployed, or changed in the production binary this round — the collector runs
the shipping wrapper exactly as configured. Offline verification covered: 13 shell self-test items
(interval parsing, bitrate headroom, six gate states, the all-zero false-pass), 17 Python items
(including 4 mutations and 2 parser/cross-check regressions), plus a real local run of the
gate-failure branch (no player launched; validates argument flow, gate and meta generation).

Once the device is powered, the order is fixed: run the 2400-second arm, pull meta and the crash
ledger, then let the decision tool speak. If it says `PERIODIC_TIMER`, the leak line yields to a
"fixed action" hypothesis; if it says `LEAK_*`, follow the fd/thread curves to the per-cycle net
increment. **Before 4–5 crash intervals exist, any change is a guess.**

---
*Copyright notice: this is an original article by whiteleibniz, licensed under CC BY-NC-SA 4.0. Please credit whiteleibniz.github.io when republishing.*
