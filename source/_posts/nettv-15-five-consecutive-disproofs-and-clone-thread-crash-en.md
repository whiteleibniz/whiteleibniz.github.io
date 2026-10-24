---
title: "netTV Hardware Decoding Deep Dive (15): Five Consecutive Disproofs — Why Every 'Obvious' Optimization Failed, and How a Bare clone Thread Kept Rebooting the Device"
date: 2026-10-20 11:30:00
categories:
  - [Embedded, Network TV Hardware Decoding]
  - [Linux, Performance Optimization]
tags:
  - sprd
  - SC9832A
  - VSP
  - ION
  - Performance Profiling
  - ARM
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash-en/)

> Part 15 of the series. In the previous part (nettv-14) we had pinned the stutter on ptsync positive feedback and O_SYNC logging,
> reaching a 17fps baseline. This part is the push from 17fps toward 25fps — **almost entirely a catalog of cautionary tales**:
> five optimizations that looked perfectly reasonable, four directly disproven by A/B experiments, and one that rebooted the device twice.
> The conclusion matters more than the process, so here it is up front.

## The One-Sentence Conclusion

**The 116ms-per-frame ledger: decode 21ms + copy 43ms + render 32ms. The real bottleneck is the 3MB memcpy,
and it is slow because the ION buffer is mapped uncached.** Every optimization aimed at "decode / render / pipelining"
is scratching an itch from outside the boot in front of the uncached-memory wall.

## Background: The 116ms Wall

Luxian 1080p live source; measured per AU (one access unit ≈ one frame):

| Segment | Time | Content |
|---|---|---|
| DRIVE | 21.1ms | vendor library synchronous decode, of which only 14ms is hardware |
| frame readback | 43.4ms | 3MB `memcpy(uncached ION → cached staging)` |
| render | 31.8ms | NV12→ARGB + rotation composition + fb write |

Monitoring `[STAT] fps_x10=157`, i.e. 15.7fps. The 25fps target means the total must come down from 116ms to under 40ms.
Below are the five things we tried, in order.

## Disproof 1: Down-Rating the Signature Scan — "25ms of the 45ms Frame Readback Is Scanning"

Logically airtight: a content signature over the Y/UV planes every frame (for duplicate-frame detection), with stride-256 sampling that still costs
8K+4K accesses — it sure looked like the big-ticket item.

After switching to "periodic signature + callback-count dedupe", the A/B measurement:

```
Group A (down-rated): frame readback 44.6ms
Group B (full signature every frame): frame readback 44.8ms
```

**The difference is noise.** The signature scan was never the bottleneck; the entire cost is the memcpy.
Lesson: between the "big-ticket item" you imagine and the real one lies a single-variable A/B.

## Disproof 2: LUT-izing fb_render — "Eliminate 3 Multiplications per Pixel"

For BT.601 conversion formulas like `r=y+f(v)`, the textbook optimization is a precomputed coefficient table:

```c
static short sRV[256], sGU[256], sGV[256], sBU[256];
static inline unsigned pxlut(int yv, int u, int v) {
    int r = yv + sRV[v];
    int g = yv - sGU[u] - sGV[v];
    int b = yv + sBU[u];
    ...
}
```

Three multiplications and six clamps become four table lookups and three additions — beautiful in theory. Measured:

```
Group A (LUT):    render 39.3ms, fb_render mean 39ms
Group B (scalar): render 32.5ms, fb_render mean 36ms
```

**The LUT was 20% slower.** Cortex-A7's hardware multiplier finishes in a single cycle, while random indexed access across four 256-entry tables
(the U/V jumps between adjacent pixels) brings L1/L2 misses. In the end we flipped the default
back (`NETTV_LUT=1` to enable), keeping the code only as A/B teaching material.

## Disproof 3: Reading ION Directly to Skip the memcpy — "copy is pure waste"

If the memcpy takes 43ms, why not have the renderer read the ION buffer directly? `NETTV_STAGE=0` is
exactly that switch. Measured:

```
5.8fps, fb_render mean 335ms
```

**10x slower than the copy version.** The reason: ION was allocated with `flags=0`, so the mapping is **uncached
memory**: the copy version does one sequential bulk read (DRAM bursts, hardware prefetch — all comfortable),
after which every access lands in cache; the direct-read version issues one uncached transaction per pixel, each costing a full bus
cycle. Sequential scanning / mixed access over uncached memory is suicide.

**The 3MB memcpy is not waste — it is the optimal solution.** But the number "43ms" itself became the new target.

## Wreck 4: The Bare clone Dual-Thread Pipeline — Two Reboots

At this point the single thread couldn't be cut any further; the only way out on the ledger was pipelining:
the worker decodes + copies, a separate thread renders, the two overlapping.
Bare bionic (-nostdlib) has no pthread, so we spawned the thread with the `clone` syscall directly:

```c
#define CLONE_VM 0x00000100
long r = syscall(120 /* clone ARM EABI */,
                 CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD,
                 sp, 0, 0, 0);
if (r == 0) { fn(); syscall(1, 0); }
```

A 20-second trial run: fully functional — the render thread started, DRIVE dropped to 18ms, wall clock 80ms.
Switching to the 60-second long test — **the device rebooted, twice in one day** (even the binary in `/tmp` was
truncated to 0 bytes: textbook power-loss-grade filesystem corruption).

The retrospective found two root causes, both landmines specific to "bare threads":

1. **No TLS was set.** `clone` was called without `CLONE_SETTLS`, so the new thread runs on the parent thread's TLS.
   And the render thread called bionic's `snprintf` (log printing) — inside, bionic stdio goes through the
   `__nbuf` thread-local buffer pool, i.e. **TLS**. The child writing through someone else's TLS corrupts the thread structure,
   and when it explodes depends on timing (hence: fine at 20s, crash at 60s).
2. **Shared signal handlers.** Under `CLONE_SIGHAND`, the SIGSEGV/SIGALRM handler may be executed by
   any thread, and the handler contains `siglongjmp` — a cross-thread longjmp is undefined behavior.

The fix (v16i): at the render thread's entry, `rt_sigprocmask` first masks all signals of the process handlers;
inside the thread, disable every TLS-touching libc call (`P`/`snprintf` become hand-written `write` syscalls;
memcpy is pure assembly, uses no TLS, kept). After the fix, the 60s long test **no longer crashes**.

> **The bare-clone thread iron rule**: inside a child thread, only raw syscalls and compiler-builtin memcpy are allowed;
> the first act on entering the thread is to mask signals; snprintf/P macros are contraband, full stop.

## Negative Optimization 5: After the Fix, the Pipeline Got Slower

Not crashing only earned the right to experiment; the single-variable comparison:

```
Group A (dual-thread pipeline): 12.3fps, wall clock 80ms (metric includes overlap)
Group B (single thread):        15.7fps, wall clock 116ms
```

**22% slower.** Attribution:
- DRIVE did drop from 21ms to 18ms, but the **43ms memcpy didn't budge** (this is the bottleneck at the tail of the chain);
- both threads hammer memory bandwidth; L2 contention slows reads on both sides;
- the `usleep(200µs)` granularity of the handshake turns the intended pipelined parallelism back into half-serial;
- render's 32ms is completely buried under the worker's 62ms — pure waste.

Android's BufferQueue works on the premise of "multiple output buffers rotating + an asynchronous decoder";
we have `g_nout=1`, a single output path, and synchronous blocking decode — hanging a render thread on top just moves
the serialization elsewhere. **When the architecture doesn't match, copying the shape is useless.**

## So How Do We Actually Get Fast?

Put three numbers together and the roadmap draws itself:

```
DRIVE 21ms (of which hardware decode 14ms, library-side paperwork 7ms — near the limit)
memcpy 43ms (3MB uncached — the only target)
render 32ms (can be buried by pipelining, but burying it yields no net gain)
```

- **First cut: switch ION to cached mapping.** Allocate with `ION_FLAG_CACHED` and run `ION_IOC_SYNC`
  to invalidate every frame. The memcpy goes from "uncached sequential bulk" to "cached bulk", expected 43ms→10ms
  magnitude, total wall clock 116→~75ms, **20fps+**. The risk is DMA coherency (VSP writes, CPU reads a stale cache
  → screen corruption), so it must be rolled out gradually.
- **Second cut: cache the DRIVE library-side 7-18ms phys ioctl** (build an fd→PA table, look up once, use it long-term).
- **Third cut: fb_render's 32ms** — with NEON disabled in the ARMv7 build, do loop unrolling and
  8-pixel prefetching.
- **The metaphysical cut: display driver overlay.** If the sprd DPU can take NV12 + rotation directly, the entire CPU composition
  disappears — the real killer move for catching up to Android's 50fps, but it requires recon of the driver's capabilities.

## Methodology Deposit

1. **Anything that "obviously looks like the big-ticket item" must be A/B verified.** Three of this round's five (signature, LUT, direct read)
   crashed against measurement, two of them counter-intuitively.
2. **With every optimization added, A/B an old behavior in parallel as counter-evidence.** Without a B group there is no conclusion,
   only a feeling.
3. **Performance attribution must reach the memory-attribute layer.** uncached/cached, sequential/random, hit/miss,
   explain order-of-magnitude differences better than algorithm-level optimizations.
4. **Before shipping any risky runtime abstraction (bare threads), first confirm it survives 3x the duration.**
   20 seconds running doesn't mean 60 seconds will — timing bugs don't pick times, only probabilities.
5. Device reboot = the prime suspect for truncated `/tmp` files. When an md5 doesn't match, suspect power loss first, code second.

---

*Previous part: nettv-14 "From 6.3fps to 17fps: The O_SYNC Logging and a dup2 Misjudgment"*
