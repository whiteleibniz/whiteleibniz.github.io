---
title: "PSP Hardware Rendering Recovery Postmortem: From 20fps to 33fps"
date: 2026-10-12 18:00:00
lang: en
permalink: en/2026/10/12/psp-hardware-rendering-recovery/
search: true
categories:
- 排障手记
tag:
- PPSSPP
- Mali
- ARM
- bionic
---

# Background

I have a Spreadtrum SC9832A Linux device (2x Cortex-A7 @1.3GHz, Mali-400 MP1, 720x1280 portrait screen) running a homemade LVGL desktop plus a libretro emulator frontend. PSP emulation goes through the ppsspp_libretro core plus the in-house miniretro frontend, which had always used software rendering at only 20fps. Historically (in an earlier firmware version) hardware rendering was measured at 34-38fps, so the goal was clear: restore hardware rendering.

# Symptoms and Investigation Path

The investigation went through three layers of root causes, each deeper than the last. The process is recorded below in the hope that others will avoid the same detours.

## Layer 1: reloc type 17, the new core fails to load

I tried rebuilding the core with the newly upgraded toolchain on the device (gcc14 + binutils 2.43), and dlopen directly reported `unknown reloc type 17`. After checking the relocation table of the final .so entry by entry, I confirmed that type 17 is `R_ARM_TLS_DTPMOD32` — a TLS dynamic relocation.

The root cause is not that the newly compiled .o files introduced TLS, but rather: for the same batch of .o files, the old binutils performs a static convergence of TLS GD (global-dynamic) to LE (local-exec) at link time, so the final artifact contains zero dynamic TLS relocations; the new binutils 2.43 no longer performs this convergence, so 4 DTPMOD32 entries remain in the dynamic relocation table, while the old Android bionic linker on the device does not support dynamic TLS at all.

I made three attempts:

1. Changed the 4 `std::call_once` sites to atomic flag swaps, and removed the `thread_local` declarations from the sol2 headers;
2. Provided a non-TLS version of the `__cxa_get_globals` shim to prevent the linker from pulling in eh_globals.o (the TLS implementation) from libstdc++.a — note that the shim must participate in linking **before** libstdc++.a; placing it afterwards causes multiple definitions;
3. Tried rebuilding with `-ftls-model=local-exec`, which the linker rejected with `R_ARM_TLS_LE32 not permitted in shared object` (local-exec cannot be used in shared libs).

After all of the above, the dynamic TLS relocations were indeed cleared to zero, but the new core still crashed at dlopen. Using bisection to disable the constructors in init_array, I located the crash to the global construction of `std::ios_base::Init` in libstdc++; yet the same constructor runs fine in the old core. There is a deeper incompatibility between the new toolchain's constructor chain and the old bionic linker, and I decided not to dig further — **the old core was intact all along, so roll back**.

## Layer 2: The FBO Readback Black Hole

After switching back to the old core, the GL backend activated, but the screen was completely black, with non-black pixels accounting for 0.08% of a captured frame. Here I took the longest detour: previously I had changed the frontend to a path of "custom FBO -> PPSSPP renders into the FBO -> glReadPixels reads it back -> software scaling and rotation -> write to the framebuffer", and had added various elimination experiments such as POT textures, cache flushing, and rmmod/insmod.

The final verdict came from a purpose-built EGL probe program: **on this Mali DDK, content read back from an FBO via glReadPixels is always 0 (even glClear fails), but reads from the default framebuffer (pbuffer) after a real draw work correctly**. In other words, the old frontend from the 0af7630 era that worked back then already had `hw_get_current_framebuffer()` returning 0 and was reading the default surface all along — I broke it myself later.

Fix: restore the frontend to the historically verified path — direct FB0 reads, EGL_SURFACE_TYPE keeping only PBUFFER_BIT, and delete the entire custom FBO code path. An image appeared immediately.

## Layer 3: useEmuThread and the GL Context

The libretro glue of PPSSPP has a piece of logic: when the GL backend is active (`GetGPUCore() == GPUCORE_GLES`), it enables EmuThread, moving all GL calls onto the core's own thread. But the EGL context is current on the frontend thread, so all GL calls become invalid. A one-line fix in the core source: `useEmuThread = false;`. This problem does not exist on the old core (that build already handled it equivalently), but if you rebuild the core, this is a pit you will certainly step into.

# Additional Pitfalls

- **fb mmap disconnection**: after the fb driver was repeatedly stressed by FBIOPAN/FBIOPUT experiments, a new process's mmap of /dev/fb0 could no longer reach real video memory (pread reads back all zeros, even memset has no effect); only a reboot restored it. Diagnosis method: use python's `os.pwrite/os.pread` via the file path to verify read/write consistency, then compare against the contents of the process's own mmap region.
- **Silently falling back to software rendering after reboot**: after a device reboot, you must `mount` the Android partition (to ensure the EGL library link chain under /system/lib exists) + `insmod mali.ko`, otherwise EGL initialization fails and the frontend silently falls back to software rendering — the only visible symptom is fps dropping from 33 to 20.
- **bionic sigset_t is only 16 bytes**: when installing a signal handler in a bare bionic probe, laying out the sigaction struct according to glibc's 128-byte layout will silently fail.
- **bionic linker rejects local-exec**: `R_ARM_TLS_LE32` compiled with `-ftls-model=local-exec` in a shared library is not permitted, so the TLS fix can only follow the route of "eliminating TLS at the source".

# Results

With the old core plus the restored frontend, measured 33fps (software rendering 20fps), a 65% performance improvement. Remaining issue: a few games (such as a rotating cube demo) still show a black screen under hardware rendering, and I suspect their render target usage falls into the FBO black hole; to be investigated.

# Methodology Summary

1. Before changing the frontend GL logic, first write a standalone EGL probe to empirically establish "which paths on this GPU are healthy", then touch the main program.
2. When dlopen fails, first look at the dynamic relocation type histogram; a diff of the ELF metadata between the old and new artifacts often gives the answer directly.
3. "Black on screen" does not mean "no image": first count the non-zero pixels of each framebuffer page, then distinguish the three cases of "not rendered", "readback failed", and "page flip failed".

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
