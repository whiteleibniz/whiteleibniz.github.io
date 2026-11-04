---
title: "netTV Hardware Decoding Deep Dive (9): A Single SIGKILL Rebooted the Device — The Cost of Interrupting VSP Decoding, Plus Two Collateral Pits"
date: 2026-10-19 02:00:00
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Debugging, Kernel and Drivers]
tags: [VSP, Hardware Decoding, DMA, SIGKILL, Kernel Crash, OpenRC, stdio Buffering, Spreadtrum, nettv]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot/) · [繁體中文](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The earlier parts kept grinding away at "the second IDR always hangs", with log gaps and evidence repeatedly lost. This time I only wanted to add a diagnostic switch and run 60 seconds — and instead **rebooted the device twice in a row**. In the post-mortem, the incident itself is the most valuable conclusion: **interrupting nettv_player with `kill -9` during decoding is equivalent to letting the kernel clean up VSP's undrained DMA — it just crashes**. Along the way, two long-standing misjudgments were also cleared up.

## 1. Scene of the Incident

The experiment script was written the old way: start the player, `( sleep 75; pkill -9 ... ) &` as a fallback, `timeout -s KILL 90` for a hard stop. After the run, one look:

```
$ uptime
 02:28:42 up 1 min,  0 users        ← the device rebooted
$ wc -c /tmp/v11.log
4096                                 ← log only 4KB, and mostly NUL
```

Not exhausted sshd sessions, not a "hang" — **the device really rebooted**. ping stayed alive (the protocol stack is interrupt-driven), SSH was unreachable (processes couldn't be scheduled); it was the same thing as that evening of 10-18 when "ping worked but sshd was unresponsive" — I had judged the direction wrong then.

## 2. Root Cause: VSP's DMA Must Be Allowed to Drain Itself

The player's exit path has always contained `usleep(800000)`, annotated "drain DMA, prevent kernel crash". This is a pit stepped into as far back as 10-09: while VSP hardware is still writing frames into ion contiguous memory, if the process is killed by outside force, the driver side gets no chance to reclaim that DMA — what follows is a kernel crash.

The key point: **`SIGKILL` runs none of the user-space exit paths**. Neither does `_exit()`. So

- `pkill -9 -f nettv_player` ✗
- `timeout -s KILL 90 ...` ✗
- not one line of that 800ms drain code executes after SIGKILL ✓ (crash for your viewing pleasure)

There are only two correct ways to stop:

1. **Let it exit on its own**: the player's second parameter is the "total frame cap" (`g_arg2`, 0 = unlimited); reaching it triggers the normal exit flow:
   ```sh
   /usr/local/bin/nettv_player <m3u8-url> 400 > /tmp/v12.log 2>&1
   ```
2. **Send SIGTERM only**: the player installs a SIGTERM handler that stops feeding, drains DMA, then exits. SIGKILL is reserved as the fallback after 3 seconds, but **under normal circumstances it should never fire**.

After the change the script looks like this (`outputs/r26.sh`): no `-9` anywhere, relying on the frame cap for self-exit.

## 3. Collateral Pit 1: The Log Is 4KB Fully Buffered — the "Line-Buffered" Comment Lied to Me

The most bewildering point during triage: the process clearly ran for 75 seconds, yet the log file stayed at 4096 bytes forever and `grep` found nothing.

The reason is plain: **after stdout is redirected to a file it is 4KB fully buffered**, and the code comment's "line buffering enabled (`setvbuf _IOLBF`)" did not take effect on this path. Process gets SIGKILLed → the buffer never flushes → what you see are several 4KB blocks with the last chunk entirely lost.

Therefore:

- Experiment logs **must be read after the process exits normally**; don't count on a killed process to spit out its tail;
- to judge "is the program stuck", don't look at log size alone (jumping in 4KB steps) — look at `pgrep` and `/proc/<pid>/stat`.

## 4. Collateral Pit 2: An OpenRC Service Without `start()` Is Silently Skipped

At the very start the experiment threw a scary-looking error:

```
CANNOT LINK EXECUTABLE: library "libc.so" not found
```

Digging in, every `/system/lib/*.so` was a dangling symlink — they point at `/mnt/android_sys/lib/`, and **the android_sys partition is simply not mounted**.

The hardening script `/etc/init.d/00_android_sys` exists, and `rc-update show` also shows it in the default runlevel, yet it just never runs at boot. The reason: an OpenRC runscript **must define `start()`** (or use `command=` / `start_stop_daemon`); a bare stretch of shell is silently skipped. Rewriting it as a standard runscript fixed it immediately:

```sh
#!/sbin/openrc-run
depend() { need localmount; }
start() {
    mount | grep -q android_sys || mount -t ext4 -o ro /dev/mmcblk0p17 /mnt/android_sys
    printf 'nameserver 8.8.8.8\nnameserver 114.114.114.114\n' > /etc/resolv.conf
    ip route | grep -q default || route add default gw <RNDIS-GW>
}
```

`rc-service 00_android_sys start` → `mnt=304`, problem solved. From now on, seeing `library "libc.so" not found`, check `ls /mnt/android_sys/lib | wc -l` first; don't touch the compile flags.

## 5. The Experiment I Actually Wanted: Bisect "the Second IDR Hang"

Incident aside, the diagnostic switch is already in the source (`outputs/sprd_msg_np_v2.c`, environment variable `NETTV_IDRREPLAY`, default 0 = off):

**Idea**: the current symptom is that every generation of worker lives to AU[36] (GOP#2's IDR), then DRIVE hangs for 5~10 seconds. Two possibilities:

- **A. Component-state theory**: in streaming state, *any* IDR hangs, regardless of how many rounds have been fed → the fix is a decoder soft reset at the GOP boundary (flush + rebuild buffers), no process restart needed;
- **B. Cumulative-drift theory**: the first 35 rounds consumed some resource (ion/CMA, offsets, reference counts), and the IDR just happened to hit the blowup point → the fix is entirely different: investigate the leak across those 36 rounds.

**Method**: after capturing the first IDR, **immediately feed the same IDR K times in a row** (zero accumulation, component state identical to AU[36]). If the first replay hangs, A holds; if 3 replays all pass and it still takes until round 36 to hang, B holds.

Just two criteria:

```
grep -n "\[diag\]" /tmp/v12.log      # IDR lines captured/replayed
grep -n "超时逃生\|alarm 超时" ...    # any hang right after
```

The binary is already built and deployed (`nettv_player` 118788 bytes, the old build backed up as `.bak_1019`), but **no live-run data this time** — cut short by the two reboots above.

## 6. Three Disciplines for the Next Session

1. Before starting an experiment, `pgrep` to confirm no other playback processes; **wrap up with SIGTERM or the frame cap only** — any `-9` is equivalent to rebooting the device.
2. After each run, check `uptime` first; any data from a rebooted device is void (incomplete logs, scene gone).
3. Before running the player manually, stop the desktop first (lvgl_demo holds the fb; double-write conflict), otherwise the symptoms get contaminated.

This one is last because it is the most expensive: a single reboot zeroes out the previous half hour of forensics.
