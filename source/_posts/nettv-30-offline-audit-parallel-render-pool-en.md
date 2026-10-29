---
title: "netTV Hardware Decode (30): How to Make Progress While the Board Is Offline — A Static Audit of the Parallel Render Pool"
date: 2026-10-30 02:30:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP decode
  - Multiprocess
  - Code audit
categories:
  - [Project Notes, netTV Hardware Decode]
  - [Embedded, Spreadtrum Platform]
copyright: Original article under CC BY-NC-SA 4.0. Republish with attribution: whiteleibniz.github.io
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/10/30/nettv-30-offline-audit-parallel-render-pool/) · [繁體中文](https://whiteleibniz.github.io/2026/10/30/nettv-30-offline-audit-parallel-render-pool-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/30/nettv-30-offline-audit-parallel-render-pool-en/)

> Post 30 in the series. The board has been offline for four consecutive rounds (10-27 through 10-30), which means the resident-fork parallel render pool from post 29 has **never once been compiled**. This post is about a way to make real progress with the hardware out of reach: a static audit aimed specifically at defects that *do not crash, they quietly corrupt* — and the four real bugs it turned up.

## 1. Offline is not a dead end, but it is not a license to keep writing code

This project has an awkward property: the only cross compiler lives on the target board. Source is written locally and compiled on the device. Pull the power and every new change becomes unvalidated debt; the more it piles up, the more likely the next online session is burned entirely on build errors.

So the right move offline is not to keep adding features. It is to treat the written-but-unverified code as an audit target. The audit needs one specific aim, and mine is a single criterion:

> Hunt first for the bugs that **do not crash, do not log an error, and quietly produce wrong results**.

The reasoning is pragmatic. Compile errors and segfaults announce themselves the moment you reconnect; they take five minutes to fix. The other class — frames that are subtly misplaced, performance counters that are fiction, resources that leak a little every frame — survives several experiment rounds and can push you to conclusions that are exactly backwards. The "private staging = frozen copy" trap from post 29 is the archetype: it never crashes, the child just keeps rendering the previous frame.

## 2. Bug 1: split points not aligned to the band height (tearing, plus out-of-bounds writes)

The renderer is cut into bands; a band renders output rows `[oy0, oy0+bandh)`. The obvious way to dispatch those bands to N workers is also the wrong one:

```c
int rows = 1280 / n;                 /* output rows per child */
j.y0 = i * rows;
j.y1 = (i == n - 1) ? 1280 : (i + 1) * rows;
```

The problem is that the inner loop of `fb_render_range` **always renders a whole band** and has no idea that `y1` exists:

```c
for (int oy0 = y0; oy0 < y1; oy0 += g_bandh)
    for (int j = 0; j < g_bandh; j++)
        memcpy(dst + (oy0 + j) * 720, band[j], 720 * 4);   /* writes bandh rows */
```

Whenever `(y1 - y0)` is not a multiple of `bandh`, the last child writes rows `[y1, oy0+bandh)`: it stomps on rows owned by the next child (tearing) and, at the end of the frame, runs past the tail of the framebuffer page (SIGSEGV). With the default band height of 64, the per-N arithmetic looks like this:

| Workers n | rows = 1280/n | multiple of 64? | outcome |
|---|---|---|---|
| 2 | 640 | yes | safe |
| 3 | 426 | **no** | tearing + OOB |
| 4 | 320 | yes | safe |
| 6 | 213 | **no** | tearing + OOB |
| 7 | 182 | **no** | tearing + OOB |
| 8 | 160 | **no** | tearing + OOB |

So the three arms the A/B script was going to run (2 and 4) **happen to dodge the bug entirely**, while the 8-worker arm — the one that actually shows off parallelism — was guaranteed to blow up. "The configurations you tested are precisely the ones that cannot fail" is the nastiest failure mode in parallel work.

The fix is not to teach the inner loop about boundaries (that means threading a per-band `bh` through a dozen sites, easy to miss one). It is to make every split point a multiple of `bandh`. Since `1280 % bandh == 0` (bandh is restricted to 16/32/64/128/256), making `rows` a multiple as well guarantees every boundary is a multiple, so a partial band cannot exist:

```c
int rows = ((1280 / n) + g_bandh - 1) / g_bandh * g_bandh;
if (rows < g_bandh) rows = g_bandh;
j.y0 = i * rows;  if (j.y0 > 1280) j.y0 = 1280;      /* trailing workers may idle */
j.y1 = j.y0 + rows; if (j.y1 > 1280) j.y1 = 1280;
```

The cost is slightly uneven load (at 8 workers: six get 192 rows, one gets 128, one idles). What you buy is a layout where overrunning is structurally impossible.

## 3. Bug 2: the fallback path races with children that are still writing

The original dispatcher bailed out on the first failed read or write and immediately re-rendered the whole frame serially:

```c
for (i...) if (read(g_rp_c2p[i], &ack, 1) != 1) { bad = 1; break; }
if (bad) fb_render_range(nv, dst, 0, 1280);    /* redo the entire frame */
```

But workers `i+1 … n-1` **already hold jobs and are writing their own rows right now**. The parent then overwrites all 1280 rows while they work — tearing that only appears when a child dies unexpectedly, which makes it nearly impossible to reproduce on purpose.

The fix: **drain every dispatched ack before declaring failure**. Once all acks are in, each child has either finished writing or is confirmed dead, and only then is the serial redo exclusive:

```c
for (int i = 0; i < sent; i++)
    if (read(g_rp_c2p[i], &ack, 1) != 1) bad = 1;   /* no break */
if (bad) { g_rp_dead = 1; g_rp_on = 0; fb_render_range(nv, dst, 0, 1280); }
```

Reads here are blocking, so a live child always answers and nothing hangs; a dead child returns 0, which doubles as proof that it is gone.

## 4. Bug 3: resident children hold on to ION buffers forever

The pool is forked on the **first frame** — by which point the parent has already opened a batch of ION / dmabuf file descriptors. `fork()` copies the descriptor table, so every resident child ends up holding a reference. When the parent calls `close()`, nothing is released, because the children still count.

On this platform the carveout pool is only 640 KB, and an ION leak ends in a black screen that can only be cleared by a reboot (see the "black screen SOP" in this series). The children touch no devices at all, so they can simply drop everything they inherited:

```c
for (int fd = 3; fd < 64; fd++)
    if (fd != rfd && fd != wfd) close(fd);
```

The general lesson: **any long-lived forked child should explicitly shrink its descriptor table**. Short-lived per-frame forks do not care; a resident pool must.

## 5. Bug 4: the self-test scratch area must not be framebuffer page 0

The first-frame self-test renders once serially, once in parallel, and compares hashes. The lazy choice for the scratch target was framebuffer page 0, since playback only ever shows pages 1 and 2.

But page 0 is the **home page**: `fb_home()` pans back to it when playback exits. Writing a full frame into it leaves the desktop parked on a ghost of the last frame. A one-shot `malloc`'d private buffer is correct — the serial reference render does not need its destination to be video memory at all.

The same pass also fixed a measurement-definition bug: in parallel mode the "convert" and "write fb" sub-timings are permanently zero, because children update their own private copies that the parent cannot see. Printing those zeros invites someone to cite them in the next A/B. Now the line reports wall clock only and says so:

```
[perf] fb_render pool 4-way avg Xms (ceiling Y fps) [wall clock] (convert/write-fb are child-private, not counted here)
```

## 6. What made the audit productive

Not care. A different question. Swapping "is this code correct?" for these four questions raised the hit rate noticeably:

1. **Boundaries and remainders**: how is the remainder handled in every split, chunk, and modulo? Does the inner loop even know the boundary exists?
2. **Concurrency on the failure path**: when the failure fires, who else is still running? Is my fallback mutually exclusive with them?
3. **Invisible holders of resources**: what does a long-lived forked child still hold, and who is counting it?
4. **Measurement definitions**: who writes this number and who can read it? Could it be a constant zero?

One more ordering rule that keeps paying off: **for parallel changes, failure modes ranked by damage are "quietly wrong" > "crashes" > "slow"**. That is why the first-frame hash self-test (serial vs parallel, FNV over the full page) matters more than the optimization itself — it is the only gate that catches the first category. And that is why the A/B script gained an 8-worker arm: prove the fix at the configuration most likely to break, instead of only exercising the ones that were always fine.

## 7. Status and next step

- Source v31 = v30 plus the four fixes above. Default behavior is unchanged (`NETTV_RPOOL` defaults to 0, i.e. the original serial path).
- Still **uncompiled** (board offline, fourth round). Next power-on sequence: push the source, build, then run a back-to-back `RPOOL=0/2/4/8` A/B.
- Pass criteria unchanged: `fps_x10` clearly above baseline, the self-test must print "serial/parallel identical", no `signal=11`, and ION clients must not grow.

Once the board is up, the numbers here get replaced by measurements. Until then, these four fixes have removed "8-way is guaranteed to blow up" from the plan.
