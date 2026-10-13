---
title: "nettv Player No-Picture and Key-Blocking Failure Fix: an Unreachable Source Must Exit, Not Restart Infinitely"
date: 2026-10-12 21:00:00
lang: en
permalink: en/2026/10/12/nettv-no-picture-key-block-fix/
search: true
categories:
- 排障手记
- 视频播放
tag:
- nettv
- VSP硬解
- 嵌入式
- 故障修复
---


# nettv Player No-Picture and Key-Blocking Failure Fix

## I. Failure Symptoms

After the user clicks a "Network TV" (网络电视) channel on the desktop:

- the `nettv_player` process can be seen running in the background, and there are even multiple historical leftover processes at the same time;
- the frontend shows no picture at all;
- all navigation keys fail (only the pay (买单) key works, and the interface looks frozen).

## II. The Root-Cause Chain (Three Layers, Each Deeper Than the Last)

### 1. Direct Cause: All Channel Sources Have Failed

The device's channel table has 8 sources, and `curl` returns `000` (connection timeout) for all of them. Public live sources (voc, various local P2P streams) have an average lifetime of only a few weeks, so failures are the norm.

### 2. Deeper Cause: the Player Handles "Source Unreachable" with Infinite Restarts

The structure of `nettv_player` (the sprd_msg baseline) is "monitor parent process + decoding child process":

- the child process cannot fetch the m3u8 → `load_chunk` fails → `_exit(10)`;
- the monitor parent process **ignores the exit code** and re-forks after 150ms → fails again → restarts again……

As a result, the process never exits and never decodes a frame. This directly causes two user-visible symptoms:

- **no picture**: no frame is decoded at all;
- **key blocking**: when starting the player, the UI page (`nettv_page.c`) pauses the LVGL main loop and installs a key interceptor, with a waiting thread blocking in `waitpid` to reap the child — if the player does not exit, the waiting thread never returns, and the interface and keys never recover.

### 3. The Deepest Pit: Three Timing Races Were Hit in a Row When Fixing "Exit on Unreachable Source"

The first version of the patch was straightforward — after 3 consecutive failures to fetch the playlist, declare it dead, use exit code 98, and have the monitor not restart when it sees 98. But testing showed it **completely ineffective**, and the log still showed infinite restarts. Layer-by-layer analysis revealed three races:

1. **The stall watchdog mistakenly kills the source-fetching phase**: the watchdog's logic is "an 8s startup grace period + killing and restarting after 5s with no new frame". But the VSP component's init alone takes several seconds, and 3 curl retries take another 15~25s — the watchdog kills the child process before it even reaches "fetch the list", so exit code 98 never has a chance to be produced.
2. **The gap between two fetches**: even with a shared "fetching list" flag added, the flag is set only inside `hls_pick()`, and it is 0 during the inter-segment `sleep(1)` and the curl fork gap, so the watchdog fires anyway.
3. **The startup-phase and playback-phase grace periods are conflated**: never having output a frame (startup phase) and hanging after having output frames (VSP hang) use the same 8s grace period, whereas the legitimate startup-phase duration (component init + source fetching + 25s download) should be much longer.

## III. The Fix

### Player Side (`sprd_msg_np.c`, 4 Places)

1. Semanticize the return value of `hls_pick()`: `1`=a new segment was obtained, `0`=the live stream has not refreshed yet, `-1`=the playlist cannot be fetched at all (source unreachable);
2. `load_chunk()`: three consecutive `-1`s declare it dead; set `g_src_dead` and **immediately notify the monitor via the shared-memory flag `shm[1]=98`** (without waiting for the exit code; responds within 0.4s);
3. Monitor parent process: on seeing flag 98 → kill the child process → `_exit(98)`, and never restart; a second determination via exit code 98 is also retained;
4. **The stall watchdog is tiered by semantics**: `prev>0` (frames have been output, VSP hang) maintains the 8s+5s fast restart; `prev==0` (never output a frame = startup phase) gets a 90s grace period. During the source-fetching phase (including the sleep/curl gap), `shm[2]=1` is set throughout to exempt the watchdog, with a fallback if consecutive playlist fetches exceed 60s.

### UI Page Side (`nettv_page.c`)

After the waiting thread reaps the child, it branches by exit code: when `WEXITSTATUS(status)==98`, use `lv_async_call` to change the status bar on the main thread to "channel source unreachable; automatically returned (switch channels or edit the channel table)". LVGL objects may only be touched on the main thread, so cross-thread notifications must go through `lv_async_call`.

### Channel Table

After all 8 sources died, they were replaced on the device with 4 live sources (钱江都市/上虞/松潘/泸县, all returning valid m3u8), and the old table was backed up as `stations.m3u.bak_20261012`.

## IV. Verification Results

| Scenario | Before the fix | After the fix |
|---|---|---|
| Clicking a dead-source channel | the player restarts infinitely, the interface is permanently frozen, and the only option is to power off | automatically exits after about 40s (exit code 98), the interface and keys recover, and the status bar indicates the source is unreachable |
| Clicking a live-source channel | — | frames decode normally (钱江都市 measured: after 4 frames per round it hits the known "second IDR hang", with a monitor restart loop — a remaining issue) |

## V. Lessons Learned

1. **"A background process is running" does not mean "it is working"**: in this case, the process running is precisely the failure itself — an infinite restart loop. To judge health, look at functional truth values (frame count, exit code), not process existence.
2. **The watchdog's grace period must be tiered by semantics**: the legitimate durations of the startup phase (including network source fetching) and a runtime hang differ by an order of magnitude; conflating them into a single 8s grace period causes mistaken kills during startup, turning "a flow that would have exited on its own" into "infinite restarts".
3. **When fixing "should exit"-type bugs, first confirm there is no lower-level "kill early" mechanism**: no matter how correct the exit code design, it will never get through if the watchdog SIGKILLs first. Parent-child process communication should prefer shared-memory flags (immediate), with exit codes only as a fallback.
4. **Do not add preconditions to idempotent operations, and do not use timing for wait conditions**: in this case, the watchdog's exit condition is ostensibly the "no new frame" event, but in reality an "8s timer" is mixed in, and mixing them makes it wrong (the mirror image of the same class of error as "not setting a time limit on the loop waiting for a child process").
5. **For UI-blocking-type failures, first ask "who is waiting for an event that will never come"**: in this case, it is `waitpid` waiting for a player that never exits. Make the child process guaranteed to exit (exit code 98 + SIGKILL fallback), and the blocking wait is safe.

## VI. Remaining Issues

- **Second IDR hang** (an `addr=0x747474` segmentation fault or permanent hang): after a 1080p live stream outputs about 4 frames in the first GOP, feeding the second IDR always triggers it, and a monitor restart only buys the "4 frames per round" slideshow pattern. This is the last obstacle to smooth nettv playback, and it has been added to the daily scheduled attack task.
- Live sources need regular inspection and replacement; the channel table fails on average once every few weeks.

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
