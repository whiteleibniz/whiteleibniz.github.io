---
title: "nettv-18: Why Does a Child Process's exec Fail with a Mystery 127 — the LD_LIBRARY_PATH Trap of a bionic Parent + musl Child"
date: 2026-10-21 02:00:00
tags:
  - sprd
  - SC9832A
  - bionic
  - musl
  - LD_LIBRARY_PATH
  - exec
  - Troubleshooting
categories:
  - [Embedded, Network TV Hardware Decoding]
  - [Linux, Dynamic Linking]
  - [Debugging, Methodology]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-18-dl-child-exec-ld-library-path/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-18-dl-child-exec-ld-library-path-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-18-dl-child-exec-ld-library-path-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

## Background: In One Sentence

Two consecutive A/B rounds of the player produced **zero frames**, and the log was flooded:

```
Error relocating /system/lib/libc++.so: __strlen_chk: symbol not found
Error relocating /system/lib/libc++.so: __errno: symbol not found
Error relocating /system/lib/libz.so.1: __register_atfork: symbol not found
  [http] reap status=0x7f00 (0=成功, 0x7f00=execl失败)
```

Last round I wrote it down as "libc++ linking broken / image version mismatch" and prepared to go wrangle the system libraries. **That was wrong** — and a textbook misjudgment.

## Symptoms

`nettv_player` uses `fork()` + `execl("/usr/bin/curl", ...)` to download HLS TS segments. The child process exits with code 127 (the parent only sees `status=0x7f00`), so the TS segments never arrive ⇒ the decoder has no input ⇒ zero frames.

## Investigation: Don't Jump to Conclusions

The key question is **whether those "missing symbols" are truly nonexistent**. First, confirm on the device:

```
$ grep __strlen_chk — does the symbol exist in /mnt/android_sys/lib/libc.so?
strings /mnt/android_sys/lib/libc.so | grep __strlen_chk    # yes, 2 hits
```

The symbols are plainly there. So "symbol not found" is not "missing symbols" — it is **"looking in the wrong libc"**.

Now look at the executable: `/usr/bin/curl` is an **Alpine musl** program, and `readelf -d` shows it NEEDs three libraries:

```
libcurl.so.4  libz.so.1  libc.musl-armhf.so.1
```

Our `nettv_player`, meanwhile, is a **bionic** program whose runtime environment carries:

```
export LD_LIBRARY_PATH=/system/lib:/mnt/android_sys/lib    # required to load the Android vendor libraries
```

`fork()` inherits the entire `environ`, and `execl()` does not clean it up ⇒ **musl's dynamic linker follows `LD_LIBRARY_PATH` to look for `libz.so.1` under `/system/lib` and picks up bionic's libz**. bionic's libz in turn NEEDs `libc++.so`, so musl goes on to load bionic's `libc++.so` — the `__strlen_chk` / `__errno` / `__memchr_chk` it wants are of course absent from **musl libc**, and the linker simply calls `exit(127)`.

One line to reproduce / one line to refute:

```
$ LD_LIBRARY_PATH=/system/lib curl -s -o /dev/null -w '%{http_code}' http://baidu.com
Error relocating /system/lib/libz.so.1: __register_atfork: symbol not found
...(a full screen)
$ curl -s -o /dev/null -w '%{http_code}' http://baidu.com
301
```

## The Fix: Strip Only the Child Process's Environment Variables

In the child produced by `fork()`, before exec, strip `LD_*` from `environ` (COW; the parent is unaffected):

```c
static void musl_child_sanitize_env(void) {
    extern char **environ;
    if (!environ) return;
    int o = 0;
    for (int i = 0; environ[i]; i++) {
        const char *e = environ[i];
        if (e[0] == 'L' && e[1] == 'D' && e[2] == '_') continue;  /* LD_LIBRARY_PATH / LD_PRELOAD ... */
        environ[o++] = environ[i];
    }
    environ[o] = (char *)0;
}
```

Call it before exec in both `fork` children (the curl download and the mplayer audio, both musl programs). The parent's own `LD_LIBRARY_PATH` stays unchanged — the bionic side still relies on it to dlopen Spreadtrum's VSP vendor libraries.

Verification: run a round with the same `LD_LIBRARY_PATH=/system/lib`; `Error relocating` appears **0 times**, `reap status=0x7f00` **0 times**, and the decoder consumes TS normally and advances to feeding the IDR.

## Three Methodology Points (Worth More Than the Bug Itself)

1. **For "symbol not found", first distinguish "absent" from "looked in the wrong place."** Check whether the symbol exists in the target library, and you can immediately rule out grand conclusions like "the image is corrupted."
2. **When the error surfaces in the child process, don't read only the parent's log.** `0x7f00` is the parent's relay; the truth is in the first line of the child's stderr.
3. ★ **Both A/B groups at zero frames simultaneously = an environment problem, not an invalid test item.** I initially almost read it as "ION cached is ineffective", when in fact **the baseline group could not produce frames either** — the comparison never held. **First prove the baseline can produce frames, then talk about comparison.**

## Aside: Cross-libc Process Trees Need Special Care

This device is a rare hybrid environment: an Alpine/musl userland plus Android's bionic vendor libraries. Whenever programs of both libcs coexist in a process tree, any "environment variable shown to the linker" (`LD_LIBRARY_PATH` / `LD_PRELOAD`) becomes **one-way contamination**: the variables bionic needs are poison to musl child processes.

> This article is original work; please credit the source when reposting.
