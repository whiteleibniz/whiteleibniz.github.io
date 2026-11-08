---
title: "netTV Hardware Decoding (36): The Crash Period Is 150s — Yet Every Long Run We Did Had the Render Pool On"
date: 2026-11-03 02:30:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Crash Forensics
  - Experiment Design
categories:
  - [Project Notes, netTV Hardware Decoding]
  - [Embedded, Spreadtrum Platform]
copyright: "Original work by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduction must credit the source: whiteleibniz.github.io"
permalink: zh-tw/2026/11/03/nettv-36-crash-bisect-render-pool-en/
---

> 🌐 Languages: [簡體中文](https://whiteleibniz.github.io/2026/11/03/nettv-36-crash-bisect-render-pool/) · [繁體中文](https://whiteleibniz.github.io/2026/11/03/zh-tw/nettv-36-crash-bisect-render-pool-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/03/nettv-36-crash-bisect-render-pool-en/)

> Part 36 of the series. The last two rounds chased "why the SIGSEGV handler never ran at all" down into the kernel's `force_sig_info`, and even produced v34 — the unblocking code. This round I stopped and checked something far more basic: **every long-duration measurement we own was taken with the render pool enabled.** In other words, "is the crash caused by the pool?" has never actually been measured.

## 1. A measurement hole we walked straight past

The production crash looks like this: the worker decodes roughly 4000–5000 frames (≈150 s), then gets killed by SIGSEGV, the monitor respawns it, and the cycle repeats.

Here is every continuous-playback measurement in the project's history:

| When | Build / config | Duration | Crashed? |
| --- | --- | --- | --- |
| 10-26 | v28 (**no render pool existed yet**) | 120 s | signal=11 = 0 |
| 10-30 | v31, `NETTV_RPOOL=0` | 45 s | 0 |
| 10-30 | v31, `RPOOL=2/4/8` | 45 s | one infinite-crash episode on 2 (fixed in v32) |
| 10-31 | v33, `RPOOL=2 + AF=1 + HLSBUF=1` | 300 s | 1 |
| production | v32, `RPOOL=2 + AF=1 + HLSBUF=1` | 600 s | 3 |

See the problem? **Every run of 150 s or longer had `NETTV_RPOOL=2`.** The only two runs with `RPOOL=0` lasted 45 s and 120 s — neither survived a single crash period.

That is a hard flaw in experiment design. With a 150 s crash period, a 120 s "clean" result proves nothing; it simply hadn't crashed yet. And yet we kept using it as if it established "the serial path is safe."

## 2. Method: arm length must be far larger than the failure period

This is the takeaway I most want to keep from this round — worth more than the code:

> To claim "config X does not crash," the observation window must be at least **4–5× the known failure period**. Period 150 s ⇒ arm ≥ 600 s.

The reasoning is plain: failures are roughly Poisson. With period `T`, the probability of surviving `t` seconds crash-free is `e^(-t/T)`. At `t = T` that is 37% — **a one-in-three chance of declaring a crashing configuration clean.** At `t = 4T` it drops to 1.8%; at `5T`, 0.7%. Only then can you conclude anything.

This also explains why earlier A/B rounds always "looked fine": they were designed to compare frame rate, not to catch crashes. 45 s is plenty for fps and nowhere near enough for MTTF.

## 3. Three arms: the only variable is whether the child actually renders

The good news is the cost of testing this is near zero — the bisect switch is already in the production binary. No code change at all:

| Arm | Config | Meaning |
| --- | --- | --- |
| C (control) | `RPOOL=2 AF=1 HLSBUF=1` | production as-is; expected to reproduce the crash |
| A | `RPOOL=0 AF=1 HLSBUF=1` | no pool at all, serial rendering |
| B | `RPOOL=2 IDLE=1 AF=1` | pool children fork normally but **only ack, never render** (a switch v32 already ships) |

Arm B is the key. It separates "the act of forking" from "running render code in the child":

* A clean, B clean, C crashes ⇒ the crash is in **the child's render code**; fork is merely the vehicle;
* A clean, B crashes ⇒ **forking itself is toxic** (forking inside a process holding the VSP);
* A crashes too ⇒ nothing to do with the pool; look at decode / feed / audio.

Mutually exclusive, and after the run you just match your result to the row. No more guessing.

**Run the control arm first.** If C doesn't crash this round, the premise is broken and the remaining two arms are shortened to 300 s as confirmation only — otherwise you burn 40 minutes for nothing.

## 4. Three engineering traps that silently void the run

### 4.1 The wrapper overwrites your env

The production entry point `/usr/local/bin/nettv_player` is a shell wrapper with `RPOOL/AF/HLSBUF` baked in. If you `export NETTV_RPOOL=0` and then call it, **the wrapper's own `export` overwrites your value** — all three arms run the same config, the experiment is void, and nothing in the log shows it.

Build each arm like this instead: copy the wrapper, drop the last line (the `exec`), append that arm's env, then put the last line back:

```sh
{
  sed -e "s/NETTV_RPOOL=[0-9]*/NETTV_RPOOL=$rp/" ... $WRAP | sed '$d'
  echo "export NETTV_RPOOL=$rp"
  echo "export NETTV_RPOOL_IDLE=$idle"
  tail -1 $WRAP          # re-append the exec line
} > /tmp/w_$tag.sh
```

This keeps every environment setting the wrapper provides (`LD_LIBRARY_PATH` and friends) while guaranteeing our values are the last ones applied before `exec`.

### 4.2 Verify the effective env

Building it right isn't enough — **verify**. Twenty-five seconds after launch, scan the live process environment blocks:

```sh
for d in /proc/[0-9]*; do
  e=$(readlink "$d/exe" 2>/dev/null)
  case "$e" in *nettv_player*) tr '\0' '\n' < "$d/environ" | grep -a NETTV_ ;; esac
done | sort -u
```

The log prints an explicit "effective env" section; if `IDLE` doesn't match, that arm is declared void on the spot. Far cheaper than staring at results afterwards wondering what went wrong.

### 4.3 Match processes by `/proc/<pid>/exe`, never by command line

This one has bitten this project five times now: `ps -ef | grep nettv_player` to find processes to kill, while the script's own command line contains `nettv_player` ⇒ **it matches itself.** The 10-30 A/B script killed itself this way — the baseline arm finished, then the script TERM'd itself and the remaining three arms never ran.

Always match on the resolved target of `/proc/<pid>/exe`. What appears in the command line then becomes irrelevant.

## 5. Verdict table (emitted automatically at the end of the script)

| A (`RPOOL=0`) | B (`+IDLE`) | C (control) | Verdict | Next step |
| --- | --- | --- | --- | --- |
| clean | clean | crash | crash is in the child's render code | build v34 (unblock + handler probe), confirm zero crashes at `RPOOL=2`, then request deployment |
| clean | crash | crash | forking itself is toxic | move the pool into a separate process, or pin `RPOOL=0`; move optimisation effort back to single-core `fb_render` |
| crash | crash | crash | unrelated to the pool | keep bisecting `AF` / `HLSBUF`; run resource-trend sampling in parallel |
| clean | clean | clean | not reproduced this round | extend arms to 1200 s, or trigger playback through the UI entry point |

## 6. Aside: the offline/online rhythm of this project

The device has now been offline (unpowered) for six consecutive rounds. The earlier coping strategy was "keep writing new source versions offline," which piled up v29, v30, v31 and v34 — **none of them ever compiled.** Each new version adds a debt: "once it powers on, first verify it even builds."

This round took a different line: **offline rounds produce zero-code-change measurement tools only.** No player modifications; just the production binary plus env combinations, compressing the uncertainty into a single 40-minute automated script. The moment the device powers on, one command yields a verdict instead of adding another compile debt.

---

> **Copyright**: Original work by whiteleibniz (compiled with AI assistance). All rights reserved. Reproduction must credit the source and original link: https://whiteleibniz.github.io
