---
title: "The Real Reason netTV Only Outputs 4 Frames: VSP mbinfo Memory Pool Exhaustion Triggers a Hardware-Decode Downgrade to Software (Not the \"Second IDR's Fault\")"
date: 2026-10-13 02:30:00
tags:
  - nettv
  - VSP hardware decoding
  - ION
  - CMA
  - Bug Fix
categories:
  - Troubleshooting Notes
  - Video Playback
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback/) · [繁體中文](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback-en/)

# The Real Reason netTV Only Outputs 4 Frames

## 1. Symptom

Playing a 1080p m3u8 live stream on "Network TV" on a Spreadtrum SC9832A device, each round only outputs **4 frames**, then the picture freezes; when the second IDR is fed, it always crashes (`SIGSEGV addr=0x747474`) or hangs permanently, and can only be restarted by the monitor process, manifesting as a "4 frames per round" slideshow mode.

In earlier rounds of troubleshooting, the conclusion was recorded as "vendor library defect: the second IDR always hangs", and a workaround was made (actively respawn upon detecting the second IDR). **This conclusion is wrong** — the second IDR is only a secondary phenomenon.

## 2. The Real Root-Cause Chain

The key move: don't just look at "which round it crashed in"; pull **each round's feed return codes** into a timeline. Use a regex to extract each AU's `decRet / frameEffective / consume byte` from the log, and the result is clear at a glance:

```
AU[  3] sz= 106336 t=5  ret=0   eff=0 cons=106336   ← 第一个 IDR，解码成功
AU[  4] sz=   8983 t=1  ret=0   eff=0 cons=8983
...
AU[  9] sz=  13967 t=1  ret=0   eff=0 cons=13967    ← 出第 4 帧
AU[ 10] sz=  17116 t=1  ret=-3  eff=0 cons=17116    ← ★ 突变点
AU[ 11] sz=  13424 t=1  ret=-9  eff=0 cons=13424    ← 从此恒 -9
AU[ 12..35]                 ret=-9  needIVOP:1 ...
```

Pulling up the vendor log for the AU[10] round, the real cause is written right there:

```
VSP_malloc_mbinfo_cb, 1770, idx: 4, size_mbinfo: 653824
ioctl c0144900 failed with code -1: Out of memory
[ion] C1 /dev/ion alloc(653824,heap=0,align=8) FAILED rc=-12
[ion] get_phy_addr: heapID=0 base=0x0 -> fail
mPmem_mbinfo[4]: get phy addr fail -1
H264Dec_init_picture, 648, mbinfo memory is not enough
H264Dec_Process_slice, 117, error_flag=0x2
decRet: -3
failed to allocate memory.
change to sw decoder.
```

The next round immediately:

```
onQueueFilled, 1122, change to sw decoder, mThumbnailMode: 0
H264Dec_ReleaseRefBuffers, 32
openDecoder, lib: libomx_avcdec_sw_sprd.so
decRet: -9, needIVOP: 1, SPS:0, PPS:0
```

String it together:

1. VSP needs one **653824-byte mbinfo** (macroblock info) roughly every 2 frames decoded, and **never frees it**, requesting in increasing idx order;
2. the CMA contiguous memory pool is only ~7MB; after subtracting the 3.1MB output frame buffer and 1.5MB input buffer, it only holds **4 blocks** of mbinfo;
3. the 5th block's `ion_alloc` returns `-ENOMEM` → `decRet=-3`;
4. the component's handling is to **permanently switch to the software decoder** (`libomx_avcdec_sw_sprd.so`) — this is a **one-way door**;
5. the software decode path cannot get the SPS/PPS fed in earlier (`SPS:0 PPS:0`), so each round returns `-9 needIVOP` (wants an I-frame), and it can never output frames again;
6. the picture freezes at 4 frames; when the second IDR is fed again, it crashes or hangs inside the software decode context.

**So "the second IDR crashes" is not a bug; it is the inevitable result after hardware decoding has already died.**

## 3. The Fix (Three Places, All Around "Never Let It Switch to Software Decoding")

### 3.1 Reuse Old Blocks When mbinfo Allocation Fails

The original LRU reuse only triggered when "the pool is full (`g_c1r_n >= C1_REUSE_MAX=5`)". But the actual CMA only holds 4 blocks; the 5th allocation fails outright, so **the reuse logic is never reached**. Change to two trigger paths: pool full **or** this `ion_alloc` failure.

```c
static int c1_reuse(void *self, const char *name, unsigned size)
{
    if (size != C1_REUSE_SZ || g_c1r_n <= 0) return 0;
    int s = g_c1r_next % g_c1r_n;   /* note %g_c1r_n, not %MAX */
    g_c1r_next++;
    ...  /* fill the old block's fd/base/handle/PA into the new MemoryHeapIon object */
    map_add(g_c1r[s].buf_fd, g_c1r[s].pa, size);
    return 1;
}
```

The cost is possibly reusing blocks still referenced by the DPB (may cause corrupted frames), but compared with "permanent software decoding", this cost is worth paying.

### 3.2 Retry with Progressively Lower Alignment on Allocation Failure

The original alignment algorithm was `order = ceil(log2(size))`, capped at 8. A 639KB mbinfo gets computed as a **1MB alignment** request, and CMA quickly fragments into unusable large blocks. On failure, retry with progressively lower alignment `6/4/2/0`, changing only alignment not size, which squeezes out one or two more blocks.

### 3.3 Actively Respawn Immediately Upon Detecting "Switch to Software Decoding"

Software decoding is a one-way door; struggling inside it is pointless. The vendor log prints `change to sw decoder`; catch this string in the `__android_log_print` hook, set a flag, and on the next round of the feed loop immediately `usleep(800ms)` to drain the DMA, then `_exit(9)`, letting the monitor bring up a clean hardware decode process in 0.15s.

## 4. A Pitfall Dug Up Along the Way: Root Partition 100% Full

Another thing found during troubleshooting: `df -h /` shows the 6.2G root partition **with not a single byte left**. The consequence is `curl` failing to write `/tmp/nettv.raw` (exit code 23), and the player misjudging it as "channel source unreachable" (exit code 98), which looks exactly like a source failure.

After clearing three debug logs (`btud_dbg.log` 326MB, `nt_live.log` 239MB, `dis.txt` 158MB), 724MB was freed.

**Lesson**: on embedded devices, "network failure" and "disk writes failing" look like the same phenomenon at the application layer; run `df` first before troubleshooting network issues.

## 5. Another Discipline: SSH Commands Must Be Short

I ran a foreground gcc compile command (over 20 seconds), which was SIGTERM'd by the local sandbox; the leftover connection dragged the device's sshd down — port 22 became `Connection refused`, unrecoverable remotely, forcing a power-cycle reboot.

**On resource-constrained embedded devices, long tasks must always be "background script + short polling"; foreground commands must always be wrapped in `timeout` and kept under 20 seconds.**

## 6. Lessons Learned

1. **Pulling per-round return codes into a timeline is far more useful than staring at the crash point.** The crash point is often at the very end of the causal chain (here, the second IDR); the real mutation point (here, `decRet` going from 0 to -3 to -9) can only be seen via a timeline.
2. **Beware of "one-way door" state switches.** Switching to software decoding when the hardware decoder runs out of resources sounds elegant, but if after switching you cannot get SPS/PPS and cannot switch back, it is a dead end. Faced with a one-way door, the right strategy is to **detect it and respawn wholesale**, not to keep feeding in the degraded state.
3. **Memory-pool-class failures require looking at the "request sequence number".** The number `idx: 4` directly tells you the pool capacity is 4, while the hardcoded `MAX=5` in the code is dead logic that will never trigger — **when using a constant to describe a resource upper bound, always use a measured value, not an estimate**.
4. **Alignment determines how long CMA lasts.** `align = ceil(log2(size))` is a big waste for non-power-of-2 sizes; aligning 639KB to 1MB fragments dozens of times faster than 4KB alignment.
5. **Do an environment checkup before troubleshooting** (`df`, `free`, routing). In this case, running `df` right away would have saved a whole round of "is the source down again" misjudgment.

---

> **Copyright**: This article is original work by whiteleibniz (organized with AI collaboration); copyright belongs to whiteleibniz. Please credit the source and link to the original when reposting: https://whiteleibniz.github.io
