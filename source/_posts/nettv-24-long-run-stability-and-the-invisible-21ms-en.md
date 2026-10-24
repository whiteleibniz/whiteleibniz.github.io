---
title: "Spreadtrum SC9832A Network TV Deep Dive (24): 6 Minutes of Continuous Playback Without Crashes or Leaks, and sysfs Lying to Me That 'There Is Only 1 Core'"
date: 2026-10-23 02:00:00
tags:
  - VSP
  - Hardware Decoding
  - Stability
  - ION
  - CPU Hotplug
  - rb_take
  - Frame Rate
  - Spreadtrum
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Debugging Methods, Performance Profiling]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/23/nettv-24-long-run-stability-and-the-invisible-21ms/) · [繁體中文](https://whiteleibniz.github.io/2026/10/23/nettv-24-long-run-stability-and-the-invisible-21ms-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/23/nettv-24-long-run-stability-and-the-invisible-21ms-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The previous twenty-odd parts have basically been wrestling with "crashes" and "frame rate", and **the vast majority of conclusions were only run for 60 seconds**. 60 seconds can prove "it outputs frames"; it cannot prove "you can keep watching". This time I stretched the window to 6 minutes and measured a batch of things never measured before: whether ION leaks slowly, whether the frame rate decays over time, whether it gets hot, and an unexpected reversal — **how many cores on this machine are actually doing work**.

## 1. Conclusions First

| Metric | Result |
|---|---|
| Continuous playback duration | 386 s (SIGTERM for a clean finish, not a crash) |
| Callback count / real frame count | 11700 / 5571 |
| Steady-state frame rate | **14.4 fps** (`fps_x10` stayed 143~150 throughout, no decay) |
| SIGSEGV | 0 |
| ION clients | constant 3 during playback, back to 0 after exit (**no leak**) |
| Temperature / clock frequency | 27.7 ℃ / 1.3 GHz (**no thermal throttling**) |
| Desktop / framebuffer | desktop survived; fb returned to normal after the finish |

**Long-run stability currently passes.** The remaining real question is: why is the long-run steady state only 14.4fps, when the single-segment 60s test of 10-22 was 21.8fps.

## 2. The Reversal: sysfs's online File Is Lying

The root cause I found on 10-22 for "case 2 (the fork render pipeline) loses" was "only 2 CPUs online". This recheck reads something even more extreme:

```
/sys/devices/system/cpu/online  = [0]
/sys/devices/system/cpu/offline = [1-3]
/proc/cpuinfo 里 processor 只列了 1 个
```

By this reading, the machine is **single-core**. But I casually wrote a fixed-workload parallel benchmark (150 million integer multiply-adds per process, self-timed with `CLOCK_MONOTONIC`), and the results completely disagree:

| Concurrency | Per-lane elapsed time |
|---|---|
| 1 lane | 2080 ms |
| 2 lanes | 2080 / 2080 ms |
| 3 lanes | 2080 / 2087 / 2110 ms |
| 4 lanes | 2085 / 2095 / 2098 / 2135 ms |

**Four lanes running simultaneously, each taking about the same time as a single lane** — a textbook-grade "true multi-core" curve. On a single core, four-way parallelism should take about 8 seconds each. And after the benchmark finished, reading `online` again, the value had become `[0-3]`.

So:

- **sysfs's `online`/`offline` and `/proc/cpuinfo` are both untrustworthy on this machine**; they are hotplug bookkeeping, not equivalent to "whether a core is running".
- The reliable way to judge core count is **throughput back-calculation**, not reading files.
- This also overturns the 10-22 verdict: **case 2 did not lose because of insufficient cores**; that -20% needs a new explanation (most likely 3MB frames shuttling back and forth in cross-process shared memory + handshake granularity).

I also casually tried hotplug writes: `echo 1 > cpu1/online` returns failure, but the state does move — this kernel's hotplug sysfs behavior is very strange, **don't use it as an experimental variable**.

## 3. New Ledger: of the 62.6ms, 21.6ms Is in No Timer at All

The perf line in the long-run steady state looks like this:

```
[perf] AU#5400 均值: 墙钟=62.6 段循环=14.1 (bsOnMsg=14.1 睡眠=0.0[refill=0.0 aux=0.0] 9c等=0.0)
                     snap=0.0 读帧=2.5 渲染=23.8 (ms) pan=0
```

Summing the profiled items: 14.1 + 2.5 + 23.8 = **40.4ms**. Wall clock 62.6ms, **a 21.6ms difference nobody claims**. Compare with the single-file mode (10-22): wall clock 41.5ms ≈ profiled sum 41.3ms, not a single millisecond off.

The discrepancy only appears in the "download-while-playing" live mode, and the direction is clear: **stuck waiting for data**. Look at `rb_take`:

```c
static const unsigned char *rb_take(unsigned *len, unsigned char *flags, int *eof)
{
    for (;;) {
        unsigned w = g_rb->wpos, r = g_rb->rpos;
        if (r != w) { /* take one NAL */ return ...; }
        if (g_rb->dl_done) { *eof = 1; return 0; }
        usleep(2000);          /* ★ ring buffer empty: 2ms-granularity busy wait, counted in no timer */
    }
}
```

Whenever the ring buffer empties it polls with a 2ms sleep, and this wait **does not land in any of `g_t_slp`/`g_t_read`/`g_t_ren`**, so it becomes the "21.6ms appearing out of nowhere in the wall clock". It eats up more than a third of the whole frame time.

This also explains where the 14.4fps steady state comes from: the supply side (download + demux + ring write) cannot keep up with the consumption side, and the consumer spends a third of its time idling, waiting for rice to be served. **Optimizing that 23.8ms of rendering any further is no longer worth the effort** — first let the rice be served.

## 4. Three Things That Can Be Done Immediately (by Cost-Effectiveness)

1. **Add timing to `rb_take`'s busy wait** (new `g_t_wait`, under 10 lines). The 21.6ms is currently "inferred"; it must become "measured", otherwise every subsequent optimization is guesswork.
2. **Quantify the dl side's data-supply capability**: the average time for a single `curl` fetch, how long the segment gaps are, the rb depth curve. If the segment gaps are the bulk, make "prefetch the next segment" the default (the dual-slot prefetch logic exists, but its effect on a real CDN has not been verified).
3. **Reduce the granularity of `usleep(2000)`** (200~500us, or switch to futex/condition variables). A 2ms granularity means an average of 1ms wasted per sleep; ten idle spins in a frame is 10ms.

## 5. Methodology Takeaways

- **"Stable" must be tested separately**: a 60-second A/B and 6 minutes of continuous playback are two different things. Without stretching the window this time, we would not have seen the "wall clock 55ms → 63ms" climb, nor the good news of ION holding steady at 3.
- **Profiled items not adding up to the wall clock is itself the biggest clue**. When the books don't balance, first look for the "untimed paths" (blocking reads, polling sleeps, implicit synchronization); don't rush to suspect the hardware.
- **Don't treat sysfs/`/proc` bookkeeping values as hardware facts**. Back-calculate where possible: fixed workload + different concurrency levels, and look at the elbow in the elapsed time.
- The finish continues to use SIGTERM + `usleep(800ms)` to drain DMA; SIGKILL was never touched throughout, and the device was rebooted zero times.

## 6. Next Steps

First add the `g_t_wait` timing and rebuild a version to pin down the 21.6ms; then see whether it really is the bulk — if so, the main battlefield for raising the frame rate shifts from "rendering" to "data supply", with a target of 14.4 → above 20fps.

---

**Related reading**: [(23) clone without TLS: three "thread must crash" cases, one root cause](nettv-23-clone-tls-alias-fork-render-pipeline.md)
