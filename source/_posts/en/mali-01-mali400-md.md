---
title: "Mali400_Working Process Summary"
date: 2026-09-30 16:44:04
lang: en
permalink: en/2026/09/30/mali-01-mali400-md/
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# Bringing Up the Mali-400 GPU on the Spreadtrum SC9832A — Working Process Summary

> This records the complete analysis path, key decisions, failed routes, and final solution from "Mali is unusable" to "GLES2 hardware rendering works + a standalone GPU benchmark program is usable".
> Timeline: 09-23 read-only survey (conclusion: "broken") → 09-29 major correction (it actually works) → 09-30 the bionic route got PSP hardware rendering working and landed the gpu_bench benchmark.

---

## 1. Task Background and Initial Goals

The device is a Spreadtrum SC9832A tablet that "keeps the Android 6.0 kernel (3.10.65) and switchroots to Alpine Linux", with a 720x1280 fb, 2 cores at 1.3GHz, and 916MB of memory. The user's goals:

> 1. Can the Mali-400 actually be used? Can it be used for display / video / UI?
> 2. Build a multi-scene 2D/3D GPU benchmark program modeled on LuMaster/3DMark, display the frame rate and score on screen, and place an icon entry on the desktop.

## 2. Analysis Framework: First Break "the GPU Is Usable" into Three Layers

Before starting, build a mental model — for the Mali-400 to be usable, all three layers must be connected:

```
① 内核驱动层   mali.ko 是否 insmod、/dev/mali0 是否出现？
② 用户态层     有没有可用的 EGL/GLES 库？musl 还是 bionic？
③ 应用层       程序怎么调用？回读怎么取像素？显示怎么上屏？
```

Each layer has a clear "verification criterion"; if a layer does not pass, investigate the next layer down.

## 3. The Assault Process (By Timeline)

### Phase A: 09-23 Read-Only Survey — Conclusion "Mali Is Unusable"

- `/dev/dri` and `/sys/class/drm` both do not exist; mesa has `libEGL.so` but no `lima_dri.so`; `mali.ko` is not loaded.
- The only Mali DDK, `libGLES_mali.so`, is a bionic binary that musl cannot load → conclusion: "it cannot be used; the GPU will not fix the stuttering".
- **Lesson**: the conclusion was drawn after checking only `/dev/dri` (the mesa/DRM route), missing the Mali proprietary driver path `/dev/mali0`.

### Phase B: 09-29 Major Correction — It Actually Works (the Key Turning Point)

- It was discovered that the Mali proprietary driver uses `/dev/mali0`, and the `mali.ko` module is on the machine itself (`/lib/modules/mali.ko`, 4.6MB, matching vermagic).
- `insmod /lib/modules/mali.ko` → `/dev/mali0` appears.
- Set up the bionic runtime environment: `/system/bin/linker` + `/system/lib` + an `egl/libGLES_mali.so` symlink.
- ★ Successfully **compiled a bionic program with musl gcc**: `-nostdlib -Wl,--entry=main -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib -lGLESv2 -lEGL`.
- Measured: `GL_RENDERER=Mali-400 MP`; GLES2 works; 480x272 clear + quad 300 times at **0.15ms per time = 864 Mpixel/s**; the same work with CPU software rendering takes **9.7ms → 65 times slower**.
- **The conclusion is reversed**: the real cause of the PSP stuttering is that we were using the CPU to do the GPU's work (SoftGPU), not that the CPU is inadequate.

### Phase C: 09-30 the bionic Route Got PSP Hardware Rendering Working

- The frontend `miniretro_psp_hw` (a bionic program compiled with musl gcc): EGL pbuffer + ES2 → `SET_HW_RENDER` → `glReadPixels` → R/B swap → `scale_rotate90` → FBIOPAN.
- core = `ppsspp_libretro_hw.so` (recompiled for bionic, with its own shim).
- Measured: game loading and Mali GLES2 produce images at **20~36fps** (the software-rendering ceiling is 10fps); in a clean environment 34~38fps (core total ~28ms: GL readback ~11.7 / scaled screen write ~9.1 / the core itself ~7).
- ★ The frontend must call `context_reset()` after `av_info`; otherwise `draw_=NULL` causes a segmentation fault.
- ★ Always judge liveness / kill processes by `/proc/<pid>/cmdline`: PPSSPP renames the main thread to `{Main}`, so `ps -o pid,comm|awk` is guaranteed to miss it.
- Remaining issue: freezing/random segmentation faults at the opening animation of commercial ISOs (already located with ptrace to an internal PPSSPP IO deadlock; not fixed).

### Phase D: Standalone Acceptance / Test / Benchmark Programs (Independent of PSP)

- `mali_check.c → /root/mali_check`: 7 acceptance items (mali0/EGL/RENDERER/gradient quad readback/fill rate/readback speed/CPU comparison) + an 8th item that scans the PSP maps.
- `gpu_test.c → /usr/local/bin/gpu_test`: a full-screen graphics test (triangle + grid, displaying `GPU:Mali-400 MP` / `FPS` / `READ` / `SCALE`), measured stable at **32.8fps**.
- `gpu_bench.c → /usr/local/bin/gpu_bench`: a 3DMark-like five-scene benchmark (2D SPRITE / 2D OVERDRAW / 3D PARTICLES / 3D TERRAIN / 3D SHADER), scored by pure GPU rendering time, with the total obtained by geometric mean; measured **6636~9052 (GOOD level)**.
- The desktop "GPU Test" icon → `/usr/local/bin/gpu_test` is symlinked to `gpu_bench`, and clicking it follows the `patch_launcher_gputest.py` pattern of yielding the fb.

### Phase E: the Unreliable-Readback Pit (Fatal for Display; Not Yet Fundamentally Fixed)

- Symptom: `glReadPixels` readback of clear/ordinary 2D quads on a pbuffer is **all black or stale red**; only large meshes with depth (TERRAIN) are occasionally correct.
- Four approaches have been verified as **all ineffective**: ① FBO offscreen rendering followed by readback ② removing glFinish and reading directly ③ eglSwapBuffers to force resolution ④ enabling GL_DEPTH_TEST globally.
- Root cause = **Mali TBDR lazy resolution + a pbuffer readback path defect** (the PSP frontend only produces images normally thanks to the PPSSPP core's internal flush; the `_gldump.c` minimal test is all black for any clear/draw and does not alias the fb).
- Consequence: the on-screen 3D/2D scenes go black, and only the HUD written directly to the fb by the CPU (frame rate/score/title) is visible; **the score and frame rate are unaffected** (the timing measures only render+glFinish, excluding readback).

## 4. Key Decisions and Lessons

| Decision point | Choice | Reason |
|---|---|---|
| Can Mali be used | insmod first and check /dev/mali0 | Do not check only /dev/dri; the proprietary driver has its own path |
| User-space GL stack | set up the bionic environment + compile bionic programs with musl gcc | the only DDK on the machine is bionic, and mesa has no lima |
| Architecture | the musl main program fork+execs a bionic child process | musl and bionic cannot coexist in the same process |
| On-screen output | readback not yet fundamentally fixed | the window-surface probe that renders directly to the fb crashes at the linker stage and remains to be resolved |
| Scoring | measure only render+glFinish | avoids contamination of the score by the unreliable readback |

**Lessons learned**:

1. Not finding `/dev/dri` does not mean the GPU is dead — check the proprietary driver path (`/dev/mali0`) first.
2. musl and bionic cannot coexist in the same process, but two processes can each use its own (the fork+exec architecture).
3. Readback (`glReadPixels`) on this Mali-400 + pbuffer combination is a display killer, not an accelerator; to produce images, prefer rendering directly to the fb.
4. The criterion must reach the very end: to tell whether Mali is really working, look at `GL_RENDERER` / `libGLES_mali.so` in maps / the `MaliWorker` thread, rather than a successful insmod.
5. The cross-compilation chain for standalone bionic programs is working; the key scripts/symbol completions are concentrated in `bionic_shim.cpp` and `_build_hw.sh` — reuse them first for new cases.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
