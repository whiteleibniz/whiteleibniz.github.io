---
title: "The Real Cause of netTV Outputting Only 4 Frames: VSP mbinfo Memory Pool Exhaustion Triggers a Fallback from Hardware to Software Decoding (Not the “Second IDR” to Blame)"
date: 2026-10-13 02:30:00
lang: en
permalink: en/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback/
search: true
categories:
- 排障手记
- 视频播放
tag:
- nettv
- VSP硬解
- ION
- CMA
- 故障修复
---


# The Real Cause of netTV Outputting Only 4 Frames

## I. Symptoms

On the Spreadtrum SC9832A device, "Network TV" (网络电视) plays a 1080p m3u8 live stream and can output only **4 frames** per round, after which the picture freezes; when the second IDR is fed in, it either always crashes (`SIGSEGV addr=0x747474`) or hangs permanently, and can only be restarted by the monitor process, manifesting as a "4 frames per round" slideshow pattern.

In the earlier rounds of troubleshooting, the conclusion was recorded as "a vendor library defect: the second IDR always hangs", and a workaround was implemented (actively respawn when the second IDR is detected). **This conclusion is wrong** — the second IDR is only a secondary phenomenon.

## II. The Real Root-Cause Chain

The key approach: do not just look at "which round it crashed in"; instead pull **the return code of each round of feeding** into a timeline. Use a regex to extract each AU's `decRet / frameEffective / consume byte` from the log, and the result is obvious:

```
AU[  3] sz= 106336 t=5  ret=0   eff=0 cons=106336   ← 第一个 IDR，解码成功
AU[  4] sz=   8983 t=1  ret=0   eff=0 cons=8983
...
AU[  9] sz=  13967 t=1  ret=0   eff=0 cons=13967    ← 出第 4 帧
AU[ 10] sz=  17116 t=1  ret=-3  eff=0 cons=17116    ← ★ 突变点
AU[ 11] sz=  13424 t=1  ret=-9  eff=0 cons=13424    ← 从此恒 -9
AU[ 12..35]                 ret=-9  needIVOP:1 ...
```

Pull up the vendor log from the AU[10] round, and the real cause is written right there:

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

In the very next round:

```
onQueueFilled, 1122, change to sw decoder, mThumbnailMode: 0
H264Dec_ReleaseRefBuffers, 32
openDecoder, lib: libomx_avcdec_sw_sprd.so
decRet: -9, needIVOP: 1, SPS:0, PPS:0
```

Stringing it together:

1. The VSP needs one **653824-byte mbinfo** (macroblock information) roughly every 2 frames decoded, and it **never frees them**, requesting them with an incrementing idx;
2. The CMA contiguous memory pool is only ~7MB; after deducting the 3.1MB output frame buffer and the 1.5MB input buffer, it can hold only **4** mbinfo blocks;
3. The 5th block's `ion_alloc` returns `-ENOMEM` → `decRet=-3`;
4. The component's response is to **permanently switch to the software decoder** (`libomx_avcdec_sw_sprd.so`) — this is a **one-way door**;
5. The software-decoding path cannot get the SPS/PPS fed in earlier (`SPS:0 PPS:0`), so it returns `-9 needIVOP` (needs an I-frame) every round and can never output frames;
6. The picture freezes at 4 frames, and when the second IDR is fed in, it crashes or hangs in the software-decoding context.

**So the "second IDR crash" is not a bug; it is the inevitable result after the hardware decoder has already died.**

## III. The Fix (Three Places, All Centered on "Never Let It Switch to Software Decoding")

### 1. Reuse Old Blocks When mbinfo Allocation Fails

The original LRU reuse was triggered only when "the pool is full (`g_c1r_n >= C1_REUSE_MAX=5`)". But the CMA can actually hold only 4 blocks, so the 5th allocation fails directly and **the reuse logic is never reached**. Change it to two trigger paths: the pool is full **or** this `ion_alloc` fails.

```c
static int c1_reuse(void *self, const char *name, unsigned size)
{
    if (size != C1_REUSE_SZ || g_c1r_n <= 0) return 0;
    int s = g_c1r_next % g_c1r_n;   /* 注意是 %g_c1r_n，不是 %MAX */
    g_c1r_next++;
    ...  /* 把旧块的 fd/base/handle/PA 填进新的 MemoryHeapIon 对象 */
    map_add(g_c1r[s].buf_fd, g_c1r[s].pa, size);
    return 1;
}
```

The cost is that a block still referenced by the DPB may be reused (possibly causing artifacts), but compared with "permanent software decoding", this cost is worth paying.

### 2. Retry with Stepwise Reduced Alignment When Allocation Fails

The original alignment algorithm was `order = ceil(log2(size))`, with an upper limit of 8. A 639KB mbinfo would be requested with **1MB alignment**, quickly fragmenting the CMA into unusable large blocks. On failure, retry with stepwise reduced alignment in the order `6/4/2/0`, changing only the alignment and not the size, which can squeeze out one or two more blocks.

### 3. Respawn Immediately Upon Detecting a "Switch to Software Decoding"

Software decoding is a one-way door, and struggling inside it is pointless. The vendor log prints `change to sw decoder`; catch this string in an `__android_log_print` hook, set a flag, and in the next round of the feeding loop immediately `usleep(800ms)` to drain the DMA and then `_exit(9)`, letting the monitor start a clean hardware-decoding process within 0.15s.

## IV. A Pit Dug Up Along the Way: the Root Partition Is 100% Full

Another thing discovered during troubleshooting: `df -h /` shows that the 6.2G root partition has **not a single byte left**. The consequence is that `curl` fails to write `/tmp/nettv.raw` (exit code 23), and the player misjudges it as "the channel source is unreachable" (exit code 98), behaving exactly as if the source had failed.

After deleting three debug logs (`btud_dbg.log` 326MB, `nt_live.log` 239MB, `dis.txt` 158MB), 724MB was freed.

**Lesson**: on embedded devices, "network failure" and "cannot write to disk" look like the same phenomenon at the application layer; run `df` before troubleshooting network problems.

## V. Another Discipline: SSH Commands Must Be Short

I ran a foreground gcc compile command (over 20 seconds), which was SIGTERM'd by the local sandbox, and the leaked session dragged the sshd on the device to death — port 22 became `Connection refused`, remote recovery was impossible, and the only option was to power-cycle.

**On resource-constrained embedded devices, long tasks must always use "a background script + short polling", and foreground commands must always be wrapped in `timeout` and kept under 20 seconds.**

## VI. Lessons Learned

1. **Pulling the per-round return codes into a timeline is far more useful than staring at the crash point**. The crash point is often at the very end of the causal chain (in this case, the second IDR), while the real point of change (in this case, `decRet` going from 0 to -3 and then -9) can only be seen through a timeline.
2. **Beware of "one-way door" state switches**. Switching to software decoding when the hardware decoder runs out of resources sounds elegant, but if the SPS/PPS cannot be obtained after the switch and there is no way back, it is a dead end. When encountering a one-way door, the correct strategy is to **detect it and respawn the whole thing**, rather than continuing to feed it in the degraded state.
3. **For memory-pool-type failures, look at the "allocation sequence number"**. The number `idx: 4` directly tells you the pool capacity is 4, while the hardcoded `MAX=5` in the code is dead logic that will never trigger — **when using constants to describe resource upper bounds, always use measured values, not estimates**.
4. **The alignment method determines how long the CMA lasts**. `align = ceil(log2(size))` is very wasteful for sizes that are not powers of 2; aligning 639KB to 1MB fragments it dozens of times faster than 4KB alignment.
5. **Do an environment checkup before troubleshooting** (`df`, `free`, routing). In this case, running `df` at the very start would have saved a whole round of the misjudgment "has the source died again?".

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
