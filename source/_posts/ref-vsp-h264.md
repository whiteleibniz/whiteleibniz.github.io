---
title: "ref_h264硬解_h264dec定案"
date: 2026-10-08 19:08:38
lang: zh-CN
search: true
categories:
- 多媒体与模拟器
- VSP硬解
tag:
- VSP
- 硬解
- H264
---


# SC8830 硬解攻关 — h264dec 反汇编定案（2026-10-08）

> 本机工作区不是 git 仓库；代码在设备 `/tmp/sprd_msg.c`，构建脚本 `/tmp/smb.sh`。
> 全部结论来自 `objdump -d /mnt/android_sys/lib/libstagefright_sprd_h264dec.so`。

## 一、onQueueFilled 真实体（`0x7cec` 起）的完整闸门链

```
7d78 ldr ip,[r4,#0x9c] ; cmp #0 ; bne 84f0    ← 入口: [0x9c]!=0 走 84f0
7d7c-7d88 bl initDecoder / freeOutputBufferIOVA
7da4 bl getPortQueue(0) → [sp+0x34]   (in 队列)
7db4 bl getPortQueue(1) → sl          (out 队列)
7dbc ldrb r8,[r4,#0x9a] ; cmp #0 ; bne 83dc   ★ [0x9a]!=0 → 直接 return
7dc8 ldr r5,[r4,#0x84] ; cmp #0 ; bne 7de8   ← [0x84]!=0 强制进解码区
7dd4 ldr fp,[r2,#4] / 7de4 beq 83dc           ← in 队列空 → return
7de8 ldr r8,[sl,#4] / 7df4 beq 83dc           ★ out 队列空 → return
7df8 cmp r5,#1 ; beq 8718                     ← [0x84]==1 走 drainAllOutputBuffers
```

### 字段语义总表（★ 都是踩过坑定案的）

| 字段 | 语义 | 写入者 |
|---|---|---|
| `[0x84]` | 解码开关。`!=0` 强制进解码区；`==1` 额外走 8718 drainAllOutputBuffers | `0x7ee0` (nFlags&1)、跑完变 2 |
| `[0x88]` | 端口尺寸变更待处理闸门（非 0 直接 return） | handlePortSettingChangeEvent |
| `[0x8c]` | 内部 drain 循环开关。`0x83c4 ldrb; cmp #0; bne 8334` | 手动置 1 可打开 |
| `[0x9a]` | **停止标志**。非 0 → 入口 7dbc 直接 return | `0x83b0`（`[0x9c]!=0` 时自动置 1）|
| `[0x9c]` | 待处理字节数。`0x7f68 beq 8518` = 跳过 scratch 拷贝 | ★**不要手动置**，见下 |
| `[0x1dc]` | SPS 已落位标志 | `0x8240`（VSP 回填 `[sp+0xa4]`）|
| `[0x1dd]` | PPS 已落位标志 | `0x8248`（VSP 回填 `[sp+0xa5]`）|
| `[0x1e0]/[0x1e4]` | SPS 缓冲 / 长度（长度上限 1024，`cmp #0x400`）| `0x7ccc` |
| `[0x1e8]/[0x1ec]` | PPS 缓冲 / 长度（同上限）| `0x7ca4` |
| `[0x1f0]` | **出帧总闸，一次性**。`0x8314 ldrb; beq 85fc` | `0x8710`，且 `0x8324` 用完立即清 0 |
| `[0x228]` | IOVA/gbMapper 通路。`!=0` → `0x8254 bne 85c0` 走 IOVA 分支 | setParameter(port1) |
| `[0x234]/[0x238]` | crop w/h（日志首行 1920/1088）。`0x82d0/0x82e4` 与 scratch 位置比较，不匹配跳 `87a8` | SPS 解析 |
| `[0x64]/[0x68]` | VSP 侧输出 w/h | handlePortSettingChangeEvent |
| `[0xac]/[0xb0]/[0xb4]` | VSP scratch(1MB malloc) / 写指针 / 长度 | initDecoder |
| `[0x208]` | VSP DecodeFrame 函数指针 | — |

## 二、★ 三个反效果的手动干预（都试过并回退，勿重犯）

### 1. 手动置 `[0x9c]` —— 会堵死循环
```
839c ldr r0,[r4,#0x9c] ; cmp #0
83b0 strbne r2,[r4,#0x9a]    ★ [0x9c]!=0 → [0x9a]=1
7dbc ldrb r8,[r4,#0x9a] ; bne 83dc  ← 下轮入口直接 return
```
`[0x9c]` 必须留给厂商自己维护。实测置 `[0x1f0]=1` 后 `consume byte` 从恒 41 变成全字节数。

### 2. 手动置 `[0x1f0]` 有效，但**每轮都要重置**
- `0x7f04 ldrb [0x1dd] ; bne 7f24` → `7f10 tst r0,#0x80 ; bne 853c`
  投 config 带 `OMX_BF_CODECONFIG(0x80)` ⇒ 永远走 853c ⇒ 到不了 `7f18 → 86e4 → 8710` ⇒ 厂商永不置 `[0x1f0]`。
- 兜底置 1 = 等效补做 8710。**效果已验证**：`consume byte` 41 → 14527/14482/14474/14465（全量）。
- 但 `0x8314` 检查后 `0x8324 strb r0,[0x1f0]` 立即清 0 ⇒ 流式循环**每轮都要重置**。

### 3. 同一个 in buffer 二次 empty 会 ASSERT
```
##### ASSERT #####
[!(!buffer->mOwnedByUs)]  [SprdSimpleOMXComponent]
```
`mOwnedByUs=1` 表示所有权已归组件；正常由 EmptyBufferDone 回调清 0，我们无 looper ⇒ 每次 empty 前必须 `set_owned(hdr, 0)`。

## 三、gralloc / handle 三层布局（全部实测定案）

- **`alloc` 真实签名只有 7 参**：`int alloc(dev,w,h,format,usage,native_handle_t**,int*stride)`
  按 AOSP 10 参调用时第 6 参字面量 0 落到 `handle**` → `0x2192 cmp r9,#0; beq 0x244a` → `mvn r4,#21` = **-22**。这是历史上 gralloc alloc 全失败的真因。
- **format 白名单**：`1 2 3 4 5 / 17(YCbCr_420_SP) / 19 20 21 / 33 34 35` + 字面量 `0x32315659`("YV12")。
  实测 `fmt=17, usage=0x300(HW_TEXTURE|HW_RENDER)` 一次成功，`stride=1920`。
  ⚠ `usage & 0x1000` 且 w,h>1 会绕去 framebuffer 路径（`0x22ba`）首调必失败。
- **`hw_module_t`**：`+0x00`=0x48574d54("HMW")、`+0x04`=1、`+0x08..0x18`=register[0..4]、`+0x80..0x8c`=perform[0..3]。
- **`alloc_device_t`**：`+0x00`=0x48574454("HWAT")、`+0x08`=module、`+0x3c`=name、`+0x40`=alloc、`+0x44`=free、`+0xcc`=ion_fd。
  ⚠ `+0x40` **直接就是函数指针**（不是指针的指针，多解一层必崩）。
- **`native_handle`**（实测 dump `12 1 18 7 <off> 4 768 3133440 1920 1088 17 1920 <pa>`）：
  `data[0]=ints[3]`=**dmabuf fd**、`ints[7]`=size、`ints[12]`=物理地址。

## 四、★ 读帧路径（三级回退，第①级已验证成功）

设备**没有 `/dev/mem`**，gralloc 用 **dmabuf 不是 ion**（`/proc/self/maps` 出现 `anon_inode:dmabuf`），
所以 handle 里的整数不能当 ion fd mmap。但：

```c
out_fd = ((int*)ghOut)[3];                  /* = dmabuf fd */
pb = mmap(NULL, size, PROT_READ, MAP_SHARED, out_fd, 0);   /* ★ 实测成功 */
```
实测：`① mmap dmabuf fd=7 size=3133440 → 0xb3cc3000 ★`

佐证 VSP 输出走 CPU 指针而非物理地址：`0x8140 add r1, ip, r1`（ip = mapper.lock 的返回地址）。

## 五、★★★ `[0x92]` = IOMMU 开关 —— 之前所有实验都跑在错误路径上

**这是本轮最重要的发现。** 日志实测：`解码器原值: [0x92]=1 [0x94]=1`
—— 解码器出厂就是 **IOMMU 开启**，而我们历史上 `force [0x92]=0` 把它**关掉了**。

`initDecoder@0x5808` 的分岔：
```
5808 ldrb r3,[r4,#0x92]
5810 cmp r3,#0
5814 beq 5950                ← [0x92]==0 → 跳过 get_iova!
5818 ldr r1,[r4,#0x94]       ← get_iova 的 which 参数
5824 bl  get_iova
5830 ldr r0,[r4,#0xa8] / 5834 bl MemoryHeapIon::getBase
5840 str r6,[r4,#0xac]       ← scratch = ION 的 base(不是 malloc)
585c str r2,[r4,#0xb4] / 5860 str r5,[r4,#0xb0]
```
同样的闸门在 `VSP_malloc_cb@0x6d50` + 另外 3 处（共 **5 处** `get_iova` 调用：
`0x4784`/`0x4b24`/`0x5824`/`0x6d6c`/`0x7050`）。

`[0x92]==0` 分支（`0x5950`）实测：
```
5960 mov r0,#0x200000 ; bl malloc
5968 str r0,[r4,#0xac]      ← scratch = 普通堆内存
5970 str r5,[r4,#0xb0] / 5974 str r1,[r4,#0xb4]=2MB
```
日志实测 `scratch[0xac]=0xb4a36000 [0xb0]=... [0xb4]=2097152` 完全吻合。

### ⚠ 直接恢复 `[0x92]=1` 会在 useBuffer 段 Segfault
```
internalUseBuffer, header=0xb6d4ed70, pBuffer=0x0, size=18565 → Segmentation fault
```
⇒ IOMMU 路径下 `useBuffer` 内部还要拿 buffer 的 IOVA（走 gralloc →
`MemoryHeapIon::Get_iova`），而我们的 gralloc alloc 出的是 **dmabuf**（`ints[3]=fd`），
没经过 `ion_share`/IOVA 映射 ⇒ 拿不到就崩。

**下一步必须先解决**：给 gralloc 分配的 buffer 建立 IOVA 映射，
然后才能把 `[0x92]` 切回 1。可用素材：
- `libomxvpu.so` 导出：`getIOMMUPhyAddr@0x33e0`、`lockAndroidBufferHandle@0x3700`、
  `getAndroidNativeBufferHandleInfo@0x3524`、`getAndroidNativeBufferInfo@0x3454`、
  `checkUseAndroidNativeBufferHeader@0x30e4`、`lockAndroidNativeBuffer@0x35c8`、
  `StoreMetaDataBuffer@0x3584`、`enableAndroidBuffer@0x3100`
- h264dec 未定义符号（我们已 mock 了一部分）：
  `MemoryHeapIon::Get_iova(int,int,unsigned long*,unsigned*)`、
  `get_iova(...)`、`free_iova(int,unsigned,unsigned)`、
  `IOMMU_is_enabled(int)`、
  `SprdSimpleOMXComponent::freeOutputBufferIOVA()`
- `libomxvpu.so` 里 `getIOMMUPhyAddr` 反汇编（Thumb）：
  ```
  33f0 ldr r4,[r0,#0x24]        ; MemoryHeapIon 对象
  33f4 movs r0,#1
  33f6 blx MemoryHeapIon::IOMMU_is_enabled(int)
  33fa cbz r0, 3442             ; ==0 → 返回
  33fc blx gettid
  3414 ldr r2,[r4,#0x8] / 341a ldr r0,[r4,#0x12]   ; size / fd
  3434 blx MemoryHeapIon::Free_iova(int,int,int,unsigned)
  ```

## 六、★★ 两条互斥路径（2026-10-08 收尾发现的死结）

`0x7f04-0x7f24` 与 `0x84a8-0x84ec` 是**两条互斥**的送 VSP 路径，只能走一条：

**路径 A：送全量码流**（需 `[0x1dd]` 已置位）
```
7f04 ldrb r2,[r4,#0x1dd] ; cmp #0 ; bne 7f24   ← [0x1dd]!=0 直接跳 7f24
7f24 vldr d0,[r5,#0x38]
7f28 ldr r3,[r4,#0x9c]                          ← ★ [0x9c] 必须非 0
7f68 beq 8518                                   ← [0x9c]==0 跳过整段拷贝
7fd4-7ffc strb 写 "00 00 00 01" 到 [0xac]
8020 bl memcpy(scratch+4, header->pBuffer, [0x9c]+4)
```
实测：置 `[0x1dd]=1` + `[0x9c]=n` → **`consume byte` = 全量 14527** ✓
⚠ 但 `[0x9c]!=0` 会触发 `0x83b0 strbne [0x9a]=1` → 入口 `7dbc` 下轮直接 return。

**路径 B：单独送 SPS 建参数集**（需 `[0x1dd]==0` 且 `[0x9c]==0`）
```
84a8 tst r0,#0x80 ; bne 853c          ← 要求 nFlags 不带 CODECONFIG
84b0 ldr r3,[r4,#0x1e4] ; cmp #0 ; beq 7f24   ← SPS长度==0 直接跳过
84dc ldr r8,[r4,#0x1e0]               ← SPS 缓冲
84e4 strb r0,[r4,#0x1f0]              ★ 厂商在这里置 [0x1f0]=1
84ec b 7f24
```
实测：不置 `[0x1dc]/[0x1dd]` → 走这里 → 但 `[0x9c]=0` 在 `7f68` 挡拷贝 → **`consume byte` 恒 41**。

### 死结
- 走 A 需要 `[0x9c]!=0`，但那会置 `[0x9a]=1` 让下轮 return。
- 走 B 需要 `[0x9c]==0`，但那样 VSP 拿不到 IDR 码流。
- `[0x1f0]=1` 必须**每轮重置**（`0x8314` 检查后 `0x8324` 立即清 0）。

### 已排除的假设（A/B 实验实测）
- **`[0x228]`（IOVA 开关）不是关键**：`SPRD_NO_IOVA=1` 强制 `[0x228]=0` 后，
  `consume byte` 同样是全量 14527，`frameEffective` 同样 0。与 `[0x228]=1` 无差别。
- **`nOffset` 推进会把码流切碎**（探针实证）：按 consume byte 推进后 scratch 内容变成
  `轮0=SPS / 轮1=PPS字节 / 轮2=IDR中段 / 轮3=切片` ⇒ VSP 永远看不到完整 SPS 开头。
  **必须恒 `nOffset=0` + 每轮投全量**。
- **`mCropWidth`/`picWidth` 日志一次都没出现** ⇒ `handlePortSettingChangeEvent` 从未被调用。

### internalUseBuffer@0x4514 的结构（`[0x92]=1` 崩在这里）
```
4654 mov r0,#0x18 ; bl operator new(24)     ; new BufferPrivateStruct(24)
465c str r5,[r0,#4]                          ; [+4] = r5(端口私有数据)
4660 ldr r5,[r4] ; 4664 str r0,[r5,#0x24]    ; portInfo->[0x24] = 新对象
4668 ldr sl,[r4] ; 466c ldr r5,[sl,#0x24]     ; 读回
4670 cmp r5,#0 ; beq 4748                    ; → __android_log_assert
4678 ldrb lr,[r9,#0x90]                      ; ★ 又一个开关 [0x90]
467c ldr r0,[r9,#0x94] ; 4688 str r0,[r5,#0x20] ; 只是存字段, 不是解引用
4684 cmp lr,#0 ; beq 46f4                     ; [0x90]==0 走 46f4
4690 ldr lr,[sp,#0x40] ; 4698 beq 47c0
46a4-46c8 RefBase::incStrong/decStrong       ; 我们已 no-op 掉
```
实测 `SPRD_IOMMU=1` 时：日志停在 `internalUseBuffer, header=..., pBuffer=0x0, size=18565`
（`[0x92]=0` 时同一位置会打**两次**，in/out 各一次）⇒ 崩在第一次 useBuffer 内部，
且**`★ Get_iova` 一次都没打印** ⇒ 根本没调到 get_iova，是更早的分支就炸了。

开关矩阵（当前默认值 = 已知可跑通的基线）：
- `SPRD_IOMMU=1` → `[0x92]=1 [0x94]=1` → useBuffer 段 Segfault（未定位）
- 默认（无 env） → `[0x92]=0 [0x94]=0` → 跑完全流程，`consume byte` 全量，
  `scratch非零=43/64`，但 `frameEffective=0`

## 七、当前卡点（下一步）

日志固定为：
```
dec_out.frameEffective: 0, consume byte: <全量 14527>, SPS:0, PPS:0
failed to get decoder information.        ← H264DecGetInfo 返回空
[0x64]/[0x68]=1920/1088 ✓  spsLen=41 ppsLen=8 ✓
[0x1e0]SPS=00 00 00 01 67 64 00 2a ...  [0x1e8]PPS=00 00 00 01 68 ee 3c b0  ✓
scratch[0..15]=00 00 00 01 67 64 00 2a ...  ✓  scratch非零=43/64
```

已排除：`nFlags`、`[0x9c]`(单独)、`[0x8c]`、`[0x1f0]`、`[0x1dc]/[0x1dd]`、port1 尺寸、
`[0x84]/[0x9a]`、mOwnedByUs、gralloc handle、mapper.lock、`[0x228]`、nOffset 推进。

**`mCropWidth`/`picWidth` 日志一次都没出现** ⇒ `handlePortSettingChangeEvent` 从未被调用
⇒ VSP 从没回填尺寸 ⇒ `H264DecGetInfo` 返回空。

**头号嫌疑（已定位，未修）**：`[0x92]` 被我们强制成 0 关掉了 IOMMU。
解码器原值是 1，走 IOMMU 时 VSP 要的是 **IOVA**（`MemoryHeapIon::Get_iova`），
而我们的 `get_iova` mock 返回的是裸物理地址 `base + g_phys_bias`，
VSP 用它访问内存必然失败 → 不出帧、`SPS:0/PPS:0`。

**次号嫌疑**：gralloc 出来的 dmabuf 没有 IOVA 映射，导致 `[0x92]=1` 时 useBuffer 直接崩。

## 六、构建/运行

```bash
export DEV_IP=192.168.137.100 MSYS_NO_PATHCONV=1   # ★ 不加会 SFTP 报不存在
python ssh_tools/dev.py --push outputs/sprd_msg.c /tmp/sprd_msg.c
python ssh_tools/dev.py "sh /tmp/smb.sh 2>&1 | grep -E 'BUILD|error:'"
python ssh_tools/dev.py "rm -f /tmp/run.log; timeout 150 /tmp/sprd_msg > /tmp/run.log 2>&1"
python ssh_tools/dev.py --get /tmp/run.log outputs/run.log
```
`smb.sh` 末尾会自己跑一遍；单独跑要手动重定向存日志。
反汇编：`python ssh_tools/dev.py "objdump -d --start-address=0x7f00 --stop-address=0x8030 /mnt/android_sys/lib/libstagefright_sprd_h264dec.so"`

## 八、★★ IOVA 链路攻坚定案（2026-10-08 下午，SPRD_IOMMU=1 路径）

### 已修复（全部实测）
1. **useBuffer 参数错位（本轮最大 bug）**：真实签名
   `useBuffer(this, hdr**, port, priv, size, pBuf, out**)`——旧调用把 pInBuf
   放 priv 槽、pBuf 槽传 0 → internalUseBuffer 的 header->pBuffer=0 →
   [0x92]=1 时 `0x477c ldr r1,[pBuffer,#12]` 解引用 0xc → SEGV。
   旧 [0x92]=0 路径不碰 pBuffer 所以侥幸不崩。
2. **internalUseBuffer out 端口 4 分支定案**（0x4678 起）：
   `[0x90]!=0` → 把 arg6 当 sp<GraphicBuffer>* 做 incStrong（传 native_handle 必崩）；
   `[0x90]==0 && [0x92]!=0` → ION/IOVA 路径 0x476c（安全）：Get_iova([0x94], pBuffer[12])
   → priv->[8]=fd, priv->[12]=iova, priv->[16]=size。
   **pBuffer[12] = native_handle data[3] = dmabuf fd**。
3. **Get_iova 参数语义**：`Get_iova(fd1_unused, fd2_real, &iova, &size)` ——
   **第二个参数才是 dmabuf fd**（=handle ints[3]=7），第一个是 [0x94]（原值 1）。
   旧 mock 用第一参查表 → 恒失败 → priv->[12] 栈垃圾。
4. **map_add 时序**：必须在 gralloc alloc 后立即登记（internalUseBuffer 在
   useBuffer **内部**调 Get_iova，晚登记=时序倒挂）。
5. **pBufCtrl（this+0x48 指向，24B）**：[0]=phyAddr（VSP 回调链填，**VSP 自己
   管理的 IOVA**，每次运行变化 0xb48x0000/0xb49x0000 = 驱动动态分配）；
   onQueueFilled 0x805c：`[0x92]!=0 且 priv->[12]==0 → fail`（0x8860 打
   "pBufCtrl->phyAddr==0, fail"）。**fail=0 已达成**。
6. **[0x8e]=1 是 openDecoder 失败后的降级标志**（0x7d68 厂商置位）：
   initDecoder 0x5770 查 [0x8e]!=0 → malloc scratch（跳过 ION）→
   [0x92]=0 旧路径实为降级路径，VSP 拿 malloc 内存 DMA 不可读 → 解不出帧的死因。
   allocateBuffer 0x4a88 同样查 [0x8e]/[0x8f]。

### 当前状态（run_iova3）
- `consume byte: 41→8→14469`（SPS/PPS/IDR 三段式全消费）、`decRet: 0`、
  `pBufCtrl fail=0`、scratch 有完整 SPS ✓
- **卡点**：`0ms` 立即返回 + `frameEffective:0` + `SPS:0,PPS:0` —— VSP 没真解
- **头号嫌疑**：h264dec memcpy 码流到 [0xac]（我们 C1 分配的 ION getBase），
  但 VSP 读的是 pBufCtrl->phyAddr（**VSP_malloc_cb@0x6ba0 分配的 bitstream
  buffer 的 IOVA**）——若 VSP_malloc_cb 从**另一块** ION 分配（非 [0xac] 同块），
  则 CPU 写/ DMA 读错位 → VSP 读到空 → 0 帧。下一步核对 VSP_malloc_cb（0x6ba0，
  走回调 0x20c/0x214，结尾写 [0x8c]）返回地址与 [0xac] 的关系。
- ioctl 0xc0084906（真实现的 Get_phy_addr）内核确认不支持；pagemap 在 ARM32
  读不出页帧（scratch_pa=0）——两条拿物理地址的路都死，但 VSP 内部 IOVA 可用。

### 补充定案（0x8090-0x8190 VSP DecodeFrame 参数）
- `0x8124 ldr r0,[r4,#0x48]` → **VSP DecodeFrame([0x208]) 第一参数 = pBufCtrl**
  （VSP 从 pBufCtrl->phyAddr 读码流，[0xac] scratch 是 CPU 侧 memcpy 目标）
- `r2 = [sp+0x54] = priv->[12] = gralloc out 的 iova(0xb4543000)` → VSP 写帧物理地址 ✓
- `0x815c [0xac] 只进 dump_strm(日志)`，非 VSP 参数
- 判断：h264dec 上层（IOVA/phyAddr/consume）**全部打通**，剩 `0ms 无帧` 问题
  在 **libomx_avcdec_hw_sprd.so 内部 H264DecDecode_NALU**（ believed 无可解数据）。
  下一步：反汇编 H264DecDecode_NALU（或 ptrace 抓 VSP 库输入指针），核对
  pBufCtrl->phyAddr 是否真对应 [0xac] 的物理（VSP init 回调链 [0x1f8] 可能
  就是对 [0xac] 做的映射 —— 若是则数据应可达，疑点转向 VSP 内部状态机）。

## 九、★★★ 2026-10-08 下午：硬解出图（里程碑）
> 结论先行：**VSP 硬件已完整解出 1920x1080 真画面**（outputs/out_frame.png 可见台标/字幕/人脸）。

### 根因链（本次全部实证）
1. `read_bits` 是 **VSP 硬件寄存器位流引擎**（写 0x60908008 触发、0x60908010 读回），
   不是读内存。硬件读码流用的物理地址来自 decoder region 表。
2. **region 表** = `H264Dec_MemV2P@0xbf8c`：region 结构 ctx+id*16，`[0x88]=pbase, [0x8c]=vbase`，
   `phys = vaddr + (pbase - vbase)`。region0 = VSPDev 内部工作区（vbase=0xef58）。
3. **ION 真接口定案（/dev/ion, kernel 无 IOMMU 映射接口）**：
   - ALLOC  = `0xc0144900`（20B 结构 {len,align,mask,flags,handle}）
   - fd导出 = `0xc0084904`（{handle,fd}，**不是 03**！）
   - FREE   = `0xc0044901`
   - PHYS   = `ION_IOC_CUSTOM 0xc0084906`，arg={cmd=0, arg=&{int fd; ulong phys; uint size}}
     → 真物理地址（如 0x9f800000）。**heap mask=8 的分配才能查**（mask 2/4 EINVAL）
   - cmd9(get_iova) **内核不存在**（1024 组合扫描全 EINVAL）→ IOMMU 路径死路，
     **必须走物理地址**（VSP 无独立 MMU，phys=总线地址）
   - ⚠ cmd=1 会 SEGV 杀进程，永远只调 cmd=0
4. 历史失败的根因：mock Get_iova 返回 CPU 虚拟地址（0xb4xxxxxx）当物理地址 →
   VSP DMA 读到垃圾 → NAL 解析失败（profile_idc INVALID）或假完成。
   [0x92] 默认改回 1（原厂值），配合 cmd0 真查后链路全通。
5. **输出 buffer 必须自管 ION**（heap 8）：gralloc.sc8830 分配的是 IOMMU heap
   （无物理连续 backing）→ cmd0 查不到 → 只能给假地址 → VSP 写帧失败。
   自管 ION + fake gralloc handle（照抄真 handle 的 magic 字段 fh[0..2],[4..6]，
   换 fd[3]/size[7]/base[12]，否则 mapper.lock 报 "Locking invalid buffer"）。
   **4 个输出 buffer**（DPB 参照帧需要，1 个会 -9 缺帧buffer）。
6. 关键寄存器定案：H264DecDecode 每轮写 0x8000=len|0x80000000、0x8004=acc|0xc0000000、
   0x8008=6、0x1060/0x1064=dataLen>>3，pStream[cap..cap+3] 写哨兵 f4 68 28 f1；
   0x8034=本轮硬件消费量，VSPDev+0x984=累计。acc>=总量 → 跳过 NALU 直接返回
   （真 PA 修好后消费模式变为 4 字节起始码 + read_bits 软件解析）。
7. `vsp_read_reg_poll@0x12a10`（libomx 内部）返回 0=成功；hook 用 **GOT patch**
   （lib_base+0x1de90），导出同名符号拦不住（bionic 先命中自身）。
   ⚠ hook 内读寄存器必须在 VSP 会话中（0x8018 轮询时），empty 返回后读必崩
   （VSP_RELEASE_Dev 已释放）。

### 出图时的表现
- SPS 轮 decRet=-9（2ms，SPS:1 PPS:0，报 PortSettingChange 1920x1088 ✓）
- IDR 轮 decRet=-7（35-44ms 真解码！"failed to decode video frame, hardware error"
  是**非致命**状态位 error_flag=0x8，帧实际已写到输出 buffer）
- Y 平面 93.5% 非零、U 97%、V 89%，画面完全正确
- 落盘判定不依赖 OMX 头回显（nFilledLen 不可信），直接按 YUV 非零比例判
- 探针尾部 RC=139（Segfault）是收尾阶段的既有 bug，不影响出图

### 剩余工作
- ① 每轮帧落到不同 out buffer 轮转确认（4 路已注册）
- ② 帧几何绿带：落盘按 stride*1088 布局切（当前按 1080 切导致 chroma 错位）
- ③ VPP/FBIOPAN 显示集成 + nettv_page
- ④ 提交推送

## 十、★★★ 2026-10-08 晚：连续多帧解码打通
- **8/8 轮全部真解码**（33-37ms/帧 ≈ 28fps 能力），逐帧落盘 /tmp/frame_NN.yuv（0x2FC000 原始 NV12）。
- **组件 [this_d+0x92] 默认改 0**（关键）：fail 分支(dec.asm 0x8064→0x8860 打 "pBufCtrl->phyAddr==0,fail")
  只在 [0x92]!=0 且 priv[12]==0 时触发；=0 时 onQueueFilled 走 Get_phy_addr_from_ion(mock=ion_phys cmd0)
  → 自管 ION 路拿真PA，gralloc 路 [12]=0 但不拦流程。VSPDev 内部 IOMMU 开关是另一个字节，不受影响。
- **内存预算定案**：连续池仅 ~2×3MB。early(main 开头)抢 2 路或 1 路 → 组件内部 DPB 分配失败
  (decRet=-3 "failed to allocate memory" → 自动切软解 → 全灭)。**成功配置 = 完全不 early 抢，
  组件先拿足内存，out[0] 在 init 后用 try_sz{0x320000,0x300000,0x400000} 分配，out[1..3] 用 gralloc**。
- 轮转中的坑（均已修在探针里）：
  - VSPDev ctx(pBufCtrl->[0]) 第 0 轮 VSP_RELEASE 后被清 0 → 每轮 empty 前恢复（g_vspdev0）
  - out header 的 priv(+0x24)->[12] 可能为 0 → 每轮扫描，fd 取自 header->pBuffer ints[3]（priv[8] 不可靠）
  - OMX out header 永不回显 nFilledLen（drain 只发空帧）→ 出帧判定必须按内存内容（Y 抽稀非零）
  - 8 轮全部 FilledDone 同一个 h（组件总选第一个空 out）→ 画面持续写在 out[0] 的 ION
- 遗留：error_flag=0x8 状态位非致命（decRet=-7 但帧正确）；当前是同一 IDR 切片重复解码验证，
  连续播放需按 AU 流式投喂（nettv 集成时做）。
- 下一步：VPP/FBIOPAN 显示（YUV→RGB 或直接 NV12 tile？需查 fb 格式）+ nettv_page 集成 + 提交推送。

## 十一、★★★ 2026-10-08 晚：真实流 NAL 流式硬解打通（约 95%）
> es_fix.h264（5.2MB 直播 ES，1016 AU / 333 有效 NAL）连续流式解码 82-103 帧 decRet=0。

### 投喂模型定案
- **VSP 每次 empty 只消费一个 NAL**（实证：AU=[AUD+slice] 时 consume=6 只吃 AUD；
  文件头垃圾 NAL(type0) 挡在第一个 → IDR 进不去 → needIVOP=1 → 全部帧被丢）。
- **投喂单位=单个 NAL**（type 1/5/6/7/8；跳过 type 0 垃圾和 9 AUD）。
  与 config 段成功路径一致（SPS/PPS/IDR 各一次 empty）。
- in buffer 32KB 足够（最大 NAL 实测 23918B）；1MB 会挤占 CMA 池提前 -3。

### ★ error_flag/Need I frame 死锁链（反汇编定案，libomx_avcdec_hw_sprd.so）
1. NALU 内 0x11724 bl VSP_POLL_COMPLETE → 返回值 int_ret
2. 0x11738 `ands r3,r0,#1`：**bit0=1 → [H264Dec ctx+0xc] |= 8**（0x11750）
3. NALU 尾 0x11884 查 [0xc]!=0 → 976 行日志 "error_flag=0x8" + return（decRet=-7）
4. **下一个 NAL 进来，0x10e38 查 [r4+0xc]!=0 → 886 行 "Need I frame!" → return -1**（上层 -5 stream error）
   → IDR 虽然出图但 error_flag 污染 ctx，后续所有 P 帧被拦。
5. IDR 日志恒 `VSP_POLL_COMPLETE int_ret: 1`（硬件每轮报 bit0）。
- **修复**：GOT patch VSP_POLL_COMPLETE（GOT 0x1dfa0，符号@0x12800），
  hook 里 `r &= ~1` 抑制 bit0 → 流程走 0x118cc "正常完成"路径 → error_flag 不再被置。
- 效果：IDR/P 帧 decRet=0、needIVOP=0、14-20ms/帧（1080p ≈ 50-70fps 能力）。

### 内存账本（CMA 池 ~7MB，hid=0 区 0x9fd20000 起连续线性分配）
- out[0] 自管 ION 3.2MB（mask8 区 0x9fa00000）+ in 32KB + mbinfo 5×653824=3.2MB ≈ 满
- **mbinfo idx 0,1,2,... 每 ~2 帧递增分配 653824B 且从不 free**（组件行为）
- C1 LRU 重用（C1_REUSE_MAX=5）已写好未触发；池满 → decRet=-3 → 组件切软解全灭
- ⚠ **禁忌**：mbinfo 换 mask8 裸分配（out[0] 同区）→ VSP DMA 写该区 → **内核崩溃设备重启**。
  C1 分配只能 hid=0。

### 遗留坏帧（唯一剩余问题，约 1/3 帧）
- 模式：间歇性（好 7 帧→坏 1→好 3→坏 2→好 9→坏 4...），chroma 全 0（U-mean=0）+ Y 宏块错乱。
- 根因：out[1..3] 是 gralloc（IOMMU heap）——cmd0(0xc0084906) 和 0xc008602a 都查不到真 PA
  → VSP DPB 参照写到无效地址 → P 帧参照错乱。参照恰好用 out[0] 时帧完美（frame_00/05）。
- 解法方向：out[1..3] 换可查 PA 的内存（池不够 3×3.2MB）→ 需 mbinfo 出池（mask8 崩溃不可行）
  或 VSP 输出降分辨率（1280x720 → 每 out 1.4MB，2 路 ION 2.8+mbinfo 3.2+in ≈ 6.5MB 可行，待验证）
- 验证工具：U 通道均值（offset 1920*1088 起 >40=好帧）；yuv2png.py（NV12 stride1088 切图）

### 工程杂项
- 编译补 `-Wl,-l:libion.so -Wl,-l:libhardware.so`（ion_open/ion_alloc/hw_get_module）
- musl 头把 gettimeofday/clock_gettime 重定向 __*_time64（bionic 无）→ 裸 `syscall(78,&tv,0)` 取毫秒
- 杀残留探针：cmdline 匹配 `/tmp/sprd_msg*`——宽松匹配 "sprd_msg" 会命中 bash 自己（踩过）
- 落盘判重：Y 抽稀 DJB2 签名，画面没变不重复落盘

## 十二、★★★ 2026-10-08 晚 2：fb 直显打通（约 97%）
### 遗留坏帧定案（重要反转）
- 本地 ffmpeg(OpenCV) 解同一条 es_fix.h264：**同样报一堆 "error while decoding MB ... bytestream -5"**
  + "non-existing PPS 2" → **源流本身丢包损伤**（网络抓包丢失），非 VSP 缺陷。
  ffmpeg 会错误掩盖（复制邻近 MB）所以不出黑 chroma 帧；VSP 掩盖策略差 → 花屏+chroma 0。
  坏帧位置跨运行逐字节相同（确定性）= 与内存配置无关的流损伤特征。
  → 实况直播集成时属正常网络损伤，VSP 管线不需要再修。
- 另修：mbinfo PA —— C1 里 0xc008602a 失败后追加 cmd0(0xc0084906) 兜底，6 个 mbinfo 全拿到真 PA。

### fb 直显管线（sprd_msg.c 内 fb_init/fb_render/fb_home）
```
out[0] NV12 1920x1088
  → pass1: 顺序 NV12→ARGB (yuv2px BT.601, 字节序 [R,G,B,X])
  → pass2a: 16x16 块转置+水平镜像 → targb[c*1080+(1079-r)] = argb[r*1920+c]
  → pass2b: targb 顺序行 3/2 NN 采样 → fb 页(720x1280)
  → FBIOPAN 双页 1/2 交替
```
- ★ CW 旋转定案：out[oy][ox] = in[row=1079-ox*3/2, col=oy*3/2]
  （台标落在右上、文字顺时针 90°，与 LVGL rotation 900 方向一致）
- ★★ FBIOPAN 必须用真 fb_var_screeninfo：FBIOGET_VSCREENINFO → 改 yoffset → FBIOPAN_DISPLAY。
  **自制 24 字节短结构体 = copy_from_user 半拷贝 → 内核栈残留垃圾 yoffset → DPU DMA 取非法地址
  → 内核崩溃设备重启（已踩，勿再犯）**
- fb0: 720x1280x4, yres_virtual=3840(3页), stride 2880；argb/targb 各 malloc 8.3MB（普通内存，非 CMA）
- 性能：pass1 ~6ms + 转置 ~5ms + pass2b ~3ms ≈ 15ms/帧，与 VSP 解码 15ms 并行够 25fps
- 验证方法论：连续渲染时 grab_screen 抓到条纹 = 抓屏慢(秒级)与 30ms/帧渲染混帧的假象；
  冻结首帧(只渲染 1 帧)再抓 = 0.821 非黑干净画面。真机目测才是金标准。
- fbtest.c(直映射)/fbtest2p.c(2-pass) 独立验证工具；es_check.py 本地 cv2 软解对比工具；
  grab_screen.py 已改读 DEV_IP 环境变量。
- 停桌面：kill $(pidof lvgl_watchdog) 按 comm 前缀 /lvgl/ awk 匹配（comm 截断 15 字符）；
  恢复：sh /etc/local.d/00_lvgl_demo.start

### 剩余工作
① 播放器二进制：curl 实时流 → demux ES → 本管线循环（替换文件读）
② nettv_page.c 集成：照 psp_game_page 暂停 LVGL+拦截器模式拉起
③ 提交推送（设备仓库 bundle 中转）

## 十三、★★★ 2026-10-08 晚 3：播放器二进制完成（约 98%）
### 播放器用法（sprd_msg 已播放器化）
```
/tmp/sprd_msg                    # 探针模式(旧行为)
/tmp/sprd_msg /path/es.h264      # 循环播放文件, SIGTERM 退出
/tmp/sprd_msg http://x/y.ts      # curl 25s 下载→播→再下载(直播持续)
/tmp/sprd_msg <src> <N>          # 播 N 帧自动退出(0/缺省=无限)
```
- 参数经 /proc/self/cmdline（无 crt0 不能用 argc/argv）
- load_chunk(): URL→curl 下载 /tmp/nettv.es→重切 NAL 表→chunk 循环重入(config 不重走)

### 性能定位方法论与结论（@ms 时间戳逐步排除法）
| 实验 | 帧率 | 结论 |
|---|---|---|
| 基线 | 2.8s/帧 | 慢 |
| 无落盘 | 3s/帧 | 落盘非瓶颈 |
| /dev/null | - | 日志非瓶颈(500KB) |
| DRIVE usleep 120ms→分档 | 1.3s/帧 | 每 NAL×120ms 是大头之一 |
| no-pan | 不变 | pan 非瓶颈 |
| no-fb_render | 30ms/NAL ★ | **fb_render ~550ms/帧** |
- fb_render 热点 = pass2a 转置 tb[c*1080+..] 列跳写(每 4B 一条 cache line, 128MB 流量)
  → 修复: tile 16x16 读入局部数组, 固定输出行 col 连续写 → 75ms/帧(13fps)
- DRIVE 延时分档: slice(t=1/5) 20ms / SPS/PPS/SEI 2ms / refill 1ms（全局 g_drive_ms）
- 前段每 2 帧 570ms = mbinfo idx 0-4 真分配期（LRU 后消失），稳态 50-75ms/帧

### ★★ 两次内核崩溃（同一根因）
快速版(75ms/帧)跑完**立即退出** → VSP 队列还有 DMA → 进程 exit → 内核 ion 驱动
回收 dmabuf → VSP DMA 写已释放页 → 内核崩重启。修 = 退出前 usleep(800000) 排空。
-O3 -mfpu=neon 版同样崩在退出期（非 NEON 之过），**禁用 -O3**，保持 -O2。
另：慢版(2.8s/帧)从未崩 —— 因为缓冲自然存在。

### ★ mbinfo OOM 强制回落 LRU
C1 分配失败(rc!=0) && size==653824 && g_c1r_n>0 → 直接复用最早槽（旧条件
g_c1r_n>=MAX(5) 永远达不到 —— 第 5 块就 ENOMEM）。效果：组件不再 -3 切软解
（mDecoderSwFlag:1 从此消失），decRet:-9 从 137 降到 12。

### 事故与教训
- 本地 python 脚本 `open(p,'w').write()` 在 write 前抛异常 → **sprd_msg.c 被清空**。
  设备 /tmp/sprd_msg.c 是最新备份源（每次 push 都完整上传）→ --get 拉回恢复。
  教训：批量替换脚本先写临时文件再 rename，或用 Edit 工具。

### 剩余（需用户参与）
- nettv_page.c 集成（拉起 /tmp/sprd_msg URL、照 psp_game_page 暂停 LVGL 模式）
- 提交推送（设备仓库 bundle 中转，需 GITEE_TOKEN）
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
