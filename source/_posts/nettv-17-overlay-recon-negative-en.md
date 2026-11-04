---
title: "nettv-17: Overlay Recon Rules Negative — What Remains When the Only Way Out Is Falsified"
date: 2026-10-20 13:10:00
tags:
  - sprd
  - SC9832A
  - fbdev
  - overlay
  - DPU
  - Mali
  - recon
categories:
  - [Embedded, Network TV Hardware Decoding]
  - [Linux, Performance Optimization]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative-en/)


## Background: One Sentence

Yesterday we pinpointed the frame rate (fps) bottleneck to exactly **the "YUV→RGB→framebuffer" step** (three completely different chains hitting the same wall), so I listed "the display controller's hardware overlay consuming NV12 directly" as the only way out.

Doubao's proposal said the same:

> Drop Mali for YUV conversion; use the display controller's hardware rotation + YUV conversion instead. The SC9832A's display module natively supports YUV input and image rotation. Send NV12 frames directly to the display layer, and use Mali only to composite UI subtitles.

Sounds right. The hardware is there, the chip supports it, and in theory it eliminates the entire CPU pixel path. **This round is about verifying whether it can actually be done.**

The verdict first: **the hardware is indeed there, but there is not a single userspace interface. This road is sealed shut.**

---

## Recon Technique: kallsyms First

No source, no driver binary, no root debugger. In this situation the first instinct is usually to dig through `dmesg`, or to `strings` the `.ko` files. **Both are wrong.**

All `dmesg` has is:

```
c0 ###---- BIT_DISPC_EB still set ----###
c0 sprdfb: [sprdfb_dispc_check_esd] (4590, 0, 0)
```

`BIT_DISPC_EB` is a tantalizing clue, but this single bit proves nothing.

**The correct entry point is `/proc/kallsyms`.** The kernel symbol table tells you directly what the driver implements:

```
$ grep sprdfb /proc/kallsyms | awk '{print $3}'
sprdfb_pan_display
sprdfb_ioctl                    ← the only userspace entry point
sprdfb_check_var
sprdfb_probe
sprdfb_panel_change_fps
sprdfb_dispc_enable_overlay      ★
sprdfb_dispc_display_overlay     ★
sprdfb_dispc_logo_proc
sprdfb_dispc_ctrl
sprdfb_dispc_refresh
...
```

**The DPU overlay hardware does exist** — `sprdfb_dispc_display_overlay` and `sprdfb_dispc_enable_overlay` are plainly there in the kernel.

Good news so far. But the next question is the key one: **can userspace call these two functions?**

---

## Dead End One: The Disassembly Route Is Blocked

To disassemble `sprdfb_ioctl` and see whether its ioctl dispatch table has overlay commands, kernel source is needed. There are three routes:

| Means | Result |
|---|---|
| `find / -name "sprdfb*.ko"` | **empty** — the driver is **built into** the kernel; there is no module file |
| `dd if=/proc/kcore` | **0 bytes** — the kernel hasn't opened `CONFIG_KCORE` read permission |
| `dd if=/dev/mem` | **No such file** — the device doesn't create this node at all |

All three are dead ends.

A mid-course detour worth mentioning: I originally wrote a "blind ioctl scan" program — iterating `/dev/fb0` over four magics `'S'/'D'/'F'/'s'` × 96 nrs × three encodings, trying all ~700 custom ioctls to see which one isn't EINVAL.

**The moment I finished it, I killed the idea.** Display driver ioctl branches usually dereference user pointers directly, and I was passing it an all-zero fake struct. This is the same class of error as the "FBIOPAN with a fake short struct crashing the kernel" we hit before — **probing with a means that can trigger a kernel crash costs too much, and if it fails you learn nothing.**

Later I switched to read-only means (`GET_VSCREENINFO` / `GET_FSCREENINFO` / rejected `PUT` → check errno): zero risk, and more accurate information. That's the right approach.

---

## Key Evidence: fbdev Capability Probing

Since fbdev interfaces are the only way to infer, measure honestly. The device has gcc, so just compile a probe program directly (by the way, this kernel's `fb.h` is an old version where the `FB_ROTATE_90` and `FB_ACTIVATE_ROTATE` macros don't exist and you have to use literal values; `fb_fix_screeninfo` also has no `flags` field, only `capabilities` — details like these only surface if you actually compile):

```c
ioctl(fd, FBIOGET_VSCREENINFO, &v);
ioctl(fd, FBIOGET_FSCREENINFO, &f);
/* try hardware rotation */
r.activate = FB_ACTIVATE_NOW | 0x100;  r.rotate = 1;
ioctl(fd, FBIOPUT_VSCREENINFO, &r);
/* try various pixel formats */
```

Result:

```
[VAR] 720x1280 virt 720x3840 bpp=32
[VAR] rotate=0 colorspace=0 nonstd=0
[VAR] rgb: 0/8 8/8 16/8 transp=0/0
[FIX] id="sprdfb" smem_start=0x9ed74000 smem_len=11059200 line_len=2880
[FIX] type=0 visual=2 accel=0x0 capabilities=0x0
[FIX] mmio_start=0x0 mmio_len=0
[FIX] panstep x=0 y=1 ywrap=0

ROTATE_90 : rejected (errno=22)
bpp=16 : accepted    bpp=32 : accepted    bpp=24 : accepted
bpp=12 : accepted    bpp=15 : accepted
```

Read line by line:

| Line | Meaning |
|---|---|
| `ROTATE_90 : rejected (errno=22)` | **no hardware rotation at the fbdev layer**. EINVAL is the driver explicitly saying "I don't support this parameter combination" |
| `capabilities=0x0` | the driver **declares not a single capability bit** (no MMIO, no hardware acceleration, no overlay) |
| `mmio_start=0x0 mmio_len=0` | **fatal** — userspace can't get the DPU register base address, so "configuring overlay yourself" is impossible |
| `accel=0x0` | same as above, no hardware acceleration flag |
| `bpp=12 : accepted` | this line is a **trap**. The driver doesn't validate pixel formats at all; it nods at any bpp. **It can't be used as evidence that "NV12 is available"** |
| `virt 720x3840` | 3840 = 1280 × 3, **triple buffering** — the FBIOPAN dual/triple buffering we've always used is it |
| `smem_len=11.06MB line_len=2880` | 2880 = 720 × 4 bytes, ARGB8888, fully consistent with our understanding |

**`mmio_start = 0` basically passes the sentence.** Even with the overlay hardware present, without register access userspace can't change a single bit.

---

## Why Android Can and We Can't

Android's NV12 direct-to-display-layer is implemented like this:

```
MediaCodec → output to gralloc buffer (NV12)
  → BufferQueue hands over GraphicBuffer(fd)
    → SurfaceFlinger receives it, hands it to HWC
      → libhwcomposer decides which display layer to use
        → DPU does NV12→RGB + scaling + compositing in hardware
```

Every link in this chain is **userspace code**: SurfaceFlinger, libhwcomposer, gralloc. We have none of them.

I confirmed in the Android image:

```
$ ls /mnt/android_sys/lib | grep -iE "hwc|composer|display|overlay"
(empty)
```

This image carries media-related things only (`libomx_avcdec_hw_sprd.so`, `libmedia*.so` and 304 other libraries), **with no display composition stack at all**. Its original design purpose was "providing LVGL with musl libc and bionic libraries", not running full Android.

So items 1, 2, and 4 of Doubao's proposal share the same problem on this device: **it assumes a userspace infrastructure we don't have.** Item 1 says "VSP outputs dma-buf shared with Mali", yet our player has no GL context at all right now; item 4 says "don't bind fb0 directly with glReadPixels", yet we never used it — that was the PSP line's historical problem.

---

## Quantitative Cap: The CPU Route's Ceiling

Three **completely independent** chains, all measured hitting the same wall:

| Chain | End-to-end fps | Where it hits |
|---|---|---|
| in-house VSP hw decoding | 15.7 | uncached ION memcpy 43.4ms + fb_render 31.8ms |
| ffmpeg 4 threads + rgba | 10.2 | YUV→RGB ≈ 25ms + rotate/scale ≈ 45ms |
| mplayer y4m chain | 7.9 | y4m disk write + scale filter |

**The decode side is already squeezed dry** — ffmpeg multithreaded `-threads 4 -f null` can run **34.9fps** (150 frames decoded in 4.3s, 2.5x faster than single-threaded 10.7s), the highest decode throughput in the whole project. But add `-vf scale,transpose -pix_fmt rgba` and it immediately drops to 10.2fps.

**The 2.5x bought by multithreading is entirely eaten by CPU pixel conversion.**

That's the conclusion: **as long as the picture must pass through the CPU pixel path — software or hardware decoding, any number of threads — the ceiling is 13-16fps.** This isn't "not optimized enough"; it's determined by the physical path.

---

## What's Left: Mali

With overlay sealed, the only GPU route is **Mali**:

- the `/dev/mali0` device node is there
- `insmod mali.ko` works (verified)
- `gpu_env_ensure()` in the project's `lv_hardware/gpu_env.c` is **already implemented** (not committed)
- known pitfall: pbuffer's `glReadPixels` is unreliable on TBDR architecture; you must **render directly to a window surface**

The approach: use a GLES shader for NV12→RGB + rotation, then draw straight into the window surface. This way the picture no longer passes through the CPU's YUV→RGB scalar computation, and in theory the 45-70ms overhead can be shifted to the GPU.

**But let me be honest: this route isn't guaranteed either.** VRAM must fit 1080p NV12 (3.1MB), Mali's actual bandwidth and shader throughput on this board are still unknowns, and the shader compilation/driver pitfalls haven't been crossed. It's worth trying, but its current status is "the only option", not "confirmed feasible".

**The other honest option is adjusting the acceptance criteria.** If the GPU route also fails, set the frame-rate target at 15-20fps, then do ION cached mapping (memcpy 43→10ms) to push hardware decoding stably to around 20fps, and squeeze the remaining 20ms of fb_render with loop unrolling and 8-pixel prefetch. **This is a deliverable plan that doesn't gamble.**

---

## Methodology: Three Things Learned from This Recon

**1. "The hardware is there" doesn't mean "you can use it".**
kallsyms has `sprdfb_dispc_display_overlay`, so the hardware exists. But `mmio_start=0`, no ioctl, `capabilities=0x0` — userspace can't use it. **Judging a capability usable must be verified down to the "interface reachable from userspace" layer**; the symbol table only proves the first layer.

**2. "The driver nodded" is the least trustworthy evidence.**
`bpp=12 : accepted` looks like "NV12 supported". But the driver doesn't even validate its own formats, which means it isn't managing formats at all. **An interface that doesn't validate — none of its "yes" answers constitute evidence.** By contrast, `ROTATE_90 : rejected (errno=22)` is hard evidence — the driver explicitly stated its position.

**3. Don't probe with means that can crash.**
The plan to blindly fire 700 ioctls looks clever, but it can crash the kernel and doesn't buy much information. Read-only ioctls (GET_*) plus "probe + check errno" is an equivalent scheme with zero risk. **The value of probing doesn't depend on how bold you are, but on how precise you are.**

---

## Appendix: Facts Covered in This Article

- kernel symbols: `sprdfb_dispc_display_overlay`@0xc024adcc, `sprdfb_dispc_enable_overlay`@0xc0249db4, `sprdfb_dispc_ctrl`@0xc088c1cc
- driver is built in (no `sprdfb.ko`); neither `/proc/kcore` nor `/dev/mem` is readable
- fbdev: `rotate=90` rejected (EINVAL), `capabilities=0x0`, `mmio_start=0`, `accel=0x0`
- fbdev actual params: 720×1280, virt 720×3840 (triple buffering), bpp32 ARGB8888, `smem_len=11.06MB`, `line_len=2880`
- `/mnt/android_sys/lib` has no hwcomposer/libcomposer; the image contains media libraries only
- three chains end-to-end: hw decoding 15.7fps / ffmpeg 4 threads+rgba 10.2fps / mplayer y4m 7.9fps
- ffmpeg `-threads 4` pure decoding 34.9fps (decode-side ceiling)

---

> **Copyright Notice**: This article is an original work by whiteleibniz (organized with AI assistance). Copyright belongs to whiteleibniz. Please credit the source and link to the original article when reposting: https://whiteleibniz.github.io
