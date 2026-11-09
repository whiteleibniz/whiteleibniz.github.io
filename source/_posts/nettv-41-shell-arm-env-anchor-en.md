---
title: "netTV HW Decode (41): Test the Never-Run Script First — the 'Last Line Is exec' Assumption in A/B Arm Builders"
date: 2026-11-10 02:40:00
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

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/11/10/nettv-41-shell-arm-env-anchor/) · [繁體中文](https://whiteleibniz.github.io/2026/11/10/zh-tw/nettv-41-shell-arm-env-anchor-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/10/nettv-41-shell-arm-env-anchor-en/)

> Part 41. The device has been offline for the 13th round in a row, so online experiments
> stay queued. The previous two rounds cleared our own code of the "second IDR always
> crashes" symptom via static audit. Instead of guessing further, this round did a physical
> on the two scripts that have **never run on the device** — and found a defect that would
> have burned an entire 50-minute online window.

## 1. Why not keep guessing at the crash

Round 40 turned the second-IDR forensics into two tools: a PC-side symbol mapper and a
device-side two-arm orchestrator. Neither has ever touched the device. With 13 consecutive
offline rounds, every static avenue is basically exhausted; pushing further would mean
changing code based on speculation with no supporting data — the kind of thing that ends up
in the post-mortem.

So the angle changed: **the online window is the most expensive resource in this project**
(22–50 minutes, plus a human watching). Make sure those two scripts cannot embarrass
themselves inside it.

The acceptance bar is not "does it parse". It is the failure class that already bit this
project twice:

- a source probe that only accepted HTTP 200, while a ranged probe really returns 206 —
  three live sources were declared dead;
- a `SigBlk` sampler guarded by string length, while the real value is a 32-digit hex
  string — sampling stayed at zero and the report said "no thread masks SIGSEGV".

Neither was a syntax error. Both disguised a **measurement-tool bug as a healthy system**.
So the criterion here: can real-shaped samples actually exercise the parts that fail
silently?

## 2. The real defect: the arm builder assumes "the last line is exec"

A/B experiments rely on an "arm builder": copy the player wrapper, inject this arm's
`export NETTV_xxx=...`. The old implementation (shared by both scripts):

```sh
mkarm() {
  tag=$1; k=$2
  { sed '$d' "$WRAP"            # drop the last line (assumed to be exec)
    echo "export NETTV_IDRREPLAY=$k"
    tail -1 "$WRAP"             # put it back
  } > /tmp/w_$$tag.sh
}
```

It only holds if **the wrapper's last line is that `exec`**. Nothing enforces that. Add one
trailing blank line — editor save, `echo >>` append, manual whitespace — and `sed '$d'`
deletes the blank line while `tail -1` pastes the blank line back:

```
#!/bin/sh
export LD_LIBRARY_PATH=...
exec /usr/local/bin/nettv_player.real "$@"   ← exec is here
export NETTV_RPOOL=0                          ← injected after exec
export NETTV_RPOOL_IDLE=1                     ← never executed
```

Once `exec` runs, the shell never reads the following lines. Consequences:

- all four arms silently run the production baseline configuration;
- the verdict script sees four identical arms and concludes "this config does not crash" —
  the data is clean, the interpretation is wrong;
- the existing `WRAP_LASTLINE_BAD` check only looks for `NETTV_` on the last line; a blank
  line passes;
- the only thing that catches it is the "effective env" hard gate, and catching it means an
  `INVALID` — a 50-minute window spent on "this round is void".

The dangerous part is that this is neither a crash nor an error message. It is data that
looks unusually clean.

## 3. Fix: anchor on the `exec` line, not on a line number

Replace "last line" with "first `exec` line" and insert before it:

```sh
awk -v k="$k" '
  /^[[:space:]]*export[[:space:]]+NETTV_IDRREPLAY=/ { next }   # drop stale same-name export
  ins==0 && /^[[:space:]]*exec[[:space:]]/ { print "export NETTV_IDRREPLAY=" k; ins=1 }
  { print }
' "$WRAP" > "$out"
```

Three side benefits: immune to trailing blank lines and comments; removes any pre-existing
same-name export so the "exactly one" gate holds (also makes reruns idempotent); and if the
wrapper has no `exec` line at all, it falls back to the old behaviour but leaves an explicit
`ARMK_FALLBACK=1` marker in the file instead of silently generating a broken one.

## 4. Proving the fix: executable-level tests plus mutation checks

Passing `sh -n` proves nothing — the broken version passed it too. Both scripts now support
an `NTLIB=1` library mode: when set, sourcing them only defines functions, starts no
experiment, touches no logs. The test suite therefore loads **the real file** and asserts on
the exact code that ships, not on a copy.

| Group | Covers | Key assertion |
|---|---|---|
| `mkarm` | trailing blank line / pre-existing export / no exec line | the exports sit **immediately above exec, in order** |
| `env_key_ok` | match / wrong value / duplicates / empty / missing | effective only if exactly one entry with the expected value |
| H2 mask criterion | extract the real 3 lines from the script, feed 8 real `SigBlk` shapes | case, all-zero, empty, too-short must not misjudge |

That first assertion deserves a note. It was initially written as "an export exists before
exec", which stayed green even when the export landed **after** exec — because the wrapper
body line, rewritten in place, already sat before exec. Only tightening it to "immediately
above exec" actually tested placement. A loose test is worse than none: it hands you a false
sense of having verified something.

Then the suite's own sensitivity — deliberately break the code under test and check that
cases notice:

```
--mutcheck
  OK arm-anchor mutation caught (degrades to last-line insert => W1 must fail)
  OK uppercase SigBlk mutation caught (missing tr normalisation)
  OK bis35c arm-anchor mutation caught
MUTCHECK=PASS
```

## 5. Two traps the test harness itself fell into

**Trap 1: the driver could pass falsely.** The first version collected output via command
substitution and counted `✗FAIL` lines. But if a phase function returns early (e.g. the
source failed), zero failure lines are produced, the count is zero, and it prints
`LIBTEST_RESULT=PASS` — exactly the "`maskedhit` stuck at 0" shape from the previous round.
Fix: every phase must emit `PHASE_RESULT` and exit 0; missing either counts as a failure.
**"No failures observed" is not "pass" unless you have verified the path that should have
produced them actually ran.**

**Trap 2: `dash`'s `.` searches PATH.** `. "_ntseg2.sh"` resolves relative to the current
directory in bash, but `dash`/`ash` perform a PATH lookup for names without a slash and
report "not found". `. "./$SRC"` behaves identically everywhere. This class of difference
only shows up when you actually run a strict POSIX shell.

## 6. Two things confirmed along the way

- Both scripts pass `dash -n` (real POSIX), and their own verdict self-tests still pass
  (8 cases / 7 + 5 source-selection cases).
- The crash address `0x747474` (ASCII `ttt`) was re-checked against the source: no matching
  fill constant, no character `memset`. So it is **not our own fill pattern**; suspicion
  remains on the vendor library or the input buffer header. Wait for the device and get a pc
  offset instead of guessing further.

## 7. Status and next steps

- Production still runs the previous binary; nothing was compiled, deployed, or committed
  this round.
- When the device is back: run the offline suite first → open-run gate (route + playable
  source) → every arm `GATE V=` all 1 → only then read VERDICT. `INVALID` means rerun the
  whole round, never edit code based on it.
- If a generated wrapper starts with `ARMK_FALLBACK`, the wrapper structure on the device
  changed — `cat` it before running.

Round 13 offline. This round was about making sure the next power-on is not wasted.
