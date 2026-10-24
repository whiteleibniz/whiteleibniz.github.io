---
title: "Spreadtrum SC9832A Network TV Deep Dive (5): The Player Blew Up the System Disk — the Cost of Per-Frame Logging, and 'Screen Corruption' Actually Depends Heavily on the Source"
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
tags: [VSP, Hardware Decoding, fb, Logging, m3u8, Spreadtrum, Embedded]
date: 2026-10-16 16:00:00
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality/) · [繁體中文](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The previous part (4) fixed the "fake physical address", and the second IDR no longer crashes or switches to software decoding. This time we continued validating on the real device, and along the way caught a problem unrelated to the picture but enough to make the whole device "die a slow death": **the player blew up the system disk**. At the same time, the question "is it actually fixed or not" splits into two more accurate conclusions: picture quality depends heavily on the source, while the IDR hang is the real blocker.

## 1. Symptom: a Few Hours Later /tmp/lvgl_demo.log Becomes 131MB

While validating, habitually glancing at the disk, `/tmp/lvgl_demo.log` was already **131621286 bytes (≈131MB)**, and the root partition had only 586MB left (91% used). Worse, it was still growing.

The log tail looks like this, and the flooding source is obvious at a glance:

```
    DRIVE empty(全量): m=0xb0b7a400 what=3048035944 hdr=0xb6cced70
    DRIVE empty(全量) → 返回, 队列:  in  queue=0xb4ec9304 begin=b4e8c060 end=00000000 (空)
    DRIVE fill(out): m=0xb0b7ae00 what=3048035944 hdr=0xb6ccedc0
    DRIVE fill(out) → 返回, 队列: ...
```

Each diagnostic line is fine on its own — when debugging hardware decoding we rely entirely on it. The problem is **it prints on every frame**, and in more than one place.

## 2. Root Cause: Three Layers Stacked

1. **The feed log is "per-frame".** The `DRIVE` macro prints two lines per buffer fed (plus a queue snapshot), and a frame is fed several times → measured **~9KB/s**.
2. **The vendor decode library also prints to stdout.** `SprdSimpleOMXComponent` / `SPRDAVCDecoder` have prints like `fillThisBuffer` / `onQueueFilled` inside, spewing along with our calls.
3. **The deadliest one: the player launched by the UI inherits the UI's stdout.** The Network TV page does `fork + execl("/usr/local/bin/nettv_player", url)` with no redirection — so all of the player's output pours into the LVGL main program's log file `/tmp/lvgl_demo.log`.

9KB/s × a few hours = over a hundred MB. For a TV box that runs 24 hours a day, this is a guaranteed disk blowup.

## 3. The Fix: One Gate + One Redirect Binding

Two ideas:

**① Add a switch to the per-frame diagnostics (off by default).** Add a gate that only recognizes an environment variable:

```c
static int g_vlog = -1;
static int vlog_on(void) {
    if (g_vlog < 0) {
        const char *e = getenv("NETTV_VLOG");
        g_vlog = (e && *e && *e != '0') ? 1 : 0;
    }
    return g_vlog;
}
```

Then wrap the two lines in the `DRIVE` macro, plus the per-frame "on screen" print, in `if (vlog_on())`. When you need to investigate, just run once with `NETTV_VLOG=1`; zero overhead in normal operation.

**② "Bind" the child process's output to a fixed file that gets truncated on every respawn.** Since the vendor library's prints are beyond our control in source code, we can only work at the fd level:

```c
static void child_log_bound(void) {
    if (vlog_on()) return;                        /* debug mode: keep the caller's redirection */
    int f = open("/tmp/nettv_child.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    dup2(f, 1); dup2(f, 2);
    if (f > 2) close(f);
}
```

Call it at the very start of the child process forked by monitor. Two benefits stacked:

- the UI's `/tmp/lvgl_demo.log` is no longer flooded (the player's output goes into its own file);
- this file is opened with **O_TRUNC**, and every fallback respawn by monitor forks again → the file is repeatedly truncated, and disk usage is hard-capped at the magnitude of "**a single child process**".

**Measured comparison:**

| Metric | Before | After |
| --- | --- | --- |
| `/tmp/lvgl_demo.log` | 131MB (still growing) | **965 bytes** |
| Child process log | mixed into the UI log | `/tmp/nettv_child.log`, ~59KB (single child) |
| Per-frame diagnostics | multiple lines per frame | 0 by default (only with `NETTV_VLOG=1`) |
| `[STAT]` heartbeat | present | kept (one line every 25 frames) |

## 4. Two Perceptions Corrected Along the Way

This was an "on-device validation", and the validation process itself corrected two earlier judgments:

**① "Screen corruption" is not binary; it depends heavily on the source.**
- good source (lxfile Luxian/Chengdu): the main picture is clear, with only local blurring in the middle-right and a small amount of edge blocking;
- bad source (a certain cztv 1080p channel): almost the whole screen is corrupted, unrecognizable.

In other words, using "is there mosaic or not" to judge "is it fixed or not" is inaccurate — you must fix on a known-good source as the baseline.

**② The real stability blocker is still the IDR hang, unrelated to the fake PA.**
The logs show every child process terminates at the same point:

```
  ── empty AU[69] 104222 字节 @7876ms t=5 (8c=1, 9a清0) ──
*** GOP#3 IDR: 原生续解(3s 挂死看门狗兜底) ***
```

That is: **when feeding the 3rd GOP's IDR, `DRIVE empty(全量)` never returns** — consistent with the previous part's conclusion (the fake PA is not its root cause). monitor falls back to a respawn every ~8-30s, so the picture runs at a rhythm of "watchable for a few minutes, a hitch, then recovery". For "stable and smooth", this must be tackled next.

(A small aside: while grabbing screenshots, two captured frames turned out to be **byte-for-byte identical**, and for a moment I thought the picture had frozen. Only later did I remember the player has "frame signature deduplication" — it only redraws the fb when the picture signature changes. Two identical frames in a static scene is a **normal optimization**, not a fault. When capturing frames to verify a dynamic picture, pick a scene with motion.)

## 5. One-Sentence Lesson

> **Debug prints are a double-edged sword: the more detailed the better while debugging, the quieter the better in production.** Especially when the program is launched by another process via `fork+exec` without redirecting stdout — you think "it's just a few extra log lines", but a few hours later it becomes a 131MB time bomb. Give it an environment-variable switch, and bind the child's output to a file that gets automatically truncated; the cost is almost zero, and the benefit is the whole device does not die a slow death.
