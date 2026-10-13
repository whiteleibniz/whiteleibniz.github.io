---
title: "ref_PSP Emulator"
date: 2026-09-24 14:18:10
lang: en
permalink: en/2026/09/24/ref-psp/
search: true
categories:
- 多媒体与模拟器
- PSP
tag:
- PPSSPP
- 模拟器
---


# PSP Emulator (starting 2026-09-24)

> The top-level MEMORY.md §12 only keeps conclusions; this article is the detail.

## A. Approach and Feasibility

- **Reuse the GBA architecture**: the miniretro frontend writes directly to `/dev/fb0` + a libretro core. core = **PPSSPP** (v1.18.x, `-DLIBRETRO=ON`)
- **★ Key point: this machine has no GL/Vulkan**, so PPSSPP must be made to use pure CPU software rendering.
  The frontend actively answers **`ppsspp_backend=none`** in `env_cb(RETRO_ENVIRONMENT_GET_VARIABLE)`
  → it lands on `LibretroSoftwareContext` (the software rendering fallback branch in the source code `libretro/LibretroGraphicsContext.cpp`).
  If you do not actively provide it, it will try GLCore→GL→Vulkan in sequence and all three will fail; worse, once the .so links against libGL,
  **it cannot even get past the dlopen stage**, losing even the fallback chance
- Other injected core options: `cpu_core=JIT` (ARM32 dynarec, an order of magnitude slower without it),
  `internal_resolution=480x272`, `frameskip=1`, `auto_frameskip=disabled`,
  `gpu_hardware_transform=disabled`, `memstick_inserted=enabled` (without it some games refuse to save),
  `io_timing_method=Fast`, `cache_iso=disabled` (only 916MB of memory; do not cache the entire ISO)
- `RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY` → `/home/PSPgame/saves`

## B. Source Acquisition and Compilation

- **On this machine** `git clone --depth 1 --recurse-submodules -j 8 https://github.com/hrydgard/ppsspp.git`
  (the Makefile route hard-depends on ffmpeg headers → must use CMake)
- Trimmed packaging: exclude `.git / ffmpeg / ext/vulkan / assets / android / Qt / SDL / Windows / UWP / ios /
  macOS / headless / unittest / Tools / pspautotests / source_assets / icons / dx9sdk / gradle` → 55MB
- `assets` was later found to be **required in full** (flash0 + font atlas + meta); uploaded separately
- CMake: `-DLIBRETRO=ON -DUSE_FFMPEG=OFF -DVULKAN=OFF -DOPENGL=OFF -DUSE_SYSTEM_ZLIB=ON
  -DUSE_SYSTEM_LIBPNG=ON -DMOBILE_DEVICE=ON -DCMAKE_BUILD_TYPE=Release`
- **★ Compilation flags must be given explicitly**: `-march=armv7-a -mtune=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard`
  (without them, gcc compiles for armv6 by default → **no ARM32 dynamic recompilation, an order of magnitude slower**)
- **★ Pitfall: `-DVULKAN=OFF` does not stop the `ext/vma` target**, which still needs `ext/vulkan/vulkan.h`;
  and when trimming packages in China/on this machine, it is easiest to exclude that entire directory → error `fatal error: ext/vulkan/vulkan.h`.
  Solution: only transfer the **header files** (just 177KB after excluding iOS 26MB / macOS 12MB / libvulkan.so 3.3MB)
- Run compilation in the background `setsid nohup make -j4 > /tmp/ppsspp_build3.log` (incremental; all already-compiled .o files are kept)

## C. Derivation (writing a second copy by hand is forbidden)

`ssh_tools/make_psp_from_gba.py` produces 4 files in one pass, `ssh_tools/deploy_psp.py` deploys and rebuilds,
`ssh_tools/finish_psp.py` wraps up (verifies dependencies → installs the .so → optional load self-test).

- Derive `miniretro_psp.c` from `miniretro_gba.c`, changing only 5 places:
  `PSP_SRC_W/H=480x272`, `SR_ROT_MAX 256²→512²` (a 272x480 rotated canvas does not fit in 256², otherwise black screen),
  `temp32` capacity, **the whitelist changed from "enumerate machine sizes" to "upper-bound check"** (only reject `width>PSP_SRC_W`),
  env_cb adds GET_VARIABLE + GET_SAVE_DIRECTORY. Everything else (double-buffered page flipping/exit strategy v3/audio adaptive resampling) is fully inherited
- The page is derived from `gba_game_page.c`: suffixes `.iso/.cso/.pbp/.elf`; **the Makefile uses `wildcard lv_pages/*.c`**,
  so a new page dropped in is automatically included in the build
- **★ replacement order landmine**: compound identifiers (`mgba_libretro.so`, `miniretro_gba`) must be replaced **before** the general rule
  `gba_->psp_`, otherwise `mgba_libretro.so` would first be written as `mpsp_libretro.so`,
  and the later exact replacements could never match again (the page cannot find the core)
- **★ Chinese font landmine**: the derived source's labels never set a font → Chinese ROM names are all tofu blocks.
  The script has already added `lv_obj_set_style_text_font(x, &lv_font_cn_16, 0)` for all `lv_label_create`
  - `LV_FONT_DECLARE`, and wraps the list container as a fallback

## D. ROM

Directory `/home/lvgl_demo/lvgl_demo/sdcard/game/psp/` (5 already placed)

| File | Size | Source | Purpose |
| ----------------------------------------------------------- | ------- | ------------------------------------------- | -------------------- |
| `Tetris 俄罗斯方块.pbp` | 16KB | github.com/zPSP-Dev/tetris-psp release v1.0 | **First choice**: a real game, extremely light, software rendering can handle it |
| `Beatbox.pbp` | 1.0MB | EBOOT.PBP inside the github.com/Babkock/Beatbox repository | Drum machine: verifies multi-key input + audio |
| `Cube 旋转立方体.pbp` / `Controller 按键测试.pbp` / `HelloWorld.pbp` | 40~76KB | PPSSPP's bundled `pspautotests/demos/` | Frame rate/key/basic rendering probes |

**★ Download availability (measured in China)**: `dlhb.gamebrew.org` returns **403**, `archive.org` and `raw.githubusercontent.com`
are **unreachable with HTTP 000**, and the GitHub API/search easily hits 403 rate limiting.
→ **The only reliable option is `github.com` itself**: `git clone --depth 1` or `github.com/<repo>/releases/download/<tag>/<file>`.
The GameBrew web pages are only used to WebFetch-extract direct links.

## E. Keyboard / Input

- On the device, `/dev/input/event0/1/2` has only the 3 onboard ones; **after plugging in a USB keyboard, hotplug works automatically** —
  `input_poll_cb()` calls `input_scan()` on every poll to rescan `/dev/input/eventN`
- `extern/miniretro/keymap_psp.conf` mapping (derived from the same source as GBA):
  WASD/arrow keys = directions; `Z`/`J`/Space = B(○); `X`/`K`/LeftCtrl = A(×); `Q`/`E` = Y(□)/X(△);
  `1`/`2` = L/R; Enter = START; LeftShift/Backspace = SELECT; **ESC = exit**
  the 4 onboard physical keys are retained (点餐114=left, 服务102=right, 福利115=A, 买单116=exit)
- Keys not mapped as expected print `未映射按键 code=xxx` on stderr; add them to the conf as prompted

## F. Build Wrangling

| Action | Command Essentials |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Check build status | `tail -1 /tmp/ppsspp_build3.log`; `grep -c 'error:'` |
| Change parallelism (keep completed targets) | Send **SIGTERM** to the PIDs from `ps -o pid,comm \| awk '$2=="make"'` (**`pkill -f` is forbidden**), wait for cc1 to exit, then continue with `make -jN` |
| Observe actual parallelism | `ps -o pid,comm \| awk '$2=="cc1"\|\|$2=="cc1plus"' \| wc -l` |

- At 4-way concurrency, memory used 224~294MB / 916MB total, **no OOM**
- After an interruption there may be half-built `.o` files (timestamp newer than the source → make thinks no rebuild is needed → it explodes only at link time).
  **★ BusyBox `find` has no `-newermt`**; use `-mmin N` / `-newer FILE`
- **Do not write to `/sys/devices/system/cpu/cpuN/online`** (see MEMORY §10 hotplug landmine);
  measured: under build load, `sprd_hotplug` automatically brings all 4 cores up (`online=0-3`)

## ★ core build: concurrency limit -j2 (OOM confirmed)
- `-j4` gets OOM-killed at 50% (`glslang_tab.cpp` single-file peak), and the entire make silently stops dead with Error 2
- Correct startup method (only build the needed target, not `all`):
  `cd /home/PSPgame/ppsspp_git/build && nohup setsid make -j2 ppsspp_libretro > /tmp/ppsspp_build4.log 2>&1 &`
- To judge liveness you must grep the log for `Killed` / `make.*Error 2`; **looking at processes alone can mislead**

## ★ Pitfall of trimming source: android/jni headers must be kept (at least 2)
- `Common/File/AndroidStorage.cpp` and others **unconditionally** `#include "android/jni/app-android.h"`; deleting the entire `android/` directory will explode at 52%
- Fix: put back the real `app-android.h` as-is (under libretro `PPSSPP_PLATFORM(ANDROID)` is false, and `<jni.h>` is still wrapped inside
  `!defined(__LIBRETRO__)` → no NDK needed) + the real `AndroidAudio.h`; **`OpenSLContext.h` depends on `SLES/*.h`; leave placeholder headers**
- General lesson: before trimming, first `grep -rn '#include "<directory>'` to find non-conditional includes; when patching files, prefer "putting back the real file as-is" over hand-written placeholders

## ★★ Smoke test iron rule: must use setsid
When `./miniretro_psp ... &` is hung under a script's sh, **busybox sh immediately sends SIGTERM to the background job** (confirmed by si_pid=ppid),
manifesting as "exits 100ms after startup", which is very easily misjudged as a core crash. Correct approach:
`setsid ./miniretro_psp <absolute path to core> <rom> keymap_psp.conf > /tmp/x.log 2>&1 &`
(Also: musl's dlopen **does not search the current directory** for names without slashes → the core must be passed an absolute path)

## ★ 4 Requirements for the PPSSPP Core to Run
1. Implement `RETRO_ENVIRONMENT_GET_LOG_INTERFACE`(cmd 27) — otherwise all core errors are invisible; the pass level is limited to WARN and above
2. assets go in `<system_dir>/PPSSPP/` (22MB), not the system root directory
3. system dir cannot be NULL (the frontend's original default was NULL; changed to `/home/PSPgame/system`)
4. `ppsspp_backend=none` → `Using Software backend`, 480x270@59.94fps, JIT uses ARM32

Remaining: `terminate called without an active exception` at the end of exit (occurs after fb reset, unrelated to dlclose; left as-is for now)

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
