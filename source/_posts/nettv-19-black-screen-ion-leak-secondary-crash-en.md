---
title: "nettv-19: Black Screen and No Response? — When the 'It Always Crashes' Conclusion Met the Secondary Crash of an ION Leak (SC9832A Hardware Decoding Field Notes)"
date: 2026-10-21 09:30:00
tags:
  - sprd
  - SC9832A
  - VSP
  - ION
  - carveout
  - SIGSEGV
categories:
  - [Embedded, Network TV Hardware Decoding]
  - [Debugging, Methodology]
  - [Linux, Memory Management]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The user pushed the door open with one sentence: "The netTV is showing a black screen and not responding."

The device answers ping, SSH works, and the desktop process `lvgl_demo` is still alive — but the player `nettv_player`'s monitor watchdog is stuck in an infinite restart loop, every worker round ending with `exit 11`, so the screen stays black forever.

This part documents the investigation. The point is not "what code was fixed", but a lesson that keeps biting: **the "it always crashes" conclusion you have been staring at for half a month may be nothing more than a secondary symptom of another crash.**

## 1. The Scene: Process Alive, Zero Frames

First the trio: process tree, log tail, dmesg.

```sh
ps | grep -E "[n]ettv|[l]vgl_demo"      # desktop alive, player present, but zero frames
tail /tmp/nettv.log                     # *** monitor: restart (child @0 frames) × 7 rounds
dmesg | tail                            # last entry is a CPU hotplug from 33 minutes ago, nothing new since
```

Three pieces of information add up to one judgment:

1. **Not a kernel crash** — dmesg has no new entries; a pure user-space problem;
2. **The desktop is not dead** — `lvgl_demo`'s main process is alive and the keys respond;
3. **The player is spinning** — each round monitor spawns a worker, the worker cannot get an output buffer and `_exit(11)`s, monitor spawns again, an infinite loop. The ION/carveout pool is eaten bite by bite by this loop; the more it loops, the less it can grab.

`exit 11` maps very clearly in the code (`sprd_msg_np.c`, lines 4673/4674):

```c
} else { P("  alloc crash\n"); which_lib(g_fault); _exit(11); }
if (!bhIn || !bhOut) { P(">>> buffer allocation failed\n"); _exit(11); }
```

**Recovery takes one step**: `pkill -f [n]ettv_player` (SIGTERM, so the process takes the normal exit path — before exit there is an 800ms DMA drain; only abnormal exits fail to reclaim ION). Two seconds later the processes are cleared, and the desktop is back immediately.

## 2. Interlude: A "Memory Health Probe"

After clearing the field, probe the build in passing:

```sh
echo "int main(){return 0;}" > /tmp/t.c
gcc -O0 -o /tmp/t.out /tmp/t.c
```

In the small hours the device's gcc was still broken — `Error relocating /usr/lib/libisl.so.23: <garbled symbol>: symbol not found` — yet the file itself had matching md5 twice over, a normal ELF header, and readelf could read the real symbol names. The verdict at the time: **not file corruption — the page cache had been trampled by VSP/ION DMA**. After the device rebooted in the morning, the same command passed on the first try.

That yields a zero-cost probe; from now on, run it before starting work:

> **`gcc -O0` fails to compile + libisl reports garbled symbols ⇒ the device's memory has been trampled by DMA. Reboot; do not force-fix packages.**

## 3. Re-running the Baseline, the "It Always Crashes" Conclusion Collapses

Field cleared, probe passed — so replay the UI path's real scenario once: m3u8 live stream, no tuning env at all, even deliberately carrying the poison env variables that trigger the old bug, for 40 seconds:

```
[STAT] frames=125 elapsed=7219ms fps_x10=173
[dl] NAL 直方图: g_nau=297 | slice(1)=522 IDR(5)=18 SPS(7)=18 PPS(7)=18
```

**125 frames, 17.3fps, 18 IDRs, 0 SIGSEGVs.**

This directly overturns the verdict that had hung in project memory for over a month — "on a 1080p live stream, after the first GOP produces 4 frames, feeding the second IDR always SIGSEGVs (addr=0x747474)". For that conclusion, GOT patches, binary-search double submits, and UAF patches had all been tried, to no avail.

The truth: that `0x747474` (ASCII "ttt" — an address that at a glance looks like it was filled in by TS stream data) was never an IDR problem; it was a **secondary crash where `alloc` returned a bad pointer after the ION pool was drained by the monitor restart-loop leak**. At first-round init the components must grab 2MB of carveout, the output buffer wants another 3.2MB, and the pool is only single-digit MB in total; when a worker exits abnormally (`_exit(11)` / killed by a signal), ION is not reclaimed, so every restart round scrapes another layer off the remaining pool — until one alloc landed on dirty memory, and that round happened to be feeding the second IDR.

**Root cause, secondary effect, and coincidence lined up as a single straight line on the timeline, looking like causation.** That was the most expensive lesson of this investigation.

By the way: in the small hours, two attempts to add "unbuffered stdout" to the player (so the last 4KB of log before a crash is no longer lost) both failed to build, and at the time I nearly attributed it to "a code problem" too — in fact gcc had already been trampled by DMA, having nothing whatsoever to do with the code. **The same class of "environment/linker" symptoms, tripped over twice in a row — a good measure of how hard this reflex is to retrain.**

## 4. Methodology, Distilled

Solidify this round's practice into three rules; next time you hit "black screen / always crashes", follow them directly:

**1. The Black-Screen Trio (in order, one conclusion per step)**
- `ps`: has the desktop process died — alive-or-dead decides whether to "rescue the desktop" or "rescue the player";
- the player log: is it a spin loop — the monitor restart counter is the most glaring signal;
- `dmesg`: any new kernel records — if none, look honestly in user space; do not shove blame onto the kernel.

**2. Only SIGTERM Reclaims ION**

`pkill -f nettv_player`, not `-9`. The player's exit path contains DMA draining and ION release; being hard-killed by a signal is equivalent to permanently leaking a chunk of the pool, fixable only by rebooting the device. For projects with a small pool (single-digit MB), **every watchdog restart round is real memory** — so watchdog strategies like "kill it when no new frames appear" demand extra care on small-memory-pool devices: when the segment interval (~10s) is longer than the kill threshold, the watchdog is killing its own.

**3. An "It Always Crashes" Conclusion Must Pass Three Gates**

Before a crash conclusion goes into memory, ask yourself:

- Has the input changed? (single TS direct connection vs m3u8 live — different paths)
- Has the resource state changed? (ION pool full vs drained by a leak)
- What does the crash address look like? (`0x747474` = "ttt" — a data-looking address like this: suspect a trampled buffer first, not the algorithm)

An "always crashes" that fails any one of the three gates is only "always crashes under the current pile of preconditions".

## 5. Next Steps

- **Empty-frame rate 53%**: in this log, 60 real frames (`filled=3133440`) against 68 empty frames (`filled=0`). After EOS the decoder is still being fed idle spins, related to the single-queue structure of `g_nout=1` (only 1 output channel won; the official baseline is 5). Cutting the idle-spin rounds amounts to a direct +50% effective throughput, more worthwhile than continuing to squeeze memcpy.
- **UI first-round failure vs manual first-round success**: under the same conditions, after a kernel reboot, opening from the UI gives exit 11, while a manual run produces frames. Suspect the desktop `lvgl_demo` grabbed part of the memory/ION first; to be reproduced and confirmed.

---

> **Copyright**: This article is an original technical note; the author reserves all rights. Please credit the source when reposting (whiteleibniz.github.io); unauthorized commercial use is prohibited.
> The devices, source code, and conclusions mentioned come from a personal embedded project's field records (Spreadtrum SC9832A / Alpine Linux / LVGL); all data is measured.
