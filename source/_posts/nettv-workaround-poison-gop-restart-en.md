---
title: "Spreadtrum SC9832A Network TV Deep Dive (3): After Fixing Hardware Decoding, Why Does the Picture Loop the Same Segment Forever"
date: 2026-10-15 02:00:00
tags:
  - VSP
  - Hardware Decoding
  - HLS
  - OMX
  - LVGL
  - Spreadtrum
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart/) · [繁體中文](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The previous two parts got the 1080p live stream running on the SC9832A with VSP hardware decoding, and also fixed the real cause of "block 5 mbinfo allocation failure → the component permanently switching to software decoding". By all rights, smooth playback should have followed — but on the real device the picture is forever **the same 2.7-second segment looping**. This part records how I punched through this final layer of window paper.

## 1. Symptoms and Quantification Tools

First, add a frame-rate heartbeat to the player (under bare bionic, don't use %f; pure integers are the most stable):

```c
static void frame_beat(void) {          /* print one line every 25 frames decoded */
    if (!g_t0ms) g_t0ms = sys_time_ms();
    if ((++g_fr % 25) != 0) return;
    long el = sys_time_ms() - g_t0ms;
    P("    [STAT] frames=%u elapsed=%ldms fps_x10=%lu\n",
      g_fr, el, g_fr * 10000UL / el);
}
```

Ran 40 seconds and grabbed the log; the result was very bizarre:

```
[STAT] frames=25 elapsed=2660ms fps_x10=93
[STAT] frames=25 elapsed=2667ms fps_x10=93
[STAT] frames=25 elapsed=2690ms fps_x10=92
```

**Always frames=25**, with elapsed barely changing. In other words: the process dies every 2.7 seconds, and the new process decodes the exact same AU[23] again.

## 2. The Real Culprit: a Workaround from a Year Ago Turned Poison

Digging through the source, I found this buried on 10-09:

```c
/* ★★ Vendor library defect (settled 2026-10-09): feeding the 2nd GOP's IDR
 * into empty(thisBuffer) always deadlocks permanently... workaround = on
 * detecting the second IDR, immediately _exit(9); active respawn: the parent
 * pulls up a new child process within 0.15s, the picture only breaks 1~2s. */
if (nt2 == 5) {
    static int idr_seen = 0;
    idr_seen++;
    if (idr_seen > 1) { P("*** GOP#%d IDR 到来, 主动重生…"); _exit(9); }
}
```

Let me reconstruct the timeline — this is a textbook case of "an expired workaround":

1. **10-09**: not knowing why the second IDR hangs, I played rough — on reaching the second IDR, the whole process commits suicide and restarts. The picture did become watchable (only 1~2 seconds of breakage), and at the time it looked like "the cure".
2. **10-13**: found the real cause — the CMA pool only fits 4 mbinfo blocks → ENOMEM → the component permanently switches to software decoding. Implemented the mbinfo reuse fix, and the switch-to-software-decoding symptom disappeared.
3. **10-15**: but the "suicide at the second IDR" is still there. So now: **hardware decoding can keep running, yet the process still commits suicide at the first GOP boundary by the old rule**. Worse, the m3u8 played-segment record (`g_last_seg`) is zeroed along with the process, and the new process pulls the same segment as soon as it comes up — hence the picture is forever the same segment.

**Lesson**: a workaround must always carry comments on "why" and "when it can be deleted", and after fixing the real cause you must **go back and clean it up**. It does not expire on its own.

The fix: default to native continuation decoding, keeping `NETTV_RESPAWN=1` as the escape hatch:

```c
static int respawn_on = -1;
if (respawn_on < 0) {
    const char *ev = getenv("NETTV_RESPAWN");
    respawn_on = (ev && ev[0] == '1') ? 1 : 0;
}
if (respawn_on) { P("*** 主动重生(NETTV_RESPAWN=1) ***"); _exit(9); }
P("*** GOP#%d IDR: 原生续解(3s 挂死看门狗兜底) ***", idr_seen);
```

## 3. A Pit Hit Along the Way: `gcc | head` Can Strangle the Build

Along the way I also fixed a build-script bug, worth its own note:

```sh
gcc ... 2>&1 | head -14     # ❌ when diagnostic lines exceed 14, head closes the pipe
                             #    gcc gets SIGPIPE and is killed → no object file produced
                             #    the script reports BUILD FAIL, and the real error is eaten by head
```

Changed to redirecting output to a file and then `tail`; worked the first time. For any scenario of "the build suddenly starts failing, but the error message is truncated", suspect the downstream end of the pipe first.

## 4. Results: Good News and Bad News

After the change, a 100-second measurement (Luxian 1080p source):

```
Frame callbacks 280 times (≈140 real frames) / 4 m3u8 segments / 0 switches to software decoding / 0 SIGSEGV
[STAT] steady state fps_x10=87~93
```

The picture can now advance, and the framebuffer capture did get a real image (the street and the channel logo are both right, rot90 normal). **But**:

1. GOP#2 can now be fed natively, **but GOP#3's IDR still hangs** (`DRIVE empty(full)` never returns) — the so-called "second IDR hang" has not disappeared; the mbinfo fix just bought one more GOP.
2. More interesting: **the SIGALRM watchdog is not delivered at all during the hang** (`alarm(3)`, `alarm(6)` both fail to fire; the process state is S, not D). The signal path does not work through the vendor library on this device; in the end I had the monitor parent raise a flag in shm (`shm[4]=1` means "feeding an IDR"), compressing the stall grace from 8 seconds to 2 seconds, relying on kill+restart as the backstop.
3. Looking at the frame captures, about 2/3 of the picture is clean and 1/3 is blocky mosaic — matching exactly the "reuse block pa=0x00000000" in the log (the mbinfo reuse block got a fake physical address); this is the next point to attack.

## 5. Next Steps

- Get a real physical address for the mbinfo reuse block (or find out why the 653824B block gets no PA from either `0xc008602a` or cmd0) — note that swapping the heap mask directly will crash the kernel; don't touch it.
- After the hang is rooted out, do multi-GOP long-run stability + resource reclamation on channel switching.
- Only then raise the frame rate: 13-20fps → 25fps.

One-line summary: **when fixing a bug, clean up the old workaround along with it, or it will turn into a new bug where you least expect it.**
