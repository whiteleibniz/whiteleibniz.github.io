---
title: "Mali400_New Application Integration Manual"
date: 2026-09-30 17:52:17
lang: en
permalink: en/2026/09/30/mali-04-mali400-md/
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# Spreadtrum SC9832A Mali-400 — New Application Integration Manual

> Scope: making a **new App** use the Mali-400 GPU.
> Prerequisites: the Alpine/musl root system + `mali.ko` loaded + the `/system` skeleton ready (prepared automatically by `/etc/local.d/01_mali.start`).
> Verification time: 2026-09-30; a live run of `/root/mali_check` is all green.

---

## 0. One-Sentence Process

**A new App using the GPU = compile it into a bionic program → get a context from an EGL pbuffer → draw with GLES2 → output images/readback as needed → (optionally) add a desktop icon.**

The only awkward point to get used to: you must use **musl gcc to compile an ELF that runs on the bionic dynamic linker** (see §2 for details), because the EGL/GLES libraries are Android's.

---

## 1. Pre-checks (First Check Whether the GPU Is Ready)

```bash
lsmod | grep mali                 # 应有 mali 模块
ls -l /dev/mali0                  # 设备节点要存在
ls -l /system/lib/libEGL.so /system/lib/libGLESv2.so /system/bin/linker
timeout -s TERM -k 2 10 /root/mali_check     # ★ 一键验收工具，全绿才算就绪
```

**What you must see (measured on this machine)**:

```
/dev/mali0 : 可打开 ✔  |  mali 内核模块 : 已加载 ✔
EGL_VENDOR : Android  | EGL_VERSION : 1.4 Android META-EGL
1280x720 pbuffer + ES2 context : 就绪 ✔
```

> If `mali.ko` is missing: `insmod /lib/modules/mali.ko`; if the `/system` skeleton is missing: `01_mali.start` sets it up automatically (it also creates `/dev/mali0` etc.).
> `WARNING: linker: unused DT entry / unsupported flags` is a **harmless** warning and can be ignored.

---

## 2. The Only Correct Compilation Method (musl gcc → bionic)

```bash
gcc -O1 -march=armv7-a -mtune=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard -I/usr/include \
    -nostdlib -Wl,--entry=main -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib \
    <app>.c /root/bionic_shim.o -L/system/lib \
    -lEGL -lGLESv2 -lc -lm -ldl -lgcc -o <app>
```

**Must be followed**:
- `-Wl,--entry=main`: **omitting it causes a crash** (without crt, ld's default entry point is the first byte of `.text`).
- `-nostdlib` + `--dynamic-linker=/system/bin/linker` + `-rpath=/system/lib`: the complete bridging trio; none can be omitted.
- Link `/root/bionic_shim.o` (already present, 10592 B) to patch the musl↔bionic ABI differences.

**Self-check After Compiling (Must Be Empty)**:

```bash
nm -D <app> | grep -E ' (mmap|munmap|lseek|fseeko|ftello|ftruncate|open|close)$'   # 应无输出
```

Any output means the exe exported the shim symbols → dependent libraries will bind the musl-ABI `mmap`, causing an **infinite loop**.

---

## 3. Code Skeleton (EGL + GLES2)

```c
#include <EGL/egl.h>
#include <GLES2/gl2.h>

EGLDisplay dpy; EGLSurface surf; EGLContext ctx;

EGLint cfg_attr[] = {
    EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,        /* ★ 必须 pbuffer */
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,     /* ★ ES2 */
    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
    EGL_DEPTH_SIZE, 16,                          /* 3D 场景才需要 */
    EGL_NONE
};

dpy  = eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(dpy, &major, &minor);              /* 实测 EGL 1.4 */
eglChooseConfig(dpy, cfg_attr, &cfg, 1, &n);
eglCreatePbufferSurface(dpy, cfg, (EGLint[]){EGL_WIDTH, RW, EGL_HEIGHT, RH, EGL_NONE});
eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, (EGLint[]){EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE});
eglMakeCurrent(dpy, surf, surf, ctx);
glViewport(0, 0, RW, RH);

/* ... 建 shader、上传顶点、每帧 draw ... */

glFinish();            /* 计时用；本帧 GPU 真正画完 */
```

**Key points**
- The pixel format measured on this machine: **RGBA 8888** (`R8 G8 B8 A8`); with depth, the cfg reports `depth=24 stencil=8 samples=0`.
- **Keep the internal resolution as small as possible**: `glReadPixels` is only **~55MB/s**, and the cost is proportional to the pixel count (720p is about 68ms, 480x272 about 9.3ms). An internal 360x640 scaled up to 720x1280 with `scale_to_fb` is recommended — this is the **most effective** lever for raising the frame rate.
- Full-screen quad: `glDrawArrays(GL_TRIANGLE_STRIP,0,4)` **draws nothing** on this machine; you must use `glDrawElements(GL_TRIANGLES,6,GL_UNSIGNED_SHORT,idx)`.

---

## 4. Three Output Modes (Choose According to Your Needs)

| Mode | Approach | Applicable to | Notes |
|---|---|---|---|
| **A offscreen / benchmark / filter** | pbuffer rendering → `glFinish()` timing → (optional) `glReadPixels` to save to disk | evaluation, GPU computation, no real-time output needed | **the score is unaffected by readback** (the timing counts only render+finish) |
| **B full-screen exclusive output to the screen** | rendering → readback → `scale`/`rotate90` → write frames via `mmap(/dev/fb0)` → `FBIOPAN` page flipping; **unconditionally return to page 0 on exit** | emulators/players/full-screen Apps | ⚠️ see the "readback pit" below |
| **C software fallback** | Mesa software rendering (without Mali) | fallback/debugging comparison | not GPU; performance is 1~2 orders of magnitude worse |

**⚠️ The readback pit (the most fatal one on this machine)**: `glReadPixels` on a pbuffer is **unreliable** — readback of a pure clear or an ordinary 2D quad becomes **all black/stale red**, and only large meshes with depth (TERRAIN) are occasionally correct. **Four approaches have been verified as all ineffective**: switching to FBO offscreen rendering / removing `glFinish` / adding `eglSwapBuffers` / enabling depth globally. The root cause is Mali's **TBDR lazy resolution** + a pbuffer readback path defect.

**Countermeasures**:
- To output images → **copy the implementation that has already produced images**: the display section of `_tmp/miniretro_psp_hw.c` (pbuffer → readback → `scale_rotate90` → `FBIOPAN`, measured at **34~38fps with images**). It relies on the PPSSPP core's internal flush to trigger resolution, and is currently the **only route that has truly produced images** on this machine.
- HUD / text / frame rate: **writing directly to the fb with the CPU is always visible** and unaffected by readback → using the GPU for the scene area and the CPU for text overlay is the **most stable combination** at present.
- If a fundamental solution is desired in the future: see Options ①/② in "Mali400_Feasibility Analysis of Dropping Android" (switch to the Linux DDK or Mesa Lima + add DRM).

---

## 5. Desktop Icon Integration (Making the App Clickable)

**Key fact**: the external `app.ini` mechanism **only scans; it has no click branch**; to make it clickable, the launcher's built-in array must be modified.

1. Edit the built-in **`s_apps[]`** in `/home/lvgl_demo/lvgl_demo/lv_pages/launcher_page.c` on the device and add a new entry (icon/name/command).
2. To launch a full-screen external program, copy the pattern of `psp_game_page.c`: **pause LVGL → release the input grab → interceptor → wait child thread → unconditionally `FBIOPAN` back to page 0 on exit** (idempotent; otherwise the desktop cannot come back).
3. Re-run `make` to deploy lvgl_demo.
4. **A labor-saving shortcut**: the existing `GPUTEST_BIN` entry is already hardcoded to `/usr/local/bin/gpu_test`; **symlink** it to your App to reuse the existing icon entry (this is how gpu_bench was hooked up this time):
   ```bash
   ln -sf /usr/local/bin/<app> /usr/local/bin/gpu_test
   ```
5. ⚠️ **Stop the watchdog before debugging** (it starts lvgl_demo every 5s); otherwise your changes will be overwritten immediately.

---

## 6. Pits You Must Avoid (the Blood, Sweat, and Tears List)

| # | Pit | Symptom | Avoidance |
|---|---|---|---|
| 1 | missing `-Wl,--entry=main` | crashes as soon as it runs | it must be in the build command |
| 2 | the exe exports the shim symbols | `mmap` is bound to the musl ABI → **infinite loop** | compile the shim with `-fvisibility=hidden` (`#pragma` cannot be used) |
| 3 | `__dlsym_time64` self-reference | musl redirects `dlsym` back to it → a `b .` infinite loop | bypass it with `__asm__("dlsym")` |
| 4 | using `thread_local` | bionic does not recognize the TLS reloc | remove it; cores already modified with `_patchtls.py` need to be re-patched |
| 5 | doing heavy work in a global constructor | crash during construction; **zeroing the constructor = suicide** (RELATIVE turns 0 into an ELF header → calling the magic number raises SIGILL) | point the constructor at a harmless function; short-circuit at the source level when necessary (e.g., ArmCPUDetect) |
| 6 | using `printf` for diagnostic output | the buffer is lost on abort, so **the scene cannot be seen** | use `write(1,...)` |
| 7 | using `ps -o pid,comm` to judge liveness | PPSSPP renames the main thread to `{Main}` → **guaranteed to be missed** (once accumulated 7 zombie instances that filled the CPU) | always look at `/proc/<pid>/cmdline` |
| 8 | not applying patches after relinking | core crashes / TLS errors | ppsspp-like cores need patches re-applied after relinking: `.py`(libpng/z) + TLS + ctor patch (addresses drift with linking; re-check with `nm`) |
| 9 | the libretro frontend omits the `context_reset()` call | `draw_=NULL` → segmentation fault in the DrawEngineGLES ctor | it must be called after `av_info` |

---

## 7. Reference File List (Objects to Copy)

| Purpose | File | Description |
|---|---|---|
| GPU readiness self-check | `/root/mali_check` (source `ssh_tools/mali_check.c`) | one-click acceptance; run it first |
| complete benchmark/multi-scene/HUD skeleton | `/root/gpu_bench.c` (`ssh_tools/gpu_bench.c`) | 5 scenes + real-time fps + a results page + `fb_restore()`; the most suitable App template |
| **the only full-screen pipeline that truly produced images** | `_tmp/miniretro_psp_hw.c` | readback→`scale_rotate90`→`FBIOPAN`, measured at 34~38fps |
| bionic bridge | `/root/bionic_shim.o` (source `bionic_shim.cpp`) | must be linked during compilation |
| deployment/build script | `ssh_tools/deploy_bench2.py` | upload→compile→atomic replacement→symlink; modify it as needed |
| icon entry | `ssh_tools/patch_launcher_gputest.py` | the `GPUTEST_BIN` entry + the fork/exec/wait/return pattern |
| troubleshooting | `ssh_tools/mali400_docs/Mali400_故障排查手册.md` | layered quick reference |
| dropping Android | `ssh_tools/mali400_docs/Mali400_摆脱安卓可行性分析.md` | the root cause of and the way out of the readback pit |

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
