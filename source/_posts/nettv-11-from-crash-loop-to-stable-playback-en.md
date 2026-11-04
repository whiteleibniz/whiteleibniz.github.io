---
title: "Getting Network TV Working: From Three Crashes a Day to 4800 Consecutive Frames"
date: 2026-10-19
tags:
  - nettv
  - vsp
  - Spreadtrum
  - sc9830
  - kernel crash
  - green screen
  - framebuffer
  - debugging methodology
categories:
  - Technology
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/19/nettv-11-from-crash-loop-to-stable-playback/) · [繁體中文](https://whiteleibniz.github.io/2026/10/19/nettv-11-from-crash-loop-to-stable-playback-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/19/nettv-11-from-crash-loop-to-stable-playback-en/)

# Getting Network TV Working: From Three Crashes a Day to 4800 Consecutive Frames

> Device: Spreadtrum SC9832A (sc8830 family), Alpine/armv7l, 720×1280 portrait screen, LVGL desktop.
> Goal: HLS live streams hardware-decoded by the VSP and output to framebuffer, matching the official Android player's playback quality.
> Final result: Liaoning TV's "Village Fortune" broadcasting stably, uptime 36 minutes with zero reboots, 4808 frames on screen.

## Starting Point: Crashes on Every Run

The new build crashed on every run, stopping at the phase stake's last line:

```
>> fill(out)#1 开始 g_nout=1
   fill(out) 交第0路 hdr=0xb6d8ec80 pBuffer=0xb6d9ba80
                                    ← 没有下一行，设备重启
```

`sigsetjmp` couldn't catch it, `dmesg` showed no OOM, and 882 MB of memory still remained. A kernel-mode crash.

## Five Root Causes, Five A/B Tests

### Root Cause 1: The Debug Code Was the Crash Cause

On the evening of 10-18 I added a "capture the hang in the act" kit: `vrp_hook()` hooks the vendor's VSP register write function, **reading the MMIO register windows** `rb + 0x60901000` / `rb + 0x60908000` directly on every call; `tr_line()` is even more aggressive, reading once before and after every DRIVE.

`vrp_hook` is a high-frequency path walked on every polling round. So the VSP state machine got scrambled, crashing at the immediately following `DRIVE fill(out)#1`.

**The crash point is not the debug code's own line**, so the stack, the logs, and the signal handlers all fail to point at it.
The old (working) build had none of this code — which is what made me think of comparing.

Fix: `NETTV_TRACE_MMIO` defaults to 0, returning immediately without touching MMIO.
Verification: ran to AU[1100]+, all 564 fills returned, zero reboots.

### Root Cause 2: NAL Fragmentation

The smoking gun from three crash scenes — **the crash point always immediately follows a NAL cut into multiple pieces**:

```
AU[109] sub1/4  4096B 后崩
AU[369] sub1/2  4096B 后崩
AU[36]  sub28/28 3048B 后崩
而 sub1/1（未切碎）从不崩
```

Decisive A/B: `NETTV_CHUNK=0` → 1200 frames up to AU[1100]+ with zero reboots; the default 4096 → crashes on every run.

Mechanism inference: the vendor library's handling of "one NAL fed in multiple nOffset continuations into the same buffer" is defective.
(I initially looked in the wrong direction — `NETTV_SPLIT` governs splitting at NAL boundaries; fragmentation is decided by `g_chunk`. The two are different.)

### Root Cause 3: Virtual Address Mistaken for Physical → All Green

Two adjacent lines in the log are the smoking gun (same fd=12):

```
登记 fd=12 → pa=0xb1ce6000            ← 虚拟地址（错）
[ion] Get_phy_addr#1 fd=12 真PA=0x9fa00000   ← 真物理地址（对）
```

The vendor VSP writes frames treating `handle->ints[12]` as the **physical address**, while what I filled in was the mmap'ed virtual address.
The hardware can't reach user-space virtual addresses → nothing gets written into real video memory → the screen goes all green.

Fix: added `g_gh_pa[]` to store the true PA; all 4 occurrences of `fh[12]` now filled with the PA; the VA is left only for the CPU to read frames.

### Root Cause 4: ION Can't Be Grabbed + Never Released

When self-managed ION (heap mask=8 `carveout_mm`, physically contiguous) is grabbed, everything works; when it can't be, `ghOut` falls back to gralloc's real handle — and gralloc uses an IOMMU heap, **with no physically contiguous backing**, so the VSP writing frames with a fake PA is guaranteed to crash the kernel.

Two changes: 6 retry rounds + 120ms backoff + a size ladder; if it still can't be grabbed, `_exit(12)` and let the watchdog restart it — **better to show no picture than to knock the kernel flying**. Also, call `ION_IOC_FREE`(0xc0044901) to release it proactively before exiting.

### Root Cause 5: The Most Expensive One — Me

`ps | grep -c nettv_player` showed **12~23 zombie processes** piled up.

In every debugging round I'd `nohup` a script, and the monitor internally respawns worker/worker-dl/mplayer on its own, leaving an extra full set per experiment round, each grabbing 2MB of C1 buffer → the pool gets stretched to bursting → subsequent launches fail.

`pgrep -x nettv_player` only counts the main process and can't see these, so I once misdiagnosed it as a "kernel leak", and even wrote a dedicated `ion_release()` to fight the fire.

After `pkill -f nettv_player` cleared them all, the pool immediately returned to `total 0`, **and playback worked immediately**.

> This one is the most valuable: **the symptom and the real cause are worlds apart, and the only dividing line is "asking one more question with ps"**.

## The Last Hour: The Screenshot Fooled Me for an Hour

The picture clearly made it to the screen, yet what I captured was the old WiFi settings page — 4 shots in a row, all identical.

Real cause: `/sys/class/graphics/fb0/virtual_size = 720,3840` — the fb has 4 pages, and my screenshot script only reads **page 0**. Meanwhile `fb_render()` writes at the `g_fbpg*720*1280*4` offset every frame and `fb_pan()` flips pages, so the content is on pages 1/2.

**An old picture in a screenshot ≠ nothing reached the screen.** Check `virtual_size` first, then draw conclusions.

I also made the screenshot script automatic on the side: driving `pan_offset` to a constant 0 can't read the current page, so it counts **color variety per page** and takes the maximum (measured: page0=55 colors, leftover from the old page, vs page1=617 colors, the real picture).
I tried "sampled sum" along the way and it picked backwards — the sum reflects brightness, not diversity.

## Final Verification

```
uptime 36min  零重启
上屏 4808 帧
画面: 辽宁卫视《乡村财富》  人物清晰 / 字幕可读 / 台标正常 / 色彩正确
```

## Methodology Review

**1. "The debug code was the crash cause" is an independent class of failure mode.**
It never crashes on its own line, so the stack and the logs all fail to point at it.
Only by putting the working old build and the crashing new build **side by side**, comparing runtime state field by field, can you see "the old build doesn't have this part".

**2. Crash-point patterns are far more powerful than "guessing hypotheses".**
Root cause 2 was spotted at a glance from the pattern "the crash point always immediately follows subN/M", not by deduction. **When you have multiple crash scenes, the first thing to do is find their common pattern.**

**3. The debugging period must have an absolutely reliable forensics channel.**
On this project, stdout is swallowed by the custom stdio's 4KB block buffer, and the whole buffer is lost at crash time — I misjudged three times off empty logs. Later I switched to the `O_SYNC` direct-write phase stake, verifying with `md5sum` on every script upload (I stepped on 3 cases of 0-byte scripts causing the misjudgment "the new build doesn't crash").

**4. When it "won't run", `ps` it first.**
Really — it costs 1 second and saves an hour of wrong attribution.

**5. A/B is the only honest experiment.**
Every one of this article's five root causes was pinned down by "change one variable, run once, compare".
Of the hypotheses I guessed by deduction, I tried eight — all wrong.

---

*Related reading: [The Debug Code Was the Crash Cause: 8 Layers of Falsification for One VSP Kernel Crash](nettv-10-debug-code-is-the-crash-cause.md) (a detailed breakdown of root cause 1)*
