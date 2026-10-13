---
title: "Mali400 Principles and Porting Learning Wiki"
date: 2026-09-30 16:44:04
lang: en
permalink: en/2026/09/30/mali-05-mali400-wiki-md/
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# HT0 Mali-400 Principles and Porting Learning Wiki

> This document is not an operation manual, but a **principles lesson**: it explains clearly why this Mali-400 can run on this "Android kernel + Alpine user space" machine, how Android originally did it, why we changed it to the current design, and what every key line of code does.
> After reading it you should be able to: facing a Mali device with "an Android kernel + a different user space", analyze on your own how to light up the GPU.

---

## 0. One Sentence to Build Intuition First

> The Mali-400 is not a display controller, but a 3D rendering GPU that **requires a kernel driver + a user-space GL stack + a correct ABI bridge** to be lit up.
> Android uses a whole set of bionic services (SurfaceFlinger + hwcomposer + libGLES_mali) to set up this stack for you;
> we rewrote this stack **with a minimal cross-compilation bridge**, running on Alpine's musl user space.

---

## 1. What the Hardware Looks Like

This chip platform is the Spreadtrum SC9832A, and the GPU is the **Mali-400 MP** (ARM's Utgard architecture, OpenGL ES 2.0, TBDR tile rendering):

```
                ┌──────────────────────────────┐
                │       展讯 SC9832A AP        │
                │  ┌──────────┐   ┌───────────┐ │
                │  │ sprdfb    │   │ Mali-400  │ │
                │  │ (dispc)  │   │ (GPU)     │ │
                │  │ /dev/fb0 │   │ /dev/mali0│ │
                │  └────┬─────┘   └────┬──────┘ │
                └───────┼──────────────┼────────┘
                    扫描输出        渲染目标(buffer)
                    显示器          GPU 画进内存再由 dispc 显示
```

The two "output" paths have completely different roles:

| Component | What it does | What the user space sees |
|---|---|---|
| sprdfb / dispc | scans the pixels in memory to the screen | `/dev/fb0` (the final output port) |
| Mali-400 | computes 3D/2D graphics into a memory buffer | `/dev/mali0` + EGL/GLES |
| VSP | video hardware decoding (H.264 etc.) | `/dev/sprd_vsp` |
| GSP | 2D acceleration (scaling/YUV→RGB) | `/dev/sprd_gsp` + ION |

**Key insight**: the GPU **cannot take over the display** — it only draws images into a buffer, which dispc then displays. Android completes this final step with SurfaceFlinger's overlay layers; this machine does not have that set of things, so our programs must do "GPU draw → readback → write to fb" themselves.

---

## 2. The Three-Layer Model for GPU Usability (the Most Important Analysis Framework)

For any Mali to be usable, all three layers must be connected. **Each layer has an explicit "verification criterion"**; if it does not pass, stop and investigate at that layer; do not try randomly across layers.

```
① 内核驱动层   mali.ko 加载了吗？/dev/mali0 出现吗？
               验通：insmod rc=0；ls /dev/mali0 有设备节点
② 用户态层     有可用的 EGL/GLES 库吗？ABI 对得上吗？
               验通：eglInitialize 成功；GL_RENDERER=Mali-400 MP
③ 应用层       程序怎么调？像素怎么取？怎么上屏？
               验通：gpu_bench 出分；PSP 前端出画面
```

Almost every pitfall we hit this time was "mistakenly thinking it was at the upper layer, but it was actually stuck at the lower layer":

- RENDERER is not Mali → not a program error, but mali.ko was not insmod'ed (layer ①);
- a bionic program crashes before main → not a logic error, but a missing `-Wl,--entry=main` (layer ② compilation);
- the screen goes black → not a drawing error, but the pbuffer readback cannot get the frame under TBDR (layer ③ display).

---

## 3. Key Concepts Explained One by One

### 3.1 bionic vs musl — Why an ABI Bridge Is Needed

This machine's user space is Alpine's **musl libc**; and Mali's only DDK, `libGLES_mali.so`, is an Android **bionic libc** binary. The two have incompatible ABIs (symbol names, struct layouts, and time_t width all differ), so musl will crash if it `dlopen`s it directly.

**Our bridge**:

- the kernel reads the ELF's INTERP and automatically loads `/system/bin/linker` (the bionic dynamic linker), letting bionic programs run by themselves;
- compile with musl gcc but **do not link musl libc**; instead use `-nostdlib -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib -lGLESv2 -lEGL -lc` to link bionic's libc;
- a few musl-specific symbols (time64, errno, tls, getentropy, etc.) are stubbed with `bionic_shim.cpp`.

### 3.2 EGL pbuffer + GLES2 context — Where the GPU Draws

```c
// 创建离屏 pbuffer surface（不在屏幕上，画进内存）
EGLSurface surf = eglCreatePbufferSurface(dpy, cfg, NULL);  // cfg 含 EGL_DEPTH_SIZE,16
eglMakeCurrent(dpy, surf, surf, ctx);
// 之后所有 gl* 都渲染到这个 pbuffer 的默认 framebuffer
```

Both the PSP frontend and gpu_bench use this approach: the GPU renders the image into a pbuffer, then `glReadPixels` brings it back to the CPU, and finally it is scaled, rotated, and written to `/dev/fb0`.

### 3.3 glReadPixels Readback and TBDR Lazy Resolution (the Most Treacherous Point)

The Mali-400 is a **TBDR (Tile-Based Deferred Renderer)**: it cuts the screen into tiles and defers actually resolving the tiles into memory until `glFinish`/swap.

- On a pbuffer, **reading back at the wrong time means you cannot get this frame** — it manifests as clear/ordinary quad readback being all black or stale red, with only large meshes with depth (where the driver is forced to resolve early) occasionally correct.
- FBO / removing glFinish / eglSwapBuffers / enabling depth — four approaches have been verified as all ineffective; the root cause lies in the driver-layer TBDR + the pbuffer readback path, which the application layer cannot bypass.
- Countermeasure: the score timing measures only `render+glFinish` (excluding readback), so it is uncontaminated; to truly produce images, the approach must change to a "window surface that renders directly to the fb" (without readback).

### 3.4 Byte Order R/B Swap

`glReadPixels` reads back the **fb's true byte order**, which may be the opposite of the driver's internal order — per measurements with the PSP frontend: `g_swap_rb = 0` (**do not swap** R/B). After readback, simply write to the fb as `[R,G,B,X]`.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
