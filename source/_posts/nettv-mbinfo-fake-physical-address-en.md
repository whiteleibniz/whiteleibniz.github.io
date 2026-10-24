---
title: "Spreadtrum SC9832A Network TV Deep Dive (4): mbinfo's 'Fake Physical Address' — the Common Suspect Behind 1/3 Mosaic on Screen and the IDR Hang"
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
tags: [VSP, Hardware Decoding, ION, CMA, DMA, m3u8, Spreadtrum]
date: 2026-10-16 02:00:00
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address/) · [繁體中文](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

The previous three parts rescued VSP hardware decoding from "switching to software decoding", and the picture finally came out. But two symptoms remain unsolved on the real device: **screenshots show 1/3 blocky mosaic**, and **the decoder hangs permanently when playback reaches the 3rd GOP's IDR**. This part records how both issues were converged onto the same suspect — the **fake physical address** of the mbinfo buffer — and the corresponding fix.

## 1. Three Pieces of Evidence Point to the Same Place

| Evidence | Observation |
| --- | --- |
| Log | `复用块#n/5 (pa=0x00000000)` — the reused mbinfo block's physical address is 0 |
| Screenshot | 2/3 of the picture is clean, 1/3 blocky mosaic, with neat boundaries, as if "part of the data was never written" |
| Timing | the hang point always appears when feeding an IDR: `DRIVE empty(全量)` never returns |

VSP is a DMA device; the addresses it uses to write macroblock info come from `Get_phy_addr_from_ion` / `Get_iova`. If this address is 0 (or is simply a CPU virtual address), the DMA writes garbage near physical address 0 — both the mosaic and the hang are explained.

## 2. An Asymmetry in the Code: One Library, Two Paths

Only when digging through the source did a very hidden asymmetry emerge: **the static version of `Get_iova` has three fallback layers, while the constructor path `MemoryHeapIon::C1` has only two**.

```c
/* Get_iova: real query → table lookup → mmap + pagemap   ← there is a third trick */
if (ion_phys(buf_fd, iova, sz) == 0) return 0;
if (map_get(buf_fd, &base, &size) != 0) {
    void *m = mmap(NULL, 0x400000, PROT_READ, MAP_SHARED, buf_fd, 0);
    base = pa_of(m);                       /* /proc/self/pagemap */
    ...
}

/* C1: 0xc008602a → cmd0 → uses the CPU VA directly as PA   ← missing pagemap */
map_add(buf_fd, (unsigned long)base, size);  /* fake PA */
```

`0xc008602a` and `cmd0(0xc0084906)` always return EINVAL for certain ION heaps (such as the non-CMA system heap), so mbinfo walks all the way into the "fall back to the CPU VA" branch — **this is where the fake PA comes from**. In the 10-15 logs, all mbinfo blocks take this branch.

## 3. The Fix: Three-Level Fallback + Contiguity Spot-Check + Reuse-Block Selection

The first layer adds pagemap, the second judges whether this memory can be given to DMA at all, and the third guarantees that reuse never picks a bad block.

```c
/* ① Spot-check physical contiguity: non-contiguous = system heap, VSP DMA will surely fail */
static int pa_contiguous(void *base, unsigned size)
{
    unsigned long prev = pa_of(base);
    if (!prev) return 0;
    for (unsigned off = 4096; off < size; off += 4096) {
        unsigned long p = pa_of((char *)base + off);
        if (!p || p != prev + 4096) return 0;
        prev = p;
    }
    return 1;
}

/* ② Three-level addressing: 0xc008602a → cmd0 → pagemap(+contiguity) */
static unsigned long buf_real_pa(int buf_fd, void *base, unsigned size, int *contig)
{
    unsigned long pa = 0; unsigned sz = 0;
    if (buf_fd >= 0) {
        if (ion_phys_sprd(buf_fd, &pa, &sz) == 0 && pa) { *contig = 1; return pa; }
        if (ion_phys(buf_fd, &pa, &sz) == 0 && pa)       { *contig = 1; return pa; }
    }
    if (base && pa_contiguous(base, size)) { *contig = 1; return pa_of(base); }
    if (base) { unsigned long p0 = pa_of(base); if (p0) return p0; }
    return 0;
}
```

Add two more disciplines on the reuse side:

- **never register 0 into the fd→PA table**: `map_add(fd, pa ? pa : (unsigned long)base, size)`. Previously 0 was written in, so a later `map_get` hit would use 0 as the physical address.
- **preferentially reuse blocks that "have a real PA and are contiguous"**; when reusing, if some block has `pa==0`, re-query it on the spot with the three-level addressing (cost is extremely low, just in case it was a transient failure).

```c
for (int k = 0; k < g_c1r_n; k++) {
    int i = (g_c1r_next + k) % g_c1r_n;
    if (!g_c1r[i].pa) {
        unsigned long pa = buf_real_pa(g_c1r[i].buf_fd, g_c1r[i].base, size, &cg);
        if (pa) { g_c1r[i].pa = pa; g_c1r[i].contig = cg; }
    }
    if (g_c1r[i].pa && g_c1r[i].contig) { s = i; break; }
}
```

There is also a **default-off** experimental switch `NETTV_MBINFO_HEAP=1,2,3`, used to manually probe whether other ION heap ids can obtain CMA contiguous blocks. Not trying by default is a lesson learned at a cost: early on, a mask8 bare allocation was tried, and it caused a **kernel crash and device reboot** outright.

## 4. How to Tell Whether It Is Fixed

The patch is done but not yet on the device (the device was offline that night), so the criteria are hardcoded in the script first; once on the device, collect with this grep:

| Criterion | Expected |
| --- | --- |
| `grep -c '真PA='` | > 0 (got the real physical address) |
| `grep -c '三级取址全失败'` | 0 |
| `grep -c '非连续'` | 0 |
| `grep '复用块' \| tail -5` | pa non-zero and marked "连续" |
| `grep -c 'change to sw decoder'` | 0 |
| `grep -c '\[STAT\]'` | count × 25 ≈ total frames; the last line gives average fps |

## 5. One-Sentence Lesson

> **The same thing often has two implementations in one library; when you change one, don't forget the other.** This time `Get_iova` had its pagemap fallback patched long ago, while the allocation path kept feeding CPU virtual addresses to DMA as physical addresses — the two sides differ by one layer, and the symptom is the hardest kind to investigate: "occasional screen corruption + occasional hangs".

## 6. On-Device Validation Results (Evening of 2026-10-16)

After the device rebooted and reconnected, on-device measurement ran per the script above (build `DEPLOY OK 83092B`, the player carrying UA+Referer passed CloudWAF to get the m3u8, decoding continuously for 150s):

| Criterion | Expected | Measured |
| --- | --- | --- |
| `真PA=` | > 0 | **270** ✅ |
| `三级取址全失败` | 0 | **0** ✅ |
| `复用块` last line | pa non-zero and contiguous | `pa=0x9fdc1000,连续` ✅ |
| `change to sw decoder` | 0 | **0** ✅ |
| `SIGSEGV` | 0 | **0** ✅ |
| `FAILED rc=` | 0 | **0** ✅ |
| `[STAT]` | continuous | 20 lines (≈500 frames) ✅ |

**Both core symptoms have disappeared**: ① the second IDR's `SIGSEGV(addr=0x747474)` no longer appears — the fake PA (DMA writing to the CPU VA) was exactly the root cause of the crash; ② mbinfo no longer goes through the `change to sw decoder` one-way door due to OOM, and the hardware decode chain is preserved.

**But the GOP#3 `DRIVE empty(全量)` hang remains**: when feeding the 3rd IDR, the decoder still sticks at "full DRIVE" without returning, except that it is now respawned by the monitor parent's stall watchdog (2.2s grace) as a fallback, instead of hanging permanently. **This in turn proves: the fake PA is not the root cause of the IDR hang** — the real culprit is the internal deadlock of the full-DRIVE call during IDR switching, which the next part will tackle head-on.

> The measurement also found 10 `非连续` blocks (non-contiguous memory given by CMA); the magnitude is small and no screen corruption/hang was triggered, leaving it for a later spot-check.
