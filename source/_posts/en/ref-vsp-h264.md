---
title: "ref_h264 Hardware Decoding_h264dec Verdict"
date: 2026-10-08 19:08:38
lang: en
permalink: en/2026/10/08/ref-vsp-h264/
search: true
categories:
- 多媒体与模拟器
- VSP硬解
tag:
- VSP
- 硬解
- H264
---


# SC8830 Hardware Decoding Effort — h264dec Disassembly Verdict (2026-10-08)

> This machine's workspace is not a git repository; the code is on the device at `/tmp/sprd_msg.c`, and the build script is `/tmp/smb.sh`.
> All conclusions come from `objdump -d /mnt/android_sys/lib/libstagefright_sprd_h264dec.so`.

## 1. The complete gate chain of the real body of onQueueFilled (starting at `0x7cec`)

```
7d78 ldr ip,[r4,#0x9c] ; cmp #0 ; bne 84f0    ← entry: [0x9c]!=0 goes to 84f0
7d7c-7d88 bl initDecoder / freeOutputBufferIOVA
7da4 bl getPortQueue(0) → [sp+0x34]   (in queue)
7db4 bl getPortQueue(1) → sl          (out queue)
7dbc ldrb r8,[r4,#0x9a] ; cmp #0 ; bne 83dc   ★ [0x9a]!=0 → return directly
7dc8 ldr r5,[r4,#0x84] ; cmp #0 ; bne 7de8   ← [0x84]!=0 forces entry into the decode area
7dd4 ldr fp,[r2,#4] / 7de4 beq 83dc           ← in queue empty → return
7de8 ldr r8,[sl,#4] / 7df4 beq 83dc           ★ out queue empty → return
7df8 cmp r5,#1 ; beq 8718                     ← [0x84]==1 goes to drainAllOutputBuffers
```

### Field semantics master table (★ all settled by past pitfalls)

| Field | Semantics | Writer |
|---|---|---|
| `[0x84]` | Decode switch. `!=0` forces entry into the decode area; `==1` additionally goes to 8718 drainAllOutputBuffers | `0x7ee0` (nFlags&1), becomes 2 after running |
| `[0x88]` | Port size change pending gate (non-zero returns directly) | handlePortSettingChangeEvent |
| `[0x8c]` | Internal drain loop switch. `0x83c4 ldrb; cmp #0; bne 8334` | can be enabled by manually setting it to 1 |
| `[0x9a]` | **Stop flag**. Non-zero → entry 7dbc returns directly | `0x83b0` (automatically set to 1 when `[0x9c]!=0`) |
| `[0x9c]` | Pending byte count. `0x7f68 beq 8518` = skip the scratch copy | ★**do not set manually**, see below |
| `[0x1dc]` | SPS landed flag | `0x8240` (VSP writes back `[sp+0xa4]`) |
| `[0x1dd]` | PPS landed flag | `0x8248` (VSP writes back `[sp+0xa5]`) |
| `[0x1e0]/[0x1e4]` | SPS buffer / length (length limit 1024, `cmp #0x400`) | `0x7ccc` |
| `[0x1e8]/[0x1ec]` | PPS buffer / length (same limit) | `0x7ca4` |
| `[0x1f0]` | **Frame output master gate, one-shot**. `0x8314 ldrb; beq 85fc` | `0x8710`, and `0x8324` clears it to 0 immediately after use |
| `[0x228]` | IOVA/gbMapper path. `!=0` → `0x8254 bne 85c0` takes the IOVA branch | setParameter(port1) |
| `[0x234]/[0x238]` | crop w/h (first log line 1920/1088). `0x82d0/0x82e4` compares with the scratch position, jumps to `87a8` if mismatched | SPS parsing |
| `[0x64]/[0x68]` | VSP-side output w/h | handlePortSettingChangeEvent |
| `[0xac]/[0xb0]/[0xb4]` | VSP scratch(1MB malloc) / write pointer / length | initDecoder |
| `[0x208]` | VSP DecodeFrame function pointer | — |

## 2. ★ Three counterproductive manual interventions (all tried and rolled back; do not repeat)

### 1. Manually setting `[0x9c]` — will deadlock the loop
```
839c ldr r0,[r4,#0x9c] ; cmp #0
83b0 strbne r2,[r4,#0x9a]    ★ [0x9c]!=0 → [0x9a]=1
7dbc ldrb r8,[r4,#0x9a] ; bne 83dc  ← the next round's entry returns directly
```
`[0x9c]` must be left for the vendor to maintain itself. Measured: after setting `[0x1f0]=1`, `consume byte` changes from a constant 41 to the full byte count.

### 2. Manually setting `[0x1f0]` works, but **must be reset every round**
- `0x7f04 ldrb [0x1dd] ; bne 7f24` → `7f10 tst r0,#0x80 ; bne 853c`
  submitting config with `OMX_BF_CODECONFIG(0x80)` ⇒ always takes 853c ⇒ cannot reach `7f18 → 86e4 → 8710` ⇒ the vendor never sets `[0x1f0]`.
- The fallback of setting it to 1 is equivalent to redoing 8710. **Effect verified**: `consume byte` 41 → 14527/14482/14474/14465 (full amount).
- But after the `0x8314` check, `0x8324 strb r0,[0x1f0]` immediately clears it to 0 ⇒ the streaming loop **must reset it every round**.

### 3. Double-emptying the same in buffer will ASSERT
```
##### ASSERT #####
[!(!buffer->mOwnedByUs)]  [SprdSimpleOMXComponent]
```
`mOwnedByUs=1` means ownership has passed to the component; it is normally cleared to 0 by the EmptyBufferDone callback, but we have no looper ⇒ we must `set_owned(hdr, 0)` before every empty.

## 3. gralloc / handle three-layer layout (all settled by measurement)

- **`alloc`'s real signature has only 7 parameters**: `int alloc(dev,w,h,format,usage,native_handle_t**,int*stride)`
  when called per AOSP's 10 parameters, the 6th parameter's literal 0 falls into `handle**` → `0x2192 cmp r9,#0; beq 0x244a` → `mvn r4,#21` = **-22**. This is the real cause of the historical universal failure of gralloc alloc.
- **format whitelist**: `1 2 3 4 5 / 17(YCbCr_420_SP) / 19 20 21 / 33 34 35` + the literal `0x32315659`("YV12").
  measured: `fmt=17, usage=0x300(HW_TEXTURE|HW_RENDER)` succeeds in one try, `stride=1920`.
  ⚠ `usage & 0x1000` with w,h>1 detours to the framebuffer path (`0x22ba`), where the first call always fails.
- **`hw_module_t`**: `+0x00`=0x48574d54("HMW"), `+0x04`=1, `+0x08..0x18`=register[0..4], `+0x80..0x8c`=perform[0..3].
- **`alloc_device_t`**: `+0x00`=0x48574454("HWAT"), `+0x08`=module, `+0x3c`=name, `+0x40`=alloc, `+0x44`=free, `+0xcc`=ion_fd.
  ⚠ `+0x40` **is directly the function pointer** (not a pointer to a pointer; dereferencing one more level will certainly crash).
- **`native_handle`** (measured dump `12 1 18 7 <off> 4 768 3133440 1920 1088 17 1920 <pa>`):
  `data[0]=ints[3]`=**dmabuf fd**, `ints[7]`=size, `ints[12]`=physical address.

## 4. ★ Frame reading path (three-level fallback; level ① is verified to work)

The device **has no `/dev/mem`**, and gralloc uses **dmabuf, not ion** (`anon_inode:dmabuf` appears in `/proc/self/maps`),
so the integers in the handle cannot be treated as ion fds for mmap. But:

```c
out_fd = ((int*)ghOut)[3];                  /* = dmabuf fd */
pb = mmap(NULL, size, PROT_READ, MAP_SHARED, out_fd, 0);   /* ★ verified to work */
```
Measured: `① mmap dmabuf fd=7 size=3133440 → 0xb3cc3000 ★`

Corroborating evidence that VSP output goes through a CPU pointer rather than a physical address: `0x8140 add r1, ip, r1` (ip = the return address of mapper.lock).

## 5. ★★★ `[0x92]` = IOMMU switch — all previous experiments ran on the wrong path

**This is the most important discovery of this round.** Log-measured: `decoder original value: [0x92]=1 [0x94]=1`
— the decoder ships with **IOMMU enabled**, while historically we `force [0x92]=0` **turned it off**.

The branch in `initDecoder@0x5808`:
```
5808 ldrb r3,[r4,#0x92]
5810 cmp r3,#0
5814 beq 5950                ← [0x92]==0 → skip get_iova!
5818 ldr r1,[r4,#0x94]       ← the which parameter of get_iova
5824 bl  get_iova
5830 ldr r0,[r4,#0xa8] / 5834 bl MemoryHeapIon::getBase
5840 str r6,[r4,#0xac]       ← scratch = ION's base (not malloc)
585c str r2,[r4,#0xb4] / 5860 str r5,[r4,#0xb0]
```
The same gate is in `VSP_malloc_cb@0x6d50` plus 3 other places (in total **5** `get_iova` calls:
`0x4784`/`0x4b24`/`0x5824`/`0x6d6c`/`0x7050`).

The `[0x92]==0` branch (`0x5950`), measured:
```
5960 mov r0,#0x200000 ; bl malloc
5968 str r0,[r4,#0xac]      ← scratch = ordinary heap memory
5970 str r5,[r4,#0xb0] / 5974 str r1,[r4,#0xb4]=2MB
```
Log-measured `scratch[0xac]=0xb4a36000 [0xb0]=... [0xb4]=2097152`, matching exactly.

### ⚠ Directly restoring `[0x92]=1` will Segfault in the useBuffer segment
```
internalUseBuffer, header=0xb6d4ed70, pBuffer=0x0, size=18565 → Segmentation fault
```
⇒ Under the IOMMU path, `useBuffer` internally also needs the buffer's IOVA (via gralloc →
`MemoryHeapIon::Get_iova`), while the buffer our gralloc alloc produces is **dmabuf** (`ints[3]=fd`),
which has not gone through `ion_share`/IOVA mapping ⇒ when it cannot be obtained, it crashes.

**The next step must first solve**: establish an IOVA mapping for the gralloc-allocated buffer,
and only then can `[0x92]` be switched back to 1. Available materials:
- `libomxvpu.so` exports: `getIOMMUPhyAddr@0x33e0`, `lockAndroidBufferHandle@0x3700`,
  `getAndroidNativeBufferHandleInfo@0x3524`, `getAndroidNativeBufferInfo@0x3454`,
  `checkUseAndroidNativeBufferHeader@0x30e4`, `lockAndroidNativeBuffer@0x35c8`,
  `StoreMetaDataBuffer@0x3584`, `enableAndroidBuffer@0x3100`
- h264dec undefined symbols (we have already mocked some):
  `MemoryHeapIon::Get_iova(int,int,unsigned long*,unsigned*)`,
  `get_iova(...)`, `free_iova(int,unsigned,unsigned)`,
  `IOMMU_is_enabled(int)`,
  `SprdSimpleOMXComponent::freeOutputBufferIOVA()`
- Disassembly of `getIOMMUPhyAddr` in `libomxvpu.so` (Thumb):
  ```
  33f0 ldr r4,[r0,#0x24]        ; MemoryHeapIon object
  33f4 movs r0,#1
  33f6 blx MemoryHeapIon::IOMMU_is_enabled(int)
  33fa cbz r0, 3442             ; ==0 → return
  33fc blx gettid
  3414 ldr r2,[r4,#0x8] / 341a ldr r0,[r4,#0x12]   ; size / fd
  3434 blx MemoryHeapIon::Free_iova(int,int,int,unsigned)
  ```

## 6. ★★ Two mutually exclusive paths (deadlock discovered while wrapping up on 2026-10-08)

`0x7f04-0x7f24` and `0x84a8-0x84ec` are **two mutually exclusive** paths for feeding the VSP; only one can be taken:

**Path A: feed the full bitstream** (requires `[0x1dd]` to be set)
```
7f04 ldrb r2,[r4,#0x1dd] ; cmp #0 ; bne 7f24   ← [0x1dd]!=0 jumps directly to 7f24
7f24 vldr d0,[r5,#0x38]
7f28 ldr r3,[r4,#0x9c]                          ← ★ [0x9c] must be non-zero
7f68 beq 8518                                   ← [0x9c]==0 skips the entire copy section
7fd4-7ffc strb writes "00 00 00 01" to [0xac]
8020 bl memcpy(scratch+4, header->pBuffer, [0x9c]+4)
```
Measured: set `[0x1dd]=1` + `[0x9c]=n` → **`consume byte` = full 14527** ✓
⚠ But `[0x9c]!=0` triggers `0x83b0 strbne [0x9a]=1` → the next round's entry at `7dbc` returns directly.

**Path B: feed the SPS alone to establish the parameter set** (requires `[0x1dd]==0` and `[0x9c]==0`)
```
84a8 tst r0,#0x80 ; bne 853c          ← requires nFlags to not carry CODECONFIG
84b0 ldr r3,[r4,#0x1e4] ; cmp #0 ; beq 7f24   ← SPS length==0 skips directly
84dc ldr r8,[r4,#0x1e0]               ← SPS buffer
84e4 strb r0,[r4,#0x1f0]              ★ the vendor sets [0x1f0]=1 here
84ec b 7f24
```
Measured: without setting `[0x1dc]/[0x1dd]` → comes here → but `[0x9c]=0` blocks the copy at `7f68` → **`consume byte` stays 41**.

### Deadlock
- Path A requires `[0x9c]!=0`, but that sets `[0x9a]=1`, making the next round return.
- Path B requires `[0x9c]==0`, but then the VSP cannot get the IDR bitstream.
- `[0x1f0]=1` must be **reset every round** (`0x8314` check, then `0x8324` immediately clears it to 0).

### Already-ruled-out hypotheses (measured by A/B experiments)
- **`[0x228]` (IOVA switch) is not the key**: after `SPRD_NO_IOVA=1` forces `[0x228]=0`,
  `consume byte` is likewise the full 14527, and `frameEffective` is likewise 0. No difference from `[0x228]=1`.
- **Advancing `nOffset` will fragment the bitstream** (probe-verified): after advancing by consume byte, the scratch contents become
  `round 0=SPS / round 1=PPS bytes / round 2=IDR middle / round 3=slice` ⇒ the VSP can never see a complete SPS start.
  **must always keep `nOffset=0` + feed the full amount every round**.
- **The `mCropWidth`/`picWidth` logs never appear even once** ⇒ `handlePortSettingChangeEvent` has never been called.

### The structure of internalUseBuffer@0x4514 (it crashes here with `[0x92]=1`)
```
4654 mov r0,#0x18 ; bl operator new(24)     ; new BufferPrivateStruct(24)
465c str r5,[r0,#4]                          ; [+4] = r5(port private data)
4660 ldr r5,[r4] ; 4664 str r0,[r5,#0x24]    ; portInfo->[0x24] = the new object
4668 ldr sl,[r4] ; 466c ldr r5,[sl,#0x24]     ; read back
4670 cmp r5,#0 ; beq 4748                    ; → __android_log_assert
4678 ldrb lr,[r9,#0x90]                      ; ★ yet another switch [0x90]
467c ldr r0,[r9,#0x94] ; 4688 str r0,[r5,#0x20] ; merely stores a field, not a dereference
4684 cmp lr,#0 ; beq 46f4                     ; [0x90]==0 goes to 46f4
4690 ldr lr,[sp,#0x40] ; 4698 beq 47c0
46a4-46c8 RefBase::incStrong/decStrong       ; we have already no-op'ed it
```
Measured with `SPRD_IOMMU=1`: the log stops at `internalUseBuffer, header=..., pBuffer=0x0, size=18565`
(with `[0x92]=0`, the same position prints **twice**, once each for in/out) ⇒ it crashes inside the first useBuffer,
and **★ `Get_iova` is never printed even once** ⇒ get_iova was never even called; an earlier branch exploded.

Switch matrix (current default values = the known-working baseline):
- `SPRD_IOMMU=1` → `[0x92]=1 [0x94]=1` → Segfault in the useBuffer segment (not located)
- default (no env) → `[0x92]=0 [0x94]=0` → runs the whole process, `consume byte` full amount,
  `scratch non-zero=43/64`, but `frameEffective=0`

## 7. Current Sticking Point (next step)

The log is fixed at:
```
dec_out.frameEffective: 0, consume byte: <full 14527>, SPS:0, PPS:0
failed to get decoder information.        ← H264DecGetInfo returns empty
[0x64]/[0x68]=1920/1088 ✓  spsLen=41 ppsLen=8 ✓
[0x1e0]SPS=00 00 00 01 67 64 00 2a ...  [0x1e8]PPS=00 00 00 01 68 ee 3c b0   ✓
scratch[0..15]=00 00 00 01 67 64 00 2a ...  ✓  scratch non-zero=43/64
```

Already ruled out: `nFlags`, `[0x9c]`(alone), `[0x8c]`, `[0x1f0]`, `[0x1dc]/[0x1dd]`, port1 size,
`[0x84]/[0x9a]`, mOwnedByUs, gralloc handle, mapper.lock, `[0x228]`, nOffset advancement.

**The `mCropWidth`/`picWidth` logs never appear even once** ⇒ `handlePortSettingChangeEvent` has never been called
⇒ the VSP has never written back dimensions ⇒ `H264DecGetInfo` returns empty.

**Prime suspect (located, not fixed)**: `[0x92]` was forced to 0 by us, turning off IOMMU.
The decoder's original value is 1; when taking the IOMMU path the VSP wants **IOVA** (`MemoryHeapIon::Get_iova`),
while our `get_iova` mock returns a bare physical address `base + g_phys_bias`,
so the VSP using it to access memory will certainly fail → no frames output, `SPS:0/PPS:0`.

**Secondary suspect**: the dmabuf from gralloc has no IOVA mapping, causing a direct crash at useBuffer when `[0x92]=1`.

## 6. Build / Run

```bash
export DEV_IP=192.168.137.100 MSYS_NO_PATHCONV=1   # ★ without it, SFTP reports "not found"
python ssh_tools/dev.py --push outputs/sprd_msg.c /tmp/sprd_msg.c
python ssh_tools/dev.py "sh /tmp/smb.sh 2>&1 | grep -E 'BUILD|error:'"
python ssh_tools/dev.py "rm -f /tmp/run.log; timeout 150 /tmp/sprd_msg > /tmp/run.log 2>&1"
python ssh_tools/dev.py --get /tmp/run.log outputs/run.log
```
`smb.sh` runs itself once at the end; for a standalone run, manually redirect to save the log.
Disassembly: `python ssh_tools/dev.py "objdump -d --start-address=0x7f00 --stop-address=0x8030 /mnt/android_sys/lib/libstagefright_sprd_h264dec.so"`

## 8. ★★ IOVA Chain Breakthrough Verdict (2026-10-08 afternoon, SPRD_IOMMU=1 path)

### Already fixed (all measured)
1. **useBuffer parameter misalignment (the biggest bug of this round)**: the real signature is
   `useBuffer(this, hdr**, port, priv, size, pBuf, out**)` — the old call put pInBuf
   in the priv slot and passed 0 in the pBuf slot → internalUseBuffer's header->pBuffer=0 →
   with `[0x92]=1`, `0x477c ldr r1,[pBuffer,#12]` dereferences 0xc → SEGV.
   The old `[0x92]=0` path never touches pBuffer, so it luckily did not crash.
2. **internalUseBuffer out-port branch 4 settled** (starting at 0x4678):
   `[0x90]!=0` → treats arg6 as sp<GraphicBuffer>* and calls incStrong (passing a native_handle will certainly crash);
   `[0x90]==0 && [0x92]!=0` → ION/IOVA path 0x476c (safe): Get_iova([0x94], pBuffer[12])
   → priv->[8]=fd, priv->[12]=iova, priv->[16]=size.
   **pBuffer[12] = native_handle data[3] = dmabuf fd**.
3. **Get_iova parameter semantics**: `Get_iova(fd1_unused, fd2_real, &iova, &size)` —
   **the second parameter is the dmabuf fd** (=handle ints[3]=7), and the first is [0x94] (original value 1).
   The old mock looked up the first parameter → always failed → priv->[12] stack garbage.
4. **map_add timing**: must be registered immediately after gralloc alloc (internalUseBuffer calls Get_iova
   **inside** useBuffer; late registration = inverted timing).
5. **pBufCtrl (pointed to by this+0x48, 24B)**: [0]=phyAddr (filled by the VSP callback chain, **the IOVA managed by the VSP itself**,
   changing each run: 0xb48x0000/0xb49x0000 = dynamically allocated by the driver);
   onQueueFilled 0x805c: `[0x92]!=0 and priv->[12]==0 → fail` (0x8860 prints
   "pBufCtrl->phyAddr==0, fail"). **fail=0 has been achieved**.
6. **[0x8e]=1 is the degradation flag after openDecoder fails** (set by the vendor at 0x7d68):
   initDecoder 0x5770 checks [0x8e]!=0 → malloc scratch (skipping ION) →
   the `[0x92]=0` old path is actually the degradation path, and the VSP getting malloc'd memory is not DMA-readable → the cause of no frames.
   allocateBuffer 0x4a88 likewise checks [0x8e]/[0x8f].

### Current status (run_iova3)
- `consume byte: 41→8→14469` (SPS/PPS/IDR three-stage full consumption), `decRet: 0`,
  `pBufCtrl fail=0`, scratch has a complete SPS ✓
- **Sticking point**: `0ms` immediate return + `frameEffective:0` + `SPS:0,PPS:0` — the VSP did not really decode
- **Prime suspect**: h264dec memcpy's the bitstream to [0xac] (the ION getBase we allocated in C1),
  but the VSP reads pBufCtrl->phyAddr (**the IOVA of the bitstream
  buffer allocated by VSP_malloc_cb@0x6ba0**) — if VSP_malloc_cb allocates from **another** ION
  (not the same block as [0xac]), then CPU write/DMA read are misaligned → the VSP reads empty → 0 frames. Next step: verify the relationship between VSP_malloc_cb (0x6ba0,
  via callbacks 0x20c/0x214, writing [0x8c] at the end) return address and [0xac].
- ioctl 0xc0084906 (the truly implemented Get_phy_addr) is confirmed unsupported by the kernel; pagemap on ARM32
  cannot read out page frames (scratch_pa=0) — both paths to obtaining physical addresses are dead, but the VSP's internal IOVA is usable.

### Supplementary verdict (0x8090-0x8190 VSP DecodeFrame parameters)
- `0x8124 ldr r0,[r4,#0x48]` → **the first parameter of VSP DecodeFrame([0x208]) = pBufCtrl**
  (the VSP reads the bitstream from pBufCtrl->phyAddr; the [0xac] scratch is the CPU-side memcpy target)
- `r2 = [sp+0x54] = priv->[12] = gralloc out's iova(0xb4543000)` → the physical address where the VSP writes frames ✓
- `0x815c [0xac]` only goes into dump_strm(log), not a VSP parameter
- Verdict: the h264dec upper layer (IOVA/phyAddr/consume) is **fully connected**, and the remaining `0ms no frames` problem
  is **inside libomx_avcdec_hw_sprd.so's H264DecDecode_NALU** (believed to have no decodable data).
  Next step: disassemble H264DecDecode_NALU (or use ptrace to capture the VSP library's input pointers), and verify
  whether pBufCtrl->phyAddr truly corresponds to [0xac]'s physical (the VSP init callback chain [0x1f8] may
  be the mapping made for [0xac] — if so, the data should be reachable, and the suspicion shifts to the VSP's internal state machine).

## 9. ★★★ 2026-10-08 afternoon: hardware decoding produces an image (milestone)
> Conclusion first: **the VSP hardware has fully decoded a real 1920x1080 picture** (outputs/out_frame.png shows the TV station logo/subtitles/a face).

### Root cause chain (all empirically verified this round)
1. `read_bits` is the **VSP hardware register bitstream engine** (triggered by writing 0x60908008, read back via 0x60908010),
   not reading memory. The physical address the hardware uses to read the bitstream comes from the decoder region table.
2. **region table** = `H264Dec_MemV2P@0xbf8c`: region struct ctx+id*16, `[0x88]=pbase, [0x8c]=vbase`,
   `phys = vaddr + (pbase - vbase)`. region0 = the VSPDev internal work area (vbase=0xef58).
3. **ION real interface verdict (/dev/ion, the kernel has no IOMMU mapping interface)**:
   - ALLOC  = `0xc0144900` (20B struct {len,align,mask,flags,handle})
   - fd export = `0xc0084904` ({handle,fd}, **not 03**!)
   - FREE   = `0xc0044901`
   - PHYS   = `ION_IOC_CUSTOM 0xc0084906`, arg={cmd=0, arg=&{int fd; ulong phys; uint size}}
     → real physical address (e.g. 0x9f800000). **Only allocations with heap mask=8 can be queried** (mask 2/4 return EINVAL)
   - cmd9(get_iova) **does not exist in the kernel** (all 1024 combinations scanned return EINVAL) → the IOMMU path is a dead end,
     **we must use physical addresses** (the VSP has no independent MMU; phys=bus address)
   - ⚠ cmd=1 will SEGV-kill the process; only ever call cmd=0
4. Root cause of the historical failure: the mock Get_iova returned a CPU virtual address (0xb4xxxxxx) as the physical address →
   the VSP DMA read garbage → NAL parsing failed (profile_idc INVALID) or a fake completion.
   [0x92] default changed back to 1 (the factory value); combined with cmd0's real query, the chain is fully connected.
5. **Output buffers must be self-managed ION** (heap 8): gralloc.sc8830 allocates from the IOMMU heap
   (with no physically contiguous backing) → cmd0 cannot query it → only a fake address can be given → VSP frame writes fail.
   Self-managed ION + fake gralloc handle (copying the real handle's magic fields fh[0..2],[4..6],
   replacing fd[3]/size[7]/base[12], otherwise mapper.lock reports "Locking invalid buffer").
   **4 output buffers** (required for DPB reference frames; with 1, you get -9 missing frame buffer).
6. Key register verdict: each round H264DecDecode writes 0x8000=len|0x80000000, 0x8004=acc|0xc0000000,
   0x8008=6, 0x1060/0x1064=dataLen>>3, and the sentinel f4 68 28 f1 is written to pStream[cap..cap+3];
   0x8034=this round's hardware consumption, VSPDev+0x984=cumulative. acc>=total → skip NALU and return directly
   (after the real PA fix, the consumption pattern changes to 4-byte start code + read_bits software parsing).
7. `vsp_read_reg_poll@0x12a10` (inside libomx) returns 0=success; the hook uses a **GOT patch**
   (lib_base+0x1de90); intercepting the same-named exported symbol does not work (bionic hits itself first).
   ⚠ reading registers inside the hook must be done within a VSP session (polling at 0x8018); reading after empty returns will certainly crash
   (VSP_RELEASE_Dev has already released).

### Behavior when producing an image
- SPS round decRet=-9 (2ms, SPS:1 PPS:0, reports PortSettingChange 1920x1088 ✓)
- IDR round decRet=-7 (35-44ms of real decoding! "failed to decode video frame, hardware error"
  is a **non-fatal** status bit, error_flag=0x8; the frame has actually been written to the output buffer)
- Y plane 93.5% non-zero, U 97%, V 89%; the picture is completely correct
- The disk-write verdict does not rely on the OMX header's echo (nFilledLen is unreliable); judge directly by the YUV non-zero ratio
- The probe's trailing RC=139 (Segfault) is a pre-existing bug in the wrap-up phase and does not affect image production

### Remaining work
- ① Confirm rotation of frames landing in different out buffers each round (4 paths already registered)
- ② Frame geometry green band: cut on disk by stride*1088 layout (currently cut by 1080, causing chroma misalignment)
- ③ VPP/FBIOPAN display integration + nettv_page
- ④ Submit and push

## 10. ★★★ 2026-10-08 evening: continuous multi-frame decoding connected
- **All 8/8 rounds truly decoded** (33-37ms/frame ≈ 28fps capability), writing frames to disk one by one as /tmp/frame_NN.yuv (0x2FC000 raw NV12).
- **The component's [this_d+0x92] default changed to 0** (key): the fail branch (dec.asm 0x8064→0x8860 prints "pBufCtrl->phyAddr==0,fail")
  only triggers when [0x92]!=0 and priv[12]==0; when =0, onQueueFilled takes Get_phy_addr_from_ion(mock=ion_phys cmd0)
  → the self-managed ION path gets the real PA, while the gralloc path has [12]=0 but does not block the process. The VSPDev internal IOMMU switch is a different byte and is unaffected.
- **Memory budget verdict**: the continuous pool is only ~2x3MB. Grabbing 2 paths or 1 path early (at the start of main) → the component's internal DPB allocation fails
  (decRet=-3 "failed to allocate memory" → auto-switch to software decoding → total wipeout). **The successful configuration = no early grabbing at all,
  the component takes memory first, out[0] is allocated after init with try_sz{0x320000,0x300000,0x400000}, out[1..3] uses gralloc**.
- Pitfalls during rotation (all fixed in the probe):
  - The VSPDev ctx (pBufCtrl->[0]) is cleared to 0 after round 0's VSP_RELEASE → restore it before each empty (g_vspdev0)
  - The out header's priv(+0x24)->[12] may be 0 → scan every round; fd is taken from header->pBuffer ints[3] (priv[8] is unreliable)
  - The OMX out header never echoes nFilledLen (drain only sends empty frames) → the frame output verdict must be based on memory contents (Y sparsely-sampled non-zero)
  - All 8 rounds FilledDone on the same h (the component always picks the first empty out) → the picture is continuously written into out[0]'s ION
- Remaining: the error_flag=0x8 status bit is non-fatal (decRet=-7 but the frame is correct); the current test is repeated decoding of the same IDR slice,
  continuous playback requires streaming per-AU feeding (to be done during nettv integration).
- Next step: VPP/FBIOPAN display (YUV→RGB or direct NV12 tile? format needs checking) + nettv_page integration + submit and push.

## 11. ★★★ 2026-10-08 evening: real-stream NAL streaming hardware decoding connected (about 95%)
> es_fix.h264 (5.2MB live ES, 1016 AU / 333 valid NAL) continuously streams-decoded 82-103 frames with decRet=0.

### Feeding model verdict
- **The VSP consumes only one NAL per empty** (verified: when AU=[AUD+slice], consume=6 eats only the AUD;
  the garbage NAL (type0) at the file head blocks in front of the first one → the IDR cannot get in → needIVOP=1 → all frames are dropped).
- **The feeding unit = a single NAL** (type 1/5/6/7/8; skip type 0 garbage and type 9 AUD).
  Consistent with the successful path of the config segment (one empty each for SPS/PPS/IDR).
- An in buffer of 32KB is sufficient (largest measured NAL is 23918B); 1MB would crowd out the CMA pool and trigger -3 early.

### ★ error_flag/Need I frame deadlock chain (disassembly verdict, libomx_avcdec_hw_sprd.so)
1. Inside a NALU, 0x11724 bl VSP_POLL_COMPLETE → return value int_ret
2. 0x11738 `ands r3,r0,#1`: **bit0=1 → [H264Dec ctx+0xc] |= 8** (0x11750)
3. At the NALU tail, 0x11884 checks [0xc]!=0 → 976 lines of "error_flag=0x8" log + return (decRet=-7)
4. **The next NAL comes in; 0x10e38 checks [r4+0xc]!=0 → 886 lines of "Need I frame!" → return -1** (upper layer -5 stream error)
   → although the IDR produces an image, error_flag pollutes the ctx, and all subsequent P frames are blocked.
5. IDR logs constantly show `VSP_POLL_COMPLETE int_ret: 1` (the hardware reports bit0 every round).
- **Fix**: GOT patch VSP_POLL_COMPLETE (GOT 0x1dfa0, symbol@0x12800),
  in the hook `r &= ~1` suppresses bit0 → the process takes the 0x118cc "normal completion" path → error_flag is no longer set.
- Effect: IDR/P frames decRet=0, needIVOP=0, 14-20ms/frame (1080p ≈ 50-70fps capability).

### Memory ledger (CMA pool ~7MB, hid=0 area starting at 0x9fd20000, contiguous linear allocation)
- out[0] self-managed ION 3.2MB (mask8 area 0x9fa00000) + in 32KB + mbinfo 5x653824=3.2MB ≈ full
- **mbinfo idx 0,1,2,... allocates 653824B incrementally every ~2 frames and is never freed** (component behavior)
- C1 LRU reuse (C1_REUSE_MAX=5) is written but not yet triggered; when the pool fills → decRet=-3 → the component switches to software decoding and total wipeout
- ⚠ **Taboo**: allocating mbinfo with a bare mask8 (the same area as out[0]) → VSP DMA writes that area → **kernel panic and device reboot**.
  C1 allocations can only use hid=0.

### Remaining bad frames (the only remaining problem, about 1/3 of frames)
- Pattern: intermittent (7 good frames → 1 bad → 3 good → 2 bad → 9 good → 4 bad...), chroma all 0 (U-mean=0) + scrambled Y macroblocks.
- Root cause: out[1..3] are gralloc (IOMMU heap) — cmd0(0xc0084906) and 0xc008602a both fail to find the real PA
  → the VSP DPB reference writes to an invalid address → P frame reference scrambling. When the reference happens to use out[0], the frame is perfect (frame_00/05).
- Solution direction: replace out[1..3] with memory whose PA can be queried (the pool cannot fit 3x3.2MB) → mbinfo needs to leave the pool (bare mask8 crashes are not viable)
  or lower the VSP output resolution (1280x720 → 1.4MB per out, 2 ION paths 2.8+mbinfo 3.2+in ≈ 6.5MB is viable, to be verified)
- Verification tool: U channel mean (starting at offset 1920*1088, >40=good frame); yuv2png.py (NV12 stride1088 image cutting)

### Engineering miscellany
- Add to compilation `-Wl,-l:libion.so -Wl,-l:libhardware.so` (ion_open/ion_alloc/hw_get_module)
- musl headers redirect gettimeofday/clock_gettime to __*_time64 (which bionic lacks) → bare `syscall(78,&tv,0)` to get milliseconds
- Killing residual probes: match cmdline with `/tmp/sprd_msg*` — a loose match on "sprd_msg" will hit bash itself (stepped on before)
- Deduplication on disk-write: Y sparsely-sampled DJB2 signature; do not write to disk again if the picture has not changed

## 12. ★★★ 2026-10-08 evening 2: fb direct display connected (about 97%)
### Remaining bad frames verdict (important reversal)
- Local ffmpeg(OpenCV) decoding the same es_fix.h264: **likewise reports a bunch of "error while decoding MB ... bytestream -5"**
  + "non-existing PPS 2" → **the source stream itself has packet-loss damage** (lost during network capture), not a VSP defect.
  ffmpeg erroneously masks it (copying neighboring MBs), so no black chroma frames; the VSP's concealment strategy is worse → garbled screen + chroma 0.
  The bad frame positions are byte-for-byte identical across runs (deterministic) = a stream-damage signature independent of memory configuration.
  → During live-stream integration this counts as normal network damage; the VSP pipeline needs no further fixing.
- Also fixed: mbinfo PA — in C1, after 0xc008602a fails, append cmd0(0xc0084906) as a fallback; all 6 mbinfo get real PAs.

### fb direct display pipeline (fb_init/fb_render/fb_home inside sprd_msg.c)
```
out[0] NV12 1920x1088
  → pass1: sequential NV12→ARGB (yuv2px BT.601, byte order [R,G,B,X])
  → pass2a: 16x16 block transpose + horizontal mirror → targb[c*1080+(1079-r)] = argb[r*1920+c]
  → pass2b: targb sequential rows, 3/2 NN sampling → fb page (720x1280)
  → FBIOPAN double pages 1/2 alternating
```
- ★ CW rotation verdict: out[oy][ox] = in[row=1079-ox*3/2, col=oy*3/2]
  (the station logo lands top-right, text rotated 90° clockwise, consistent with the direction of LVGL rotation 900)
- ★★ FBIOPAN must use the real fb_var_screeninfo: FBIOGET_VSCREENINFO → change yoffset → FBIOPAN_DISPLAY.
  **A homemade 24-byte short struct = copy_from_user half-copy → residual garbage yoffset on the kernel stack → the DPU DMA fetches an illegal address
  → kernel panic and device reboot (already stepped on; do not repeat)**
- fb0: 720x1280x4, yres_virtual=3840(3 pages), stride 2880; argb/targb each malloc 8.3MB (ordinary memory, not CMA)
- Performance: pass1 ~6ms + transpose ~5ms + pass2b ~3ms ≈ 15ms/frame, parallel with the VSP decode's 15ms, enough for 25fps
- Verification methodology: capturing the screen with grab_screen during continuous rendering showing stripes = an artifact of slow capture (second-level) mixing frames with 30ms/frame rendering;
  freeze the first frame (render only 1 frame) then capture = 0.821 non-black clean picture. Real-machine visual inspection is the gold standard.
- fbtest.c(direct mapping)/fbtest2p.c(2-pass) independent verification tools; es_check.py local cv2 software decode comparison tool;
  grab_screen.py has been changed to read the DEV_IP environment variable.
- Stop the desktop: kill $(pidof lvgl_watchdog) with comm prefix /lvgl/ awk matching (comm truncated to 15 characters);
  restore: sh /etc/local.d/00_lvgl_demo.start

### Remaining work
① Player binary: curl real-time stream → demux ES → loop this pipeline (replacing file reading)
② nettv_page.c integration: bring it up following the psp_game_page pattern of pausing LVGL+interceptor
③ Submit and push (device repo bundle relay)

## 13. ★★★ 2026-10-08 evening 3: player binary complete (about 98%)
### Player usage (sprd_msg is now player-ized)
```
/tmp/sprd_msg                    # probe mode (old behavior)
/tmp/sprd_msg /path/es.h264      # loop-play a file, exit on SIGTERM
/tmp/sprd_msg http://x/y.ts      # curl 25s download→play→download again (live continuation)
/tmp/sprd_msg <src> <N>          # play N frames then exit automatically (0/missing=infinite)
```
- Parameters are passed via /proc/self/cmdline (no crt0, so argc/argv cannot be used)
- load_chunk(): URL→curl download /tmp/nettv.es→re-cut NAL table→chunk loop reentry (config is not redone)

### Performance localization methodology and conclusions (@ms timestamp step-by-step elimination)
| Experiment | Frame Rate | Conclusion |
|---|---|---|
| baseline | 2.8s/frame | slow |
| no disk write | 3s/frame | disk write is not the bottleneck |
| /dev/null | - | logging is not the bottleneck (500KB) |
| DRIVE usleep 120ms→stepped | 1.3s/frame | per NAL x 120ms is one of the big ones |
| no-pan | unchanged | pan is not the bottleneck |
| no-fb_render | 30ms/NAL ★ | **fb_render ~550ms/frame** |
- fb_render hotspot = pass2a transpose tb[c*1080+..] column-jump writes (one cache line per 4B, 128MB of traffic)
  → fix: read 16x16 tiles into a local array, write contiguously on fixed output rows → 75ms/frame (13fps)
- DRIVE delay stepping: slice(t=1/5) 20ms / SPS/PPS/SEI 2ms / refill 1ms (global g_drive_ms)
- The front section's 570ms every 2 frames = mbinfo idx 0-4's real allocation period (disappears after LRU), steady state 50-75ms/frame

### ★★ Two kernel panics (same root cause)
Running the fast version (75ms/frame) to completion then **exiting immediately** → the VSP queue still has DMA → process exit → the kernel ion driver
reclaims the dmabuf → VSP DMA writes to freed pages → kernel panic and reboot. Fix = usleep(800000) to drain before exit.
The -O3 -mfpu=neon build likewise panics during exit (not NEON's fault), **disable -O3** and keep -O2.
Also: the slow version (2.8s/frame) never panicked — because the buffers naturally persisted.

### ★ mbinfo OOM forces fallback to LRU
C1 allocation fails (rc!=0) && size==653824 && g_c1r_n>0 → directly reuse the earliest slot (the old condition
g_c1r_n>=MAX(5) could never be met — the 5th block already hits ENOMEM). Effect: the component no longer switches to software decoding with -3
(mDecoderSwFlag:1 disappears from then on), decRet:-9 drops from 137 to 12.

### Accidents and lessons
- A local python script's `open(p,'w').write()` throws an exception before write → **sprd_msg.c was emptied**.
  The device's /tmp/sprd_msg.c is the latest backup source (every push uploads it in full) → --get pulls it back for recovery.
  Lesson: batch replacement scripts should write to a temp file first and then rename, or use the Edit tool.

### Remaining (user participation required)
- nettv_page.c integration (bring up /tmp/sprd_msg URL, following the psp_game_page pattern of pausing LVGL mode)
- Submit and push (device repo bundle relay, GITEE_TOKEN required)

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
