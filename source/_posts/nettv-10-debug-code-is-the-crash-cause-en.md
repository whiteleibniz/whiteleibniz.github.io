---
title: "The Debug Code Was the Crash Cause: 8 Layers of Falsification for One VSP Kernel Crash"
date: 2026-10-19
tags:
  - nettv
  - vsp
  - Spreadtrum
  - sc9830
  - kernel crash
  - debugging methodology
  - MMIO
categories:
  - Technology
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause/) · [繁體中文](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause-en/)

# The Debug Code Was the Crash Cause: 8 Layers of Falsification for One VSP Kernel Crash

> Background: HLS live-stream hardware decoding on Spreadtrum SC9832A (sc8830 family), driving `SprdSimpleOMXComponent` directly, output to framebuffer. One day the new build crashed on every single run — crashing at `DRIVE fill(out) #1`, with the device rebooting right after. **Process-level guards couldn't stop it, and there was not a single clue on the stack.**
>
> The real culprit was a piece of debug code "added to investigate a hang".

## Symptoms

The phase stake (`O_SYNC` direct write to `/tmp/phase.log`) showed every round stopping at the same line:

```
t=1385724329 >> fill(out)#1 开始 g_nout=1
t=1385724331    fill(out) 交第0路 hdr=0xb6d8ec80 pBuffer=0xb6d9ba80
                                     ← 没有下一行，设备重启，uptime 回 1 分钟
```

`sigsetjmp` couldn't catch it, `dmesg` showed no OOM, and `MemFree` still had 882 MB.

## 8 Layers of Falsification

The crashing line was **byte-for-byte identical** to the working 10-18 build — so the difference lay **before** it.
I A/B-tested every hypothesis I could think of, one at a time:

| # | Hypothesis | Verification | Result |
|---|------|---------|------|
| 1 | The supplementary `useBuffer` call triggers a vendor ASSERT | `NETTV_UBMODE=0` skips the extra call | Still crashes at the same spot |
| 2 | `setParameter(0x7f000011)` is the crash cause | `NETTV_SP228=0` skips it | Still crashes |
| 3 | The fake native_handle for self-managed ION is the crash cause | `NETTV_NOFAKE=1` disables it entirely | Still crashes |
| 4 | The feeding split `offsplit`/`chunk` is the crash cause | Force `g_offsplit=0 g_chunk=0` | Still crashes |
| 5 | The `NOUT 6→4` rollback touched BSS | After rolling back | Still crashes |
| 6 | Handle source: gralloc vs self-managed ION | `NETTV_EARLY=1` grabs self-managed ION early; the handle reverts to a heap address | Still crashes |
| 7 | The carveout_mm pool was drained (`total 0`) | 6 retries + backoff + size ladder; the 6th round really grabbed it | Still crashes |
| 8 | Out of memory | MemFree 882 MB, no OOM in dmesg | Ruled out |

Once layer 8 was ruled out, only one thing could explain the "same-environment A/B contrast": **code the old build didn't have**.

## The Real Culprit

On the evening of 10-18, to capture a "hang in the act", I added a set of register forensics:

```c
static int vrp_hook(void *d, unsigned off, ...)   /* hook the vendor's VSP register write function */
{
    int r = g_vrp_real ? g_vrp_real(...) : -1;
    g_vsp_rb = *(unsigned *)d;                    /* ← grab the VSP register window base */
    unsigned rb = *(unsigned *)d;
    volatile unsigned *W = (volatile unsigned *)(rb + 0x60901000);
    volatile unsigned *B = (volatile unsigned *)(rb + 0x60908000);
    P("[W10] 1010=%08x ...", W[0x10/4], ...);    /* ← direct MMIO read */
}
```

Then there was `tr_line()`, **called once before and after every DRIVE**, reading `W[0x1c/4]` and `B[0x34/4]`.

`vrp_hook` is a high-frequency path walked on **every polling round** — equivalent to continuously
**reading MMIO** from the two register windows `0x60901000` / `0x60908000` throughout decoding.

The result: the VSP state machine was scrambled, and it crashed at the immediately following `DRIVE fill(out) #1`.
**The crash point is not the debug code's own line, but the next breakage it caused.**

The fix was a single line of semantics:

```c
{ static int mmo = -1;
  if (mmo < 0) { const char *em = getenv("NETTV_TRACE_MMIO");
                 mmo = (em && em[0] == '1') ? 1 : 0; }
  if (!mmo) return r; }        /* off by default; never touch MMIO */
```

Verification: the new build ran to `AU[299]`, with all 1032 `fill(out)` calls in phase.log "returned", and zero device reboots.

## Three Methodology Lessons

**1. "The debug code was the crash cause" is an independent class of failure mode.**
It never crashes on its own line, so the stack, the logs, and ASAN all fail to point at it.
Only by putting the old and new builds **on the same device in the same environment, running A/B against each other**, and comparing runtime state field by field (I printed handle `ints[0..23]`, `g_gh_n`, `g_nout`), could you see "the old build doesn't have this part".

**2. During the hunt you need one absolutely reliable logging channel.**
On this project, stdout was swallowed by the custom stdio's 4KB block buffer, and the entire buffer was lost at crash time — so I misjudged three times off empty logs. The `O_SYNC` direct-write phase stake is the only trustworthy channel.
Likewise, every script upload must be verified with `md5sum`; I stepped on 3 cases of "0-byte script led to misjudging that the new build doesn't crash".

**3. The criteria must be reproducible.**
The "ALIVE=0" signal carries zero information (the old build's normal self-exit is also 0); whether `uptime` falls back to 1 minute, plus the phase stake's last line, are the reliable criteria.

## A Real Problem Fixed Along the Way

When `g_gh_n=0` (the carveout_mm pool periodically drained by component init), `ghOut` stays on gralloc's real handle. And gralloc uses an IOMMU heap, **with no physically contiguous backing**, so the VSP writes frames to fake physical addresses.

So two lines of defense were added:
- Pool grabbing with retries (6 rounds × 120ms backoff × 4-step size rotation) — measured, round 6 can grab it;
- If it still can't be grabbed, `_exit(12)` and hand it to the watchdog for a restart — **better to show no picture than to knock the kernel flying**.

## In Closing

"Let's add a register dump and see" — that sentence has a price in hardware-accelerated debugging.
Reading MMIO is not `read()` on an ordinary variable; it is **reaching into someone else's state machine**.

The approach to complex problems comes down to one sentence: **put the "working build" and the "crashing build" side by side and bisect them item by item**. If I hadn't had the working 10-18 source as a baseline this time, I'd still be in this pit guessing at an eighth, ninth, and tenth hypothesis.
