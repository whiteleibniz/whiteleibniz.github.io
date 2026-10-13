---
title: "ref_Emulator_Rendering and Exit"
date: 2026-09-29 18:05:26
lang: en
permalink: en/2026/09/29/ref-emulator-render/
search: true
categories:
- 多媒体与模拟器
- 模拟器通用
tag:
- 模拟器
- 渲染
---


# Reference (Details) — Game Emulator: Rendering Pipeline and Exit Strategy

> Split out from `MEMORY.md §11` to avoid exceeding the main note's size limit. The conclusion-level summary remains in MEMORY.md.
> Original evidence: `AI工作流/bugfix/bugfix_20260923_09~14*.md`, `outputs/bugfix_20260923/`, Skill `child-exit-hang-diagnosis`

## A. Five Pitfalls of the Rendering Pipeline (empirically verified; read before changing `video_cb` / `scale_rotate90`)

1. **240x160 must be allowed through** (the original hardcoded 256x240 filter causes all GBA frames to be dropped = black screen);
   **must read line by line according to pitch** (mGBA pitch=512=256px/line, width only 240; linear reads produce vertical stripes)
2. **Double-buffered page flipping fixes tearing**: render the entire frame to the back page, then `FBIOPAN_DISPLAY`; `FBIO_WAITFORVSYNC` returns EPERM on this machine and is unusable
   → **this is exactly the source of the "page flip landmine"** (see MEMORY.md §3)
3. **★ R/B swapping may only happen once across the whole chain** (internal `0xAARRGGBB`, swap once before writing) → swapping twice = red and blue inverted
4. **The real audio rate ≠ the rate reported by the core**: mGBA reports 32768, but each `retro_run` actually delivers 1097 frames (≈65536Hz) → converting by the reported value overproduces by a factor of two
   truncation = continuous crackling. The correct solution is `s_fpc × s_fps_meas`; buffer ≥8192 int16; **stay silent for the first 300ms** (the first frame has only 82 frames, which would miscompute the ratio and flood the fifo)
5. **★ CPU is pegged at 100%, the miniretro ceiling is ≈56fps** (<59.73) → audio can only be stretched to real time according to the measured frame rate, with the pitch about 6% lower

## B. Exit Strategy (finalized v3 + unconditional page flip = bugfix 16 / 18)

- **The only hard criterion: the child process has truly disappeared**. Both pages always **block on `waitpid`, with no upper limit, no flag, and no timeout**
  (FC's `fc_wait_thread` has always been written this way and has never had a failure — this is the baseline)
- **Order**: the input interceptor receives the exit key → `kill(SIGTERM)` (**return immediately, never sleep**) → create a **dedicated coup de grâce thread**
  `gba_kill_later` (`SIGKILL` only if still alive after 600ms) → the reaper thread blocks on `waitpid` → `gba_reset_fb_page()` →
  `hardware_keys_set_grab(true)` → `app_runtime_set_lvgl_paused(false)` → `lv_async_call(full-screen redraw)`
  → **finally** remove the interceptor. `gba_on_destroy` additionally uses `SIGTERM` plus a 300ms grace period to protect `.sav`
- **Frontend side**: `on_quit_signal`(SIGTERM→quit=1) + `fb_restore()` + normal `return 0`.
  **`fb_restore()` unconditionally pans back to page 0 and never clears the screen** (clearing the screen would turn that ~1s pure black = "frozen black screen");
  **it also no longer memcpy's the whole page** (removed in bugfix 16: that was equivalent to writing content into the page LVGL always draws)
- **★★ page flips are always 【unconditional】** (bugfix 18, all 5 call sites on the page side): `FBIOPAN_DISPLAY(yoffset=0)` is idempotent
  → **never add a pre-check**; after sending, read back and verify once, and resend if incorrect. Moreover, **the page flip and the full-screen redraw must be in the same beat**
  (flip again immediately after the redraw inside the main thread's redraw callback) → see §C-7
- **Measured**: after sending the signal, the child process "truly disappears" in **~1015~1020ms on both frontends** (inherent overhead of the kernel reclaiming evdev/fb, which the frontend cannot influence;
  a deliberately accepted cost; stop trying to optimize it); after exit, **both frontends freeze on the game's last frame** = **0 black-screen windows**
- **★ locating `yoffset` readback (three-version conclusion, final version)**: it **can** reflect whether the frontend is flipping pages (when the observation method is available),
  but it **cannot** serve as the gate for "whether to flip a page" — the bookkeeping value is not guaranteed to equal the page the scan output (LCDC) is currently reading;
  once the two disagree, `if(yoffset != 0)` skips the page flip = **occasional leftover of the previous image** (the true culprit of bugfix 18)

## C. Paths Already Disproved — Do Not Take Them Again

1. **Setting a "running out N seconds counts as exit" upper bound on the wait loop** ← the true culprit of the "frozen black screen": the game is judged to have exited as soon as it runs to completion normally → the key interceptor is removed
   (**the exit key stops working**) + LVGL grabs fb0 back and overwrites the game. **FC uses unbounded blocking waitpid; this is the watershed of "FC works / GBA breaks"**
2. `_exit(0)` **cannot** save kernel time (it only skips the user-space close; the process disappears **even later**)
3. Putting the "wait for the reaper" loop **inside a mutex** → UI recovery is dragged out to the full duration
4. Using `setenv` as a single-child-process switch (**main-process level**, which leaks across pages) → **always set it in the child process after `fork()` and before `execl()`**
5. **Clearing the screen when the frontend exits** (the "black" is caused by clearing the screen; the "freeze" is the ~1s overhead common to both frontends — do not investigate them as the same problem)
6. **Only restoring your own layer**: the parent process's backup SIGKILL interrupts the child process's "saving the game + flipping the page" → **parent and child layers must both provide a fallback**
7. **★ "idempotent operation + pre-check"** (bugfix 18): writing `if(yoffset!=0) pan()` turns "**always do**" into
   "**occasionally don't**" — the causal chain is "the readback value ≠ the real state → judged false → the entire backend reset section is skipped".
   For idempotent operations with negligible cost, **just do it, don't ask**.
   **The first line of investigation for intermittent failures is the "conditional check", not the timing**: first ask "is there any way this code chooses not to act when the input is correct"
8. **Putting "page flipping" and "redrawing" in two separate execution flows**: they are two halves of the same visual transaction; splitting them leaves an intermediate state (bugfix 18)

## D. Tools and Probes

- Page flip diagnostic `fbpan`: `/tmp/fbpan [page number]` (source code `ssh_tools/_tmp/fbpan.c`, compiled with the device's gcc)
- Grab the current visible page `ssh_tools/grab_screen.py`; end-to-end reproduction `ssh_tools/gba_repro.py`;
  freeze the frontend to verify the fallback `verify_gba_guard.py`; full process `verify_gba_final.py`
- Audio probe `MINIRETRO_AUDIO_DEBUG=1 miniretro ...`, printing once per second
  `peak/samples/out/drop/fps/calls/fpc/in_rate/out_rate/busy_ms`
- Known limitation: this machine has only 4 physical keys (left/right/A/exit); the GBA's L/R/START/SELECT require a USB gamepad or a modified keymap

---

## E. Frame Rate Budget and Speedup (2026-09-29, GBA)

### E.1 Three Numbers You Must Know
1. **`FBIOPAN_DISPLAY` blocks 17.46ms per call (bare test of 100 calls) ⇒ panel refresh 57.3Hz**.
   It waits for the next vsync before returning ⇒ **as long as every frame flips a page, the frame rate ceiling is 57.3Hz** (the GBA's nominal 59.73 can never be reached).
   Stop trying to "optimize to 60fps" — the physical ceiling is right here.
2. **The actual work per frame is ≈10ms**: mGBA core_run itself ~5ms + conv 0.4ms + scale_rotate90 4.85ms;
   the remaining 7ms is pan waiting for vsync (nothing to do, but in single-threaded mode it serially occupies the main loop).
3. **Frame drop mechanism**: a "stutter" = a frame's work exceeds the remaining budget of the current vsync phase → misses that bus → that frame takes 34.9ms (half speed).
   Therefore the correct goal for speedup is **increasing the margin**, not raising the peak frame rate.

### E.2 Segmented Probes (how to measure)
`MINIRETRO_PERF=1 miniretro_gba <core> <rom> <keymap>`, printing once per second
`fps / core / conv / scale / pan (ms/frame) / total busy`; `vf` = number of video_cb calls per second.
(`MINIRETRO_AUDIO_DEBUG=1` is the probe for the audio path; the two are independent.)

### E.3 Two Speedups Already Done
- **scale_rotate90**: ① target-column gather lookup table → **source-column range table `sr_xstart[]` + contiguous filling**;
  ② 780,000 4B uncached writes → **cached row buffer `sr_rowbuf` + `fb_store_row()` NEON 16B wide writes** (194,000 writes).
  Measured 6.7ms → 4.85ms. Writing video memory is uncached; **reducing the number of bus accesses is the key** (not reducing the pixel count).
- **governor**: `performance` at runtime (768~900MHz → 1.3GHz), restored to `interactive` on exit.
- **★ Compilation**: GBA must use `-O2 -march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard`;
  this machine's gcc `-dumpmachine` = `armv6-alpine-linux-musleabihf`, with default `-mfpu=vfpv2`
  → when not explicitly specified, `arm_neon.h` reports `inlining failed ... target specific option mismatch`.
  SC9832A = Cortex-A7; explicitly enabling armv7-a+NEON is measured to compile and run correctly.
- **Not done (optional)**: disabling double buffering (saves pan's 4~7ms, but causes tearing); mGBA frame skipping; GSP hardware scaling/rotation.

### E.4 Frame Rate Display
- Switch: "Game Frame Rate" on the settings page → `show_fps=1` in `lv_conf/settings.conf`;
  the frontend parses that file directly (**setenv is not allowed**, see the §"setenv pollution" lesson),
  the environment variable `MINIRETRO_SHOW_FPS=1/0` can temporarily override it.
- Drawing method: 5x7 dot matrix (0-9/F/P/S/:) enlarged 3x, **must be drawn on the back page before `FBIOPAN_DISPLAY`**,
  otherwise it gets knocked off by the next frame's page flip; colors use the `FBPIX(r,g,b)` macro (fb physical [R,G,B,X]).
- Position: `x=12, y=fb_h-7*3-14` (bottom left), with a black background backing.

### E.5 PSP Performance Ceiling = 10fps (conclusion measured on 2026-09-29)
- Segmentation (`MINIRETRO_PERF=1`): core_run 96ms (of which our image production is 9.7ms) / 10.2fps.
  **Image production accounts for only 10%**; the rest is PPSSPP's fixed per-frame cost; **independent of ROM load** (Tetris runs at the same speed).
- Already ruled out: resolution (PPSSPP only accepts ≥480x272), audio (no difference when MUTEd), CPU frequency limiting (1.3GHz measured at 214M iter/s),
  JIT vs IR (same speed). `frameskip=2` is optimal; **=8 is instead slower**.
- ★ **core option names/values must be verified with GET_VARIABLE receipts** (a wrongly written variable is silently ignored by the core);
  **writing the same key as two entries in the table → lookup only returns the first one**.
- ★ **Never use `MINIRETRO_NOAUDIO=1` (not registering the audio callback) → PPSSPP segfaults**.
- Frame rate overlay/segmented printing/tuning environment variables: see `2026-09-29.md` "PSP Stutter Localization and Optimization".

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
