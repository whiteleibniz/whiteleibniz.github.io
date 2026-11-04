---
title: "nettv-16: Hardware Decoding Is Slower Than Software — A Controlled Experiment That Completely Overturned the Assumption That Decoding Is Slow"
date: 2026-10-20 11:45:00
tags:
  - sprd
  - SC9832A
  - VSP
  - mplayer
  - OMX
  - Hardware Decoding
  - Software Decoding
  - ARM
  - Performance Analysis
categories:
  - [Embedded, Network TV Hardware Decoding]
  - [Linux, Performance Optimization]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-16-hw-decoding-slower-than-sw/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-16-hw-decoding-slower-than-sw-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-16-hw-decoding-slower-than-sw-en/)


## One-Line Conclusion

We spent three weeks tuning the VSP hardware decoding pipeline from "zero frames" to "15.7fps", then ran a software decoding control with the same stream and the same player binary:

```
mplayer -vo null -nosound  →  25.0 fps   (pure H.264 decoding ceiling)
in-house VSP hw pipeline   →  15.7 fps   (decode + frame fetch + render, full chain)
```

**CPU software decoding is faster than VSP hardware decoding.** It's not that the optimization wasn't done well — the premise of "decoding is slow" never held in the first place.

---

## 1. First, Figure Out the mplayer Path

The user suggested a direction: "can we make mplayer use H.264 hardware decoding". Reconnaissance results in three parts.

### 1. Where It Is, and Whether It Has Hardware Decoding

```
$ ls /usr/bin/mplayer /usr/local/bin/mplayer
ls: cannot access: No such file or directory     ← not in PATH
$ find / -name 'mplayer*'
/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer     ← static binary shipped with the project
```

```
$ mplayer -v
MPlayer 1.4-13 (C) 2000-2019 MPlayer Team
CPU: ARM
```

Scanning with `strings`, not a single hardware-decoding-related symbol:

```bash
$ strings mplayer | grep -iE 'libvpu|sprd_vsp|vdsp|hwaccel'
(empty)
```

The only hit, `"For hardware decoders"`, appears in this context:

```
hwmpa
NicoDVB
For hardware decoders
Uncompressed PCM audio decoder          ← audio family (libmpg123/ac3)
```

MPlayer 1.4 is a 2019 branch, and it has exactly one route to hardware decoding: **an external ffmpeg offloading decoding via `-vc ffmpeg:`**. ffmpeg isn't installed on our device, and installing it wouldn't help either (see below).

### 2. Where It Can Output

```
$ mplayer -vo help
fbdev   fbdev2   lvfb   null   mpegpes   yuv4mpeg   png   tga   pnm   md5sum
```

Note how informative this line is: **no v4l2, no dri, no GL vo of any kind**.

This means even if mplayer decodes to NV12, it can only convert to RGB on the CPU itself and write into the framebuffer. VSP decoding, DPU composition — it can touch none of them. **"-vo lvfb" is the only option worth trying**; that's the LVGL direct-write vo written by this project.

### 3. ffmpeg Doesn't Save the Day Either

It's in the Alpine repository:

```
ffmpeg-6.1.2-r1 armhf {ffmpeg} (GPL-2.0-or-later AND LGPL-2.1-or-later)
```

But `which ffmpeg` is empty — **it's only in the repository index, not installed**. And even installing it would be pointless: Alpine's ffmpeg is a community build, **with no Spreadtrum VSP hwaccel adaptation** (`h264_sprd`-style decoders are not mainline ffmpeg). Installing it would only give software decoding — the same road as mplayer.

---

## 2. The Real Control Experiment

With recon done, it's time for data. Pull a real 1080p TS segment (2.6MB) from the Luxian source and run it three ways.

### Group A: mplayer Pure Decoding Ceiling

```bash
mplayer -benchmark -vo null -nosound -framedrop /tmp/mp.ts
```

```
FPS seems to be: 25.000000
VO: [null] 1920x1080 => 1920x1080 Planar YV12
BENCHMARKs: VC:   9.778s VO:   0.001s A:   0.000s Sys: 0.065s =  9.844s
BENCHMARK%: VC: 99.3308% VO: 0.0068% A: 0.0000% Sys: 0.6624% = 100.0000%
```

`VC` is video decode (Video Codec) time, accounting for **99.33%**. 10 seconds to finish = **25fps = 40ms/frame**.

### Group B: The Existing Software Pipeline (y4m Relay)

The project already has a software path: `curl → mplayer → yuv4mpeg → lv_canvas` (`/usr/local/bin/nettv_play.sh`), with these parameters:

```sh
$MP -cache 2048 -cache-min 5 -autosync 100 -mc 1 -quiet \
    -vo yuv4mpeg:file=/tmp/nettv.y4m -vf scale=640:360 $AOARGS -nolirc -
```

Running the same TS:

```bash
mplayer -vo yuv4mpeg:file=/tmp/t1.y4m -vf scale=640:360 -nosound -fps 60 -slave /tmp/mp.ts
# after 18s: y4m = 49421692 bytes
# 640×360×1.5 = 345600 bytes per frame → 142 frames
# → 7.9 fps
```

**25fps of decoding capability drops to 7.9fps after the y4m disk write + scale filter.** The lost 17fps is entirely in IO and secondary scaling — nothing to do with decoding.

### Group C: Our In-House VSP Hardware Decoding

Quantitative from the same-round A/B of v16i (60s steady state):

```
single thread 15.7fps, wall clock 116ms/AU
  = DRIVE 21.1ms + memcpy 43.4ms + render 31.8ms
```

### All Three Side by Side

| Approach | Frame rate | Where the bottleneck is |
|------|------|----------|
| mplayer `-vo null` | **25.0 fps** | decoding itself, 40ms/frame |
| in-house VSP hw full chain | 15.7 fps | decode 21ms; the other 95ms all in memcpy+render |
| software + y4m disk write | 7.9 fps | file IO + scale filter |

**The most glaring part of this table**: the vendor's VSP hardware decode takes only 14ms (reported by the library itself), yet our entire hw pipeline takes 64ms/frame. The 27ms saved is entirely eaten by other things — and we still end up behind.

---

## 3. Why This Result Is Counterintuitive

By all rights hardware decoding should crush software decoding. The difference is that **software decoding's "slowness" is concentrated in the decode, while hardware decoding's "slowness" is scattered across IO**.

A7's software decoder is slow, but it works on ordinary `malloc`ed memory — CPU-cache friendly, contiguous, prefetchable. The VSP output, on the other hand, is a block of uncached ION memory, so:

1. **3MB memcpy 43ms** — non-cached memory read byte by byte; every byte is an independent transaction
2. **fb_render 31ms** — NV12→ARGB + 90° rotation, 1280×720 entirely scalar arithmetic

Software decoding doesn't have step 1 at all: the decoder writes directly into an ordinary buffer, and step 2 can use `-vo lvfb` to have mplayer draw straight into the framebuffer, skipping the middle steps.

**So the decision to "use a hardware decoder" wasn't wrong per se; what's wrong is that the hardware decode's output has no efficient consumption path.** Hardware only turns compressed data into pixels; the remaining 95ms of moving and compositing doesn't shrink by a single line.

As an aside, a counter-proof: we previously tried `NETTV_STAGE=0` to read ION directly and skip that memcpy, and **fb_render shot from 33ms to 335ms** (10x slower), 5.8fps. Because random reads from non-cached memory are worse than sequential copies. **The 3MB memcpy is already optimal under the current mapping attributes.**

---

## 4. Two Real Hardware Routes Found Along the Way

During recon we saw two things far more valuable than mplayer.

### `libomx_avcdec_hw_sprd.so`

```
$ ls /mnt/android_sys/lib | grep -i omx
libomx_avcdec_hw_sprd.so        ← Spreadtrum's official H.264 hardware OMX plugin
libomx_avcdec_sw_sprd.so
libomx_avcenc_hw_sprd.so
libomx_m4vh263dec_hw_sprd.so
...
```

This is the real official hardware path. Dependencies are clean:

```bash
$ strings libomx_avcdec_hw_sprd.so | grep -E '^lib.*\.so' | sort -u
libc++.so   libc.so   libcutils.so   libdl.so
liblog.so   libm.so   libutils.so
```

All sitting in `/mnt/android_sys` (mounted at boot via `/etc/init.d/00_android_sys`, 304 libraries).

**But don't be optimistic just yet**: it's an Android OMX adaptation layer, and working properly requires the `OMXMaster` registration, `BufferQueue` reference counting, and `gralloc` buffer trio — all in the Android media stack, and our bare-bionic player has none of them. Driving OMXCodec directly is a lot of work, and its semantic assumptions about ION handles (how fd + offset + size are interpreted) are in the same domain as the green-screen pitfalls we hit managing ION ourselves.

**Verdict: doable, high cost, ranked behind ION cached.**

### ION Cached Mapping

This route is still the best value: change the VSP output buffer from uncached to cached (`ION_FLAG_CACHED = 1`), with one `ION_IOC_SYNC` invalidate per frame. The 43ms memcpy could theoretically drop to around 10ms, wall clock 116ms → 75ms, reaching 20fps outright.

The risk is DMA coherency: between the VSP finishing its write and the CPU reading it, a flush is required; missing it means a garbled or green screen. That's a reason for a gradual rollout, not for giving up.

---

## 5. So What's Next

mplayer's positioning is now clear:

- **"mplayer hardware decoding" is void** — it has no hardware decode framework and no GPU output path
- **"mplayer software decoding" has value** — the 25fps decoding ceiling is real, and **not touching VSP or ION means no kernel crash risk**

Three changes to the software route, ranked by cost-effectiveness:

1. **Drop the y4m disk write**, use `-vo lvfb` directly (mplayer's built-in LVGL direct-write vo) — eliminates the entire file IO, expected 7.9 → ~20fps
2. **Drop `-vf scale=640:360`**, let the vo output directly at the target size — saves one CPU scaling pass
3. **Drop `-autosync 100 -mc 1`** — added in v4 to guard against pts jumps at TS segment boundaries, and we've proven ptsync is the source of the negative feedback

All three together, software decoding could likely reach 25fps, with zero kernel risk. **This makes it a better first gradual-rollout experiment than ION cached.**

But be clear about its ceiling: 25fps is the decode ceiling of mplayer's class of CPU; above 1080p you'd need 720p sources or downscaled resolution. At that point hardware decoding still has to be fixed eventually.

---

## 6. Three Methodology Takeaways

**1. "Hardware vs software decoding" is not a matter of faith — it's measurable.**
A single `mplayer -vo null -benchmark` gets the truth out in under two minutes. Before investing three weeks in hardware acceleration, spend two minutes measuring the software ceiling.

**2. Performance problems are about "where the money goes", not "which step is slowest".**
Hardware decode dropping from 64ms to 14ms is a huge win, but the same period added 95ms of other overhead; the net gain is negative. The slow step (memcpy 43ms) isn't the step initially suspected (decoding).

**3. A third-party component's capability boundaries are established by reading lists, not guessing.**
The `mplayer -vo help` line lists ten vos, with no v4l2 and no dri — mplayer cannot participate in GPU composition, a fact confirmable without reading a single line of source. And `strings | grep hwaccel` being empty means there's no hardware decode framework. Far more reliable than "I think MPlayer should support it".

---

## Appendix: Key Facts Covered in This Article

- mplayer location: `/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer`, MPlayer 1.4-13 static build, **not in PATH**
- Software decode ceiling 25.0fps / 40ms per frame (`VC` at 99.33%)
- Existing y4m chain 7.9fps; the real bottleneck is file IO + scale filter
- Hardware decode baseline 15.7fps, wall clock 116ms (DRIVE 21.1 + memcpy 43.4 + render 31.8)
- Direct ION read counter-proof: fb_render 335ms, 10x slower
- `/mnt/android_sys/lib/libomx_avcdec_hw_sprd.so` exists, but requires the Android media stack
- Alpine's ffmpeg 6.1.2 has no VSP hwaccel, and isn't installed

---

> **Copyright Notice**: This article is an original work by whiteleibniz (organized with AI assistance). Copyright belongs to whiteleibniz. Please credit the source and link to the original article when reposting: https://whiteleibniz.github.io
