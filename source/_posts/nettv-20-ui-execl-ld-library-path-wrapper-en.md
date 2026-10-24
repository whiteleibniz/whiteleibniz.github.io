---
title: "nettv-20: The Second Face of the Channel-Change Black Screen — bionic Ignores DT_RPATH; a Single Wrapper Rescues the UI Path"
date: 2026-10-21 09:40:00
tags:
  - sprd
  - SC9832A
  - bionic
  - LD_LIBRARY_PATH
  - dlopen
  - Symlink
categories:
  - [Embedded, Network TV Hardware Decoding]
  - [Linux, Dynamic Linking]
  - [Debugging, Methodology]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-20-ui-execl-ld-library-path-wrapper/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-20-ui-execl-ld-library-path-wrapper-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-20-ui-execl-ld-library-path-wrapper-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

This morning the "pkill trick" had just rescued the black-screened TV; in the afternoon the user tuned to another channel — **still black**. The background processes were plainly alive. Well, this device's black screen has two entirely different faces.

This part documents the capture of the second face: a real bug hidden inside a dynamic-linker behavioral difference.

## 1. The Scene: Process Alive, Log Says "Key Symbol Missing"

Grab the process tree and the logs: the player `nettv_player` is indeed running, but the worker child's log stops on one glaring line:

```
=== 符号解析 ===
  create=0x0 onMsgRecv=0xb5340731 empty=0xb533f90d ...
>>> 关键符号缺失, 无法继续
```

`create` is the address of the component factory function `createSprdOMXComponent`; `0x0` = not resolved. Without the factory function there is no decoder component, and everything after it is moot.

The first suspicion was the pit just fixed yesterday (early hours of 10-21): the musl child forked by the bionic parent inheriting `LD_LIBRARY_PATH`, which made curl's exec fail. But this time the symptom was the opposite — **what failed was the parent's own dlopen**, and the log contained no `Error relocating` at all.

## 2. A/B Cuts Straight to the Root Cause

Same m3u8, same no-tuning env; the only variable is `LD_LIBRARY_PATH`:

| Run | LD_LIBRARY_PATH | Result |
|---|---|---|
| Manual + with env | `/system/lib:/mnt/android_sys/lib` | ✅ 89 frames, normal self-exit |
| Manual + no env | (empty) | ❌ create=0x0, exit(1) |
| UI channel tune | (empty) | ❌ create=0x0, exit(1) |

One cut and the root cause appears: **the UI's `execl` does not pass `LD_LIBRARY_PATH` to the player** (`lv_pages/nettv_page.c:315`).

```
pid = fork();
if (pid == 0) {
    setpgid(0, 0);
    execl(NT_PLAYER_BIN, "nettv_player", url, NULL);   /* the environment is inherited from the desktop as-is; no LD_LIBRARY_PATH */
    _exit(127);
}
```

Why would a single environment variable make `dlopen` of an **absolute path** fail? Follow the clues:

1. The code does `dlopen("/system/lib/libstagefright_sprd_h264dec.so", RTLD_GLOBAL)` — an absolute path, solid;
2. But `/system/lib/libstagefright_sprd_h264dec.so` is a **51-byte symbolic link**; the real file lives in `/mnt/android_sys/lib/` (at desktop startup `gpu_env_ensure()` symlinks the entire Android lib directory into `/system/lib` — this project's way of setting up the bionic runtime environment);
3. The symlink itself is fine: `ls /mnt/android_sys/lib` shows all 304 files present;
4. But **h264dec's dependency chain (directly or indirectly) contains libraries that exist only in `/mnt/android_sys/lib`** — when the bionic linker resolves these NEEDED entries it searches in order: `LD_LIBRARY_PATH` → `DT_RUNPATH` → default system paths. Without `LD_LIBRARY_PATH`, the default paths do not turn up the Android private libraries, the entire dlopen fails, and the `create` symbol naturally cannot be obtained.

In other words: the `/system/lib` symlinks cover only "the few directly dlopened ones" — **the dependency chain is soft**.

## 3. The First Fix Attempt: rpath, an Ugly Death

If `LD_LIBRARY_PATH` is objectionable as a runtime variable, surely welding it in at compile time works? Add to `build.sh`'s link parameters:

```diff
-    -Wl,-rpath,/system/lib -Wl,--export-dynamic \
+    -Wl,-rpath,/system/lib:/mnt/android_sys/lib -Wl,--export-dynamic \
```

Rebuild, deploy, run — **`create=0x0` reproduces exactly as before**.

The reason: **bionic's dynamic linker does not implement DT_RPATH semantics**. This is a classic difference between bionic and glibc/musl — under glibc this trick was fixed long ago, but on Android's linker `DT_RPATH` is essentially ignored; the search path honors only `LD_LIBRARY_PATH` and the system configuration (the `ld.config.txt` machinery).

> **Another lesson banked: when porting experience across libcs, first confirm the other side honors these semantics.** The pits this project's bare-bionic programs have stepped in (`-nostdlib`'s `_exit`, musl/bionic mixed runs, and now DT_RPATH) were almost all dug by "applying musl/glibc common sense onto bionic".

## 4. The Real Fix: One Layer of sh Wrapper

The UI code (`nettv_page.c`) lives in the device repo; changing it means recompiling the `lvgl_demo` desktop and restarting the desktop — too much disruption. The fastest, zero-intrusion approach: **replace `/usr/local/bin/nettv_player` with a wrapper**, moving the real binary to `.real`:

```sh
#!/bin/sh
# /usr/local/bin/nettv_player
export LD_LIBRARY_PATH=/system/lib:/mnt/android_sys/lib
exec /usr/local/bin/nettv_player.real "$@"
```

The UI's `execl("/usr/local/bin/nettv_player", ...)` stays untouched; the wrapper adds the environment variable and then execs the real binary, with the arguments `"$@"` passed through verbatim. Nor does it conflict with the early-10-21 `musl_child_sanitize_env()` (the player strips `LD_*` internally before forking curl/mplayer) — one adds at the door, the other strips in the back room, each minding its own stretch.

A no-env live run verifies all green:

```
create=0xb3ce99fc onMsgRecv=0xb3d3f731 ...     /* symbol resolution passed */
[http] reap status=0x0 (0=成功, 0x7f00=execl失败)  /* curl child normal */
*** monitor: 重启 (子进程 @89 帧)                /* 89 frames, normal */
```

**A future pit plugged in passing**: `build.sh`'s deploy logic is `mv $OUT /usr/local/bin/nettv_player` — the next time anyone runs a build, the wrapper gets overwritten by the binary. The deploy target has been changed to `nettv_player.real`; the wrapper stays put.

## 5. Methodology: The Three "False Root Causes" Ruled Out This Time

A record of the guesses eliminated one by one by evidence during the investigation; such "exclusion records" are as valuable as "localization records":

1. **"The ION pool was drained by a leak again"** — `/sys/kernel/debug/ion` shows `total 0 / orphaned 0`; the pool is clean, and `free` shows 744MB idle;
2. **"The device is sleeping repeatedly and corrupting memory again"** — `dmesg | grep -c "CPU1: shutdown"` shows only 1, and the `gcc -O0` probe passed on the first try; memory is healthy;
3. **"The worker died mysteriously"** — `monitor: 重启 (子进程 @89 帧)` is not a crash; it is the worker's **designed self-exit** after playing out the 90-frame cap, and the monitor's cyclic restart is also designed behavior. The log tail "stopping abruptly" is just the last round being cut off by the outer `timeout` right after it started.

All three guesses had their "evidence" at the time (the black screen, the spinning, the hotplug record at the dmesg tail), but none stood up to targeted verification. **The trouble with black-screen-class problems: the symptoms all look alike, yet the root causes differ every time** — so you must re-collect evidence every time; you cannot apply the last conclusion.

## 6. TODO

- **The Liaoning Mobile source itself cannot play either**: the source the user tuned to (`zteottcdn.ln.chinamobile.com`) has IDR frames of about 319KB, exceeding the VSP input port's 256KB limit — a known black-screen source. Even after fixing the environment you will have to change channels to see picture — **when verifying, please switch to Sichuan/Luxian-type sources**.
- Root-fix candidate: in `nettv_page.c`'s child, `setenv("LD_LIBRARY_PATH", ...)` before `execl` (a local backup `outputs/nettv_page_ui.c` already exists); added to the next git commit list.

---

> **Copyright**: This article is an original technical note; the author reserves all rights. Please credit the source when reposting (whiteleibniz.github.io); unauthorized commercial use is prohibited.
> The devices, source code, and conclusions mentioned come from a personal embedded project's field records (Spreadtrum SC9832A / Alpine Linux / LVGL); all data is measured.
