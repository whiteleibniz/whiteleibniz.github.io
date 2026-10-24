---
title: "nettv-21: The 16.9fps Is Fake — the Frame-Rate Statistics Fooled Us for Three Months, and a 17x Frame-Readback Speedup (SC9832A Hardware Decoding Troubleshooting Log)"
date: 2026-10-21 11:30:00
tags:
  - sprd
  - SC9832A
  - VSP
  - ION
  - framebuffer
  - Performance Optimization
  - Statistical Definition
categories:
  - [Embedded, Network TV Hardware Decoding]
  - [Debugging, Performance Optimization]
  - [Linux, Memory Management]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-21-frame-rate-statistics-lies-ion-cached-17x/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-21-frame-rate-statistics-lies-ion-cached-17x-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-21-frame-rate-statistics-lies-ion-cached-17x-en/)

Right after the previous round finished fixing the "black screen when tapping a channel in the UI", the user dropped one line: **"Playback has improved, but it is nowhere near normal viewing standards."**

The value of that sentence is that it forced me to look back at numbers that had "already been optimized for many rounds". One check was enough to see the scale of it — **the frame rate we had been staring at for three months was wrong from start to finish.**

This part documents two things: one is the trap of statistical definitions (numbers lie), the other is a genuine performance breakthrough (a 17x frame-readback speedup), plus a scheme that got overturned (it almost crashed the device).

## 1. Look at the Numbers First: the 16.9fps Is Fake

The player has a heartbeat that prints one line every 25 frames:

```
[STAT] frames=12825 elapsed=759074ms fps_x10=168
```

759 seconds, 12825 frames, **16.9fps**. Looks perfectly normal, right? The source is a 1080p/25fps live stream; the gap is not that big.

But I went and counted the callbacks:

```sh
grep -c 'filled=3133440' /tmp/nettv_child.log   # real frames: 6776
grep -c 'filled=0 out=0'  /tmp/nettv_child.log   # empty events: 7471
```

**6776 real frames + 7471 empty events.**

After the vendor library emits one real frame, an empty event with `filled=0` always follows immediately — `drainAllOutputBuffers` recycles the same output header, `nFilledLen` is zeroed, and so `BufferFilledDone` fires once more.

And our code indiscriminately does `g_filled++` inside the `BufferFilledDone` callback:

```c
static OMX_ERRORTYPE bfd(OMX_PTR a,OMX_PTR b,OMX_BUFFERHEADERTYPE_PT h) {
    ...
    g_filled++; frame_beat(); return 0;   /* ← real frames and empty events counted together */
}
```

So **the frame count doubled out of thin air**. The real picture update rate is:

```
6776 / 759s = 8.9 fps
```

Not 16.9 — **8.9**.

That number later contaminated two other places as well:

- **Dedup logic**: `is_new = (g_filled != filled_seen)` — an empty event also counts as "a new frame has arrived", triggering a full frame readback + render (77ms), even though the picture content never changed at all.
- **perf sampling**: every average from `[perf] AU#7400` is normalized by "callback count" rather than "real frame count".

**Lesson 1: a performance counter must first answer "what is it counting?"** A counter that conflates two semantics contaminates statistics, dedup, and sampling all at once — and because the number looks plausible, nobody thinks to doubt it.

The fix is straightforward — count real frames separately:

```c
/* ★★ 2026-10-21 Real-frame detection: the vendor emits one real frame always followed
 *   by a filled=0 empty event.
 *   Measured: real frame filled=3133440/out=0, empty event filled=0/out=0 ⇒
 *   (nFilledLen||nOutputLen) non-zero means a real frame.
 *   ★ g_filled keeps its "all callbacks" semantics (the monitor liveness heartbeat shm[3] depends on it),
 *     real frames are counted separately with g_filled_real ⇒ [STAT] frame rate is no longer inflated 2x. */
if (h && (h->nFilledLen || h->nOutputLen)) g_filled_real++;
```

Note this deliberately does **not** change the semantics of `g_filled` — the monitor's liveness watchdog relies on `shm[3] = g_filled` to tell whether the vendor is still delivering callbacks, and that must keep the broad definition of "all callbacks". **When one counter carries two semantics, split it into two rather than changing the original one.**

## 2. The Real Bottleneck: 88% of the Time Is Not in Decoding

Knowing the real frame rate is 8.9fps, I needed to know where the time went. The player already had segmented timing:

```
[perf] AU#7400 均值: 墙钟=113.0 段循环=32.6 snap=0.0 读帧=44.3 渲染=33.0 (ms)
```

113ms per frame corresponds to 8.85fps — an exact match with the measured 8.9. Breaking the three segments down:

| Segment | Time | Share | What it is |
|---|---|---|---|
| segment loop | 32.6ms | 29% | feeding AUs + waiting for the vendor to drain |
| **frame readback** | **44.3ms** | **39%** | **3MB memcpy (ION → staging)** |
| render | 33.0ms | 29% | NV12 → ARGB → rotate → write fb |

The vendor's own decode time, across 828 samples, **is 14ms every single time**, rock steady.

**Put differently: VSP hardware decoding accounts for only 12%; 88% of the time is our post-processing.** The hardware is nowhere near the bottleneck; the bottleneck lies on the path of "moving the decoded frame onto the screen".

This realization matters — it means every direction of "optimize hardware decoding performance" is wrong; the direction should be "optimize data movement".

## 3. The Breakthrough: uncached Memory Is the Culprit

The 44.3ms frame-readback segment does exactly one thing:

```c
memcpy(g_stage, q, 0x2FC000);   /* 3MB, copied from ION VA to staging */
```

3MB / 44.3ms = **68MB/s**. This bandwidth is absurdly low — a normal DDR memory memcpy can exceed 1GB/s.

The cause is in the ION allocation's `flags`:

```c
ad.len = FSZ; ad.align = 0x1000; ad.mask = 8;   /* flags defaults to 0 */
```

`flags=0` means an **uncached mapping**. On an uncached mapping, every cache line read issues an independent bus transaction; hardware prefetch helps not at all. That is where 68MB/s comes from.

Change it to `flags=1` (cached), with the CPU side going through ordinary load/store:

```c
if (cached_mode()) ad.flags = 1;
```

But here there is a **mandatory accompanying DMA coherency handling**: VSP writes frames into this memory via DMA, and the CPU cache may still hold stale data from before the DMA. So before reading, you must invalidate first:

```c
/* ION_IOC_INV = _IOW('I',14,void*) = 0xc0104914 */
static void ion_inv_out(void) {
    for (int i = 0; i < g_gh_n; i++)
        if (g_ion_handle[i])
            ioctl(g_ionfd, 0xc0104914, &g_ion_handle[i]);
}
```

**Here is a pitfall, and its position is critical**: the invalidate must come **before** the staging memcpy. Because the memcpy's source is that DMA region; copying first and invalidating after is a no-op. The original code only did one invalidate, in the pipeline path's render thread, and after the memcpy — with cached enabled on the single-threaded path you read dirty data (screen corruption).

A/B measurements (same source, same length, only one variable switched):

```
frame readback=44.3ms  →  frame readback=2.6ms        (17x)
wall clock=113.0ms →  wall clock=71.4ms
real frame rate 8.45fps → 12.7fps
```

Picture quality was verified at the same time: the sparse non-zero counts of the Y plane of the first three frames were 8151/8150/8154, and the three frames' signature hashes differ from one another — indicating a genuinely changing picture, not a black screen nor screen corruption.

**Lesson 2: when a number clearly deviates from physical common sense (68MB/s), suspect the mapping attributes first, and the algorithm second.** Same memcpy; flipping one flag makes it 17x faster.

## 4. The Overturned Scheme: Switch Heaps to Dodge the Pool

After switching to cached, I hit a new problem: the vendor decoder's C1 buffer allocation started reporting OOM:

```
ioctl c0144900 failed with code -1: Out of memory
```

Worse, after failing to get C1, the vendor **falls back to using a CPU virtual address** as a physical address ("all three levels of address resolution failed → falling back to CPU VA (fake PA, risk of garbled frames!)"), and then VSP writes frames to an invalid address → SIGSEGV.

Diagnosis revealed **same-pool contention**: our output buffer is 3.2MB and must be an order-8 contiguous block; the vendor's five 638KB C1 DPB blocks also need order-8 (its `align=8`). The carveout pool has only 4 order-8 large blocks in total (8MB); once we take 1, the vendor no longer has enough.

My first reaction was: **can't we just switch pools** — change the output buffer to `mask=2` (System RAM) instead of `mask=8` (carveout_mm). The vendor's own 2MB C1 uses mask=2 already, so it looks entirely feasible.

So I changed the code, compiled, deployed, ran verification. **Then the device rebooted outright.**

No oops, no panic, `/proc/sys/kernel/watchdog` = 1, dmesg is full of `powerdown_cpus`. Only when checking physical addresses did the reason surface:

```
vendor 2MB C1 (mask=2):  real PA = 0x9f800000   ← inside the carveout window
our output (mask=8):    real PA = 0x9fa00000   ← inside the carveout window
```

**mask=2 and mask=8 land in the same carveout region** (0x9f8xxxxx), not "System RAM" at all. The real System RAM is at 0x80000000-0xbfffffff, and what mask=2 grabbed there is a high address — **beyond the address window the VSP hardware can access**; VSP writes there and flies off, and the hardware watchdog resets immediately.

**Lesson 3: the same mask name can mean something entirely different in different contexts.** I saw "the vendor succeeds with mask=2" and assumed mask=2 = System RAM = a safe alternative pool — but those two mask=2 allocations landed in completely different physical regions: one at 0x9f8xxxxx (carveout), one at 0x8xxxxxxx (real RAM). **The same parameter name does not mean the same semantics; you must look at the actual physical address.**

Fortunately this scheme was caught by testing before it could do any real hardware damage, with no worse consequences. Roll back to `mask=8`.

## 5. One More Pitfall: the cached Pool Is Empty

While checking the pool, I also found:

```
carveout_mm:  10 order 4 highmem pages in uncached pool = 655360 total
               0 order 4 highmem pages in   cached pool =       0 total
```

**The cached pool does not have a single page.** That is, a `flags=1` allocation on carveout goes to an empty pool to grab pages, and fails when it cannot get one. Left unhandled, one allocation failure will chain-OOM all of the vendor's subsequent C1 allocations.

So cached allocation must carry a fallback:

```c
if (ioctl(g_ionfd, 0xc0144900, &ad) != 0) {
    if (ad.flags) {
        ad.flags = 0;                          /* fall back to uncached */
        if (ioctl(g_ionfd, 0xc0144900, &ad) != 0) continue;
        g_cached_mode = 0;                     /* globally disable cached */
        P("  [ion] cached allocation failed, falling back to uncached\n");
    } else continue;
}
```

**Lesson 4: an optimization switch must carry its own downgrade path.** For the same switch, on/off are two states that both run, not a binary choice of "on means fast, off means slow".

## 6. Going Further: Split the Render's 30ms Too

After switching to cached, I added segmented timing to `fb_render` (conversion vs write fb):

```
[perf] fb_render 均值 32ms (换算上限 31 fps) | 转换 30ms 写fb 1ms
```

**Writing fb takes only 1ms** — writing 3.6MB into the mmap'd framebuffer costs almost nothing (memory bandwidth is ample). All 30ms is in the pure arithmetic of "NV12 → ARGB + rotate + 3/2 downsampling".

But pure arithmetic should not be this slow. Do the math: 920k pixels, 3 multiplications + 6 shifts + 6 clamp branches per pixel, **over 2 million multiply-adds in total**, which on a Cortex-A7 is at most 1~2ms. Where did the missing 28ms go?

**Cache misses.** The render's memory access pattern is transposed — output pixel (oy, ox) takes `[1079-ox*3/2][oy*3/2]` from the source image; source rows follow output columns, source columns follow output rows, and each source pixel's adjacent output pixels are 1.5 pixels apart in the source image. The source image is 3MB; one frame spans 1080 source rows taking 720 points each — **every source-row change is a fresh cache line fetch**.

That explains why the earlier "table lookup" approach was actually slower (39.3ms vs 32.5ms) — the lookup moved the miss from the source side to the table side, for zero net gain.

The fix is not to change the algorithm but to **change the grouping granularity**: the original implementation processed 16 output rows at a time (one "band"), with each source row reading only 24 bytes (~37% of a cache line). After changing to 64 rows, each source row reads 96 bytes, and adjacent bands read exactly the neighboring segments of the same batch of cache lines — **reusable within L2**.

```c
#define BANDH 64     /* 16 → 64, geometry formula completely unchanged, only grouping changes */
```

Measured: render 34.3 → **30.3ms**, real frame rate 12.4 → **13.1fps**. A screen capture confirms the picture geometry is undistorted in any way (channel logo position, subtitles, colors all normal).

**Lesson 5: cheap arithmetic does not mean cheap memory access.** The same 2 million multiply-adds are about the same scalar vs NEON; but "one cache line fetch per source pixel" vs "one per 4 source pixels" differs by 10x.

## 7. This Round's Ledger

| Item | Before | After |
|---|---|---|
| real picture update rate | 8.45 fps | **13.1 fps** |
| frame-readback segment time | 44.3 ms | **2.7 ms** |
| render segment time | 33.0 ms | **30.3 ms** |
| per-frame wall clock | 113.0 ms | **70.6 ms** |
| `[STAT]` frame rate definition | inflated 2x | real frame count |

The vendor's 14ms decode is the hard floor; the theoretical ceiling is 1000/(14+30) ≈ 23fps.

## 8. Two More Pitfalls This Round, Worth a Separate Note

### Pitfall 1: Mistaking "More Memory-Efficient" for "Better Aligned"

Our output buffer is 3.25MB, and the exact frame size is 3.13MB — I assumed preferring the exact size would save 140KB and leave a bit more room for the vendor's C1. Result: **OOM went from 1 to 28**.

The reason is plain: 3.13MB cannot make up a whole order-8 block; 3.25MB can. **The first entry on the size ladder is not "the most frugal", it is "the best aligned"**.

### Pitfall 2: The perf Sampling Factor Is Hardcoded, and Two Metrics Start Fighting Each Other

After changing the band height from 16 to 64, `[perf] fb_render avg` reported 133ms, while "render=" inside `[perf] AU` reported 30.3ms — **the same code, two metrics differing by 4x**.

The sampling conversion factor is hardcoded `* 20` (80 bands, sampling every 20). After the band height becomes 64, that is 20 bands sampling every 5, and the factor should become `* 5`. Once this kind of "magic number" is decoupled from the structural parameters, the metric is useless.

```c
#define FB_SAMPLE_MUL (1280 / BANDH / 5)   /* the factor must move in lockstep with structural parameters */
```

**Lesson 6: performance tooling is itself code that needs maintenance.** The more tightly its constants couple to the object under test, the more changing one side forces changing the other.

## 9. Next Steps

1. **Increase the band height further** (64 → 128 / 256): verify whether DRAM traffic can drop further, until the render segment stops varying with band height
2. **NEON-ize YUV→ARGB**: the device CPU (ARMv7 rev5) **supports neon**, and the toolchain already carries `-mfpu=neon-vfpv4`;
   nobody had just written the intrinsics. The arithmetic part (3 multiplications + clamp) can be squeezed to 1/4 with the saturating instruction `vqmovun`
3. **Change the transpose implementation**: currently "read in source order, write transposed on the output side" — a natural cache disaster.
   Changing to "bilinear scaling + scale to 720×1280 first, then transpose" may make memory access contiguous
4. **fb direct-write optimization**: currently mmap writes 3 pages of fb + PAN; is there a hardware overlay path
5. **Root-fix the pool conflict**: have our output allocation queued after the vendor's C1

---

**One last word**: the most valuable output of this round is not the 17x, but **turning the fake number "16.9fps" into the real number "8.9fps"**. An inflated metric makes you think "a bit more optimization will be enough", while the real number tells you: there is still a long way to go, but the direction is clear — not in decoding, but in data movement.
