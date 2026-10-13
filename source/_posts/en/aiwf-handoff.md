---
title: "handoff_doubao_2026-10-10"
date: 2026-10-10 17:10:35
lang: en
permalink: en/2026/10/10/aiwf-handoff/
search: true
categories:
- AI工作流
- 方法论与资产
tag:
- AI协作
- 交接
---


# Handoff Document — PSP Hardware Rendering Recovery on the SC9832A Device (2026-10-10)

> Handoff recipient: Doubao. After reading this document, you can continue the work. Device = Spreadtrum SC9832A armv7l, Alpine chroot, 720x1280 portrait fb, LVGL 9.6 desktop + emulator/network TV.

## 1. Connection and Tools (Required Reading)

- The device accesses the Internet through the PC's ICS NAT: USB RNDIS (192.168.137.x) → PC → WiFi. Environment variable `DEV_IP` (currently 192.168.137.100).
- **Always use `ssh_tools/dev.py` in the project for SSH** (paramiko): `DEV_IP=192.168.137.100 python dev.py "<cmd>"`; to run a local script, `python dev.py --run <script> [timeout]`; to transfer files, `MSYS_NO_PATHCONV=1 python devput.py <local> <remote>` (**MSYS_NO_PATHCONV=1 is required**, otherwise Git Bash will eat the remote path). A bare `ssh` will be rejected (non-key-based login).
- ★ The local sandbox will SIGTERM long-running commands → **all SSH commands must complete in <20s**; run long tasks in the background with `--run`. Leaked killed SSH sessions will exhaust dropbear (symptom: TCP22 is reachable but the banner disconnects immediately; the only fix is to power-cycle the device).
- ★ The device's SFTP is broken → do not use dev.py --get to pull large files; use devput (inline base64) for text/small files.
- The device has python3.12, GNU ld 2.43.1 (no gold/lld), and gcc14 (upgraded via apk; artifacts from the new toolchain are not recognized by the old bionic linker, see §3).
- Screenshot: `ssh_tools/grab_screen.py <out.png>` (reads /dev/fb0).
- A black screen capture does not mean there is no picture: first use `python3` to pread /dev/fb0 and count the non-zero pixels on each page before drawing a conclusion.

## 2. Today's Main Achievement: PSP Hardware Rendering Recovered, Measured at 33fps

Background: PSP = `extern/miniretro/miniretro_psp_hw` (frontend) + ppsspp_libretro core. Previously, software rendering only achieved 20fps (cpu2/3 could not be brought up; only 2xA7). Today, hardware rendering (Mali-400) has been fixed, and screen captures confirm FPS:33.

### Three Root Causes (in the Order of Investigation)

1. **reloc type 17 = R_ARM_TLS_DTPMOD32**: when the new binutils 2.43 links old .o files, it no longer performs TLS GD→LE static relaxation → the old bionic linker rejects dlopen outright. We tried to eliminate TLS at the source (call_once→atomic, removing thread_local from sol.hpp, and a non-TLS `__cxa_get_globals` shim `/root/eh_shim.cpp` — **the shim must be linked before libstdc++.a**). The dynamic TLS relocs were cleared to zero, but the new core still crashed on dlopen in a constructor (binary search located init_array[0] = std::ios_base::Init from libstdc++'s globals_io.cc; the old core runs the same ctor fine, and the ctor chain problem with the new toolchain remains unsolved). **Conclusion: abandon the new core and fall back to the old core** (the one from the git HEAD 0af7630 era = the original that achieved 34-38fps back then, verified OK via dlopen). The currently deployed `extern/miniretro/ppsspp_libretro_hw.so` is the old core; the new core artifacts are at `/home/PSPgame/ppsspp_git/build_bionic/lib/ppsspp_libretro.so` (backup .bak_ctor0), and the TLS patch source has been saved to disk for the record.
2. **The real cause of the black screen (the biggest twist)**: this Mali DDK **reads back all zeros from an FBO (glReadPixels from FBO)** (the special path for glClear is also broken), and only the **default framebuffer (pbuffer) reads back correctly after a real draw**. Previously, the frontend was changed to a "self-created FBO → render to the FBO → read back" path, which was the main cause of the black screen. We have restored the verified 0af7630 path: `hw_get_current_framebuffer()` returns 0, `hw_present()` calls glReadPixels directly on the default surface, EGL_SURFACE_TYPE keeps only EGL_PBUFFER_BIT, and the fbo_setup/prog_make/window surface experiments have been removed (egl_setup is aligned with the historical version).
3. **PPSSPP useEmuThread**: when the GL backend is active, PPSSPP runs GL on its own thread, while the context is current on the frontend thread → all GL calls become invalid. The core source `libretro/libretro.cpp` around line 1492 has been patched with `useEmuThread = false;` (backup .bak_emuthread). Was the old core compiled before the patch? — Note: **the fact that the old core runs means that copy already contained equivalent logic or was compatible with the frontend thread model. The measured 33fps is the standard; do not touch it again**.

### Frontend Modified Files (on the device, not yet committed to git)

- `extern/miniretro/miniretro_psp_hw.c`: restored the direct fb0 read path + simplified egl_setup. Backup chain: `.bak_fb0` (before the FBO path change), `.bak_egl2`/`.bak_egl3` (before/after the egl simplification).
- Build: `cd extern/miniretro && sh build_hw.sh` (bionic recipe: -nostdlib + /root/bionic_shim.o + -L/system/lib -lEGL -lGLESv2).
- The source files are mostly LF with a small amount of CRLF mixed in → **when modifying code, use python byte-level anchor replacement, not line numbers** (it will blow up).
- Debug environment variables: `MINIRETRO_SHOW_FPS=1` (on-screen fps overlay), `MINIRETRO_DUMP=1` (dump the Nth frame to /tmp/fbo.raw and /tmp/fb_dst.raw).

### Startup Command (for Testing)

```
cd /home/lvgl_demo/lvgl_demo/extern/miniretro
MINIRETRO_SHOW_FPS=1 timeout -k 3 30 ./miniretro_psp_hw ./ppsspp_libretro_hw.so /home/lvgl_demo/lvgl_demo/sdcard/game/psp/9100053.iso
```
Game directory `/home/lvgl_demo/lvgl_demo/sdcard/game/psp/` (9100053.iso, Cube 旋转立方体.pbp, etc.).

## 3. ★★ Mandatory Checklist After Reboot (Skipping It Is All Pitfalls)

1. **Default route**: run `route add default gw 192.168.137.1` on the device (otherwise it cannot reach the external network).
2. **ICS rebinding on the PC side**: after RNDIS re-enumerates, run `outputs/_ics_rebind.ps1` on the PC. Criterion: GW_OK+EXT_FAIL means ICS has dropped.
3. **mount p17**: `mount -r /dev/mmcblk0p17 /mnt/android_sys` (after a reboot, the stamp fallback of gpu_env_ensure **does not take effect**; if not mounted → /system/lib/libEGL.so link breaks → EGL fails and silently falls back to software rendering at 20fps).
4. **insmod mali**: `insmod /lib/modules/mali.ko` (hardware acceleration is off by default and the app does not pull in the driver; if not loaded, it likewise silently falls back to software rendering).
5. Distinguishing hardware/software rendering: the on-screen FPS overlay shows ~33 for hardware rendering and ~20+frameskip for software rendering; in the logs, `video_cb pitch=0` means hardware rendering and pitch=1920 means software rendering.

## 4. New Pitfalls Encountered Today (High Reuse Value)

- **fb mmap disconnection**: after the fb driver was tossed around by multiple FBIOPAN/FBIOPUT experiments, **writes from a new process's mmap of /dev/fb0 no longer reach the real video memory** (pread returns all zeros, and memset is also ineffective). **A reboot restores it**. Diagnosis: use python `os.pwrite/pread` via the file path to verify read/write consistency, then compare with the dump from the process's own mmap.
- FBIOPAN requires the **real fb_var_screeninfo** (yoffset is at struct offset 20, yres@4, yres_virtual@12); a fake short structure will crash the kernel (restating an old pitfall).
- The bionic bare-probe trio: `_start` (`exit(main())`) + /root/bionic_shim.o + correct sigaction (**bionic's sigset_t is only 16 bytes**; laying it out as glibc's 128B will hijack it). See /tmp/dlprobeA.c for reference.
- A bionic bare main has no libc_init → dlopen of libEGL works, but the linker's subsequent initialization may fault at 0x30 — probe conclusions must be verified in the environment where "libGLESv2 is dlopened first, then the core" (the /tmp/dlprobe9.c pattern).
- `pidof` can match zombie processes (busybox looks at comm); service health checks must always use functional ground truth (socket/file/data). This old pitfall was already overhauled once on 10-10.
- The frontend process will swallow the TERM from `timeout` and not exit → always use `timeout -k 2 <N>`.
- Remember to clear the field of pgrep/stale processes first (`kill -9` leftover miniretro processes) before testing, otherwise the screen capture will catch old frames.

## 5. Other Current Status of the Device (Parts Settled on 10-10; Do Not Re-Step on Them)

- WiFi/Bluetooth switch-style power-on has been committed and pushed (`eb755bd`). marlinba must be a real directory (a symlink means RF fail and no frames can be sent). Fix wifi with `outputs/_fixwifi.sh`.
- The removal of Mali scripting has been implemented but not committed: 01_mali.start has been deleted; the bionic environment = `lv_hardware/gpu_env.c gpu_env_ensure()` + section 7 of deploy.sh; mali.ko = the "Hardware Acceleration" (硬件加速) switch on the settings page (off by default). **When testing hardware rendering with the PSP frontend, insmod manually (see §3.4)**.
- Half of the old conclusion about the PSP hardware-rendering black screen (_winsurf direct rendering to be done) is void: the pbuffer read-back path has been tested and works today, while the window surface (feeding eglCreateWindowSurface with fbdev_window) still segfaults (the DDK is an ANativeWindow variant).
- Touch: this device has no touch (no kernel driver, i2c not bound); it only has 3 buttons.
- git: the only repository is on the device at /home/lvgl_demo/lvgl_demo (gitee javaren/wxb_lvgl, master), and pushes go through push_via_bundle.py + GITEE_TOKEN. Commits must obtain the user's consent with a "file list + Chinese description".

## 6. To-Do (by Priority)

1. **Cube 旋转立方体.pbp black screen at 20fps**: the logs show pitch=0 (hardware rendering is running) but the read-back is black and fps drops to 20. It is suspected that this demo's render target/depth usage has fallen into the DDK's FBO black hole. You can first try `MINIRETRO_DUMP=1` to see whether it reads back from the FBO or the default surface.
2. **Occasional silent exits of the frontend (RC=0, irregular at ~10-30s)**: occurred multiple times today, with no tombstone and not a crash. Suspected directions: a conditional break in the retro_run main loop / EGL surface lost callback. Add logging to capture the exit path.
3. **git commit**: after confirming stability, commit miniretro_psp_hw.c (fb0 path restored) + a note documenting the source TLS patch. Before committing, list the file list and obtain the user's consent.
4. deploy package consistency: confirm whether miniretro_psp_hw.c in deploy/ needs to be updated in sync.
5. (Long term) if you want to attack the new core's ctor crash again: compare the .init_array entries of the new and old .so against their TUs and cut them one by one with -fno-; the cost-performance ratio is not high.

## 7. Quick Reference for Key Paths

| Item | Path |
|---|---|
| Frontend source/build | On the device /home/lvgl_demo/lvgl_demo/extern/miniretro/ (build_hw.sh) |
| PPSSPP source/build tree | /home/PSPgame/ppsspp_git (build_bionic/, incremental) |
| Old core original | extern/miniretro/ppsspp_libretro_hw.so at git HEAD |
| Currently deployed core backup | extern/miniretro/ppsspp_libretro_hw.so.bak_tls |
| bionic shim | /root/bionic_shim.cpp/.o, /root/eh_shim.cpp (non-TLS __cxa_get_globals) |
| dlopen probes | /tmp/dlprobe{2..A}.c (dlprobe9 = the correct way to load GLES first) |
| WiFi fix script | Local outputs/_fixwifi.sh; ICS rebind outputs/_ics_rebind.ps1 |
| Today's complete log | Local .workbuddy/memory/2026-10-10.md |
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
