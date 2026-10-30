---
title: "netTV Hardware Decode (32): The Parallel Render Pool, Measured — 20 fps to 28 fps, and Why More Workers Is Not Better"
date: 2026-10-30 22:10:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP decode
  - Multiprocess
  - Performance measurement
categories:
  - [Project Notes, netTV Hardware Decode]
  - [Embedded, Spreadtrum Platform]
copyright: Original article under CC BY-NC-SA 4.0. Republish with attribution: whiteleibniz.github.io
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/10/30/nettv-32-parallel-render-pool-measured/) · [繁體中文](https://whiteleibniz.github.io/2026/10/30/nettv-32-parallel-render-pool-measured-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/30/nettv-32-parallel-render-pool-measured/)

> Post 32 in the series. The previous post fixed the pool crashing (a child process had inherited the parent's `siglongjmp` recovery context). This one is its report card: same board, same source, same binary, **20–22 fps turned into 28.4 fps** — plus one counterintuitive finding: **more workers is not better; two is the optimum**.

## 1. Crashes first, performance later

Last time the pool went onto hardware it crashed: the worker died with SIGSEGV every generation, the monitor restarted forever, and the board eventually hung and needed a power cycle. The root cause: the pool's child inherited the parent's SIGSEGV handler, and that handler ends in `siglongjmp(g_jb)` — with `g_jb` living on the **parent's stack**. So the moment the child faulted, it long-jumped into the parent's stack and turned into a "second decoder" fighting over the same VSP.

The fix is one line: reset SEGV/BUS/ILL/FPE/ABRT to `SIG_DFL` inside the child, so it dies cleanly on a fault and the parent redoes that one frame serially on EOF.

After that, one single-arm reproduction (never stacked arms) to confirm it no longer crashed — and only then the real measurements.

## 2. Measurements

Same Spreadtrum SC9832A (quad-core Cortex-A7, 1080p25 live source), same v32 binary (`md5 0b6a4840`), 45 seconds per arm, one arm at a time:

| Arm | fps×10 | Render wall clock | Segment gap | Audio drain | rb depth | Dropped-audio ratio | First-frame self-check |
|---|---|---|---|---|---|---|---|
| RPOOL=0 (control ①) | 202 | 18 ms (serial) | 14.7 s | 19.9 s | 298 | 0 | — |
| RPOOL=0 (control ②, closing) | 222 | 19 ms (serial) | — | — | — | 0 | — |
| **RPOOL=2** | **269** | 14 ms | 10.5 s | 9.5–19.1 s | 296 | 0 | pass |
| RPOOL=4 | 261 | — | — | — | — | 0 | pass |
| RPOOL=8 | 257 | — | — | — | — | 0 | **pass** |
| **RPOOL=2 + async audio** | **284** | 13 ms | **4.0–5.0 s** | **3 ms** | 926–978 | 0.6 ⚠ | pass |
| RPOOL=2 + async audio + HLSBUF=1 | 282 | — | 5.5–6.6 s | 2–3 ms | 752–771 | 0.4 ⚠ | pass |

The "first-frame self-check" column deserves its own note: it means the FNV hash of the whole page rendered serially equals the hash rendered in parallel, **bit for bit**. That is the only correctness gate a parallel rewrite can have.

## 3. Three conclusions

### 3.1 The parallel pool works — and two workers is the optimum

Serial 20–22 fps, two workers 26–27 fps: **+25 % to +33 %**, with render wall clock dropping from 18–19 ms to 14 ms.

Then the counterintuitive part: **four workers gave 261 and eight gave 257 — both below two.** The board is simultaneously running the decoder, the downloader and an audio player; every extra pool worker means more CPU contention, one more pipe round trip and one more ack to wait for. And rendering was never a pure compute bottleneck in the first place (it is dominated by memory-access misses), so slicing it finer only shrinks each worker's working set and makes the cache worse.

> More parallelism is not better. **Measure the 1→2→4 curve, find the knee, and stop.** This holds for just about every "several roles contending for one quad-core board" situation.

### 3.2 The 8-worker arm passing proves the offline fix was a real fix

The 8-worker configuration was *guaranteed* to crash before the fix: with split points not aligned to the band height, the last child wrote past its band — tearing the picture and running off the end of the framebuffer page. And that bug was found and fixed while completely offline, by static reasoning alone. The arithmetic was:

```
with band height 64, n=3/6/7/8 ⇒ rows=426/213/182/160, none a multiple of 64 ⇒ partial band ⇒ overrun
```

Now, on real hardware, the 8-worker arm ran 45 seconds, the self-check reported "serial/parallel identical", zero crashes, zero leftover processes, and the ION client count did not grow. **The offline static audit was validated by the device.**

Worth noting: the originally planned three arms (0/2/4) happened to be exactly the "safe" configurations — the one that would have caught this (8) was not in the plan. That is precisely why 8 was later added to the A/B matrix.

### 3.3 The bottleneck moved: rendering is no longer the problem, the source and audio are

Add the asynchronous audio pump and the numbers change shape: audio drain **19.9 s → 3 ms**, segment gap **14.7 s → 4.0–5.0 s**, fps **28.4**.

28.4 fps is **above the source's own 25 fps** — so rendering is definitively no longer the bottleneck (no amount of extra parallelism creates frames the source does not have).

What, then, causes the remaining 4–5 s gap? I went and probed the source: that particular m3u8 has a **window of only three segments** with roughly ten seconds between segments. So "segment pick 5.7–13.3 s" is mostly **waiting for the source to refresh**, not a shortage of buffer depth. That also settled an open question:

| Arm | fps | Segment gap |
|---|---|---|
| HLSBUF=3 (buffer a few more segments) | 284 | 4.0–5.0 s |
| HLSBUF=1 (less buffering, faster startup) | 282 | 5.5–6.6 s |

Steady state is essentially identical. **Live latency of ~5–10 s is a property of the source, not something the player can engineer away** — a source that emits a segment every ten seconds has its latency floor right there. This also dissolves the "does the user accept +18 s of startup delay?" question I had been carrying: since HLSBUF=1 starts faster with no steady-state cost, use 1.

## 4. One problem still open

The asynchronous audio pump's dropped-segment ratio came out at **0.4–0.6**, above the 0.35 threshold I set for myself. The mechanism: while the pump is busy, an incoming whole audio segment is **silently discarded**, and the log shows the backlog growing to 38–63 KB.

The consequence is audio/video drift that accumulates over time. Two candidate fixes: turn the pump into a single queued worker (busy means enqueue, not drop), or raise its concurrency. **Noted for the next round; no extra variable stacked on top of this one.**

## 5. Checklist worth keeping

The genuinely valuable output of this round is not the fps number but these six points:

1. **Zero the crashes before discussing performance.** Until the self-check and the graceful fallback work, no fps figure is trustworthy.
2. **Measure the parallel curve and find the knee** — more workers is not better; on a quad-core board two is often the answer.
3. **Run one arm at a time.** Stacking four arms let the first arm's crash loop hang the board (that is exactly how it died last round).
4. **The end-to-end bottleneck is a chain**: segment pick → audio → decode → render. Each fix exposes the next link; measure the share of every link before touching one.
5. **Latency is sometimes a property of the source.** Count how many segments the m3u8 window holds and how many seconds apart they are — the answer is usually right there.
6. **Offline static auditing is worth doing**, provided you aim at the right target: the defects that neither crash nor log, only corrupt quietly. Whether the fix can be validated later depends on somebody remembering to run the configuration most likely to break.

Next round: deploy v32 together with `NETTV_RPOOL=2` and `NETTV_AUDIO_ASYNC=1` to the live image, then run long-duration stability and channel-switch regression; and rework the audio pump from "drop when busy" into a queued single worker.
