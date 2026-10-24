---
title: "Fixing the nettv Player's No-Picture and Key Blocking Failures: When a Source Is Unreachable, Exit — Don't Restart Forever"
date: 2026-10-12 21:00:00
tags:
  - nettv
  - VSP Hardware Decoding
  - Embedded
  - Bug Fix
categories:
  - Troubleshooting Notes
  - Video Playback
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/12/nettv-no-picture-key-block-fix/) · [繁體中文](https://whiteleibniz.github.io/2026/10/12/nettv-no-picture-key-block-fix-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/12/nettv-no-picture-key-block-fix-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

# Fixing the nettv Player's No-Picture and Key Blocking Failures

## 1. Symptoms

After a user taps a channel under "Network TV" on the desktop:

- `nettv_player` can be seen running in the background, sometimes even with several leftover processes from history at the same time;
- the frontend shows no picture;
- all navigation keys are dead (only the "buy single" key works; the UI looks frozen).

## 2. The Root-Cause Chain (Three Layers, Each Deeper Than the Last)

### 2.1 Direct Cause: All Channel Sources Dead

On-device measurement of the channel table: 8 sources, with `curl` returning `000` for all of them (connection timeout). Public live sources (voc, regional P2P streams) have an average lifetime of only a few weeks; dying is the norm.

### 2.2 Deeper Cause: The Player's Handling of "Source Unreachable" Is Infinite Restarts

The structure of `nettv_player` (sprd_msg baseline) is "monitor parent + decoder child":

- the child fails to pull the m3u8 → `load_chunk` fails → `_exit(10)`;
- the monitor parent **ignores the exit code**, re-forks after 150ms → fails again → restarts again...

So the process never exits and never decodes a frame. This directly produces two user-visible symptoms:

- **No picture**: no frame is ever decoded;
- **Key blocking**: the UI page (`nettv_page.c`) pauses the LVGL main loop when it starts the player and installs a key interceptor, with a waiter thread blocked in `waitpid` to reap the corpse — the player doesn't exit, so the waiter thread never returns, and the UI and keys never recover.

### 2.3 The Deepest Pit: Three Timing Races in a Row While Fixing "Exit on Unreachable Source"

The first patch was straightforward — 3 consecutive failures to pull the playlist = death sentence, exit code 98, and the monitor doesn't restart on 98. But on-device testing showed it **completely didn't work**; the log still showed infinite restarts. Peeling it apart layer by layer revealed three races:

1. **The stall watchdog kills the source-fetching phase by mistake**: the watchdog's logic is "8s grace at startup + kill and restart if no new frame for 5s after that". But VSP component init alone takes several seconds, and 3 curl retries take another 15~25s — the watchdog kills the child before it even reaches "pull the list", so exit code 98 never gets a chance to be produced.
2. **The gap between two fetches**: even with the "pulling list" shared flag added, the flag is only set inside `hls_pick()`; during the inter-segment `sleep(1)` and the curl fork gap the flag is 0, and the watchdog fires anyway.
3. **Startup grace conflated with playback grace**: "never output a frame" (startup) and "hung after outputting frames" (VSP hung) share the same 8s grace, while the legitimate startup cost (component init + source fetch + 25s download) should be much longer.

## 3. The Fix

### Player Side (`sprd_msg_np.c`, 4 places)

1. `hls_pick()` return-value semantics: `1` = got a new segment, `0` = live hasn't refreshed yet, `-1` = can't even pull the playlist (source unreachable);
2. `load_chunk()`: 3 consecutive `-1` = death sentence, set `g_src_dead` and **notify the monitor immediately via the shared-memory flag `shm[1]=98`** (no need to wait for the exit code; responds within 0.4s);
3. monitor parent: sees flag 98 → kills the child → `_exit(98)`, never restarts; the exit-code 98 path is kept as a second line of judgment;
4. **stall watchdog tiered by semantics**: `prev>0` (has output frames, VSP hung) keeps the 8s+5s fast restart; `prev==0` (never output a frame = startup) gets 90s grace. During source fetching (including sleep/curl gaps) `shm[2]=1` is set throughout to suppress the watchdog, with a 60s consecutive playlist-pull timeout as the backstop.

### UI Page Side (`nettv_page.c`)

The waiter thread routes by exit code after reaping: when `WEXITSTATUS(status)==98`, it uses `lv_async_call` to change the status bar on the main thread to "Channel source unreachable, returned automatically (switch channels or edit the channel table)". LVGL objects may only be touched on the main thread; cross-thread notifications must go through `lv_async_call`.

### Channel Table

After all 8 sources died, the on-device replacement is 4 live sources (Qianjiang Metro / Shangyu / Songpan / Luxian, all returning valid m3u8), with the old table backed up as `stations.m3u.bak_20261012`.

## 4. Verification Results

| Scenario | Before the Fix | After the Fix |
|---|---|---|
| Tapping a dead-source channel | player restarts forever, UI frozen permanently, only a power cut left | exits automatically in ~40s (exit code 98), UI and keys recover, status bar shows source unreachable |
| Tapping a live-source channel | — | decodes frames normally (Qianjiang Metro measured: 4 frames per round before hitting the known "second IDR hang", monitor restart loop; a legacy issue) |

## 5. Lessons Learned

1. **"A background process is running" does not mean "it is working"**: in this case, the process running is precisely the fault itself — an infinite restart loop. To judge health, look at functional truth values (frame count, exit code), not process existence.
2. **Watchdog grace must be tiered by semantics**: the legitimate time cost of startup (including network source fetching) and of a runtime hang differ by an order of magnitude; sharing one 8s grace will kill by mistake during startup, turning "a flow that would have exited on its own" into "infinite restarts".
3. **When fixing a "should exit" class of bug, first confirm there is no deeper "kill early" mechanism**: no matter how right the exit-code design is, if the watchdog SIGKILLs first it can never get through. Parent-child communication should prefer the shared-memory flag (immediate); the exit code is only the backstop.
4. **Idempotent operations should not have preconditions, and waiting conditions should not use timers**: in this case the watchdog's exit condition is nominally the "no new frame" event but actually smuggles in an "8s timer", and the moment you mix them it's wrong (the mirror image of "a loop waiting on a child process with no time limit").
5. **For UI blocking failures, first ask "who is waiting for an event that will never come"**: here it is `waitpid` waiting on a player that never exits. Make the child process guaranteed to exit (exit code 98 + SIGKILL backstop), and a blocking wait is safe.

## 6. Remaining Issues

- **Second IDR hang** (`addr=0x747474` segfault or permanent hang): after the first GOP of a 1080p live stream outputs ~4 frames, feeding the second IDR always triggers it; monitor restarts only buy a "4 frames per round" slideshow mode. This is the last obstacle to smooth nettv playback, and it is already on the daily scheduled task list.
- Live sources need periodic inspection and replacement; the channel table goes stale every few weeks on average.

---

> **Copyright**: This article is original work by whiteleibniz (with AI-assisted editing). Copyright belongs to whiteleibniz. Please credit the source and link to the original article when reposting: https://whiteleibniz.github.io
