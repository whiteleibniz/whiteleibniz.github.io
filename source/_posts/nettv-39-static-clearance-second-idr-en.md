---
title: "netTV HW Decode (39): Static Clearance — Rule Out Our Own Code for the Second-IDR SIGSEGV"
date: 2026-11-08 02:40:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Hardware Decode
  - Debugging
categories:
  - [Project Notes, netTV HW Decode]
  - [Embedded, Spreadtrum Platform]
  - [Engineering Practice, Debugging Methods]
copyright: "Original work by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduction must credit whiteleibniz.github.io"
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr/) · [繁體中文](https://whiteleibniz.github.io/2026/11/08/zh-tw/nettv-39-static-clearance-second-idr-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr-en/)

> Part 39 of the series. The device was offline again (11th round in a row), so no
> online experiments. This round made a zero-cost advance on a long-standing issue:
> **the second IDR reliably SIGSEGVs at fault address 0x747474** — a static audit
> cleared the "our own code overflows a buffer" hypothesis entirely, cutting the
> online forensic search space by more than half.

## 1. What the crash site looks like

The recorded fault address is `0x747474`. Read little-endian, those bytes are
`74 74 74 00` — ASCII `"ttt\0"`. **A value that looks like text data, not a legal
address, sitting in a pointer slot** is the classic signature of a
"pointer clobbered by data" bug: somewhere a stream write went past a boundary,
stomped a pointer in an adjacent struct, and the crash only happens when that
pointer is dereferenced.

That makes the search direction clear: find every copy point that writes data
next to compact structs. In our player, that means every `memcpy` on the NAL
feed path.

## 2. Nine memcpy sites, audited one by one

I pulled all 9 `memcpy`/`memmove` call sites from the production v32 source and
checked each for bounds enforcement:

| # | Site | Copy target | Bounds guarantee | Verdict |
|---|------|-------------|------------------|---------|
| 1 | `rb_put` | ring-buffer slot | `n ≤ RB_DCAP/2` pre-filter + backpressure + tail wrap | ✅ bounded |
| 2 | `auagg_add` | AU aggregation buffer | flush on overflow, oversized NALs bypass | ✅ bounded |
| 3 | `idrmix_feed` | concatenated-feed buffer | first memcpy doesn't check SPS length, but SPS is tens of bytes and the path is default-off | ✅ bounded in practice |
| 4 | `cfg` write | SPS..IDR contiguous region | explicit `(idr_end - sps_at) ≤ sizeof cfg` check | ✅ bounded |
| 5 | `nal_local` copy-out | 512KB local copy | `nlen > sizeof nal_local` → skip | ✅ bounded |
| 6 | IDR replay diagnostic | 512KB replay buffer | explicit `nlen ≤ sizeof irp_buf` check | ✅ bounded |
| 7 | first-segment feed | input buffer | `n > bhIdr->nAllocSize` checked before copy | ✅ bounded |
| 8 | segment-split loop | input buffer at offset | `segs[si]+slen > n` → continue; sub-blocks derived from csz | ✅ bounded |
| 9 | render/out path | fb and staging | fixed 3MB / fixed 24-word struct | ✅ bounded |

Two easy-to-miss spots checked too: URL joining's `memcpy(host, p, hl)` clamps
`hl ≥ sizeof host`; the out-path reallocation copies between two fixed-size
static arrays.

**Conclusion: our feed/render path contains no out-of-bounds write capable of
stomping a pointer.**

## 3. Where the suspicion lands

After clearance, only two suspect classes remain:

1. **Inside the vendor library.** We bypass OMX layer 2 and drive
   `SprdSimpleOMXComponent` directly; the input buffer header
   (`pBuffer`/`nAllocSize`) and component internals are all maintained by vendor
   code. The ptrace-confirmed "GOP#3 full-DRIVE input-queue UAF" belongs here.
2. **Trust in the buffer header itself.** Every round we trust
   `bhIdr->nAllocSize`/`pBuffer`. If the vendor side mutates the header (e.g.
   after a port reconfiguration without reallocation), our "bounded" checks are
   bounding the wrong object.

Note: this crash is already mitigated in production v32 by multiple layers
(oversize skip, 32KB splitting, IDR watchdog, sw-decode fallback respawn), so it
presents as a "historical phenomenon" rather than a daily failure. But without
root cause, the mitigation stack runs on thin ice.

## 4. Online forensics checklist (ready the moment the device powers on)

- **The SIGSEGV handler is fixed** (uc offset +32), so a crash leaves addr/pc/regs.
  Map the pc with `elf_syms.py`: lands in our `.text` → the audit missed
  something; lands in the vendor library → class 1 confirmed.
- **`NETTV_IDRREPLAY=K`** (built into v32): capture the first IDR and replay it K
  times. Crashes on first replay → component-state issue (A); replays fine but
  crashes at the second real IDR → accumulation drift (B). One env var bisects
  the cause.
- Watch the `[inbuf]` (oversize skip) and `[split]` logs: a skip record before a
  crash means a NAL larger than any seen before appeared in the stream — check
  the source before the code.

## 5. Closing thought on method

A fault address that looks like text ⇒ suspect "pointer clobbered by data" first;
and **the site of the clobber is usually not the site of the crash**, so hunting
only near the crash stack is wrong. The value of static clearance: spend half an
hour turning "we probably don't overflow" into an evidenced conclusion, so the
online window — this project's most expensive resource — never gets wasted
debugging ourselves.

**Negative results are results too**: this round changed zero code, but shrank
the search space from "all of our code" to two classes: "vendor library + buffer
header trust". The forensic path is pre-built for the next reproduction.

> 🌐 Other languages: [简体中文](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr/) · [繁體中文](https://whiteleibniz.github.io/2026/11/08/zh-tw/nettv-39-static-clearance-second-idr-zh-tw/)
