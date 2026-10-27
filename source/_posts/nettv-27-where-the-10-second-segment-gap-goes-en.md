---
title: "netTV Hardware Decoding (27): The Source Is 25fps, We Play 15 — Itemizing the 10-Second Segment Gap"
date: 2026-10-25 02:35:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP decoding
  - HLS live
  - Profiling
categories:
  - [Projects, netTV hardware decoding]
  - [Embedded, Spreadtrum]
copyright: Original article under CC BY-NC-SA 4.0. Attribution required when republishing: whiteleibniz.github.io
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/25/nettv-27-where-the-10-second-segment-gap-goes/) · [繁體中文](https://whiteleibniz.github.io/2026/10/25/nettv-27-where-the-10-second-segment-gap-goes-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/25/nettv-27-where-the-10-second-segment-gap-goes-en/)

> Part 27. The previous post blamed the 14.2fps steady state on the source being 14.6fps. This post **overturns** that with PTS evidence, then itemizes the real 10-second black hole into two line items.

## 1. Reversal: the source is 25fps, not 14.6fps

The earlier arithmetic was "155 frames per segment ÷ 10.6s segment gap = 14.6fps". The denominator was wrong: **the segment gap is wall-clock time, not the content duration of the segment.** Real frame rate can only come from the stream itself.

So I wrote `nalcount.c`: chop 188-byte packets, parse the PES header at every PUSI to read PTS, compute frame rate as "AU count ÷ PTS span", and cross-check with "average PTS delta". One segment of the Luxian source:

```
packets=14034 pes=150 au(pts)=150
nal: idr=5 nonidr=145 sps=5 pps=5 sei=5 aud=150
pts_span=5.960s  fps_by_span=25.00
avg_pts_delta=3600.00 ticks  fps_by_delta=25.00
```

**150 frames / 5.96s / a perfectly constant PTS delta of 3600 ticks (90000/25) — a real 25fps, nailed down.** Two independent methods agree, so there is no frame loss and no VFR.

In other words: we take 10.3 seconds to play 5.96 seconds of content. **The source was never the slow one; we were.** "Reach 25fps" is physically achievable again.

One trap along the way: `mplayer -identify` reports `ID_VIDEO_FPS=25.000`, which for MPEG-TS is basically a container default and worthless as evidence. It reported 25.000 for two other sources as well, yet their average PTS deltas were 8359/8704 ticks (~10.8fps) — clearly a different story.

Survey of six sources:

| Source | Resolution | AU/segment | PTS span | Real fps |
|---|---|---|---|---|
| Luxian | 1920×1088 | 150 | 5.96s | **25.00** |
| Shangyu | 1920×1088 | 200 | 7.96s | **25.00** |
| Songpan | 1920×1088 | 270 | 10.76s | **25.00** |
| Qianjiang | 1920×1088 | 200 | 7.92s | 25.13 (uneven) |
| CloudFront | 960×544 | 100 | 3.96s | 25.00 |
| Northern BG | — | — | — | playlist unreachable |

## 2. The 10.3-second bill

Timers were added to every stage of the download loop (`g_dl_t_pick / pref / af / hist`). One run at stock settings:

| Segment | Gap | Pick | Prefetch (incl. download) | Audio | Parse | Enqueue |
|---|---|---|---|---|---|---|
| 2 | 10439ms | 4983ms | 5236ms | 5231ms | 212ms | 6ms |
| 3 | 10470ms | 5075ms | 5172ms | 5167ms | 214ms | 6ms |
| 4 | 10402ms | 4980ms | 5211ms | 5206ms | 213ms | 6ms |

(Cumulative counters; the per-segment value is the difference between rows.)

Beautifully clean: **download 0.21s and enqueue 6ms together are under 3%** of the gap. Of the 10.3 seconds, 5.2s is `audio_feed()` and 5.0s is `pick_seg()`.

Why is `audio_feed()` 5.2 seconds? It pushes the whole 2.6MB TS segment into a 64KB fifo that mplayer drains at 1× realtime. **That is not backpressure, that is physical drain time** — it equals the segment's content duration. And it sits *before* "pick next segment + prefetch", so every loop iteration is locked behind audio.

Here is the trap: `NETTV_AF_RETRY` only caps *stall retries* (300 × 20ms by default); it cannot fix whole-segment draining. Setting it to 1 moved 16.0 → 19.0fps and only cut the gap to 8.1s. Then I renamed the mplayer binary to kill audio entirely: **still 8.1s, still 19.0fps.** Those two controls together prove audio only accounts for 2.2s of stalling — the 5.2s body needs a structural change, not a knob.

## 3. Fix: asynchronous audio pump

Simple idea — after the downloader has parsed a segment, the raw file is useless to it. `rename` it into the sole ownership of a child process that feeds audio slowly, and let the downloader move on immediately:

```c
static void audio_feed_async(const char *path)
{
    if (g_afifo < 0) return;
    if (g_aud_pump > 0) {                 /* non-blocking reap; skip if still busy */
        int st = 0;
        if (waitpid(g_aud_pump, &st, WNOHANG) == 0) return;
        g_aud_pump = -1;
    }
    snprintf(sp, sizeof sp, "%s.aud", path);
    rename(path, sp);                     /* downloader is done with it */
    pid_t p = fork();
    if (p == 0) { signal(SIGPIPE, SIG_IGN); audio_feed(sp); unlink(sp); _exit(0); }
    if (p > 0) g_aud_pump = p;
}
```

Three details you cannot skip:

1. **Reap with `waitpid(WNOHANG)`, never probe liveness with `kill(pid,0)`.** A zombie still answers `kill(pid,0)` with 0, so the pump would look permanently busy and audio would stop feeding after the very first segment.
2. **You must `rename`, not fork-and-read the original path.** With a 2-slot rotation, the next download overwrites that path while the child is still reading — you get a half segment.
3. Skip the current segment if the previous pump is still running — **video first**. An audio gap is acceptable; starving the decoder is not.

Measured (same source, same 95s, same binary; `NETTV_AUDIO_ASYNC` is the only variable):

| Config | Gap | Audio | Pick | Steady fps |
|---|---|---|---|---|
| Stock | 10309ms | 5231ms | 4983ms | 15.2 |
| `AF_RETRY=1` | 8100ms | — | — | 19.0 |
| Audio chain removed | 8100ms | 0 | — | 19.0 |
| **Async audio pump** | **8228ms** | **1ms** | 5104ms | **19.8** |

The 5.2 seconds of audio vanished (5231ms → 1ms): **15.2 → 19.8fps, +30%.**

## 4. Who owns the remaining 8.2 seconds

After the pump, the bill reorders to **pick 5.1s + download 2.9s = 8.2s**, against 5.96s of content.

- The 2.9s download is a hard cost (2.6MB at roughly 900KB/s) and it already runs as an async prefetch overlapping other work.
- **The 5.1s pick is pure waste** and is now target number one. `pick_seg()` → `hls_pick()` fetches the playlist; if no new segment appeared it `sleep(1)`s and retries, up to 4 times — 4 fetches plus 3 sleeps lands right around 5 seconds. Yet not a single "no new segment" line was logged, meaning the final attempt succeeded, i.e. **we burn roughly three pointless waits every round**.

Why wait for a new segment when we are clearly behind the live edge? That is the next question: either the playlist's sliding window is narrower than assumed, or the `g_last_seg` comparison breaks somewhere (query strings, post-redirect URL changes). Next step is to instrument `hls_pick()`'s retry count and per-fetch latency separately.

## 5. Lessons

1. **Never use wall-clock as content duration.** The previous wrong conclusion survived a full round purely because "segment gap" sounds like a property of the segment. Whenever you see "X seconds", ask: seconds of content, or seconds we burned?
2. **Knobs have ceilings; structure does not.** `AF_RETRY` 300 → 1 recovered only 2.2s, because the 5.2s body is drain time, not retries. Moving the work out of the loop recovered all of it.
3. **Run the A/B in both directions.** `AF_RETRY=1` alone would have "proved" audio backpressure was the culprit; adding the audio-chain-removed arm showed both land at 8.1s, meaning the knob was cutting something else.
4. **A forensics tool must be self-verifying.** `nalcount` reports two frame rates (span-based and delta-based); only when they agree did I trust them enough to overturn the previous round.

---

Part 27. Current state: source is a genuine 25fps, pipeline holds 19.8fps after the async audio pump, and the top bottleneck has moved to the 5.1 seconds inside `pick_seg()`.
