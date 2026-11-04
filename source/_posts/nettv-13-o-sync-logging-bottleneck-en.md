---
title: "netTV Hardware Decoding Deep Dive (13): 11 O_SYNCs Per Frame — the 'Forensic Logging' Was the Frame-Rate Killer"
date: 2026-10-20 14:00:00
tags:
  - VSP
  - Hardware Decoding
  - Frame Rate
  - O_SYNC
  - fsync
  - Logging Overhead
  - Performance Profiling
  - Spreadtrum
  - nettv
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Debugging, Performance Optimization]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-13-o-sync-logging-bottleneck/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-13-o-sync-logging-bottleneck-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-13-o-sync-logging-bottleneck-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

After the previous part lifted the stutter from 0.08fps to 6.3fps (**~80x**), I briefly assumed what remained was the hardware decoder's own limit — the log said in black and white "VSP single-frame decode 43ms, hardware ceiling ≈23fps", and the monitoring samples also said fb_render takes 33ms. By that math, the 25fps ceiling was untouchable.

But that was a grudging re-tally after comparing against Android: **inside the 43ms "decode", the vendor library itself reported the hardware only spent 14ms**. What were the other 29ms? Digging down that thread, what eventually surfaced was nowhere near the decoder — it was **the forensic logging I had added line by line myself**.

This part documents the full localization of this "logging eats frame rate (fps)" problem: the 140ms-per-frame breakdown, the measured cost of O_SYNC, and a counter-intuitive conclusion — **the trace added to catch a hang made every decode 3x slower**.

## 1. Ledger First, Then the Knife: 140ms Per Frame, Broken Into Five

No code changes; first squeeze the timings out of the previous round's complete log. The log already had enough instrumentation (AU header, DRIVE return, 9c wait exit, on-screen timestamp); a 30-line awk aligns them by AU:

| Segment | Time | Content |
|---|---|---|
| DRIVE (empty sync submit) | **43ms** | vendor library self-report: **hardware decode 14ms** |
| snap_state + diagnostic printing | ~37ms | 4 lines of state snapshot + pa_of queries |
| frame readback + render | ~62ms | memcpy 3MB staging + signature scan + fb_render (33ms) |
| tail | ~21ms | fill(out)×2 + REFILL kick + status line |
| **Total** | **~140ms** | ≈7fps (monitoring [STAT] truth 13.2fps, pulled back by multi-frame batching) |

Two numbers immediately failed to reconcile: **the vendor library log plainly wrote `decRet: 0, 14ms`**, yet DRIVE took 43ms; existing samples said fb_render is 33ms, but the whole "frame readback + render" segment is 62ms. Where did the extra time go?

## 2. The First Suspect: O_SYNC Once Every 15ms

First measure the floor cost of flash writes. The device's /tmp sits on eMMC; use dd in a loop to write 128 bytes 60 times each:

```
fsync  60×128B: 1110ms   ← ~18.5ms per write
normal write 60×128B:  200ms   ← ~3.3ms per write (incl. fork/exec)
```

Then count how many synchronous writes are actually in the hot loop. For this project — "on a hang, stdout is lost entirely, but the phase log must survive" — two logging systems both carry `O_SYNC`:

- `tr_line`: writes one line to vsp_trace.log before and after each DRIVE — **2 writes per submit, 6+ per frame, and on by default**. It was added on 10-19 to catch "the second IDR hang"; the register MMIO reads (the real culprit of that kernel crash) were later turned off by default, but **the file writing was forgotten**.
- `phx`: 2 lines per REFILL_OUT channel, plus the kick requeue triggered on every AU — 3~5 times per frame.
- `ph`: one line at the segment header.

**About 11 O_SYNCs per frame.** At 15ms each that's 165ms — more than an entire frame; even if eMMC coalesces small writes and you count 3~~5ms each, that's still 30~~55ms per frame. This halves the "43ms decode" twice over.

The most ironic part: `tr_line`'s comment says it was added to locate "which DRIVE it hung on". But it is itself the thing that made DRIVE slow — **the forensic instrument changed the system under investigation**. This is already the third time in this project: debug code scrambled the VSP state machine and crashed the kernel; the rate limiter added to ptsync to cure the stutter became a stutter amplifier; the O_SYNC trace added to catch a hang slows every frame. Exactly the same pattern.

## 3. The Change: One Variable — "Diagnostics Off by Default"

Per the project's iron rule of one variable per change, this round's diff is a single sentence: **all hot-loop diagnostics off by default, restorable via env**.

```c
/* tr_line: default flips from "on" to "off"; only NETTV_TRACE=1 enables it */
if (!(e && e[0] == '1')) { g_tr_off = 1; return; }

/* phx / snap_state / [r%04d] / AU header / DRIVE return / [9c wait] all routed through kdiag_on() */
static int kdiag_on(void) {
    if (g_kdiag < 0) {
        const char *e = getenv("NETTV_KDIAG");
        g_kdiag = (e && *e && *e != '0') ? 1 : 0;
    }
    return g_kdiag || vlog_on();
}
```

At the same time we added a **zero-I/O-overhead bucketed aggregation timer** (prints averages every 200 AUs): wall clock, segment loop, snap, frame readback, render. With diagnostics off, the ledger can't go dark too — otherwise the next round starts with archaeology again.

```c
{ long _pw = sys_time_ms();
  if (p_au_prev) { g_t_wall += _pw - p_au_prev; g_t_n++;
      if (g_t_n % 200 == 0)
          P("  [perf] AU#%d avg: wall=%.1f segloop=%.1f snap=%.1f read=%.1f render=%.1f (ms)\n", ...);
  }
  p_au_prev = _pw; }
```

The new binary is 128256 bytes (the old build, 128028, is backed up as .bak_1020); build and deploy via the existing script.

## 4. Verification Stuck on a "Resource Conflict"

The A/B script was ready long ago (A = new default, B = `NETTV_STAGE=0` direct ION read, saving the 3MB memcpy), yet both rounds crashed into a `_exit(12)` restart loop within 20 seconds. Checking processes revealed it: **the user's desktop was playing TV** — the ~7MB VSP/ION pool was occupied, and my second instance kept backing off and retrying, never winning an output buffer.

Both times the same exit code 12 (hardcoded in the code as "self-managed ION still has 0 channels; refusing to hand the IOMMU handle to VSP"); combined with "the change only touched logging and timers" and "the same time slot yesterday was normal with no other player running", regression is ruled out. This adds another entry to project memory: **frame-rate experiments and user playback are mutually exclusive** — the ION pool is an exclusive resource; before starting an experiment, confirm there is no live playback session.

So the verdict comes in two halves:

- **Confirmed**: 11 O_SYNCs per frame, the 15ms-per-write floor, and only 14ms of the 43ms being hardware (all backed by logged measurements).
- **To be quantified**: end-to-end fps after turning it off, and whether direct ION reads save that 20ms memcpy — the script `/tmp/v16_ab.sh` is already on the device; one command once the user stops playback.

By the ledger: disabling diagnostics saves ~30~55ms, plus direct ION reads save another ~20ms — 140ms → ~65ms ≈ **15fps**; getting to 25fps beyond that requires tackling fb_render's 33ms (NEON-ize or use VSP scaling — confirmed unsupported on the decode side, CPU-only) and the 29ms of vendor-side overhead inside DRIVE (our Get_phy_addr hook re-queries the ion ioctl every frame; the fd→PA mapping can be cached).

## 5. Three Takeaways

1. **Logging is not free, and synchronous logging especially not.** On flash where a normal write is 3ms and O_SYNC is 15ms, a single trace line costs half a frame decode. Any logging hanging in the hot loop: multiply by the frame count before keeping it.
2. **Ask "is it really?" before believing any "hardware ceiling".** The vendor library's own 14ms vs the 43ms outside DRIVE differ by 3x, and the difference lies entirely outside the library — mbinfo callbacks, phys ioctl, bind/unbind, double FilledDone. Performance work should respect the vendor's own timings; that ruler carries none of our bias.
3. **Forensic code needs a "shelf life".** A trace added to catch one bug retires the day that bug is fixed. Better: when adding it, fix its default and its off-switch from the start; never let temporary code become the default path — this project has already paid tuition with three kernel crashes and one frame-rate disaster.

---

*Related reading: [netTV Hardware Decoding Deep Dive (12): 80x Speedup — a PTS sync deadlock of "the more it stalls, the more it drops"](nettv-12-ptsync-positive-feedback-stall.md)*
