---
title: "netTV Hardware Decoding (38): A Reachable Stream Is Not a Playable One — Adding a Bitrate Headroom Criterion to Source Selection"
date: 2026-11-07 02:40:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - HLS
  - Live Streaming
  - Measurement
  - Experiment Design
categories:
  - [Project Notes, netTV Hardware Decoding]
  - [Embedded, Spreadtrum Platform]
  - [Engineering Practice, Measurement and Experiment Design]
copyright: "Original work by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduction must credit the source - whiteleibniz.github.io"
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/11/07/nettv-38-source-bitrate-budget/) · [繁體中文](https://whiteleibniz.github.io/2026/11/07/zh-tw/nettv-38-source-bitrate-budget-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/07/nettv-38-source-bitrate-budget-en/)

> Part 38 of the series. The device was still unpowered this round (the tenth in a row), so once again only offline work was possible. This time I went back and questioned something that had been treated as a given from day one: **can the device actually keep up with the stream we selected?** The answer is uncomfortable — the source currently in production runs at 1.4× the device's bandwidth, and the "smooth playback" we thought we had is really just the player skipping ahead to the newest segment.

## 1. A premise that was never measured

From day one, source selection used two criteria: the m3u8 returns 200, and the first segment returns 200/206. Pass both, call the source "usable", write it into the channel list.

The criteria are not wrong, but they only answer "is this source alive", never "can the device keep up". The device has a hard ceiling: earlier rounds measured roughly 300 KB/s of download throughput, about 2400 kbps. **Any live stream above that line can never reach the live edge** — the player can only discard expired segments and jump to the newest one.

The symptoms are exactly the ones we kept complaining about: about six seconds to first frame, random stalls, slow channel switching. I had been attributing all of that to decoding, rendering and buffering policy, and had never accounted for bitrate.

## 2. How to measure: three numbers are enough

No special tooling needed:

1. Segment size in bytes (download one full segment)
2. Segment duration (the `#EXTINF` in the playlist)
3. Measured throughput (time the same download)

So **bitrate = segment bytes × 8 ÷ segment duration**, and **headroom = device bandwidth ÷ bitrate**. Below 1.3 headroom, the stream cannot be sustained on average and the player survives only by skipping.

I ran all twelve candidate sources through this (the script is in the repo, one command to re-run). Sorted by headroom, the picture changes completely:

| Source (by region / channel) | Segment | Duration | Bitrate | Headroom | Verdict |
|---|---|---|---|---|---|
| A cartoon channel | 2977 kB | 2.0 s | 11908 kbps | 0.20 | Far over |
| An international channel (Spanish) | 3069 kB | 6.0 s | 4092 kbps | 0.59 | Over |
| Luxian news | 2563 kB | 6.0 s | 3423 kbps | 0.70 | Over |
| Shangyu culture/cinema | 3390 kB | 8.0 s | 3390 kbps | 0.71 | Over |
| **Songpan news (in production)** | 4499 kB | 10.8 s | **3333 kbps** | **0.72** | Over |
| Hebei kids/science | 1054 kB | 3.1 s | 2702 kbps | 0.89 | Marginal |
| Qianjiang city | 1807 kB | 8.0 s | 1807 kbps | 1.33 | Just above |
| Zhejiang Intl 720p | 813 kB | 8.0 s | 813 kbps | 2.95 | Comfortable |
| Zhejiang Intl 360p | 520 kB | 8.0 s | 520 kbps | 4.62 | Safest |

Two sources were completely unreachable (two channels on the same server, both down) — 2 out of 12.

## 3. The table overturns three things

**First, the production source is over budget.** Headroom 0.72 means ten seconds of stream needs 13.9 seconds to download. There is a picture at all only because the player drops segments. So every earlier "13–20 fps" number is contaminated with bandwidth starvation — it was never purely a rendering problem.

**Second, the crash experiment must not switch sources.** The tempting move this round was: we have a source at one quarter the bitrate, switch immediately. No. What we need to reproduce is "the second IDR crashes deterministically" and "a crash roughly every 150 seconds". Switching sources also changes NAL counts, TS sizes and segment cadence — it may well switch away the very phenomenon we are chasing. **Use the reproducible source to study crashes, and a sustainable source to study smoothness. Two sources, two purposes.**

**Third, every smoothness conclusion is now void.** As long as we run a 3333 kbps source, "raise the frame rate to 25 fps" is a false goal — the bottleneck is the download, not the decoder.

## 4. A textbook trap caught along the way

To save bandwidth, the pre-flight probe fetched only the first 2 KB of the playlist with `curl -r 0-2047`. It reported three of four sources dead.

The reality: with a Range request the server replies **206 Partial Content**, not 200. The check only accepted 200, so three live sources were declared dead. One-line fix (normalize 206 to 200).

This matters more than it looks: **a probe can itself become the fault, and specifically a false negative** — it does not raise an error, it quietly tells you "the source is gone", and off you go replacing sources, blaming the CDN, blaming the player. The first thing to do with any health check you write is to run it against something you know is good — not against the world.

## 5. So it became a gate

Ten consecutive offline rounds forced a re-evaluation: the online window is the most expensive resource in this project — a 50-minute experiment per round, and a leaked SSH session means physically power-cycling the device. Meanwhile the two known landmines — a lost default route and a dead source — both produce four arms of zero frames, ending in a single INVALID.

So all of the above became a pre-flight gate, in four steps:

1. Check the default route; if missing, restore it with `route add default gw`.
2. Probe each source in a bitrate-annotated table; only `200 with #EXTM3U` counts as alive.
3. On failure of the primary, fall back automatically and record "source switched" explicitly — the switch must reach the conclusion, otherwise two rounds cannot be compared.
4. All dead or no route: write INVALID and stop. **Not a single arm starts.**

The verdict logic itself was not touched. Last round's "verdict validity gate" was right; this round merely moved the gate earlier: **first prove the experiment can run, then prove its result is believable.**

## 6. One sentence worth taking away

The value of an automation script is not how clever it is, but its willingness to admit, at the very start, that today's job cannot be done. What it saves is fifty minutes; what it buys is one real experiment.
