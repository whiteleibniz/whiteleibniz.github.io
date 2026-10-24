---
title: "netTV Hardware Decoding Deep Dive (14): The 17fps Baseline and a dup2 Misjudgment — Judging Whether Frames Are Coming Out Can't Rely on the Main Log Alone"
date: 2026-10-20 14:45:00
categories:
  - Embedded
  - netTV Hardware Decoding
  - Performance Optimization
tags:
  - SC9832A
  - VSP
  - HLS
  - H.264 Hardware Decoding
  - framebuffer
  - Performance Profiling
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment-en/)

> Part 14 of the series. The previous part (13) identified the "O_SYNC logging" as the invisible frame-rate killer and turned it off by default.
> This part answers: with it off, how many frames do we actually get? The answer is **17fps** — and how `dup2`
> misled me into almost judging "running fine" as "0 frames".

## 1. First, Settling a Loose End from the Previous Part

The previous part ended with the A/B experiment blocked by the user's desktop playback occupying the ION pool; the rerun finally produced real data.
But the very first rerun hit something bizarre: both group A and group B logs were only **271~291 bytes, 6 lines**,
with frame count 0, heartbeat 0, and perf summary 0 — identical to the last time the "pool was occupied".

But this time the ION pool was empty (my instance ran `earlyion g_nout=1`, and `out[0]` obtained a real 3.2MB physical address).
So we did a single-variable reproduction: **add only `NETTV_VLOG=1`** (enable verbose logging, change nothing else) —
48 frames in 12 seconds, everything normal.

In other words: **VLOG=0, no frames; VLOG=1, frames.** How could a single environment variable control whether frames come out?
Tracing every reference to `vlog_on()` in the source, we caught the culprit at line 193:

```c
static void child_log_bound(void) {
    if (vlog_on()) return;   /* debug mode: keep the caller's redirection */
    int f = open("/tmp/nettv_child.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    dup2(f, 1); dup2(f, 2);  /* ← the child's stdout is swapped to a file */
    if (f > 2) close(f);
}
```

This is the "cap disk usage" design added on 10-16: in non-debug mode, the child process's stdout is redirected to
`/tmp/nettv_child.log`, preventing the library's per-frame prints from bloating `/tmp/lvgl_demo.log` to 131MB.
**After the redirection, the frame stats `[STAT]`, the per-200-AU perf summary `[perf]`, and the frame-on-screen markers
all go into `nettv_child.log`** — while the main log is left with only the startup banner lines.

> Groups A and B were producing frames normally all along. A 271-byte main log ≠ 0 frames.
> When I saw `FilledDone decoded frame` appear in `nettv_child.log`, I still judged it to be "output from the user session".

**Lesson (now a project iron rule)**: to judge "is the player producing frames, and at what frame rate", you must
`grep /tmp/nettv_child.log` (`FilledDone` / `on-screen` / `[STAT]` / `[perf]`);
never look at the main log. For any process whose stdout has been through `dup2`, the main log's line count tells you nothing.
Also note that at source line 191, `kdiag_on()` is implemented as `g_kdiag || vlog_on()` —
**setting `NETTV_VLOG=1` turns on all kdiag diagnostics as a side effect**; watch for this coupling when debugging.

## 2. The Real Baseline After Diagnostics-Off by Default

Rerun with the corrected criterion (Luxian 1080p source, completely fresh default environment, 60 seconds):

- **825 frames / 48.4 seconds, `[STAT] fps_x10=170`, i.e. 17fps**
- vs the previous part's v15 (diagnostics all on) at 13.2fps: **+29%** — the diagnostics-off-by-default fix is confirmed effective, no regression

`[perf]` per-AU breakdown (wall-clock mean 112ms):

| Segment | Time | Content |
|---|---|---|
| segment loop / DRIVE | **32.4ms** | hardware decode 14ms (vendor self-report) + ~18ms library-side (phys ioctl address lookup, bind/unbind, double FilledDone) |
| snap_state | 0ms | kdiag gating in effect ✓ |
| frame readback | **45.5ms** | 3MB memcpy to cached staging ~20ms + content signature scan ~25ms |
| fb_render | **30.5ms** | CPU single-pass geometric composition (scale + rotate + NV12→ARGB), sampled mean 34ms |
| rest | ~3.6ms | tail fill(out) requeue, etc. |

## 3. The Math: Is 25fps Within Budget

25fps requires ≤40ms/AU; we're at 112ms. Cut segment by segment:

1. **Cut / down-rate the signature scan** (frame readback 45.5→~22ms): the signature exists to dedupe "unchanged picture, don't re-render",
   but the vendor's `FilledDone` callback fires every frame (the heartbeat is built on it), so dedupe can switch to callback counting entirely —
   no need for the CPU to scan 8K sample points; for the Y-nonzero emptiness check, keep only the first few frames.
2. **NEON-ize fb_render** (30.5→~10ms): geometric composition is regular fixed-point arithmetic,
   and ARMv7 NEON has mature idioms.
3. **Cache the DRIVE library side** (32.4→~24ms): phys ioctl re-queries fd→PA every AU;
   caching by fd saves half.
4. All three cuts applied: 24 + 22 + 10 = **56ms ≈ 18fps — still not enough.**

**Conclusion: cutting alone cannot reach 25fps; the only way is pipelining.** Today the worker is purely serial:
during the 32ms of decoding the CPU waits; during the 30ms of rendering the VSP idles. Just move "frame readback + render" into
the **parallel window** while the next frame decodes (Android's BufferQueue model), and the single-AU wall clock approaches
`max(decode, render) ≈ 35ms`, **about 28fps**.

The pipeline's hard constraint is the old one: **double buffering needs 2×3.1MB output + mbinfo 653KB + 256KB input
≈ 7.1MB, while the CMA pool is nominally only ~7MB**. Either grow the pool first (kernel cmdline),
or bet the pool is actually looser than nominal (the vendor init grabs the C1 pool, not necessarily all inside CMA).
That's also the first thing the next part will experiment on.

## 4. Next Steps (Single-Variable Order)

1. Down-rate the signature scan (frame readback 45.5→~22ms; the safest cut, do it first)
2. NEON geometric composition in fb_render (30.5→~10ms)
3. Double-buffered pipeline (squeeze 2 channels out of the CMA pool) — decides whether 25fps+ is reachable
4. fd→PA cache inside DRIVE
5. Farther out: recon the display driver's overlay capability — NV12 sent straight to the display layer + hardware rotation,
   eliminating the entire CPU composition (benchmark against Android's HWComposer)

---

*The articles and experiment scripts in this series are maintained alongside the project; they represent only a personal record of embedded learning and debugging.*
*This article is an original technical summary. Please credit the source when reposting; commercial use is prohibited.*
