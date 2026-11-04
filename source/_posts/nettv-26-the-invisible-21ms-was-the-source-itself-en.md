---
title: "netTV Hardware Decoding Deep Dive (26): The 21.6ms Mystery — When the Bottleneck Was the Source Itself"
date: 2026-10-24 11:40:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP Hardware Decoding
  - HLS Live Streaming
  - Performance Profiling
categories:
  - [Project Practice, netTV Hardware Decoding]
  - [Embedded, Spreadtrum Platform]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/24/nettv-26-the-invisible-21ms-was-the-source-itself/) · [繁體中文](https://whiteleibniz.github.io/2026/10/24/nettv-26-the-invisible-21ms-was-the-source-itself-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/24/nettv-26-the-invisible-21ms-was-the-source-itself-en/)


> Part 26 of the series. The previous part instrumented the supply side; this one takes it on-device and balances the books — and the conclusion rewrites the project's entire optimization direction.

## 1. Background: An Account That Wouldn't Balance

The 10-23 long-run stability test left an unexplained gap: on the Luxian 1080p live stream, the wall-clock period per AU was 62.6ms, but every instrumented component added up to only 40.4ms (segment loop 14.1 + frame readback 2.5 + render 23.8), leaving **21.6ms unaccounted for**. Switching the same source to single-segment file mode, wall clock 41.5ms ≈ instrumented sum 41.3 — zero residual.

The gap only appeared in "download-while-playing" mode, and the prime suspect was `rb_take()` spinning while waiting for supply — but a suspect is not a conviction.

On 10-24 we did one thing: **turned the unknown into an explicit printed value**. On the worker side we added four timing buckets: `g_t_take` (rb_take supply wait) / `g_t_pre` / `g_t_cool` / `g_t_pace`, plus a "residual = wall clock − sum of buckets" field on the [perf] line. On the dl side, every segment now prints one line: "[supply] download/enqueue/segment gap/rb depth/backpressure".

## 2. On-Device Result: Books Balanced, the Suspect Exonerated

150s of continuous playback, 0 crashes, clean exit. AU#400 average:

```
wall=58.1 = segment loop 13.9 (bsOnMsg 14.0)
          + frame readback 2.5
          + render 23.2
          + take NAL 17.6    ← there it is
          + prep 0.3
          + residual 0.5     ← down from 21.6ms to 0.5ms
```

**The residual method worked: the 21.6ms mystery = rb_take supply wait 17.6ms + change.** Instrumentation goal achieved; case closed.

But before closing the case we glanced at two more numbers — and they flipped the entire optimization direction.

## 3. Two Numbers That Flipped the Conclusion

### Number 1: The fps Curve Is Not a Flat Line

```
start: fps_x10 = 208 → 226    (20.8~22.6fps)
steady: fps_x10 = 142         (14.2fps)
```

Same stream, same code — 22fps at the start, 14fps at steady state. If the bottleneck were us, the curve would be flat; **only "supply dictates consumption" produces this shape** — the start eats the backlog, and once it's gone, you're in the source's real-time rhythm.

### Number 2: The NAL Histogram Is Cumulative

The dl side already had a diagnostic histogram (counting NAL types per segment), but `hist[]` is a `static` array — **what it prints is cumulative, not per-segment delta**. After differencing between segments:

| Segment | slice delta | IDR delta | SPS/PPS | Total frames/segment |
|---|---|---|---|---|
| 9→10 | 145 | 5 | 5+5 | **155** |
| 13→14 | 145 | 5 | 5+5 | **155** |

Segment gap 10.6s. **155 frames ÷ 10.6s = 14.6fps — the Luxian source's true frame rate is only 14.6fps.**

The [STAT] line's definition confirms it: `frames=4275 real=2035 elapsed=142918ms` — frames is the OMX callback count (29.9fps, including vendor filled=0 empty events); real is the true frame count (14.2fps).

## 4. So All the Books Get Rearranged

| Item | Value | Meaning |
|---|---|---|
| Source frame rate | 14.6fps | 155 frames / 10.6s segment |
| Pipeline throughput ceiling | **22.5~24fps** | measured during burst (41.5ms/AU, no supply wait) |
| Steady-state fps | 14.2fps | **= source frame rate, pinned by the source** |
| take-NAL wait | 17.6ms/AU | supply throttling, not waste |

**The pipeline has 60% more throughput than the source needs.** The "push frame rate to 25fps" goal we chased all along is physically unreachable for a 14fps source — like interpolating a 25fps movie to 60fps: those 35 frames simply don't exist in the source.

The 10-23 A/B data now reads consistently too: 60s short test 21.8fps (the startup-backlog window, with 3-5 segments queued in the playlist), 386s long run 14.4fps (backlog exhausted, in the source's real-time rhythm). **High short-test frame rates were always an illusion.**

## 5. What Is the 10.6s Segment Gap

Per-segment cycle on the dl side: download 235ms → enqueue 3ms → `audio_feed` blocks ~10.6s (fifo backpressure = segment audio duration, the metronome of A/V sync) → next segment.

The segment gap *is* the `audio_feed` block — the deliberate design of the 10-17 A/V sync refactor: **dl is locked to the real-time rhythm by the audio clock, pacing video progress onto the audio timeline**. The benefit: audio and video never drift apart. The cost: dl only ever stays one segment ahead, with no hoarding ability.

So "prefetch the next segment" is killed outright: prefetching = video running ahead of audio = A/V sync collapse. The ~164 NAL ≈ 9.5s steady-state backlog in rb is a designed jitter cushion, not a defect.

## 6. Direction Rewrite

The old top to-do was "frame-rate battleground = supply". It now becomes:

1. **Verify the pipeline with a high-frame-rate source**: find a 25/30fps source among the 12 tested channels, and check on-device whether the fps curve sits at 22fps+ without startup decay — that's the pipeline's real report card
2. If no high-frame-rate source exists, loop local multi-GOP samples (h1.ts/np1.ts) to measure the pipeline ceiling directly
3. Keep instrumentation (v18) as a standard A/B tool, md5 `c15e558f`, committed as `f3bd837`
4. Redirect remaining effort to the real product problems: ghosting, channel switching, A/V sync details, black-screen root fix

## 7. Methodology Takeaways (Worth More Than the Conclusion)

1. **The residual method**: time everything you can time, and print the rest as an explicit "residual" — the unknown becomes observable, which is how we caught 21.6ms
2. **The cumulative-value trap**: a diagnostic histogram using a static array outputs cumulative values by definition. This time we almost mistook "2030 frames per segment" for truth (actually 14 segments' accumulation) — the absurd 191fps it computed is what exposed it. **Any static cumulative must output deltas**
3. **Short test vs long run**: in a buffered system, short-test report cards are fake. 60s measured 21.8fps; 386s dropped to 14.4fps — the difference is entirely the startup backlog
4. **Callback count ≠ frame count**: the vendor appends a filled=0 empty event to every real frame; OMX callback rate 29.9fps vs true frames 14.2fps — a 2x gap. Frame judgment must use `[STAT] real=`

## 8. Current Status

- Steady-state playback: 14.2fps (= source frame rate), 0 crashes, no ION leak, 9.5s buffer
- Pipeline throughput: 22.5~24fps (bounded by the 23.2ms render; no cheap variables left)
- Code: `f3bd837` committed (not pushed, awaiting authorization)
- Next: find a high-frame-rate source and get the pipeline's real report card

---

*Part 26 of the "netTV Hardware Decoding Deep Dive" series. All data measured on real Spreadtrum SC9832A hardware.*
