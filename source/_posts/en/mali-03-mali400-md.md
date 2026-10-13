---
title: "Mali400_Troubleshooting Manual"
date: 2026-09-30 16:44:04
lang: en
permalink: en/2026/09/30/mali-03-mali400-md/
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# Spreadtrum SC9832A Mali-400 GPU Troubleshooting Manual — spd-box

> **Purpose**: use this manual to locate root causes when Mali/GPU programs fail to start, RENDERER is wrong, readback is black, or bionic programs crash. Every command line is taken from measurements on the actual device.
> **How to use**: first look at the §1 layered quick-reference master table to locate the layer → jump to the corresponding section → confirm with the "locating commands" → handle it according to "fix".
> **Companion documents**: the principles Wiki (§3 concepts) and the working process summary (phase B/E decisions) are the condensed versions; this article is the full version.

---

## 0. Troubleshooting Discipline (Read First; Violating It Wastes Time)

1. **Locate by layer; do not try randomly across layers**: ① kernel (mali.ko→/dev/mali0) → ② bionic environment (linker/lib/symlinks) → ③ compilation (musl gcc compiling bionic) → ④ application (gpu_bench/gpu_test/PSP frontend) → ⑤ readback/display (glReadPixels/TBDR). Whichever layer fails, investigate only that layer and its upstream.
2. **Look at the symptom before looking at processes**: if RENDERER is wrong, run `/root/mali_check` first; for a crash, look at `dmesg | tail` first.
3. **Always match processes by `/proc/<pid>/cmdline`**; the `ps -o pid,comm|awk` pattern is forbidden (PPSSPP's main thread name is `{Main}`, so it is guaranteed to be missed).
4. **bionic programs should output with `write(1,...)`, not `printf`** (on abort the buffer is lost and the scene cannot be seen).

---

## 1. Layered Failure Quick-Reference Master Table (One-Page Location)

| Symptom | Most likely root cause | Locating command | Section |
|---|---|---|---|
| `GL_RENDERER` is not Mali-400 MP / EGL initialization 0x3001 | mali.ko is not insmod'ed or the egl symlink is missing | `ls -la /dev/mali0; ls -l /system/lib/egl/` | §2 |
| `insmod mali.ko` fails | vermagic mismatch / module not present | `modinfo /lib/modules/mali.ko \| head` | §2 |
| a bionic program crashes as soon as it runs (before main) | missing `-Wl,--entry=main` | `readelf -l <bin> \| grep interpreter` | §3 |
| link error `__clock_gettime64 undefined` | musl 64-bit time_t redirection | `nm <bin> \| grep clock_gettime` | §3 |
| an infinite loop burning CPU inside dlopen | the exe's export table contains mmap/lseek etc. | `nm -D <bin> \| grep -E ' mmap\|lseek'` | §3 |
| on-screen scenes go black, with only the HUD visible | pbuffer glReadPixels is unreliable (TBDR) | look at the center pixels in the gpu_bench dump log | §5 |
| readback is all black/stale red | TBDR resolution was not triggered | run the `_gldump.c` minimal test | §5 |
| the desktop "GPU Test" icon launches the old program | gpu_test is not symlinked to gpu_bench | `ls -l /usr/local/bin/gpu_test` | §4 |

---

## 2. Kernel / Driver Layer (① mali.ko → /dev/mali0)

### 2.1 RENDERER Is Not Mali-400 / EGL_NOT_INITIALIZED

- **Locating**: `ls -la /dev/mali0`; `ls -l /system/lib/egl/` should have the `libGLES_mali.so` symlink; check items 1~2 with `/root/mali_check`.
- **Fix**:
  ```sh
  insmod /lib/modules/mali.ko            # rc=0 才继续
  ls -la /dev/mali0                      # crw-rw---- 10, 22
  mkdir -p /system/bin /system/lib/egl
  cp /tmp/aand/system/bin/linker /system/bin/linker
  for f in /tmp/aand/system/lib/*.so /mnt/android_sys/lib/*.so; do ln -sf "$f" /system/lib/; done
  ln -sf /mnt/android_sys/lib/egl/libGLES_mali.so /system/lib/egl/
  ```
- **Note**: do not run `/system/bin/linker xxx` manually — with argv[0] being the linker, it prints a helper hint and exits; let the kernel read INTERP and load the linker automatically (by executing the program directly).

---

## 3. User-Space bionic Compilation Layer (③ musl gcc compiling bionic)

### 3.1 A Program Crashes as Soon as It Runs (before main)

- **Root cause**: with `-nostdlib`, ld's default entry point is the first byte of .text.
- **Fix**: add `-Wl,--entry=main` to the compilation.

### 3.2 `__clock_gettime64` undefined

- **Root cause**: musl's 32-bit time_t is 64 bits while bionic's is 32 bits, so clock_gettime is renamed.
- **Fix**: implement it yourself with `{long tv_sec; long tv_usec;}` + `syscall(78, &t, 0)` (see `bionic_shim.cpp`).

### 3.3 An Infinite Loop Inside dlopen (Burning CPU)

- **Root cause**: the exe's `--version-script` exports `mmap/lseek/ftruncate/fseeko/ftello`, hijacking bionic's internal calls of the same names → argument misalignment and an infinite loop.
- **Fix**: put these symbols only in the shim linked by the core itself; **the exe's export table must never contain them** (self-check with `nm -D <bin>`).

### 3.4 Other Symbols the Shim Must Provide

`__dso_handle` / `__errno_location` / `__tls_get_addr` / `__nanosleep_time64` / `getentropy` / `secure_getenv` (verified in the device's `bionic_shim.cpp`).

---

## 4. Application Layer (④ gpu_bench / gpu_test / PSP Frontend)

### 4.1 The Desktop Icon Launches the Old Program

- **Locating**: `ls -l /usr/local/bin/gpu_test` (it should be symlinked to gpu_bench).
- **Fix**: `ln -sf /usr/local/bin/gpu_bench /usr/local/bin/gpu_test`.

### 4.2 Abnormally Low Score / Frame Rate Displayed but Scenes Are Black

- See §5 (a readback problem that does not affect score timing).

---

## 5. Readback / Display Layer (⑤ glReadPixels / TBDR) — Known to Be Unsolvable; Understand This First

### 5.1 On-Screen 3D/2D Scenes Go Black, with Only the HUD Visible

- **Root cause**: Mali TBDR lazy resolution + a pbuffer readback path defect, so `glReadPixels` cannot get the current frame (clear/2D quads are all black or stale red; only large meshes with depth are occasionally correct).
- **Four approaches tried, all ineffective**: FBO offscreen rendering followed by readback / removing glFinish and reading directly / eglSwapBuffers / enabling depth globally.
- **Countermeasure (current)**: the score and frame rate are based on `render+glFinish` timing, unaffected by readback, so benchmarking remains usable; the on-screen image awaits a fundamental fix via an "EGL window surface that renders directly to the fb" (the `_winsurf` probe crashes at the bionic linker stage and remains to be resolved).
- On exit, `fb_restore()` unconditionally flips back to page 0, so the desktop can be restored.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
