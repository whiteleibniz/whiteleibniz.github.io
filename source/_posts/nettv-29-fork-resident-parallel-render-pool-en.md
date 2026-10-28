---
title: "netTV Hardware Decode (29): Spreading a 23 ms Render Across 4 Cores — A Resident fork() Render Pool"
date: 2026-10-29 02:45:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP decode
  - Multiprocess
  - Profiling
categories:
  - [Project Notes, netTV Hardware Decode]
  - [Embedded, Spreadtrum Platform]
copyright: Original article under CC BY-NC-SA 4.0. Republish with attribution: whiteleibniz.github.io
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool/) · [繁體中文](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool-en/)

> Post 29 in the series. After earlier rounds cut segment picking from 5 s to 0.3 s and made audio draining asynchronous, the next frame-rate wall showed up: **23–32 ms per frame in the renderer, using exactly one core**. This post walks through splitting the renderer across processes — and through three traps that do not crash, they quietly corrupt.

## 1. Why the renderer is the target now

The bill so far, on the same quad-core Cortex-A7 board with the same 1080p25 live stream:

| Stage | Cost | Status |
|---|---|---|
| `bsOnMsg` (vendor synchronous decode) | 14.1 ms | hard floor, untouchable |
| Segment picking | 4981 ms → 225 ms | fixed (sequential advance inside the HLS window) |
| Audio draining | 5231 ms → 1 ms | fixed (async pump, not yet deployed) |
| **Render (`fb_render`)** | **23–32 ms** | **this post** |

Decode 14.1 + render 23.2 ≈ 37 ms, i.e. a 27 fps ceiling. **Even with zero supply-side stalls, "smooth" stays out of reach.** The renderer is the only large block left.

And there is an uncomfortable detail: this board really is quad-core (we overturned that on 10-23 by measuring throughput — `sysfs` `online`/`offline` and `/proc/cpuinfo` both lie here; run a benchmark instead of reading files). The renderer was using one core while three idled.

## 2. Can it be parallelised? Check the write side first

The renderer converts NV12 → ARGB, rotates 90°, and writes the framebuffer at 720×1280. The core loop is organised in bands:

```c
for (oy0 = 0; oy0 < 1280; oy0 += bandh) {      /* bandh rows per band, default 64 */
    for (int i = 0; i < 720; i++) {
        int r = 1079 - i*3/2;                   /* source row */
        yuv2px8_neon(Y + r*1920 + c0, C + (r>>1)*1920 + (c0 & ~1),
                     colbase + i, 720, bandh);
    }
}
```

Look at both sides of the memory traffic:

- **Writes**: band `oy0` only touches output rows `[oy0, oy0+bandh)`. Bands are **row-disjoint**.
- **Reads**: the source NV12 is read-only throughout.

That is sufficient: **disjoint writes + read-only source = no locking at all**. No atomics, no semaphores — just slice the 1280 rows into N ranges and hand them to N workers. It is the kind of change that looks trivially parallel, and then hands you three traps.

## 3. Trap one: fork() for rendering, never a bare clone

This is a hard rule on this project, bought with two device reboots.

To avoid `fork` overhead we once spawned the render thread with a bare `clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD)`. The problem: **no `CLONE_SETTLS`**, so parent and child share TLS. bionic's stdio routes `snprintf`/`vsnprintf` through the `__nbuf` TLS buffer pool, so a single call from the child corrupts the parent thread's structures.

The symptom was actively misleading: not a clean crash but "the second IDR always SIGSEGVs at a nonsense address like `0x747474`". We spent a long time auditing NAL feed buffer reuse and SPS/PPS re-send timing — all the wrong direction.

So this time: **not one `clone`**, plain `fork()`. A forked child gets a full private copy of TLS and cannot stomp the parent.

## 4. Trap two: the dangerous failure is wrong pixels, not a crash

This is the lesson I would most want to keep.

A render child must read the current frame. In our pipeline that frame is first `memcpy`'d out of the ION buffer into a staging area (ION is mapped uncached; byte-wise reads measured 500 ms/frame, so it has to be pulled into cache first). The staging buffer used to be allocated like this:

```c
if (!g_stage) g_stage = (unsigned char *)malloc(ST_SIZE);
```

`malloc` returns **private** memory. After `fork()`, the child gets a **frozen copy** — same address, stale contents from the fork instant. The result: no crash, no error, no warning. Just a picture that lags or scrambles. On real hardware that class of bug multiplies debugging cost by ten.

The fix is one line:

```c
void *sm = mmap(0, ST_SIZE, PROT_READ|PROT_WRITE, MAP_SHARED|MAP_ANONYMOUS, -1, 0);
g_stage = (sm == MAP_FAILED || !sm) ? malloc(ST_SIZE) : sm;
g_stage_shared = (sm != MAP_FAILED && sm);
```

A `MAP_SHARED` anonymous mapping shares physical pages between parent and child. Single-process behaviour is identical to `malloc`, so the serial path is unchanged.

As a belt-and-braces measure, if `mmap` fails and we fall back to `malloc`, the pool is **disabled outright** (`g_stage_shared == 0`). Slow is acceptable; wrong is not.

## 5. Trap three: forking once per frame already lost once

So is "fork N children per frame" enough? No — we tried that on 10-22 and it lost: the fork pipeline measured 17.5 fps against 21.8 fps single-threaded. The suspicion is that shipping 3 MB of frame data across a process boundary each frame costs more than the parallelism gains.

Hence a **resident pool**: `fork` once at startup, then pass jobs over `pipe`. Each frame sends a 20-byte struct:

```c
struct rp_job { const unsigned char *nv; unsigned long dst; int y0, y1; };
```

The child body is three lines and touches no TLS-dependent libc entry points:

```c
static void rpool_child(int rfd, int wfd) {
    for (;;) {
        struct rp_job j;
        if (read(rfd, &j, sizeof j) != (long)sizeof j) break;   /* 0 = parent closed */
        fb_render_range(j.nv, (unsigned *)j.dst, j.y0, j.y1);
        if (write(wfd, &ack, 1) != 1) break;
    }
    _exit(0);
}
```

The parent writes all N jobs first (they fit in the pipe buffer), then collects N completion bytes in order. Any failure re-renders the whole frame serially and **falls back permanently** — an optimisation must never take a live stream down.

Children also set `PR_SET_PDEATHSIG = SIGKILL`, so the kernel reaps them if the parent goes away.

## 6. First-frame self-check: make silent corruption impossible to miss

Since trap two tells us this failure mode is silent, we build something that is not silent.

On the first frame through the parallel path, render serially into a scratch framebuffer page (we map 3 pages; playback only uses pages 1 and 2, so page 0 is free), hash it with FNV-1a; then render in parallel into the real page and hash that. If the hashes differ, the pool is judged broken, logs a warning, and falls back to serial permanently:

```c
fb_render_range(nv, scr, 0, 1280);   unsigned h1 = rp_hash(scr);
fb_render_pool (nv, dst);            unsigned h2 = rp_hash(dst);
if (h1 != h2) { P("[rpool] self-check failed serial=%08x pool=%08x -> permanent serial fallback\n", h1, h2); ... }
```

The cost is paid once: one extra render plus a 3.6 MB hash (~1–2 ms). In exchange, **any divergence between parallel and serial output is caught**. For a lock-free parallel change like this, I rate the self-check above the optimisation itself.

## 7. Refactor: make the band loop take a range

So the same code can run serially or as a child's slice, the inner band loop becomes a ranged function:

```c
static void fb_render_range(const unsigned char *nv, unsigned *dst, int y0, int y1);
```

Serial calls it with `(0, 1280)`, **bit-for-bit equivalent** to the old path; each child calls it with its own slice. One subtlety here: the render config used to live in `static`s inside `fb_render` (`g_bandh`, `use_neon`, `use_lut`, …), and children never call `render_cfg_init()`. So I promoted them to **file-scope globals** and let `fork` inherit them. Miss one (say `g_prof`) and an env switch silently stops working — the same disease as trap two.

Frame-rate accounting got aligned too: the old sampling multiplier was once wrong (`[perf]` reported 25 ms while the AU section reported 32.3 ms, contradicting each other). The new code reconstructs from the actual band count and sample count of the range instead of a fixed factor.

## 8. How to validate: one variable, plus a hard gate

The gate is `NETTV_RPOOL=N` (1–8, default **0 = original serial path**, behaviour unchanged). The A/B runs three arms back to back: 0 / 2 / 4, same binary, same source, same duration.

Four criteria, the second one non-negotiable:

1. `[STAT] fps_x10` clearly above the baseline;
2. **`[rpool] self-check passed, serial/pool identical`** — divergence is an automatic loss, no matter how high the frame rate;
3. no `signal=11` in the crash log;
4. ION clients do not grow (parallel rendering must not consume extra ION memory).

Why criterion 2 is absolute: the worst outcome of parallel rendering is not slowness, it is **quietly wrong pixels**. More frames with a scrambled picture is an incident, not an optimisation.

## 9. Status and next steps

This post was written while the board was offline (third consecutive run without a link), so **everything above is design and static review — no measurements yet**. What exists:

- source v30 (v29's async audio pump fixes plus this render pool);
- a device-side build script and a three-arm A/B script;
- three safeguards: first-frame self-check, auto-disable on non-shared staging, permanent fallback on child failure.

Once the board is up: run the async audio pump A/B first (prepared last round), confirm the segment gap drops below 6 s and the frame rate passes 22 fps; then run this pool A/B. Only if both pass do we talk deployment — the async pump carries a "+18 s startup delay" trade-off that the user has to accept first.

> See the checklist below. This kind of change has to be validated on real hardware: frame rate, picture correctness, and long-run stability.

## Verification checklist for the user

1. Build: does `_b30.sh` report `BUILD_OK`? (v30 adds a `pipe`/`fork` path — check for compile errors first.)
2. Self-check: does the log show the pool self-check **passed**, not failed?
3. Frame rate: compare `[STAT] fps_x10` across the three arms; the enabled arms should be clearly above baseline `0`.
4. Picture: look for colour bands, horizontal stripes, or shifted rows on the real screen (the hash check only proves parity with serial, not that serial itself is right).
5. Stability: `signal=11` count is 0, ION clients do not grow, and cleanup ends with `left=0`.
