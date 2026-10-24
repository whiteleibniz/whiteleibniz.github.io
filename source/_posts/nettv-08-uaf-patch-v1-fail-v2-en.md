---
title: "netTV Hardware Decoding Deep Dive (8): A Vendor-Library Patching Train Wreck — How I Corrupted a Live Register ip"
date: 2026-10-18 02:00:00
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Debugging, Disassembly]
tags: [VSP, Hardware Decoding, h264dec, UAF, ARM Assembly, Binary Patching, Spreadtrum, SIGSEGV]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/18/nettv-08-uaf-patch-v1-fail-v2/) · [繁體中文](https://whiteleibniz.github.io/2026/10/18/nettv-08-uaf-patch-v1-fail-v2-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/18/nettv-08-uaf-patch-v1-fail-v2-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The previous part had characterized the UAF in the vendor library `libstagefright_sprd_h264dec.so` — the one that "corrupts a linked-list node at every GOP boundary" — and I gleefully applied a binary patch: adding node-validity checks to three list traversals. Deployed it and — **not a single frame came out**. This part records the cause of the wreck (I treated a live register as a scratch variable), how the v2 patch was written, and it also closes the case on the `addr=0x747474` crash signature that had been hanging for half a day.

## 1. Symptom: Crashes at the config Stage, 0 Frames

The patched binary runs, and the child-process log stops at:

```
  SPS NAL=[0,30) len=30   PPS NAL=[30,37) len=7 (rb cfg=106381)
  config 字节: SPS 30(首=0x00)  PPS 7(首=0x00)
    DRIVE empty(SPS) 崩溃
```

The scene captured by the SEGV handler:

```
*** SIGSEGV sig=0000000b addr=00747474 step: DRIVE empty(cfg) 喂 SPS 与 PPS, 各一次(裸 NAL)
    pc=00636363 lr=5f347644 sp=706d616c
```

`addr=0x747474` ("ttt"), `pc=0x636363` ("ccc"), `sp=0x706d616c` ("lamp") — all three ASCII. On the evening of 10-17 this signature led me astray: seeing nothing but ASCII, I inferred "our NAL/ring-buffer copy path has an out-of-bounds write, splattering bitstream data into the stack and heap", then spent the whole night auditing the length sources of `rb_put` / `load_chunk_local` / `cfg memcpy` — nothing found.

## 2. A/B First, Don't Rush to Change Code

Wiser this time: first use an environment variable to split "patched library" and "original library" and run each for 40 seconds:

| Version | Result |
|---|---|
| Patched library (auto-enabled) | `stat_lines=0`, `segv=1`, `cfg_crash=1` — not a single frame |
| Original library `NETTV_H264DEC_SO=/system/lib/...` | config passes, frames come out (27/22/4 frames per round), but still hangs at `AU[102]` (GOP boundary, 116686B big IDR) → monitor restart |

One-line conclusion: **the patch itself is broken**; the original library's behavior is the correct one (it produces frames, only the GOP boundary still hangs). 0x747474 is a product of the patch, not some "stream-data out-of-bounds write". The earlier "unified root cause" hypothesis is void.

> Lesson: when a crash signature looks like "memory smashed by data", don't audit your own copy paths first. **A/B out the thing you just changed first** — this change (the patched library) sat in the most suspicious spot, yet I first assumed the old code was at fault.

## 3. Disassembly: ip Is Live, and I Used It as a Scratch Register

Dig out the relevant fragments of the original `.so`'s `findCodecConfigData` (from 0x7b80; ARM 32-bit, not Thumb):

```
7de8: ldr  r8,  [r10, #4]      ; r8 = linked-list sentinel head
7dec: ldr  ip,  [r8, #8]       ; ip = head->next = first node
7e04: mov  lr,  ip             ; lr = current outer node
7e1c: mov  r2,  ip             ; ← outer back-edge target: every round re-fetches the first node from ip
7e20: mov  fp,  #0
7e24: ldr  r2,  [r2, #8]       ; inner: count nodes (site A)
7e28: add  fp,  fp, #1
7e2c: cmp  r2,  r8
7e30: bne  7e24
7e34: cmp  fp,  r3
7e38: bls  0x83e4              ; count mismatch → fallback path (site C)
7e3c: ldr  r1,  [lr]
7e44: ldr  r0,  [fp, #0x24]
7e58: ldr  lr,  [lr, #8]       ; outer advance (site B)
7e5c: cmp  r2,  #0
7e60: bne  7e1c                ; back to outer
```

See `7e1c: mov r2, ip`? **`ip` (r12) holds a constant value throughout the double loop — the first node**; every outer back-edge restarts from it.

My v1 patch, to pass the node pointer into the thunk, wrote at both sites:

```asm
7e24: mov  ip, lr      ; ← overwrote ip with the current outer node!
7e28: bl   t_cnt
```

and `7e58: mov ip, lr` at site B. That instantly turned `ip` into "the previous outer node"; the next round's `mov r2, ip` fetched not the first node at all, the inner count `fp` and the compare `cmp fp, r3` went completely wrong, and eventually some virtual call stepped on a garbage pointer — hence `pc=0x636363`, `addr=0x747474`.

Incidentally, a second v1 bug surfaced: in site C's thunk, `add r4, r4, #1` is immediately followed by `pop {r4, pc}`, and the stale value popped off the stack overwrites the freshly added 1 — **r4 never increments**.

## 4. How v2 Is Written: Find a "Dead" Register

The patch thunk must borrow a register to pass the argument (because `bl` clobbers `lr`), but `ip` is unusable. Walking the register lifetimes of this loop line by line: **`r0` is dead between `0x7e1c` and `0x7e44`** — its last definition is in `7e00~7e14`, and its next use at `7e44 ldr r0,[fp,#0x24]` reassigns it. So:

- at the site, write `mov r0, lr` (stuff the outer node pointer into the dead register r0);
- inside the thunk, use `r0` to fetch next / do validity checks, and on the way out use `mov lr, r0` to restore lr;
- the thunk only does `push {lr}` … `pop {pc}`, **not popping r4**, not touching ip;
- bad-node handling: at the inner site set `r2 = r8` (sentinel) so `cmp r2,r8` immediately matches and exits; at the outer site set `r2 = 0` so `7e60 bne` fails and exits — safer than v1's `mov lr, r8`, no longer dereferencing the sentinel;
- don't touch site C at all (0x83e8 fallback path, low benefit, high risk).

The generated patch changes only 85 bytes total (8 bytes at each of the two sites + a 60-byte thunk in the hole):

```
7e24: e1a0000e  mov r0, lr
7e28: eb0013f4  bl  0xce00
7e58: e1a0000e  mov r0, lr
7e5c: eb0013f3  bl  0xce30
```

## 6. Measured Results (re-measured 2026-10-18)

After pushing the v2 patch to the device it ran for 75 seconds; the conclusion stings a little but is valuable:

| Metric | v1 patch | Original library | v2 patch |
|---|---|---|---|
| `DRIVE empty(SPS) 崩溃` | 1 | 0 | **0** |
| Frames produced | 0 frames | normal (8.6fps) | normal (8.8fps) |
| SIGSEGV | 1 | 0 | 0 |
| monitor restarts | 0 (no frames at all) | fixed @27 frames each round | fixed @27 frames each round |

Three things:

1. **v2 really did fix v1's bug** — no more crash at the config stage, confirming that "use r0 instead of ip" is the correct fix. The patch itself is now harmless.
2. **But it did not cure the GOP-boundary hang** — the original library and v2 alike stop at exactly 27 frames each round.
3. The corollary matters: **the current GOP hang is not the site A/B linked-list UAF crash, but a "stuck without returning" infinite-loop form**. Adding validity checks to pointers does nothing for an infinite loop — I had been treating these two as the same thing; that is a conceptual error.

So v2 will not go to production (no benefit, only more attack surface); stick with the original library.

## 7. Next Steps

Abandon the "harden vendor traversal" route and instead do **in-process decoder rebirth**: after detecting a hang at the GOP boundary, don't exit the whole process (preserving m3u8 download progress and the bitstream in the ring buffer); only rebuild the decoder component itself (Loaded→Idle→Executing, re-running allocateBuffer + config). This avoids the vendor library's cumulative corruption without replaying the previous segment.

One more note: after a device reboot, free disk dropped from 348M to 203M; /tmp log cleanup gains very little, so there is another long-term growth source to investigate.

## 8. Three Disciplines Before Landing a Patch (all learned the hard way)

1. **The hole must be inside an executable mapping.** The 10-17 first version wrote the thunk to 0xdd18 — that is `.got`/`.data`; the linker parsed the machine code as dynamic table entries, and decoding collapsed entirely. The usable range is the zero hole `0xcdc4..0xd000` at the end of the `.rodata` segment (falls inside the LOAD1 R+X mapping).
2. **Before modifying a .so, dig out the original instructions one by one** and confirm the width and semantics of the replaced instructions (side effects like `add fp,fp,#1` must be redone inside the thunk).
3. **A patch must always be revertible with one environment variable.** Being able to localize "the patch is broken" in 5 minutes this time was all thanks to the escape hatch `NETTV_H264DEC_SO`.

## 6. Current State and Next Steps

The v2 patch (`outputs/patch_h264dec_uaf_v2.py` → `h264dec_uaf_v2.so`) has been generated and pushed to the device, but before the acceptance run the device's sshd sessions were exhausted (port 22 banner drops immediately; only a power cycle works), so **the measured data comes next time**.

Acceptance criteria after the reboot:

- `DRIVE empty(SPS) 崩溃` count = 0 (config no longer broken by the patch);
- `[STAT]` frame count climbs monotonically past 31 (no longer stopping at the same frame count each round);
- the monitor restart details no longer show the fixed pattern of "hung near AU[102]".

If v2 also can't suppress the GOP-boundary hang, then the traversal-hardening route is wrong and the thinking must change: do decoder rebirth in-process (preserving m3u8 progress), or simply feed only up to the boundary per a GOP quota and reset the decoder state with the next IDR.
