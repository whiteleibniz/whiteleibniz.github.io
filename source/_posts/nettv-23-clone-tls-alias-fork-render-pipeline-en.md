---
title: "Spreadtrum SC9832A Network TV Deep Dive (23): Three 'Thread Must-Crash' Cases, One Root Cause — clone Without TLS Leaves Parent and Child Sharing One errno"
date: 2026-10-22 14:00:00
tags:
  - VSP
  - Hardware Decoding
  - SIGSEGV
  - clone
  - TLS
  - fork
  - Pipeline
  - Spreadtrum
  - Bare clone Thread
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Debugging Methods, A/B Experiments]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/22/nettv-23-clone-tls-alias-fork-render-pipeline/) · [繁體中文](https://whiteleibniz.github.io/2026/10/22/nettv-23-clone-tls-alias-fork-render-pipeline-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/22/nettv-23-clone-tls-alias-fork-render-pipeline-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

In the last part we pinned down the page-flipping thread for "curing smearing" (off by default, 21.9fps for safety), so the natural question is: **is there any room left to raise the frame rate?** The ledger is right there — 41.3ms per frame = vendor synchronous decode 14.1ms (the hard floor) + frame read 2.7ms + render 23.9ms. The decode side has nothing left to shave, so the only cheap move is to **move rendering onto a second execution unit and pipeline it with decoding**: the worker side needs only 16.8ms and the render side 24.1ms, so the steady-state frame rate = max(both) ≈ 24ms ≈ a theoretical ceiling of 41fps. This part covers the first implementation of that "tier 2" plan — **crashing again** — plus the root cause dug up this time, one that explains three historical mysteries in a single breath.

## 1. The Ledger and the Goal

The frame-rate ledger finalized on 10-21/22 (Luxian 1080p source, 60s sampling):

| Stage | Time | Nature |
|---|---|---|
| bsOnMsg (vendor synchronous decode) | 14.1 ms | Hard floor; all 828 samples are 14ms, cannot be shaved |
| Frame read (ION cached memcpy) | 2.7 ms | Already optimized (44.3→2.6) |
| Render (yuv2rgb + geometry compositing + fb write) | 23.9 ms | Profiled: memory access 10 / arithmetic 13 / scattered writes ≈0 / copy 2, no cheap variables |
| **Total** | **41.3 ms → 21.9 fps** | |

Those 24ms of rendering are pure CPU work (NEON is already saturated), but beyond the data dependency it has **no ordering dependency on decoding** — decoding frame n and then rendering frame n can proceed fully in parallel with rendering frame n-1. So the shape of tier 2 is clear: **double buffering + producer/consumer** — the worker memcpys each decoded frame into staging and publishes it, while the render side renders at its own pace.

## 2. Version One: A Bare clone Render Thread — Always Crashes

The most intuitive first implementation: start a render thread with `clone()`, double buffering plus an atomic sequence-number handshake. The logic ran fine — until it hit real hardware:

```
*** monitor: 子进程自退 st=0xb ***        （SIGSEGV，无限重启，0 帧）
```

phase.log (with `O_APPEND|O_SYNC`, crash-proof) shows every generation dying in exactly the same way:

```
t=... DRIVE empty(in) 喂 IDR+SPS+PPS (Annex-B 全序列, nFlags=0)
t=... mon-child-signal=11 st=0xb        （60~300ms 后）
```

**Every generation of the worker dies abruptly right after "feeding the IDR"** — identical to the page-flipping thread symptom from the last part, down to the death phase.

## 3. The Root Cause: clone Without CLONE_SETTLS, Parent and Child Sharing One TLS

When `clone()`'s flags lack `CLONE_SETTLS`, something very hidden happens: **the child thread's TPIDRURO register inherits the parent thread's value verbatim** — that is, the parent and child threads **share the same TLS (thread-local storage)**.

In the bare bionic (`nostdlib`) environment this means:

1. whenever the child thread makes a **failed system call**, glibc/bionic's `__errno_location()` writes errno — and errno hides at a fixed offset inside TLS;
2. that write **clobbers the parent thread's errno in passing**;
3. the parent's immediately following "feed IDR" logic branches on errno → the logic goes wrong → it keeps running with a wrong state → wild pointer SIGSEGV.

The crash address `0x747474` = ASCII `"ttt"`, consistent with "some chunk of string data dereferenced as a pointer".

### Three Historical Mysteries Explained in One Breath

Flipping back through the historical notes, every one hits:

| Historical mystery | Attribution at the time | Truth |
|---|---|---|
| 10-15 "the second IDR always crashes" | ION pool drained → secondary crash | A clone thread trampling the parent thread's errno |
| 10-22 "vsync page-flip thread for curing smearing always crashes" | Undetermined (off by default) | Same disease |
| This time: v16h/v16i render thread always crashes | —— | Same disease |

The project memory actually recorded one rule long ago — **bare clone child threads must not use libc (TLS trampling)** — but it stayed at the level of "the child thread itself shouldn't call libc" and **never connected "errno aliasing can back-kill the parent" with the crash symptoms**, which is why the first two times we went hunting in the ION pool. This is the cost of notes: rules written too narrowly; next time you step in from a different angle you still won't recognize it.

## 4. The Plan: fork Instead of clone

Since the root cause is "a shared address space lets them trample each other", the fix is decisive: **move the render side to a `fork()` child process**.

```
worker (parent process)                render child process
─────────────                         ─────────────
DRIVE decode one frame
memcpy → g_st[wn & 1]   (MAP_SHARED)
g_ps->wn++  ───────────publish────────▶  sees wn > rn
                                         takes g_st[rn & 1]
                                        fb_render() (dedup already done in parent)
                                        g_ps->rn++
```

Structural benefits:

- **The child process has its own address space** (private TLS, heap, stack) — however it screws up, it cannot reach the parent; parent and child share only **explicit** MAP_SHARED regions: one 4KB handshake area (`wn/rn/rstop/rexited`, four volatile fields) plus two 3MB double staging buffers;
- the child process **resets SIGSEGV/SIGBUS/SIGILL to default actions** — if a real wild pointer appears, it dies alone; the parent's `waitpid(WNOHANG)` notices and sets `g_pipe_on=0`, **automatically falling back to single-threaded**, with playback uninterrupted;
- the child sets `PR_SET_PDEATHSIG(SIGKILL)`, so a sudden parent death leaves no orphan render process clinging to fb.

## 5. Three Implementation Details Worth Recording

**1. Deduplication must stay in the parent process.** The dedup criterion `g_filled` (incremented by the vendor callback for each real decoded frame) is a quantity **in the parent process's address space**; after fork, the child gets a frozen copy from the fork instant, so deduplicating in the child would forever judge "this is an old frame" and render nothing. So the publish gate lives in the parent: memcpy + `wn++` only when `g_filled != filled_seen_p`.

**2. A frame's real width is 1920×1088×3/2 = 0x2FC400, so staging must be ≥ 0x300000.** The old code computed 0x2FC000 via "width×height×1.5 rounded up to 0x1000", and memcpy only copied 0x2FC000 — when the render side reads the chroma plane it goes **12KB out of bounds**. malloc has heap slack behind it so it never crashed, but this is the prime suspect for "color banding on the left edge of the picture"; switching to a fixed-size mmap would SIGBUS outright. Fixed as `ST_SIZE=0x300000` + full-frame copy.

**3. Draining at shutdown matters more than Kill.** On exit, first set `rstop=1` to tell the child "finish the frame in hand, then quit", and wait ≤3s for `rexited`; only on timeout `SIGKILL` the render child — **the only KILL scenario allowed anywhere in this project**, because by then the VSP DMA has long drained on the worker side (`usleep(800ms)`), and killing a pure CPU render process carries no hardware state risk. Conversely, KILLing the player mid-decode crashes the kernel (an old lesson, empirically confirmed twice).

## 6. A/B Reality Check: fork Won Stability, Lost Frame Rate

After building and deploying v17 (enabled with `NETTV_PIPE=1`, off by default), a 45s smoke test: **signal=11 = 0**, with `流水线: fork渲染子进程(v17)` + `已 fork(pid=19839, 双staging=MAP_SHARED 0x300000)` confirming it took effect. Then four ABBA groups (Luxian 1080p, 60s each, NETTV_PIPE the only variable):

| Group | env | signal=11 | Real frames | fps | Worker wall-clock breakdown |
|---|---|---|---|---|---|
| A1 | default (single-threaded) | 0 | 1154 | **21.8** | 41.5 = bsOnMsg 14.2 + frame read 2.6 + render 24.2 |
| B1 | `NETTV_PIPE=1` | 0 | 929 | 17.5 | 36.6 = bsOnMsg 10.1 + frame read 3.1 + 10.2 + ~13ms waiting for render |
| B2 | `NETTV_PIPE=1` | 0 | 918 | 17.4 | Same as B1 |
| A2 | default (single-threaded) | 0 | 1130 | **21.8** | 41.6 = 14.2 + 2.7 + 24.0 |

Full marks on the stability goal (**0 crashes after fork; the root cause behind render-side threads always crashing really pulled out**), but the frame rate dropped **-20%**. One line suffices for the root cause:

```sh
cat /sys/devices/system/cpu/cpu1/online    # 1
cat /sys/devices/system/cpu/cpu2/online    # 0  ← two of the four cores are offline
```

**Only 2 CPUs are online.** The premise of a pipeline is "rendering and decoding genuinely run in parallel on two execution units"; on a machine with only 2 online cores, which still have to serve monitor/dl/mplayer, the worker and the render child mostly **time-share the same core**, plus 3MB of staging shuffled between the two cores every frame (L1 is private to each core; cache lines migrate through L2), so the memory bus and scheduling overhead all turn into net loss. The worker's wall clock did drop from 41.5 to 36.6ms, but total throughput is 57ms/frame — **parallelism never happened**.

So the verdict: **keep `NETTV_PIPE` off by default**, with v17's single-threaded path showing zero regression (A1/A2 match the historical baseline item by item). But this direction has not been thoroughly falsified — two cheap follow-ups remain:

- **taskset affinity**: pin the render child to cpu1 and keep the worker on cpu0, then test again to rule out scheduling dispersion;
- **online cpu2/cpu3**: with all four cores online, the pipeline's ledger can actually be computed (writing to `/sys` hotplug nodes is a global config change; per the project's iron rule, confirm first).

## 7. The Real Dividend: Smearing Can Be Saved

Looking back, v17's biggest value is not the frame rate — it **vindicates the capability of "starting threads on the render side"**. The vsync page-flip thread (curing smearing), switched off by default in the early hours of 10-22 because clone threads always crashed, was then suspected of "ioctl and VSP concurrently stepping on the fb lock" — **wrong; the real culprit was TLS aliasing**. The flip thread itself only does `WAITFORVSYNC` + `PAN_DRAW` + waiting on a small block of shared state; implementing it as a fork child makes stepping on the parent structurally impossible, the root cause is gone, and the feature can come back. That is the next part.

## 8. Lessons

1. **A thread started with `clone` without `CLONE_SETTLS` is a parent-child TLS alias, not a "lightweight process".** Any work thread that needs to run libc (especially touching errno) should either pass TLS properly or just fork — fork's isolation is a structural guarantee that does not depend on "remembering which flag to pass".
2. **"The child thread breaks itself" and "the child thread gets the parent killed" are two different things.** The latter is unguardable, because the crime scene is not on yourself; the isolation boundary must be drawn at the address space, not at "I don't think it will touch that".
3. **State judgments belong on the side of the state's owner.** Deduplication in the child looks natural ("whoever consumes judges"), but the state quantity lives in the parent — across a fork, the judgment must stay in the parent.
4. **Size constants must be computed by "real width", not "rounded to look nice".** 0x2FC000 and 0x2FC400 differ by only 1KB, bought with a 12KB out-of-bounds read; this kind of bug never surfaces relying on malloc's slack, and explodes the moment you switch allocator.
5. **Count the cores before parallelizing.** This tier-2 ledger ("render 24ms pipelined with decode 16.8ms ⇒ ceiling of 41fps") is a joke on a single core and a disaster on two — `cat /sys/devices/system/cpu/cpu*/online` takes three seconds and should have been run before writing the first line of pipeline code. And remember: **the words "theoretical ceiling" presume the execution unit actually exists**.

---

**Files involved in this article** (device-side repo `/home/lvgl_demo/lvgl_demo`): `deploy/nettv_player/sprd_msg_np.c` (`render_child()` / `pipe_child_died()` / `struct pipe_sh` / worker publish block), build script `deploy/nettv_player/build.sh`. Local debug scripts: `outputs/_pipe_smoke_1022.sh` (smoke test), `outputs/_pipe_ab3_1022.sh` (ABBA A/B).
