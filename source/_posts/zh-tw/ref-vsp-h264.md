---
title: "ref_h264硬解_h264dec定案"
date: 2026-10-08 19:08:38
lang: zh-TW
search: true
categories:
- 多媒体与模拟器
- VSP硬解
tag:
- VSP
- 硬解
- H264
permalink: zh-tw/2026/10/08/ref-vsp-h264/
---


# SC8830 硬解攻關 — h264dec 反彙編定案（2026-10-08）

> 本機工作區不是 git 倉庫；代碼在設備 `/tmp/sprd_msg.c`，構建腳本 `/tmp/smb.sh`。
> 全部結論來自 `objdump -d /mnt/android_sys/lib/libstagefright_sprd_h264dec.so`。

## 一、onQueueFilled 真實體（`0x7cec` 起）的完整閘門鏈

```
7d78 ldr ip,[r4,#0x9c] ; cmp #0 ; bne 84f0    ← 入口: [0x9c]!=0 走 84f0
7d7c-7d88 bl initDecoder / freeOutputBufferIOVA
7da4 bl getPortQueue(0) → [sp+0x34]   (in 隊列)
7db4 bl getPortQueue(1) → sl          (out 隊列)
7dbc ldrb r8,[r4,#0x9a] ; cmp #0 ; bne 83dc   ★ [0x9a]!=0 → 直接 return
7dc8 ldr r5,[r4,#0x84] ; cmp #0 ; bne 7de8   ← [0x84]!=0 強制進解碼區
7dd4 ldr fp,[r2,#4] / 7de4 beq 83dc           ← in 隊列空 → return
7de8 ldr r8,[sl,#4] / 7df4 beq 83dc           ★ out 隊列空 → return
7df8 cmp r5,#1 ; beq 8718                     ← [0x84]==1 走 drainAllOutputBuffers
```

### 字段語義總表（★ 都是踩過坑定案的）

| 字段 | 語義 | 寫入者 |
|---|---|---|
| `[0x84]` | 解碼開關。`!=0` 強制進解碼區；`==1` 額外走 8718 drainAllOutputBuffers | `0x7ee0` (nFlags&1)、跑完變 2 |
| `[0x88]` | 端口尺寸變更待處理閘門（非 0 直接 return） | handlePortSettingChangeEvent |
| `[0x8c]` | 內部 drain 循環開關。`0x83c4 ldrb; cmp #0; bne 8334` | 手動置 1 可打開 |
| `[0x9a]` | **停止標誌**。非 0 → 入口 7dbc 直接 return | `0x83b0`（`[0x9c]!=0` 時自動置 1）|
| `[0x9c]` | 待處理字節數。`0x7f68 beq 8518` = 跳過 scratch 拷貝 | ★**不要手動置**，見下 |
| `[0x1dc]` | SPS 已落位標誌 | `0x8240`（VSP 回填 `[sp+0xa4]`）|
| `[0x1dd]` | PPS 已落位標誌 | `0x8248`（VSP 回填 `[sp+0xa5]`）|
| `[0x1e0]/[0x1e4]` | SPS 緩衝 / 長度（長度上限 1024，`cmp #0x400`）| `0x7ccc` |
| `[0x1e8]/[0x1ec]` | PPS 緩衝 / 長度（同上限）| `0x7ca4` |
| `[0x1f0]` | **出幀總閘，一次性**。`0x8314 ldrb; beq 85fc` | `0x8710`，且 `0x8324` 用完立即清 0 |
| `[0x228]` | IOVA/gbMapper 通路。`!=0` → `0x8254 bne 85c0` 走 IOVA 分支 | setParameter(port1) |
| `[0x234]/[0x238]` | crop w/h（日誌首行 1920/1088）。`0x82d0/0x82e4` 與 scratch 位置比較，不匹配跳 `87a8` | SPS 解析 |
| `[0x64]/[0x68]` | VSP 側輸出 w/h | handlePortSettingChangeEvent |
| `[0xac]/[0xb0]/[0xb4]` | VSP scratch(1MB malloc) / 寫指針 / 長度 | initDecoder |
| `[0x208]` | VSP DecodeFrame 函數指針 | — |

## 二、★ 三個反效果的手動干預（都試過並回退，勿重犯）

### 1. 手動置 `[0x9c]` —— 會堵死循環
```
839c ldr r0,[r4,#0x9c] ; cmp #0
83b0 strbne r2,[r4,#0x9a]    ★ [0x9c]!=0 → [0x9a]=1
7dbc ldrb r8,[r4,#0x9a] ; bne 83dc  ← 下輪入口直接 return
```
`[0x9c]` 必須留給廠商自己維護。實測置 `[0x1f0]=1` 後 `consume byte` 從恆 41 變成全字節數。

### 2. 手動置 `[0x1f0]` 有效，但**每輪都要重置**
- `0x7f04 ldrb [0x1dd] ; bne 7f24` → `7f10 tst r0,#0x80 ; bne 853c`
  投 config 帶 `OMX_BF_CODECONFIG(0x80)` ⇒ 永遠走 853c ⇒ 到不了 `7f18 → 86e4 → 8710` ⇒ 廠商永不置 `[0x1f0]`。
- 兜底置 1 = 等效補做 8710。**效果已驗證**：`consume byte` 41 → 14527/14482/14474/14465（全量）。
- 但 `0x8314` 檢查後 `0x8324 strb r0,[0x1f0]` 立即清 0 ⇒ 流式循環**每輪都要重置**。

### 3. 同一個 in buffer 二次 empty 會 ASSERT
```
##### ASSERT #####
[!(!buffer->mOwnedByUs)]  [SprdSimpleOMXComponent]
```
`mOwnedByUs=1` 表示所有權已歸組件；正常由 EmptyBufferDone 回調清 0，我們無 looper ⇒ 每次 empty 前必須 `set_owned(hdr, 0)`。

## 三、gralloc / handle 三層佈局（全部實測定案）

- **`alloc` 真實簽名只有 7 參**：`int alloc(dev,w,h,format,usage,native_handle_t**,int*stride)`
  按 AOSP 10 參調用時第 6 參字面量 0 落到 `handle**` → `0x2192 cmp r9,#0; beq 0x244a` → `mvn r4,#21` = **-22**。這是歷史上 gralloc alloc 全失敗的真因。
- **format 白名單**：`1 2 3 4 5 / 17(YCbCr_420_SP) / 19 20 21 / 33 34 35` + 字面量 `0x32315659`("YV12")。
  實測 `fmt=17, usage=0x300(HW_TEXTURE|HW_RENDER)` 一次成功，`stride=1920`。
  ⚠ `usage & 0x1000` 且 w,h>1 會繞去 framebuffer 路徑（`0x22ba`）首調必失敗。
- **`hw_module_t`**：`+0x00`=0x48574d54("HMW")、`+0x04`=1、`+0x08..0x18`=register[0..4]、`+0x80..0x8c`=perform[0..3]。
- **`alloc_device_t`**：`+0x00`=0x48574454("HWAT")、`+0x08`=module、`+0x3c`=name、`+0x40`=alloc、`+0x44`=free、`+0xcc`=ion_fd。
  ⚠ `+0x40` **直接就是函數指針**（不是指針的指針，多解一層必崩）。
- **`native_handle`**（實測 dump `12 1 18 7 <off> 4 768 3133440 1920 1088 17 1920 <pa>`）：
  `data[0]=ints[3]`=**dmabuf fd**、`ints[7]`=size、`ints[12]`=物理地址。

## 四、★ 讀幀路徑（三級回退，第①級已驗證成功）

設備**沒有 `/dev/mem`**，gralloc 用 **dmabuf 不是 ion**（`/proc/self/maps` 出現 `anon_inode:dmabuf`），
所以 handle 裡的整數不能當 ion fd mmap。但：

```c
out_fd = ((int*)ghOut)[3];                  /* = dmabuf fd */
pb = mmap(NULL, size, PROT_READ, MAP_SHARED, out_fd, 0);   /* ★ 實測成功 */
```
實測：`① mmap dmabuf fd=7 size=3133440 → 0xb3cc3000 ★`

佐證 VSP 輸出走 CPU 指針而非物理地址：`0x8140 add r1, ip, r1`（ip = mapper.lock 的返回地址）。

## 五、★★★ `[0x92]` = IOMMU 開關 —— 之前所有實驗都跑在錯誤路徑上

**這是本輪最重要的發現。** 日誌實測：`解碼器原值: [0x92]=1 [0x94]=1`
—— 解碼器出廠就是 **IOMMU 開啟**，而我們歷史上 `force [0x92]=0` 把它**關掉了**。

`initDecoder@0x5808` 的分岔：
```
5808 ldrb r3,[r4,#0x92]
5810 cmp r3,#0
5814 beq 5950                ← [0x92]==0 → 跳過 get_iova!
5818 ldr r1,[r4,#0x94]       ← get_iova 的 which 參數
5824 bl  get_iova
5830 ldr r0,[r4,#0xa8] / 5834 bl MemoryHeapIon::getBase
5840 str r6,[r4,#0xac]       ← scratch = ION 的 base(不是 malloc)
585c str r2,[r4,#0xb4] / 5860 str r5,[r4,#0xb0]
```
同樣的閘門在 `VSP_malloc_cb@0x6d50` + 另外 3 處（共 **5 處** `get_iova` 調用：
`0x4784`/`0x4b24`/`0x5824`/`0x6d6c`/`0x7050`）。

`[0x92]==0` 分支（`0x5950`）實測：
```
5960 mov r0,#0x200000 ; bl malloc
5968 str r0,[r4,#0xac]      ← scratch = 普通堆內存
5970 str r5,[r4,#0xb0] / 5974 str r1,[r4,#0xb4]=2MB
```
日誌實測 `scratch[0xac]=0xb4a36000 [0xb0]=... [0xb4]=2097152` 完全吻合。

### ⚠ 直接恢復 `[0x92]=1` 會在 useBuffer 段 Segfault
```
internalUseBuffer, header=0xb6d4ed70, pBuffer=0x0, size=18565 → Segmentation fault
```
⇒ IOMMU 路徑下 `useBuffer` 內部還要拿 buffer 的 IOVA（走 gralloc →
`MemoryHeapIon::Get_iova`），而我們的 gralloc alloc 出的是 **dmabuf**（`ints[3]=fd`），
沒經過 `ion_share`/IOVA 映射 ⇒ 拿不到就崩。

**下一步必須先解決**：給 gralloc 分配的 buffer 建立 IOVA 映射，
然後才能把 `[0x92]` 切回 1。可用素材：
- `libomxvpu.so` 導出：`getIOMMUPhyAddr@0x33e0`、`lockAndroidBufferHandle@0x3700`、
  `getAndroidNativeBufferHandleInfo@0x3524`、`getAndroidNativeBufferInfo@0x3454`、
  `checkUseAndroidNativeBufferHeader@0x30e4`、`lockAndroidNativeBuffer@0x35c8`、
  `StoreMetaDataBuffer@0x3584`、`enableAndroidBuffer@0x3100`
- h264dec 未定義符號（我們已 mock 了一部分）：
  `MemoryHeapIon::Get_iova(int,int,unsigned long*,unsigned*)`、
  `get_iova(...)`、`free_iova(int,unsigned,unsigned)`、
  `IOMMU_is_enabled(int)`、
  `SprdSimpleOMXComponent::freeOutputBufferIOVA()`
- `libomxvpu.so` 裡 `getIOMMUPhyAddr` 反彙編（Thumb）：
  ```
  33f0 ldr r4,[r0,#0x24]        ; MemoryHeapIon 對象
  33f4 movs r0,#1
  33f6 blx MemoryHeapIon::IOMMU_is_enabled(int)
  33fa cbz r0, 3442             ; ==0 → 返回
  33fc blx gettid
  3414 ldr r2,[r4,#0x8] / 341a ldr r0,[r4,#0x12]   ; size / fd
  3434 blx MemoryHeapIon::Free_iova(int,int,int,unsigned)
  ```

## 六、★★ 兩條互斥路徑（2026-10-08 收尾發現的死結）

`0x7f04-0x7f24` 與 `0x84a8-0x84ec` 是**兩條互斥**的送 VSP 路徑，只能走一條：

**路徑 A：送全量碼流**（需 `[0x1dd]` 已置位）
```
7f04 ldrb r2,[r4,#0x1dd] ; cmp #0 ; bne 7f24   ← [0x1dd]!=0 直接跳 7f24
7f24 vldr d0,[r5,#0x38]
7f28 ldr r3,[r4,#0x9c]                          ← ★ [0x9c] 必須非 0
7f68 beq 8518                                   ← [0x9c]==0 跳過整段拷貝
7fd4-7ffc strb 寫 "00 00 00 01" 到 [0xac]
8020 bl memcpy(scratch+4, header->pBuffer, [0x9c]+4)
```
實測：置 `[0x1dd]=1` + `[0x9c]=n` → **`consume byte` = 全量 14527** ✓
⚠ 但 `[0x9c]!=0` 會觸發 `0x83b0 strbne [0x9a]=1` → 入口 `7dbc` 下輪直接 return。

**路徑 B：單獨送 SPS 建參數集**（需 `[0x1dd]==0` 且 `[0x9c]==0`）
```
84a8 tst r0,#0x80 ; bne 853c          ← 要求 nFlags 不帶 CODECONFIG
84b0 ldr r3,[r4,#0x1e4] ; cmp #0 ; beq 7f24   ← SPS長度==0 直接跳過
84dc ldr r8,[r4,#0x1e0]               ← SPS 緩衝
84e4 strb r0,[r4,#0x1f0]              ★ 廠商在這裡置 [0x1f0]=1
84ec b 7f24
```
實測：不置 `[0x1dc]/[0x1dd]` → 走這裡 → 但 `[0x9c]=0` 在 `7f68` 擋拷貝 → **`consume byte` 恆 41**。

### 死結
- 走 A 需要 `[0x9c]!=0`，但那會置 `[0x9a]=1` 讓下輪 return。
- 走 B 需要 `[0x9c]==0`，但那樣 VSP 拿不到 IDR 碼流。
- `[0x1f0]=1` 必須**每輪重置**（`0x8314` 檢查後 `0x8324` 立即清 0）。

### 已排除的假設（A/B 實驗實測）
- **`[0x228]`（IOVA 開關）不是關鍵**：`SPRD_NO_IOVA=1` 強制 `[0x228]=0` 後，
  `consume byte` 同樣是全量 14527，`frameEffective` 同樣 0。與 `[0x228]=1` 無差別。
- **`nOffset` 推進會把碼流切碎**（探針實證）：按 consume byte 推進後 scratch 內容變成
  `輪0=SPS / 輪1=PPS字節 / 輪2=IDR中段 / 輪3=切片` ⇒ VSP 永遠看不到完整 SPS 開頭。
  **必須恆 `nOffset=0` + 每輪投全量**。
- **`mCropWidth`/`picWidth` 日誌一次都沒出現** ⇒ `handlePortSettingChangeEvent` 從未被調用。

### internalUseBuffer@0x4514 的結構（`[0x92]=1` 崩在這裡）
```
4654 mov r0,#0x18 ; bl operator new(24)     ; new BufferPrivateStruct(24)
465c str r5,[r0,#4]                          ; [+4] = r5(端口私有數據)
4660 ldr r5,[r4] ; 4664 str r0,[r5,#0x24]    ; portInfo->[0x24] = 新對象
4668 ldr sl,[r4] ; 466c ldr r5,[sl,#0x24]     ; 讀回
4670 cmp r5,#0 ; beq 4748                    ; → __android_log_assert
4678 ldrb lr,[r9,#0x90]                      ; ★ 又一個開關 [0x90]
467c ldr r0,[r9,#0x94] ; 4688 str r0,[r5,#0x20] ; 只是存字段, 不是解引用
4684 cmp lr,#0 ; beq 46f4                     ; [0x90]==0 走 46f4
4690 ldr lr,[sp,#0x40] ; 4698 beq 47c0
46a4-46c8 RefBase::incStrong/decStrong       ; 我們已 no-op 掉
```
實測 `SPRD_IOMMU=1` 時：日誌停在 `internalUseBuffer, header=..., pBuffer=0x0, size=18565`
（`[0x92]=0` 時同一位置會打**兩次**，in/out 各一次）⇒ 崩在第一次 useBuffer 內部，
且**`★ Get_iova` 一次都沒打印** ⇒ 根本沒調到 get_iova，是更早的分支就炸了。

開關矩陣（當前默認值 = 已知可跑通的基線）：
- `SPRD_IOMMU=1` → `[0x92]=1 [0x94]=1` → useBuffer 段 Segfault（未定位）
- 默認（無 env） → `[0x92]=0 [0x94]=0` → 跑完全流程，`consume byte` 全量，
  `scratch非零=43/64`，但 `frameEffective=0`

## 七、當前卡點（下一步）

日誌固定為：
```
dec_out.frameEffective: 0, consume byte: <全量 14527>, SPS:0, PPS:0
failed to get decoder information.        ← H264DecGetInfo 返回空
[0x64]/[0x68]=1920/1088 ✓  spsLen=41 ppsLen=8 ✓
[0x1e0]SPS=00 00 00 01 67 64 00 2a ...  [0x1e8]PPS=00 00 00 01 68 ee 3c b0  ✓
scratch[0..15]=00 00 00 01 67 64 00 2a ...  ✓  scratch非零=43/64
```

已排除：`nFlags`、`[0x9c]`(單獨)、`[0x8c]`、`[0x1f0]`、`[0x1dc]/[0x1dd]`、port1 尺寸、
`[0x84]/[0x9a]`、mOwnedByUs、gralloc handle、mapper.lock、`[0x228]`、nOffset 推進。

**`mCropWidth`/`picWidth` 日誌一次都沒出現** ⇒ `handlePortSettingChangeEvent` 從未被調用
⇒ VSP 從沒回填尺寸 ⇒ `H264DecGetInfo` 返回空。

**頭號嫌疑（已定位，未修）**：`[0x92]` 被我們強制成 0 關掉了 IOMMU。
解碼器原值是 1，走 IOMMU 時 VSP 要的是 **IOVA**（`MemoryHeapIon::Get_iova`），
而我們的 `get_iova` mock 返回的是裸物理地址 `base + g_phys_bias`，
VSP 用它訪問內存必然失敗 → 不出幀、`SPS:0/PPS:0`。

**次號嫌疑**：gralloc 出來的 dmabuf 沒有 IOVA 映射，導致 `[0x92]=1` 時 useBuffer 直接崩。

## 六、構建/運行

```bash
export DEV_IP=192.168.137.100 MSYS_NO_PATHCONV=1   # ★ 不加會 SFTP 報不存在
python ssh_tools/dev.py --push outputs/sprd_msg.c /tmp/sprd_msg.c
python ssh_tools/dev.py "sh /tmp/smb.sh 2>&1 | grep -E 'BUILD|error:'"
python ssh_tools/dev.py "rm -f /tmp/run.log; timeout 150 /tmp/sprd_msg > /tmp/run.log 2>&1"
python ssh_tools/dev.py --get /tmp/run.log outputs/run.log
```
`smb.sh` 末尾會自己跑一遍；單獨跑要手動重定向存日誌。
反彙編：`python ssh_tools/dev.py "objdump -d --start-address=0x7f00 --stop-address=0x8030 /mnt/android_sys/lib/libstagefright_sprd_h264dec.so"`

## 八、★★ IOVA 鏈路攻堅定案（2026-10-08 下午，SPRD_IOMMU=1 路徑）

### 已修復（全部實測）
1. **useBuffer 參數錯位（本輪最大 bug）**：真實簽名
   `useBuffer(this, hdr**, port, priv, size, pBuf, out**)`——舊調用把 pInBuf
   放 priv 槽、pBuf 槽傳 0 → internalUseBuffer 的 header->pBuffer=0 →
   [0x92]=1 時 `0x477c ldr r1,[pBuffer,#12]` 解引用 0xc → SEGV。
   舊 [0x92]=0 路徑不碰 pBuffer 所以僥倖不崩。
2. **internalUseBuffer out 端口 4 分支定案**（0x4678 起）：
   `[0x90]!=0` → 把 arg6 當 sp<GraphicBuffer>* 做 incStrong（傳 native_handle 必崩）；
   `[0x90]==0 && [0x92]!=0` → ION/IOVA 路徑 0x476c（安全）：Get_iova([0x94], pBuffer[12])
   → priv->[8]=fd, priv->[12]=iova, priv->[16]=size。
   **pBuffer[12] = native_handle data[3] = dmabuf fd**。
3. **Get_iova 參數語義**：`Get_iova(fd1_unused, fd2_real, &iova, &size)` ——
   **第二個參數才是 dmabuf fd**（=handle ints[3]=7），第一個是 [0x94]（原值 1）。
   舊 mock 用第一參查表 → 恆失敗 → priv->[12] 棧垃圾。
4. **map_add 時序**：必須在 gralloc alloc 後立即登記（internalUseBuffer 在
   useBuffer **內部**調 Get_iova，晚登記=時序倒掛）。
5. **pBufCtrl（this+0x48 指向，24B）**：[0]=phyAddr（VSP 回調鏈填，**VSP 自己
   管理的 IOVA**，每次運行變化 0xb48x0000/0xb49x0000 = 驅動動態分配）；
   onQueueFilled 0x805c：`[0x92]!=0 且 priv->[12]==0 → fail`（0x8860 打
   "pBufCtrl->phyAddr==0, fail"）。**fail=0 已達成**。
6. **[0x8e]=1 是 openDecoder 失敗後的降級標誌**（0x7d68 廠商置位）：
   initDecoder 0x5770 查 [0x8e]!=0 → malloc scratch（跳過 ION）→
   [0x92]=0 舊路徑實為降級路徑，VSP 拿 malloc 內存 DMA 不可讀 → 解不出幀的死因。
   allocateBuffer 0x4a88 同樣查 [0x8e]/[0x8f]。

### 當前狀態（run_iova3）
- `consume byte: 41→8→14469`（SPS/PPS/IDR 三段式全消費）、`decRet: 0`、
  `pBufCtrl fail=0`、scratch 有完整 SPS ✓
- **卡點**：`0ms` 立即返回 + `frameEffective:0` + `SPS:0,PPS:0` —— VSP 沒真解
- **頭號嫌疑**：h264dec memcpy 碼流到 [0xac]（我們 C1 分配的 ION getBase），
  但 VSP 讀的是 pBufCtrl->phyAddr（**VSP_malloc_cb@0x6ba0 分配的 bitstream
  buffer 的 IOVA**）——若 VSP_malloc_cb 從**另一塊** ION 分配（非 [0xac] 同塊），
  則 CPU 寫/ DMA 讀錯位 → VSP 讀到空 → 0 幀。下一步核對 VSP_malloc_cb（0x6ba0，
  走回調 0x20c/0x214，結尾寫 [0x8c]）返回地址與 [0xac] 的關係。
- ioctl 0xc0084906（真實現的 Get_phy_addr）內核確認不支持；pagemap 在 ARM32
  讀不出頁幀（scratch_pa=0）——兩條拿物理地址的路都死，但 VSP 內部 IOVA 可用。

### 補充定案（0x8090-0x8190 VSP DecodeFrame 參數）
- `0x8124 ldr r0,[r4,#0x48]` → **VSP DecodeFrame([0x208]) 第一參數 = pBufCtrl**
  （VSP 從 pBufCtrl->phyAddr 讀碼流，[0xac] scratch 是 CPU 側 memcpy 目標）
- `r2 = [sp+0x54] = priv->[12] = gralloc out 的 iova(0xb4543000)` → VSP 寫幀物理地址 ✓
- `0x815c [0xac] 只進 dump_strm(日誌)`，非 VSP 參數
- 判斷：h264dec 上層（IOVA/phyAddr/consume）**全部打通**，剩 `0ms 無幀` 問題
  在 **libomx_avcdec_hw_sprd.so 內部 H264DecDecode_NALU**（ believed 無可解數據）。
  下一步：反彙編 H264DecDecode_NALU（或 ptrace 抓 VSP 庫輸入指針），核對
  pBufCtrl->phyAddr 是否真對應 [0xac] 的物理（VSP init 回調鏈 [0x1f8] 可能
  就是對 [0xac] 做的映射 —— 若是則數據應可達，疑點轉向 VSP 內部狀態機）。

## 九、★★★ 2026-10-08 下午：硬解出圖（里程碑）
> 結論先行：**VSP 硬件已完整解出 1920x1080 真畫面**（outputs/out_frame.png 可見臺標/字幕/人臉）。

### 根因鏈（本次全部實證）
1. `read_bits` 是 **VSP 硬件寄存器位流引擎**（寫 0x60908008 觸發、0x60908010 讀回），
   不是讀內存。硬件讀碼流用的物理地址來自 decoder region 表。
2. **region 表** = `H264Dec_MemV2P@0xbf8c`：region 結構 ctx+id*16，`[0x88]=pbase, [0x8c]=vbase`，
   `phys = vaddr + (pbase - vbase)`。region0 = VSPDev 內部工作區（vbase=0xef58）。
3. **ION 真接口定案（/dev/ion, kernel 無 IOMMU 映射接口）**：
   - ALLOC  = `0xc0144900`（20B 結構 {len,align,mask,flags,handle}）
   - fd導出 = `0xc0084904`（{handle,fd}，**不是 03**！）
   - FREE   = `0xc0044901`
   - PHYS   = `ION_IOC_CUSTOM 0xc0084906`，arg={cmd=0, arg=&{int fd; ulong phys; uint size}}
     → 真物理地址（如 0x9f800000）。**heap mask=8 的分配才能查**（mask 2/4 EINVAL）
   - cmd9(get_iova) **內核不存在**（1024 組合掃描全 EINVAL）→ IOMMU 路徑死路，
     **必須走物理地址**（VSP 無獨立 MMU，phys=總線地址）
   - ⚠ cmd=1 會 SEGV 殺進程，永遠只調 cmd=0
4. 歷史失敗的根因：mock Get_iova 返回 CPU 虛擬地址（0xb4xxxxxx）當物理地址 →
   VSP DMA 讀到垃圾 → NAL 解析失敗（profile_idc INVALID）或假完成。
   [0x92] 默認改回 1（原廠值），配合 cmd0 真查後鏈路全通。
5. **輸出 buffer 必須自管 ION**（heap 8）：gralloc.sc8830 分配的是 IOMMU heap
   （無物理連續 backing）→ cmd0 查不到 → 只能給假地址 → VSP 寫幀失敗。
   自管 ION + fake gralloc handle（照抄真 handle 的 magic 字段 fh[0..2],[4..6]，
   換 fd[3]/size[7]/base[12]，否則 mapper.lock 報 "Locking invalid buffer"）。
   **4 個輸出 buffer**（DPB 參照幀需要，1 個會 -9 缺幀buffer）。
6. 關鍵寄存器定案：H264DecDecode 每輪寫 0x8000=len|0x80000000、0x8004=acc|0xc0000000、
   0x8008=6、0x1060/0x1064=dataLen>>3，pStream[cap..cap+3] 寫哨兵 f4 68 28 f1；
   0x8034=本輪硬件消費量，VSPDev+0x984=累計。acc>=總量 → 跳過 NALU 直接返回
   （真 PA 修好後消費模式變為 4 字節起始碼 + read_bits 軟件解析）。
7. `vsp_read_reg_poll@0x12a10`（libomx 內部）返回 0=成功；hook 用 **GOT patch**
   （lib_base+0x1de90），導出同名符號攔不住（bionic 先命中自身）。
   ⚠ hook 內讀寄存器必須在 VSP 會話中（0x8018 輪詢時），empty 返回後讀必崩
   （VSP_RELEASE_Dev 已釋放）。

### 出圖時的表現
- SPS 輪 decRet=-9（2ms，SPS:1 PPS:0，報 PortSettingChange 1920x1088 ✓）
- IDR 輪 decRet=-7（35-44ms 真解碼！"failed to decode video frame, hardware error"
  是**非致命**狀態位 error_flag=0x8，幀實際已寫到輸出 buffer）
- Y 平面 93.5% 非零、U 97%、V 89%，畫面完全正確
- 落盤判定不依賴 OMX 頭回顯（nFilledLen 不可信），直接按 YUV 非零比例判
- 探針尾部 RC=139（Segfault）是收尾階段的既有 bug，不影響出圖

### 剩餘工作
- ① 每輪幀落到不同 out buffer 輪轉確認（4 路已註冊）
- ② 幀幾何綠帶：落盤按 stride*1088 佈局切（當前按 1080 切導致 chroma 錯位）
- ③ VPP/FBIOPAN 顯示集成 + nettv_page
- ④ 提交推送

## 十、★★★ 2026-10-08 晚：連續多幀解碼打通
- **8/8 輪全部真解碼**（33-37ms/幀 ≈ 28fps 能力），逐幀落盤 /tmp/frame_NN.yuv（0x2FC000 原始 NV12）。
- **組件 [this_d+0x92] 默認改 0**（關鍵）：fail 分支(dec.asm 0x8064→0x8860 打 "pBufCtrl->phyAddr==0,fail")
  只在 [0x92]!=0 且 priv[12]==0 時觸發；=0 時 onQueueFilled 走 Get_phy_addr_from_ion(mock=ion_phys cmd0)
  → 自管 ION 路拿真PA，gralloc 路 [12]=0 但不攔流程。VSPDev 內部 IOMMU 開關是另一個字節，不受影響。
- **內存預算定案**：連續池僅 ~2×3MB。early(main 開頭)搶 2 路或 1 路 → 組件內部 DPB 分配失敗
  (decRet=-3 "failed to allocate memory" → 自動切軟解 → 全滅)。**成功配置 = 完全不 early 搶，
  組件先拿足內存，out[0] 在 init 後用 try_sz{0x320000,0x300000,0x400000} 分配，out[1..3] 用 gralloc**。
- 輪轉中的坑（均已修在探針裡）：
  - VSPDev ctx(pBufCtrl->[0]) 第 0 輪 VSP_RELEASE 後被清 0 → 每輪 empty 前恢復（g_vspdev0）
  - out header 的 priv(+0x24)->[12] 可能為 0 → 每輪掃描，fd 取自 header->pBuffer ints[3]（priv[8] 不可靠）
  - OMX out header 永不回顯 nFilledLen（drain 只發空幀）→ 出幀判定必須按內存內容（Y 抽稀非零）
  - 8 輪全部 FilledDone 同一個 h（組件總選第一個空 out）→ 畫面持續寫在 out[0] 的 ION
- 遺留：error_flag=0x8 狀態位非致命（decRet=-7 但幀正確）；當前是同一 IDR 切片重複解碼驗證，
  連續播放需按 AU 流式投餵（nettv 集成時做）。
- 下一步：VPP/FBIOPAN 顯示（YUV→RGB 或直接 NV12 tile？需查 fb 格式）+ nettv_page 集成 + 提交推送。

## 十一、★★★ 2026-10-08 晚：真實流 NAL 流式硬解打通（約 95%）
> es_fix.h264（5.2MB 直播 ES，1016 AU / 333 有效 NAL）連續流式解碼 82-103 幀 decRet=0。

### 投餵模型定案
- **VSP 每次 empty 只消費一個 NAL**（實證：AU=[AUD+slice] 時 consume=6 只吃 AUD；
  文件頭垃圾 NAL(type0) 擋在第一個 → IDR 進不去 → needIVOP=1 → 全部幀被丟）。
- **投餵單位=單個 NAL**（type 1/5/6/7/8；跳過 type 0 垃圾和 9 AUD）。
  與 config 段成功路徑一致（SPS/PPS/IDR 各一次 empty）。
- in buffer 32KB 足夠（最大 NAL 實測 23918B）；1MB 會擠佔 CMA 池提前 -3。

### ★ error_flag/Need I frame 死鎖鏈（反彙編定案，libomx_avcdec_hw_sprd.so）
1. NALU 內 0x11724 bl VSP_POLL_COMPLETE → 返回值 int_ret
2. 0x11738 `ands r3,r0,#1`：**bit0=1 → [H264Dec ctx+0xc] |= 8**（0x11750）
3. NALU 尾 0x11884 查 [0xc]!=0 → 976 行日誌 "error_flag=0x8" + return（decRet=-7）
4. **下一個 NAL 進來，0x10e38 查 [r4+0xc]!=0 → 886 行 "Need I frame!" → return -1**（上層 -5 stream error）
   → IDR 雖然出圖但 error_flag 汙染 ctx，後續所有 P 幀被攔。
5. IDR 日誌恆 `VSP_POLL_COMPLETE int_ret: 1`（硬件每輪報 bit0）。
- **修復**：GOT patch VSP_POLL_COMPLETE（GOT 0x1dfa0，符號@0x12800），
  hook 裡 `r &= ~1` 抑制 bit0 → 流程走 0x118cc "正常完成"路徑 → error_flag 不再被置。
- 效果：IDR/P 幀 decRet=0、needIVOP=0、14-20ms/幀（1080p ≈ 50-70fps 能力）。

### 內存賬本（CMA 池 ~7MB，hid=0 區 0x9fd20000 起連續線性分配）
- out[0] 自管 ION 3.2MB（mask8 區 0x9fa00000）+ in 32KB + mbinfo 5×653824=3.2MB ≈ 滿
- **mbinfo idx 0,1,2,... 每 ~2 幀遞增分配 653824B 且從不 free**（組件行為）
- C1 LRU 重用（C1_REUSE_MAX=5）已寫好未觸發；池滿 → decRet=-3 → 組件切軟解全滅
- ⚠ **禁忌**：mbinfo 換 mask8 裸分配（out[0] 同區）→ VSP DMA 寫該區 → **內核崩潰設備重啟**。
  C1 分配只能 hid=0。

### 遺留壞幀（唯一剩餘問題，約 1/3 幀）
- 模式：間歇性（好 7 幀→壞 1→好 3→壞 2→好 9→壞 4...），chroma 全 0（U-mean=0）+ Y 宏塊錯亂。
- 根因：out[1..3] 是 gralloc（IOMMU heap）——cmd0(0xc0084906) 和 0xc008602a 都查不到真 PA
  → VSP DPB 參照寫到無效地址 → P 幀參照錯亂。參照恰好用 out[0] 時幀完美（frame_00/05）。
- 解法方向：out[1..3] 換可查 PA 的內存（池不夠 3×3.2MB）→ 需 mbinfo 出池（mask8 崩潰不可行）
  或 VSP 輸出降分辨率（1280x720 → 每 out 1.4MB，2 路 ION 2.8+mbinfo 3.2+in ≈ 6.5MB 可行，待驗證）
- 驗證工具：U 通道均值（offset 1920*1088 起 >40=好幀）；yuv2png.py（NV12 stride1088 切圖）

### 工程雜項
- 編譯補 `-Wl,-l:libion.so -Wl,-l:libhardware.so`（ion_open/ion_alloc/hw_get_module）
- musl 頭把 gettimeofday/clock_gettime 重定向 __*_time64（bionic 無）→ 裸 `syscall(78,&tv,0)` 取毫秒
- 殺殘留探針：cmdline 匹配 `/tmp/sprd_msg*`——寬鬆匹配 "sprd_msg" 會命中 bash 自己（踩過）
- 落盤判重：Y 抽稀 DJB2 簽名，畫面沒變不重複落盤

## 十二、★★★ 2026-10-08 晚 2：fb 直顯打通（約 97%）
### 遺留壞幀定案（重要反轉）
- 本地 ffmpeg(OpenCV) 解同一條 es_fix.h264：**同樣報一堆 "error while decoding MB ... bytestream -5"**
  + "non-existing PPS 2" → **源流本身丟包損傷**（網絡抓包丟失），非 VSP 缺陷。
  ffmpeg 會錯誤掩蓋（複製鄰近 MB）所以不出黑 chroma 幀；VSP 掩蓋策略差 → 花屏+chroma 0。
  壞幀位置跨運行逐字節相同（確定性）= 與內存配置無關的流損傷特徵。
  → 實況直播集成時屬正常網絡損傷，VSP 管線不需要再修。
- 另修：mbinfo PA —— C1 裡 0xc008602a 失敗後追加 cmd0(0xc0084906) 兜底，6 個 mbinfo 全拿到真 PA。

### fb 直顯管線（sprd_msg.c 內 fb_init/fb_render/fb_home）
```
out[0] NV12 1920x1088
  → pass1: 順序 NV12→ARGB (yuv2px BT.601, 字節序 [R,G,B,X])
  → pass2a: 16x16 塊轉置+水平鏡像 → targb[c*1080+(1079-r)] = argb[r*1920+c]
  → pass2b: targb 順序行 3/2 NN 採樣 → fb 頁(720x1280)
  → FBIOPAN 雙頁 1/2 交替
```
- ★ CW 旋轉定案：out[oy][ox] = in[row=1079-ox*3/2, col=oy*3/2]
  （臺標落在右上、文字順時針 90°，與 LVGL rotation 900 方向一致）
- ★★ FBIOPAN 必須用真 fb_var_screeninfo：FBIOGET_VSCREENINFO → 改 yoffset → FBIOPAN_DISPLAY。
  **自制 24 字節短結構體 = copy_from_user 半拷貝 → 內核棧殘留垃圾 yoffset → DPU DMA 取非法地址
  → 內核崩潰設備重啟（已踩，勿再犯）**
- fb0: 720x1280x4, yres_virtual=3840(3頁), stride 2880；argb/targb 各 malloc 8.3MB（普通內存，非 CMA）
- 性能：pass1 ~6ms + 轉置 ~5ms + pass2b ~3ms ≈ 15ms/幀，與 VSP 解碼 15ms 並行夠 25fps
- 驗證方法論：連續渲染時 grab_screen 抓到條紋 = 抓屏慢(秒級)與 30ms/幀渲染混幀的假象；
  凍結首幀(只渲染 1 幀)再抓 = 0.821 非黑乾淨畫面。真機目測才是金標準。
- fbtest.c(直映射)/fbtest2p.c(2-pass) 獨立驗證工具；es_check.py 本地 cv2 軟解對比工具；
  grab_screen.py 已改讀 DEV_IP 環境變量。
- 停桌面：kill $(pidof lvgl_watchdog) 按 comm 前綴 /lvgl/ awk 匹配（comm 截斷 15 字符）；
  恢復：sh /etc/local.d/00_lvgl_demo.start

### 剩餘工作
① 播放器二進制：curl 實時流 → demux ES → 本管線循環（替換文件讀）
② nettv_page.c 集成：照 psp_game_page 暫停 LVGL+攔截器模式拉起
③ 提交推送（設備倉庫 bundle 中轉）

## 十三、★★★ 2026-10-08 晚 3：播放器二進制完成（約 98%）
### 播放器用法（sprd_msg 已播放器化）
```
/tmp/sprd_msg                    # 探針模式(舊行為)
/tmp/sprd_msg /path/es.h264      # 循環播放文件, SIGTERM 退出
/tmp/sprd_msg http://x/y.ts      # curl 25s 下載→播→再下載(直播持續)
/tmp/sprd_msg <src> <N>          # 播 N 幀自動退出(0/缺省=無限)
```
- 參數經 /proc/self/cmdline（無 crt0 不能用 argc/argv）
- load_chunk(): URL→curl 下載 /tmp/nettv.es→重切 NAL 表→chunk 循環重入(config 不重走)

### 性能定位方法論與結論（@ms 時間戳逐步排除法）
| 實驗 | 幀率 | 結論 |
|---|---|---|
| 基線 | 2.8s/幀 | 慢 |
| 無落盤 | 3s/幀 | 落盤非瓶頸 |
| /dev/null | - | 日誌非瓶頸(500KB) |
| DRIVE usleep 120ms→分檔 | 1.3s/幀 | 每 NAL×120ms 是大頭之一 |
| no-pan | 不變 | pan 非瓶頸 |
| no-fb_render | 30ms/NAL ★ | **fb_render ~550ms/幀** |
- fb_render 熱點 = pass2a 轉置 tb[c*1080+..] 列跳寫(每 4B 一條 cache line, 128MB 流量)
  → 修復: tile 16x16 讀入局部數組, 固定輸出行 col 連續寫 → 75ms/幀(13fps)
- DRIVE 延時分檔: slice(t=1/5) 20ms / SPS/PPS/SEI 2ms / refill 1ms（全局 g_drive_ms）
- 前段每 2 幀 570ms = mbinfo idx 0-4 真分配期（LRU 後消失），穩態 50-75ms/幀

### ★★ 兩次內核崩潰（同一根因）
快速版(75ms/幀)跑完**立即退出** → VSP 隊列還有 DMA → 進程 exit → 內核 ion 驅動
回收 dmabuf → VSP DMA 寫已釋放頁 → 內核崩重啟。修 = 退出前 usleep(800000) 排空。
-O3 -mfpu=neon 版同樣崩在退出期（非 NEON 之過），**禁用 -O3**，保持 -O2。
另：慢版(2.8s/幀)從未崩 —— 因為緩衝自然存在。

### ★ mbinfo OOM 強制回落 LRU
C1 分配失敗(rc!=0) && size==653824 && g_c1r_n>0 → 直接複用最早槽（舊條件
g_c1r_n>=MAX(5) 永遠達不到 —— 第 5 塊就 ENOMEM）。效果：組件不再 -3 切軟解
（mDecoderSwFlag:1 從此消失），decRet:-9 從 137 降到 12。

### 事故與教訓
- 本地 python 腳本 `open(p,'w').write()` 在 write 前拋異常 → **sprd_msg.c 被清空**。
  設備 /tmp/sprd_msg.c 是最新備份源（每次 push 都完整上傳）→ --get 拉回恢復。
  教訓：批量替換腳本先寫臨時文件再 rename，或用 Edit 工具。

### 剩餘（需用戶參與）
- nettv_page.c 集成（拉起 /tmp/sprd_msg URL、照 psp_game_page 暫停 LVGL 模式）
- 提交推送（設備倉庫 bundle 中轉，需 GITEE_TOKEN）
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
