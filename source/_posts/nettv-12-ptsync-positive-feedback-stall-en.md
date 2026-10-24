---
title: "Spreadtrum SC9832A Network TV Deep Dive (12): 80x Speedup — A 'The More It Stalls, the More It Drops' PTS Sync Death Loop"
date: 2026-10-20 02:00:00
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Debugging, Performance Optimization]
tags:
  - VSP
  - hardware decoding
  - PTS
  - A/V sync
  - positive feedback
  - performance optimization
  - Spreadtrum
  - nettv
  - A/B testing
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-12-ptsync-positive-feedback-stall/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-12-ptsync-positive-feedback-stall-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-12-ptsync-positive-feedback-stall-en/)

The first ten parts were all spent wrestling with "crashes": kernel crashes, hangs, green screens, black screens. Once those were solved and 4800 consecutive frames became possible, the only enemy left was — **stutter**. 240 seconds produced only 19 frames on screen, about 0.08fps; the picture was basically a slideshow.

This part covers how that number was raised to 6.3fps (about 80x), and how, along the way, a single diagnostic experiment **falsified a wrong hypothesis chased for three days**.

## 1. Falsification First: IDR Is Not to Blame

There had always been one hypothesis: **"feeding a second IDR guarantees a hang"**. In the logs, every generation of the process died near the GOP#2 IDR — consistent across all three streams, seemingly ironclad.

Two possibilities had to be distinguished:

- **A**: in streaming state, the decoder hangs upon seeing any second IDR → the fix is a soft reset at the GOP boundary
- **B**: drift/leaks accumulated over the previous 36 rounds → the fix is hunting for resource leaks

The two fixes are completely different; guessing wrong means a wasted week. So on 10-19 I planted a diagnostic switch in the player, `NETTV_IDRREPLAY=K`: after capturing the first IDR, **feed the same IDR K times in a row** (zero accumulation, eliminating every drift factor).

10-20, in the small hours, the first truly successful run (the previous round's script upload turned into 0 bytes and I wasted a day waiting — more on that separately later):

```
[diag] NETTV_IDRREPLAY=3 (首 IDR 连投次数)
[diag] 捕获首 IDR 106336B(t=5), 之后连投 3 次
[diag] AU[4] 重投首 IDR 106336B(t=24), 剩 2 次
[diag] AU[5] 重投首 IDR 106336B(t=24), 剩 1 次
[diag] AU[6] 重投首 IDR 106336B(t=24), 剩 0 次
★ 帧#20 已上屏 @4887ms
★ 帧#21 已上屏 @5028ms
```

**Fed three times in a row, not one hang, and frames kept coming.**

Hypothesis A is out. The IDR itself is innocent; the claim "a second IDR always hangs" was wrong from the root — it was only the **symptom**; the real problem was something else happening in the window around the IDR's arrival.

## 2. The Real Culprit: An A-V Sync That Only Slows Down

Flipping further down the same log, one line repeats endlessly:

```
[ptsync] 视频落后, 暂缓解码 (累计 960)
```

It appeared 138 times in 240 seconds (one line printed per 16 frame drops), working out to over two thousand dropped frames.

The corresponding code looks like this:

```c
/* returns 1=wait (video ahead), -1=drop (video too far behind), 0=normal */
static int pts_should_skip_or_wait(void)
{
    ...
    long long diff = (long long)vp - (long long)target;
    if (diff < -(long long)thresh) return -1;   /* too far behind → drop frame */
    return 0;
}
```

Note that the function signature promises two things: "wait when ahead" and "drop when behind". But **the `return 1` branch was never implemented** — the whole function has only two outcomes: drop a frame, or do nothing.

So the logic became one-directional:

1. Video falls behind → drop a frame
2. Dropping a frame = consuming more slowly (in the code, `rb_take` discards one NAL and then `continue`s)
3. Slower = further behind
4. Back to step 1

**This is positive feedback.** Once triggered it only stalls harder and harder and never converges. Worse, the trigger condition is trivially easy to meet: a live stream's `video_pts_ms` updates only once every 6 seconds (one TS segment), while the wall clock `target` climbs every millisecond; during those 6 seconds `diff` runs steadily negative, and the moment it crosses the threshold (by then already relaxed to 5000ms) it is guaranteed to fire.

Incidentally, using it as the A-V sync reference is untenable in the first place: the audio runs on an independent mplayer + `bt_audio.fifo`, which is simply not the same clock source as the video.

## 3. A/B: The Gap of a Single env

No code changes — just one environment variable. Same binary, same source (Luxian 1080p), same 240 seconds:

| Round | NETTV_PTSSYNC | Frames on screen | AU progress | ptsync drops |
|------|---------------|---------|---------|------------|
| v13  | On by default | 19 | Stalls after AU[27] | 960 cumulative |
| v14  | `=0` off | 1191 (400-frame cap reached in just 63.6s) | AU[441] | 0 |

**About 80x.** And with it off, AU advanced all the way to 441, and the earlier "stops at AU[36]" phenomenon vanished as well — that too was an illusion created by the frame-drop storm, not a decoder crash.

## 4. The Fix

Since the conclusion is "this logic does more harm than good in the current architecture", the fix is to cement the verified env behavior into the default, keeping both the code and the switch:

```c
g_ptssync = (e && e[0] == '1') ? 1 : 0;   /* 10-20: off by default */
```

And to spell out why in the comments. The entire round's change is a single character-level difference, and the build artifact's size didn't change at all (still 128028 bytes) — **which also shows that this time you can't judge the build by binary size; you have to look at timestamps and behavior**.

## 5. Four Lessons

**1. A one-directional feedback loop is more dangerous than no feedback at all.**
A controller with deceleration but no acceleration is a one-way ticket once it enters the negative region. When writing closed-loop logic like "A-V sync", first confirm that both directions are truly implemented — don't let the function signature fool you.

**2. Symptoms masquerade as root causes, and they masquerade well.**
"A second IDR always hangs" was chased for three days; the truth is that the IDR's arrival happened to trigger a frame-drop storm. **First design an experiment that cleanly separates the two hypotheses (IDRREPLAY), then start fixing.**

**3. Always md5 after uploading.**
Last round's /tmp/r26.sh was 0 bytes yet showed PUSHED, causing "the experiment ran but no conclusion was obtained" to be misrecorded as "the experiment failed". This time the process was fixed — every step gets a `md5sum` check.

**4. Treat stutter and crashes with the same rigor.**
Crashes have backtraces; stutter has nothing, so it's tempting to guess. But locating stutter is actually cheaper — one env switch and you have an answer in four minutes.

---

*Related reading: [Spreadtrum SC9832A Network TV Deep Dive (9): One SIGKILL Rebooted the Device](nettv-09-sigkill-vsp-kernel-reboot.md)*
