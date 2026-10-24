---
title: "netTV Hardware Decoding Deep Dive (7): Squeezing 250ms-Per-Frame Rendering Down to 20ms — Killing Three Full-Resolution Passes with Geometric Composition"
date: 2026-10-17 02:00:00
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Performance Optimization, Image Processing]
tags: [VSP, Hardware Decoding, framebuffer, NV12, Rotation, Performance Optimization, Spreadtrum]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/17/nettv-07-fb-render-single-pass/) · [繁體中文](https://whiteleibniz.github.io/2026/10/17/nettv-07-fb-render-single-pass-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/17/nettv-07-fb-render-single-pass-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The earlier parts filled in the potholes of VSP hardware decoding, mbinfo fake physical addresses, and GOP replay — the picture comes out, but **only at 4fps**. One sampler run showed 100% CPU burned inside `fb_render` — either a vendor-library deadlock or our own NV12→ARGB + 90° rotation + scaling. This part documents how I took it from 250ms/frame down to 19-21ms/frame.

## 1. What the Old Renderer Looked Like

VSP decode output is NV12 1920x1088; the screen is a 720x1280 portrait panel, so each frame needs three things: NV12→ARGB conversion, 90° rotation, and scaling to 720x1280. The old implementation was a proper three-pass affair:

```c
/* pass1: full-resolution NV12 → ARGB */
for (iy = 0; iy < 1080; iy++)
    for (ix = 0; ix < 1920; ix += 2) {
        uu = Cl[ix] - 128; vv = Cl[ix+1] - 128;
        dr[ix]   = yuv2px(Yl[ix],   uu, vv);
        dr[ix+1] = yuv2px(Yl[ix+1], uu, vv);
    }
/* pass2a: 16x16 block transpose + vertical flip → g_targb */
/* pass2b: targb 1080x1920 → fb 720x1280 (NN 3/2 sampling) */
```

The two intermediate buffers `g_argb` / `g_targb` are 8.3MB each; together they eat roughly 25MB of memory traffic per frame (2.07M pixels × 4B × several read-modify-write rounds). On a Cortex-A7 that is 250ms.

## 2. The Key Insight: The Full-Resolution Middle Layer Is Pure Waste

One glance at the output size and it clicked: **only 720×1280 = 921,600 pixels are needed in the end, yet the middle layer computed a full 1920×1080 = 2,073,600 pixels**. In other words, 56% of the pixels so painstakingly computed would never be sampled — thrown away directly.

So why not compute only "the 44% that will actually be used"?

Compose the three geometric transforms (transpose + vertical flip + 3/2 nearest-neighbor sampling) into one, and you get a direct mapping:

```
fb[oy][ox] = src_argb[1079 - ox*3/2][oy*3/2]
```

Derivation: `targb[tx][ty] = argb[1079-ty][tx]`, and `fb[oy][ox] = targb[oy*3/2][ox*3/2]`; substitute and out it comes. **Mind you don't swap the row/column roles** — my first version had them backwards: the whole picture transposed, with an extra blank strip at the bottom, only caught by frame-grab comparison (details below).

There is also an unavoidable tension: **in a transpose problem, "write in output-row order" and "read in source-row order" can never hold at the same time**. Writing in output-row order forces column reads from the source (stride 1920 bytes, one cache line per pixel); reading in source-row order forces column writes to the output. The fix is tiling: split the output into 16-row bands, compute into a `band[16][720]` staging buffer, then memcpy whole rows into the framebuffer:

```c
static unsigned band[16][720];
for (int oy0 = 0; oy0 < 1280; oy0 += 16) {
    int c0 = oy0*3/2;
    for (int i = 0; i < 720; i++) {          /* ox = i, source row fixed */
        int r = 1079 - i*3/2;
        const unsigned char *Yl = Y + (size_t)r*1920;
        const unsigned char *Cl = C + (size_t)(r>>1)*1920;
        for (int j = 0; j < 16; j++) {       /* oy = oy0+j, contiguous source-column window */
            int c  = c0 + j*3/2;
            int cb = c & ~1;                 /* NV12 interleave: u in even columns, v right after */
            int uu = Cl[cb] - 128, vv = Cl[cb+1] - 128;
            band[j][i] = yuv2px(Yl[c], uu, vv);
        }
    }
    for (int j = 0; j < 16; j++)
        memcpy(dst + (size_t)(oy0+j)*720, band[j], 720*4);
}
```

Now each source line touches only 1~2 cache lines on the read side (24-byte window), and each output line is a single 2880-byte contiguous burst on the write side — both sides happy.

Three details worth recording:

- **UV must be sampled at even columns.** `c` can be odd (3/2 sampling yields column indices 0,1,3,4,6...); in NV12, u/v are stored interleaved in pairs, so align to even columns with `cb = c & ~1`, then take `Cl[cb]` and `Cl[cb+1]`. Get it wrong and half the picture shifts color.
- **Access locality.** Output rows are written sequentially; the input Y row index `r` advances only 1~2 rows per row with sequential column reads — cache friendly. Far healthier than the "transpose the whole frame" approach that jumps 4.3KB to write 4 bytes.

While at it, delete both 8.3MB intermediate buffers too, saving 16.6MB of memory — no small number on a device with only a few hundred MB.

## 3. Quantified: From 4fps to 12fps

The player has a `bench` self-test entry (30 renders, timed individually); the first version (wrong geometry, no transpose tension) ran 19-21ms/frame. After fixing the geometry and adding banded staging, the end-to-end measurement was **25 frames / 2057ms = 12.1fps** — 3x the old 4fps. Along the way I also stepped into an invisible pit:

**The real reason "no video visible" was not the renderer — it was page flipping.** The player kept writing the picture into page 1/2 of the framebuffer (double buffering), but `fb_pan()` contained a single `return; /* no-pan experiment */` — FBIOPAN was never actually issued, and the screen stayed frozen on page 0 used by the LVGL desktop. In other words: **decoding, rendering, and writing to the screen were all working; only the last step — "switch the visible window over" — was missing**, so the user saw a stone-still desktop. The fix uses the safe posture (a hard-won decision after the earlier kernel crash): trust only the real struct returned by `FBIOGET_VSCREENINFO`, validate `yres_virtual >= 3840`, change `yoffset`, then `ioctl(FBIOPAN_DISPLAY)`. Along the way, add `fb_sys_home()` to the monitor process — when a child is SIGKILLed it has no time to pan back to page 0 itself, the screen freezes on the last frame, so the monitor must switch the picture back.

The lesson is plain: **after changing a geometric mapping, grab a framebuffer frame and bit-compare it against a verified reference frame before talking about shipping.** I had trusted the bench timings because they looked good, but the direction was wrong — good performance and a correct picture are two different things.

## 4. A Near-Miss: Did the Speedup Detonate the Vendor Library Crash?

There was an interlude. Right after switching to the new renderer on a live source: 91 SIGSEGVs in 20 seconds, 124 monitor restarts. Reading the scene logs, the crash came right after the vendor library `libstagefright_sprd_h264dec.so` finished processing a frame — indistinguishable from the earlier confirmed "OMX input queue use-after-free".

First instinct: **the renderer got 12x faster → the bitstream is fed faster → the vendor library's race/UAF was forced out**. It sounded perfectly plausible, and I almost wrote it into the conclusion.

But a single observation proves nothing. So I added an environment-variable switch `NETTV_RENDER=0` to fall back to the old three-pass path, running an A/B **with the same binary**:

| Render path | Duration | SIGSEGV | monitor restarts |
|---|---|---|---|
| Slow (three-pass) | 40s | 0 | 6 |
| Fast (single-pass) | 40s | **0** | 3 |

Not only did the fast path not crash, it restarted fewer times. **Those crashes were a state problem of the device/source at the time** (ION/CMA state after repeated kills, plus a dried-up early-morning live source), unrelated to the render path.

The lesson is plain: the first batch of anomalies after a performance optimization easily gets attributed to "the optimization changed the timing". Before concluding, run an A/B that switches only the optimization and changes nothing else — low cost, and it saves a wrong verdict.

## 5. A Few Pits Stepped Into Along the Way

1. **Under bare bionic, `_exit` does not flush stdio.** We enter main directly with `-nostdlib -Wl,--entry=main`, so the bench timings and frame-rate heartbeats never print — `_exit` just leaves, and the stdio buffers never hit the disk. Every measurement point needs an `fflush(0)` after it, otherwise "no log" gets misread as "never executed".

2. **Child-process logs get O_TRUNC-truncated when the monitor process respawns them.** The monitor respawns the child every few seconds, wiping the log each time, so the crash scene cannot be preserved. Change to appending an independent file `/tmp/nettv_segv.log` from the SIGSEGV handler, surviving restarts.

3. **GCC's block-partitioning reorder bug.** After adding some code, the compiler errored out:

   ```
   .size expression for c1_reuse.part.0 does not evaluate to a constant
   Error: junk at end of line, first unrecognized character valued 0x4
   ```

   GCC split the function into `.part.0` and then handed the assembler an illegal `.size`. Adding `-fno-reorder-blocks-and-partition` to the build script fixes it.

4. **Using `&` to start a background process inside a single SSH command is unreliable** — subsequent commands get truncated by session teardown, and even the redirect file fails to appear. Long tasks always go into a script uploaded first, then `nohup sh xxx.sh &`.

5. **The child stopping at exactly 31 frames each round is not a crash.** The frame-cap parameter defaults to 0 (unlimited); the real reason is that `load_chunk()` cleanly exits at an m3u8 segment boundary because no new segment can be fetched (the source dried up). Seeing "the same frame count every round" — don't jump to "hung".

## 6. Current State and Next Steps

Rendering is no longer the bottleneck (20ms). But the end-to-end frame rate has not gone up yet — because the source itself dries up, each round's child lives only to 31 frames, so the real fps cannot be measured. Next, use a local multi-GOP `.ts` file source to keep the decoder fully fed, eliminating source interference, then clean up what remains: the 3MB `memcpy` per round, the `usleep(20ms)` in the `slice` loop, and the signature scan.

**One-sentence summary of this class of optimization**: don't rush to NEON-ize or hand-assemble a hot function; first ask "of these pixels I compute, how many will actually be seen in the end". Often cutting out the middle layer pays an order of magnitude more than instruction-level optimization.
