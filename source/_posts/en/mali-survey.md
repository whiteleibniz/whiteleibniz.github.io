---
title: "Mali400 and Hardware Acceleration_Survey Conclusions"
date: 2026-09-23 11:06:07
lang: en
permalink: en/2026/09/23/mali-survey/
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# Mali-400 GPU and Hardware Acceleration: Survey Conclusions

> Date: 2026-09-23　Device: Spreadtrum SC9832A (Alpine / kernel 3.10.65 stock Android kernel / 720x1280 fb)
> Question: MPlayer playback stutters; is the Mali-400 being used at all; can it be used for display/video/UI.
> Nature: a read-only survey; **no playback verification was performed** (by agreement, verification is done by the user on the device).

---

## 0. First, Correct Two Concepts

1. **The Mali-400 is a 3D rendering GPU, not a display controller.**
   Display is done by `20800000.fb` (sprdfb / dispc) hardware scan-out, and `/dev/fb0` is the final output port.
   The GPU **cannot "take over the display"** — it can only draw images into a memory buffer, which dispc then displays (Android completes this step with
   SurfaceFlinger + hwcomposer's overlay layers; this machine does not have that set of things).
2. **Marlin is not responsible for video.** Marlin2 is the combo chip for WiFi / BT / FM / GNSS.
   Video hardware decoding is on the AP side and is called **VSP** (`/dev/sprd_vsp`, paired with `sprd_coda7l`).

---

## 1. Hardware and Driver Status (Measured)

| Component | Evidence of existence | Current status |
|---|---|---|
| Mali-400 GPU | device tree `60000000.gpu`; `/lib/modules/mali.ko` (4.6 MB) | ❌ **completely unused**: the platform device has **no driver binding**, the module is not loaded, and **`/dev/mali` does not exist** |
| Display controller | `20800000.fb` → `/dev/fb0`, 720x1280 32bpp, `accel false` | ✅ in use (fbdev software writes) |
| VSP video codec | `/dev/sprd_vsp`, `/dev/sprd_coda7l` (misc registered = probe succeeded) | ⚠️ the driver is there, but **no program uses it** |
| JPG hardware codec | `/dev/sprd_jpg` | ⚠️ same as above |
| GSP 2D acceleration | `/dev/sprd_gsp` + `/dev/sprd_iommu_gsp` | ⚠️ same as above (blit/scaling/rotation/YUV→RGB) |
| ION memory allocator | `/dev/ion` + 3 ion-heap platform devices | ✅ usable (the GPU/VSP/GSP all depend on it) |

Supplement: `nproc = 2` (**only 2 cores online**, not 4), up to 1.3 GHz, 916 MB of memory.
The mplayer binary is at `/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer` (13.7 MB, not in the PATH).

---

## 2. Can the Mali-400 Be Brought Up: No

To use the GPU, all three layers must be present: **kernel driver → user-space EGL/GLES libraries → application**. Layer by layer:

### 2.1 Kernel Layer: It Can Be Lit Up (but It Is Not the Bottleneck)

```
mali.ko vermagic = 3.10.65 SMP preempt mod_unload modversions ARMv7
```

It is **exactly identical** to the current kernel (this machine is already running the stock Android kernel).
Therefore `insmod /lib/modules/mali.ko` will most likely succeed, `60000000.gpu` will bind the driver, and `/dev/mali` will appear.
**This step can be done, but it is useless** — see the next item.

### 2.2 User-Space Layer: a Deadlock (bionic vs musl)

The only Mali user-space DDK existing on the whole machine is in the Android partition:
`/mnt/android_sys/lib/egl/libGLES_mali.so` (1.2 MB, containing "Mali online shader compiler r6p0-01rel0").
The libraries it depends on:

```
libc.so(→ bionic)  libc++.so  libbinder.so  libcutils.so  libhardware.so
libion.so  liblog.so  libui.so  libutils.so  libboost.so  libapplist.so
```

→ it is a **bionic binary that musl cannot load**.
To rescue it, one would have to: set up a glibc chroot, then hand-craft bionic stubs, and also implement `libbinder` (Android IPC) — unrealistic.

### 2.3 The Open-Source mesa-lima Route: Also Blocked

Alpine has mesa installed (`libEGL.so` / `libGLESv2.so` / `libgbm.so` are all present), but:

- `/usr/lib/dri/` contains only `nouveau/r600/radeonsi/virtio_gpu_drv_video.so` — these 4 are
  **VA-API video drivers**, and there is **no `lima_dri.so`** (the open-source 3D driver for Mali-400/450);
- **Neither `/dev/dri` nor `/sys/class/drm` exists** — lima is a DRM driver that requires kernel 4.20+,
  and this machine runs 3.10.65. Porting would mean moving the entire DRM subsystem into 3.10, which is unrealistic.

**Conclusion: the Mali-400 cannot be brought up on this machine.** The kernel side can be lit up, but there is no usable user-space GL stack.

---

## 3. Even If the GPU Could Be Used, It Is Not the Cause of the Stuttering

- **The real cause of video stuttering is CPU software decoding**. Software-decoding H.264 (especially 720p / high profile / B-frames)
  on 2 cores at 1.3 GHz is certain to be too much to handle, and **the GPU does not do video decoding**.
- **Using the GPU for the UI (LVGL) would most likely be slower**: LVGL currently writes directly to fbdev and refreshes only dirty rectangles (a small area),
  which is the shortest path. Switching to GLES would require `glReadPixels` readback of the result before writing to fb — Mali-400 readback is extremely slow,
  a typical case of "acceleration that actually makes things slower".

---

## 4. The Two Pieces of Hardware That Should Really Be Used (Both Present and Already Probed)

### 4.1 VSP — Video Hardware Decoding (the Correct Solution to the "Stuttering")

The Android partition contains hardware codec OMX components:

```
libomx_avcdec_hw_sprd.so        H.264 硬解
libomx_m4vh263dec_hw_sprd.so    MPEG4 / H.263 硬解
libomx_vpxdec_hw_sprd.so        VP8/VP9 硬解
libomx_avcenc_hw_sprd.so        H.264 硬编
libomxvpu.so                    VPU 封装层
```

This proves that **hardware decoding capability really does exist**, and the kernel nodes `/dev/sprd_vsp` and `/dev/sprd_coda7l` are also in place.
But these OMX libraries are also bionic and cannot be used directly.

**The only way out**: write a user-space driver yourself, calling ioctl on `/dev/sprd_vsp` directly (a Spreadtrum-private ioctl that requires reverse engineering;
the workload is on the same order as the earlier FM ioctl reverse engineering), then feed it to mplayer/a self-built player.

### 4.2 GSP — 2D Acceleration (the Real Correct Solution for "Using It on the Display")

`/dev/sprd_gsp` + `/dev/sprd_iommu_gsp`, together with `/dev/ion` for buffer allocation, can do in hardware:

- **YUV → RGB color conversion**
- **arbitrary-ratio scaling**
- rotation, alpha blending, blit

Value for mplayer: it eliminates software scaling + color conversion (`-vf scale` / swscale),
which in software-decoded playback typically accounts for **30~50% of the CPU**, the second-largest cost after decoding.
For LVGL: full-screen composition is possible, but LVGL itself renders in software, so the benefit is limited.

---

## 5. What Can Be Done Immediately Without Touching the Kernel or Reverse Engineering (These Steps Are Recommended First)

1. **Quantify the bottleneck** (this decides which route to take later):
   ```sh
   cd /home/lvgl_demo/lvgl_demo/libs
   ./mplayer/mplayer -benchmark -vo null -nosound 你的视频.mp4
   ```
   - If pure decoding alone reaches ≥25 fps → the bottleneck is in **scaling/writing to fb**:
     **pre-transcode the video to a fixed 720x1280 resolution** before playing it (this eliminates runtime scaling and gives the biggest gain);
     or reduce the complexity of `-vf scale` (`-sws 0` is the fastest).
   - If pure decoding is only ~10 fps → the bottleneck is **decoding**: lower the specifications or use VSP hardware decoding.
2. **Pre-transcode to baseline specifications** (the least effort with a clear gain):
   H.264 **baseline**, no B-frames, 720x1280 (or 480x854), ≤1 Mbps, 24~25 fps.
   baseline has no CABAC and no B-frames, so software-decoding overhead drops substantially.
3. **Reduce the playback parameter load**: `-framedrop -nosound -noautoquality -vo fbdev`;
   audio decoding is also a real CPU cost on a 2-core machine.

---

## 6. Optional Follow-up Routes (Ranked by Cost/Benefit Ratio)

| # | Route | Gain | Cost |
|---|---|---|---|
| d | pre-transcoding + benchmark to locate the bottleneck | medium (very likely to solve the stuttering directly) | almost zero |
| b | reverse-engineer `/dev/sprd_gsp` for hardware scaling/color conversion | medium-high (noticeably easier video playback) | medium (ioctl reverse engineering + ION allocation) |
| a | reverse-engineer `/dev/sprd_vsp` for hardware decoding | high (fundamentally solves the decoding bottleneck) | large (analogous to FM ioctl reverse engineering) |
| c | `insmod mali.ko` to light up the kernel layer | **almost zero** (no usable user-space GL stack) | small, but **not recommended** |

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
