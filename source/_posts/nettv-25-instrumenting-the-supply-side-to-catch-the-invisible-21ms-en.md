---
title: "netTV Hardware Decoding Deep Dive (25): Putting Instruments on the 'Invisible 21.6 ms' — Supply-Side Instrumentation Design"
date: 2026-10-24 02:00:00
tags:
  - VSP
  - Hardware Decoding
  - Frame Rate
  - rb_take
  - m3u8
  - Performance Profiling
  - Live Streaming
  - Spreadtrum
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Debugging, Performance Optimization]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/24/nettv-25-instrumenting-the-supply-side-to-catch-the-invisible-21ms/) · [繁體中文](https://whiteleibniz.github.io/2026/10/24/nettv-25-instrumenting-the-supply-side-to-catch-the-invisible-21ms-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/24/nettv-25-instrumenting-the-supply-side-to-catch-the-invisible-21ms-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The previous part stretched continuous playback to 386 seconds — stability passed, yet it left behind **an account that doesn't balance**: AU average wall clock 62.6 ms, while all segment timers together add up to only 40.4 ms, **21.6 ms claimed by no timer at all**. This time the device is offline (RNDIS not enumerated, WiFi also down), so on-device testing is out; do what offline work should do — **install the instruments properly**, so the next boot can directly read out who that 21.6 ms belongs to.

## 1. Why the Account Doesn't Balance

The existing segment timing covers only four blocks: segment loop (bsOnMsg + sleep + 9c wait), snap, frame readback, render. But what the worker does in one AU round goes far beyond these:

| Untimed region | Description |
|---|---|
| `rb_take()` | when the ring is empty, `usleep(2000)` spins waiting for dl to supply data; 2 ms granularity averages 1 ms of wasted sleep |
| from NAL acquisition to `DRIVE` | NAL copy-out, splitting, refilling the out queue, quota checks |
| IDR burst cooldown | active `usleep` when `g_idr_gap_ms` is nonzero |
| frame interval floor | frame-pacing `usleep` when `g_fps_ms` is nonzero |

One more key clue: **in single-segment file mode, wall clock = the profiling sum, to the millisecond**. The gap only shows up in the "download-while-play" live chain — so suspicion centers on "waiting for data", not "computing too slowly".

## 2. Ruling Out Three Suspects with Defaults Alone

Half the candidates can be cut without touching the device, because the defaults sit right in the code:

- `g_gop_ms = 0`, `g_fps_ms = 0` (decided 2026-10-19: quota and frame pacing both off by default) ⇒ **GOP budget skip** and **frame-interval sleep** are identically 0 under the default run;
- `g_idr_gap_ms` is nonzero only when adjacent IDR spacing < 1 s, while the GOP is about 2 s and decoding is slower than real time ⇒ **IDR cooldown** is essentially always 0;
- `NETTV_PTSSYNC` off by default ⇒ the PTS frame-drop branch doesn't participate.

So under the default path the number-one suspect is **`rb_take()` spinning while waiting for supply**. But "prime suspect" is not "convicted", so this round's move is not to change it directly, but to **close the account first**.

## 3. What the Instrumentation Does (10-24 Offline Changes)

**Worker side**: four new timing buckets `g_t_take / g_t_pre / g_t_cool / g_t_pace`, plus two free metrics —

- **Residual**: `wall − (segment loop + snap + frame readback + render + NAL take + prepare + cooldown + pace)`, printed once every 200 AUs;
- **rb depth**: per-round average of accumulated `wpos − rpos` (unconsumed NAL count).

Residual ≈ 0 means the 21.6 ms has landed in one of the buckets; residual still large means there is a fifth place, so keep bisecting. rb depth distinguishes two worlds at a glance: **depth long-term ≈ 0 ⇒ the consumer is waiting for data (supply is the bottleneck); depth keeps rising ⇒ consumption is the bottleneck**.

**dl side**: one `[供數]` line per segment, four numbers —

```text
[供数] 段N: 下载=Xms 入池=Yms 段间隙=Zms(EMA=…) rb深=D 背压=B
```

Here **segment gap** is defined as "the last NAL of the previous segment finishes entering the pool → this segment starts entering the pool" — the window during which rb stops growing and the worker can only spin; its main component is `audio_feed`'s segment-beat blocking. A large segment gap means prefetch should be deeper or segments pulled earlier; a large download time means source-side rate limiting, and no code change helps.

**Zero behavioral change**: `rb_take`'s spin granularity keeps the old 2000 µs; only the `NETTV_RBUS=N` environment variable is added, so once localization is done you can directly A/B 2000/500/200 without recompiling.

## 4. How to Read the Next perf Line

```text
[perf] AU#N 均值: 墙钟=… 段循环=… (bsOnMsg=… 睡眠=… 9c等=…)
       snap=… 读帧=… 渲染=… | 取NAL=… 准备=… 冷却=… 节拍=… | 余差=… rb深=… (ms)
```

Decision table:

| Phenomenon | Conclusion | Next step |
|---|---|---|
| NAL take ≈ 21.6, rb depth ≈ 0 | supply really is the bottleneck (confirmed) | quantify segment gap → pull the next segment earlier / deepen prefetch |
| residual ≈ 21.6, all buckets small | a fifth place hasn't made it into a bucket | keep bisecting (likely segment-tail wrap-up or the frame-drop branch) |
| rb depth persistently > a few hundred | consumption is the bottleneck | go back to the render 23.8 ms line |
| residual ≈ 0 and NAL take ≈ 0 | the 21.6 ms is a sampling artifact | re-check the wall-clock statistics definition |

## 5. Methodology Takeaways

1. **When the account doesn't balance, install instruments first — don't change code first.** Changing `usleep(2000)` to 500 µs directly also lets you "give it a try", but afterwards you won't know where the win came from, or whether there is a second place.
2. **The residual method**: add up all the known terms, and print the "unknown" as an explicit quantity. Once the unknown becomes a number, localization turns from guessing into looking up.
3. **Static elimination via defaults.** Three candidates need no device at all — a feature off by default cannot produce 20 ms in a default run. Read the code to cut candidates first, and save one genuinely unknown quantity for the on-device round.
4. **Direct supply/consumption balance metrics explain more than timers do**: timers tell you "how long it waited"; rb depth tells you "why it waited".

## 6. Status

This round the **device is offline** (RNDIS not enumerated, no RNDIS adapter on the PC side); the changes have not yet been compiled or run on device:

- Source: `outputs/sprd_msg_np_v2.c` (supply-side instrumentation, md5 `c15e558f`)
- Acceptance scripts: `outputs/_sup1024.sh` (build v18 + run 150 s), `outputs/_sup1024_fin.sh` (read the criteria)

Next boot: first confirm the new source is in place → run `_sup1024.sh` → after 3 minutes run `_sup1024_fin.sh` to read the numbers, then use the decision table above to decide what to cut next.
