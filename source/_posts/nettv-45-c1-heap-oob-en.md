---
title: "netTV HW Decode (45): A 12-Byte Heap Overflow — How a Static Audit Caught Our Own Dead Writes"
date: 2026-11-12 02:00:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Hardware Decode
  - Memory Safety
  - Debugging Methods
categories:
  - [Project Notes, netTV HW Decode]
  - [Embedded, Spreadtrum Platform]
  - [Engineering Practice, Debugging Methods]
copyright: "Original works by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduce with attribution to whiteleibniz.github.io"
---

> 🌐 Language: [简体中文](https://whiteleibniz.github.io/2026/11/12/nettv-45-c1-heap-oob/) · [繁體中文](https://whiteleibniz.github.io/2026/11/12/zh-tw/nettv-45-c1-heap-oob-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/12/nettv-45-c1-heap-oob-en/)

> Post 45 in the series. Last round we concluded the crash was "accumulating drift" and built the measuring instrument — but the device stayed powered off.
> This round we changed the audit dimension: not waits, but allocations. The culprit turned out to be six assignments
> in our own shim layer that were never read by anyone.

A periodic SIGSEGV we chased for half a month ended on six assignments in our own code. They are not `memcpy` calls, so two earlier rounds of "audit every memcpy boundary" never touched them. This post is about that blind spot, and about pinning down "how big is this object, really" with nothing but a disassembler.

<!-- more -->

## Background: symptom and prior conclusions

The network-TV player on a Spreadtrum SC9832A device (VSP hardware decoding) dies of SIGSEGV roughly every three minutes during steady playback. Frame rate stays normal, the crash does not scale with IDR size, and the faulting address sometimes looks like ASCII — `0x747474`.

Directions already ruled out:

- The signal handler was rewritten (`sigaltstack`, pure `write` to avoid dying on a held malloc lock) — but it is never entered;
- All nine of our `memcpy` sites were checked individually; every one is bounded;
- Render pool, thread signal masks, and fork timing were A/B tested; none is the primary cause.

What remained was the "accumulating drift" hypothesis: some path executed every frame slowly consumes a resource. The open question was **which path**.

## Method: turn alloc/free pairing into a function-level audit

The previous round audited waits and timeouts. This round audited allocation behaviour. The idea is plain:

1. Take exact function boundaries from `.dynsym` FUNC symbols (which carry a size); fill in non-exported static functions using `push {…, lr}` prologues — the only reliable boundary signal in a stripped library;
2. Build a PLT-address → symbol-name map from `.plt` + `.rel.plt`, then capture every `bl/blx` inside a function body that targets `malloc/calloc/new/mmap` or `free/delete/munmap`;
3. Decide whether the call site sits inside a loop formed by a backward branch in the same function (the smell of per-iteration allocation);
4. Walk back twelve instructions to recover `r0` (including `movw`/`movt` pairs) — the requested size;
5. Build a call graph rooted at per-frame entry points (`onQueueFilled`, `H264DecDecode`, …) and BFS-annotate reachability depth.

Two gates to keep the tool from fooling itself:

- **Coverage must be printed.** Linear disassembly stops at constant pools; when coverage is low the tool prints `INCOMPLETE`. Otherwise "found zero allocation sites" gets read as "nothing allocates".
- **A negative control.** The register-layer library does not import `malloc` at all, so the tool must report "zero heap allocation sites" rather than "no leak". That is a deliberate reverse test.

## The decisive step: how big is the object?

One unremarkable line in the audit output: a callback contains `_Znwj` with a recovered `r0 = 0x1c`.

`0x1c` is 28. Those 28 bytes are then handed to the `MemoryHeapIon` constructor. Following that thread through all four construction sites, three of them read `mov r0, #0x1c; bl _Znwj` — **the object is 28 bytes**.

Back to our own source. To work around ION allocation failures, the player replaces the entire `MemoryHeapIon` constructor with a shim that fills the object according to a field-offset table:

```c
*(void    **)(o +  0) = ...;
*(int      *)(o +  8) = ...;
*(unsigned *)(o + 12) = ...;
*(int      *)(o + 16) = ...;
*(unsigned *)(o + 20) = ...;
*(void    **)(o + 24) = ...;   /* 28 bytes end here */
*(unsigned *)(o + 28) = handle;   /* overflow 1 */
*(int      *)(o + 32) = fd;       /* overflow 2 */
*(int      *)(o + 36) = buf_fd;   /* overflow 3 — actually reaches o+39 */
```

**Every construction writes 12 bytes past the end.** And none of those three fields is ever read: `getBase()` reads +24, `getHeapID()` reads +16, `get_phy_addr_from_ion()`/`get_iova()` read +8/+12/+16/+24. All three assignments are dead writes.

Frequency sets the scale: an mbinfo buffer is requested roughly every two frames — 12.5 times per second at 25 fps, about 2200 overflowing writes every three minutes, each smearing 12 bytes over the neighbouring malloc chunk (header or data).

## Why two memcpy audits missed it

This is the part worth remembering.

Intuitively, "out-of-bounds write" means "a `memcpy` length computed wrong". So the audit was shaped like that: check every length variable, every source buffer size, every `min()` clamp. That works for **data movement**. It fails completely for **fixed-offset struct writes**: `*(int*)(o + 36) = fd;` contains no length variable at all. It *looks* like setting a field. The correctness problem hides in an external fact — how large the object actually is.

So the audit rule needs an addition: **audit by "write offset vs. true object size", not only by "is there a length parameter".** The true size usually is not in your file; it comes from a `new(N)` inside the library, and you have to disassemble to get it.

A counter-intuitive corollary: these six lines existed from the second version of the code and survived all the way to the deployed build, through several rounds of "memory safety review". They were not hidden — they were simply outside the checklist.

## Two mutually exclusive hypotheses, one experiment to separate them

At this point there are two candidates whose predictions contradict each other:

| Hypothesis | Prediction |
|------------|------------|
| A: per-frame byte leak | CMA free memory declines linearly; 151 s implies ~1.94 KB/frame, 186 s ~1.58 KB/frame (7 MB pool, 25 fps) |
| B: corrupted heap metadata (this post) | **It can crash with CMA flat**; the timing depends on when the allocator touches the damaged chunk |

That distinction matters: every previous investigation watched free memory, and hypothesis B consumes none. If you only sample CmaFree, B stays invisible forever.

So the next step is one thing only: delete those 3 lines × 2 sites (six lines total), compile, and run four to five full failure periods. Crash gone means root cause; markedly longer interval means a contributing cause; no change kills the hypothesis and sends us back to the CMA slope branch.

Which is also why nothing else was changed at the same time. There is still a separate "signal-mask sanitisation" patch pending on this code, and mixing the two into one experiment would make the result unattributable. The value of "one variable at a time" is not caution — it is that conclusions stay reusable.

## Takeaways

- A static audit's output is not necessarily "the vendor library is broken". It can be "our own shim layer is broken" — and the shim is exactly the part everyone assumes has already been validated.
- Function-level symbols, self-reported coverage, and a negative control are the minimum kit for a static report to count as evidence.
- An ASCII-looking fault address (`0x747474`) does not make it a string. Don't ride that intuition too far; this round did not prove where it comes from either.
