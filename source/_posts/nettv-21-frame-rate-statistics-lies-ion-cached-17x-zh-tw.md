---
title: nettv-21：16.9fps 是假的——影格率統計定義騙了我們三個月，以及一個 17 倍的讀影格提速（SC9832A 硬解排查實錄）
date: 2026-10-21 11:30:00
tags:
  - sprd
  - SC9832A
  - VSP
  - ION
  - framebuffer
  - 效能最佳化
  - 統計定義
categories:
  - [嵌入式, 網路電視硬解]
  - [除錯, 效能最佳化]
  - [Linux, 記憶體管理]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-21-frame-rate-statistics-lies-ion-cached-17x/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-21-frame-rate-statistics-lies-ion-cached-17x-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-21-frame-rate-statistics-lies-ion-cached-17x-en/)

上一輪剛把「UI 點頻道黑畫面」修完，使用者就丟了一句：**「播放效果有改進，但完全達不到正常觀看標準。」**

這句話的價值在於它逼我回頭看那些「已經最佳化過很多輪」的數字。結果一查不得了——**我們盯了三個月的影格率，從頭到尾都是錯的。**

這篇記錄兩件事：一個是統計定義的陷阱（數字騙人），一個是真正的效能突破（讀影格 17 倍提速），以及一個被推翻的方案（差點把裝置搞崩）。

## 一、先看數字：16.9fps 是假的

播放器裡有個心跳，每 25 影格打一條：

```
[STAT] frames=12825 elapsed=759074ms fps_x10=168
```

759 秒、12825 影格、**16.9fps**。看起來挺正常對吧？來源是 1080p/25fps 的直播串流，差得不算太多。

但我去數了一下回呼：

```sh
grep -c 'filled=3133440' /tmp/nettv_child.log   # 真影格: 6776
grep -c 'filled=0 out=0'  /tmp/nettv_child.log   # 空事件: 7471
```

**6776 真影格 + 7471 空事件。**

廠商函式庫在吐出一個真影格之後，必然緊跟一個 `filled=0` 的空事件——`drainAllOutputBuffers` 把同一個 output header 回收重用，`nFilledLen` 被清零，於是又回呼了一次 `BufferFilledDone`。

而我們的程式碼在 `BufferFilledDone` 回呼裡無差別地 `g_filled++`：

```c
static OMX_ERRORTYPE bfd(OMX_PTR a,OMX_PTR b,OMX_BUFFERHEADERTYPE_PT h) {
    ...
    g_filled++; frame_beat(); return 0;   /* ← 真影格和空事件一起算 */
}
```

於是**影格數統計憑空翻了一倍**。真實畫面更新率是：

```
6776 / 759s = 8.9 fps
```

不是 16.9，是 **8.9**。

這個數字後來還污染了另外兩處：

- **重複判斷邏輯**：`is_new = (g_filled != filled_seen)` —— 空事件也算「有新影格」，觸發一次完整的讀影格+渲染（77ms），而畫面內容根本沒變。
- **perf 取樣**：`[perf] AU#7400` 的各種平均值，都是按「回呼數」而不是「真影格數」歸一化的。

**教訓一：效能計數器必須先問清楚「它數的是什麼」。** 一個把兩種語義混在一起的計數器，會同時污染統計、重複判斷、取樣三個地方，而且因為數字看起來合理，誰也不會去懷疑。

修法很直接——把真影格單獨計數：

```c
/* ★★ 2026-10-21 真影格判定: 廠商每吐一個真影格必跟一個 filled=0 的空事件。
 *   實測真影格 filled=3133440/out=0, 空事件 filled=0/out=0 ⇒
 *   (nFilledLen||nOutputLen) 非 0 才是真影格。
 *   ★ g_filled 保持"全部回呼"語義(monitor 存活心跳 shm[3] 依賴它),
 *     真影格單獨用 g_filled_real 計數 ⇒ [STAT] 影格率不再虛高一倍。 */
if (h && (h->nFilledLen || h->nOutputLen)) g_filled_real++;
```

注意這裡刻意**沒有**改 `g_filled` 的語義——monitor 的存活看門狗靠 `shm[3] = g_filled` 判斷廠商還在不吐回呼，那個必須保持「所有回呼」的寬鬆定義。**同一個計數器承擔兩種語義時，寧可拆成兩個，也不要改原有的那個。**

## 二、真正的瓶頸：88% 的時間不在解碼上

知道真實影格率是 8.9fps 之後，我需要知道時間去哪了。播放器裡早就有分段計時：

```
[perf] AU#7400 均值: 墙钟=113.0 段循环=32.6 snap=0.0 读帧=44.3 渲染=33.0 (ms)
```

113ms 出一影格，對應 8.85fps——和實測的 8.9 完全吻合。這三段耗時拆開看：

| 段 | 耗時 | 占比 | 是什麼 |
|---|---|---|---|
| 段迴圈 | 32.6ms | 29% | 投餵 AU + 等廠商排空 |
| **讀影格** | **44.3ms** | **39%** | **3MB memcpy（ION → staging）** |
| 渲染 | 33.0ms | 29% | NV12 → ARGB → 旋轉 → 寫 fb |

而廠商自己的解碼耗時，828 次取樣**全部是 14ms**，紋絲不動。

**換句話說：VSP 硬體解碼只佔了 12%，88% 的時間是我們的後處理。** 硬體完全不是瓶頸，瓶頸在「把解碼好的影格搬到螢幕上」這段路上。

這個認知很重要——它意味著所有「最佳化硬解效能」的方向都是錯的，方向應該是「最佳化資料搬運」。

## 三、突破：uncached 記憶體是元兇

讀影格段 44.3ms 做的事就一件：

```c
memcpy(g_stage, q, 0x2FC000);   /* 3MB，從 ION VA 拷到 staging */
```

3MB / 44.3ms = **68MB/s**。這個頻寬低得離譜——正常 DDR 記憶體 memcpy 能到 1GB/s 以上。

原因在 ION 分配的 `flags`：

```c
ad.len = FSZ; ad.align = 0x1000; ad.mask = 8;   /* flags 預設為 0 */
```

`flags=0` 意味著 **uncached 映射**。在 uncached 映射上，每讀一個 cache line 都要獨立發起一次匯流排交易，硬體預取完全幫不上忙，68MB/s 就是這麼來的。

改成 `flags=1`（cached），CPU 側走普通 load/store：

```c
if (cached_mode()) ad.flags = 1;
```

但這裡有個**必須配套的 DMA 一致性處理**：VSP 是用 DMA 往這塊記憶體寫影格的，CPU cache 裡可能還留著 DMA 之前的舊資料。所以讀之前必須先 invalidate：

```c
/* ION_IOC_INV = _IOW('I',14,void*) = 0xc0104914 */
static void ion_inv_out(void) {
    for (int i = 0; i < g_gh_n; i++)
        if (g_ion_handle[i])
            ioctl(g_ionfd, 0xc0104914, &g_ion_handle[i]);
}
```

**這裡踩了一個坑，位置很關鍵**：invalidate 必須在 staging memcpy **之前**。因為 memcpy 的源就是那塊 DMA 區，先拷後 invalidate 等於白做。原來的程式碼只在 pipeline 路徑的渲染執行緒裡做了一次 invalidate，而且是在 memcpy 之後——單執行緒路徑開著 cached 就會讀到髒資料（花畫面）。

A/B 實測（同源、同長度、只切一個變數）：

```
讀影格=44.3ms  →  讀影格=2.6ms        （17 倍）
牆鐘=113.0ms →  牆鐘=71.4ms
真實影格率 8.45fps → 12.7fps
```

畫面品質同時驗證過：前三影格的 Y 平面稀疏非零計數是 8151/8150/8154，三影格的簽章雜湊互不相同——說明是真實變化的畫面，不是黑畫面也不是花畫面。

**教訓二：當一個數字明顯偏離物理常識時（68MB/s），先懷疑映射屬性，再懷疑演算法。** 同樣的 memcpy，改一個 flag 就快 17 倍。

## 四、被推翻的方案：換個堆來躲池子

改完 cached 之後我遇到一個新問題：廠商解碼器的 C1 緩衝區分配開始報 OOM：

```
ioctl c0144900 failed with code -1: Out of memory
```

更糟的是，廠商拿不到 C1 之後會**退回到 CPU 虛擬位址**當實體位址用（「三級取址全失敗 → 退回 CPU VA(假PA, 花影格風險!)」），然後 VSP 往一個無效位址寫影格 → SIGSEGV。

診斷後發現是**同池競爭**：我們的輸出 buffer 是 3.2MB，必須 order-8 連續區塊；而廠商那 5 塊 638KB 的 C1 DPB 也要 order-8（它的 `align=8`）。carveout 池裡的 order-8 大塊總數只有 4 塊（8MB），我們佔 1 塊，廠商就不夠了。

我的第一反應是：**那我們換個池不就行了**——把輸出 buffer 改用 `mask=2`（System RAM）而不是 `mask=8`（carveout_mm）。廠商自己的 2MB C1 本來就用 mask=2，看起來完全可行。

於是我改程式碼、編譯、部署、跑驗證。**然後裝置直接重新開機了。**

沒有 oops，沒有 panic，`/proc/sys/kernel/watchdog` = 1，dmesg 是一堆 `powerdown_cpus`。查實體位址才發現原因：

```
廠商 2MB C1 (mask=2):  真PA = 0x9f800000   ← carveout 視窗內
我們的輸出 (mask=8):   真PA = 0x9fa00000   ← carveout 視窗內
```

**mask=2 和 mask=8 拿到的是同一個 carveout 區域**（0x9f8xxxxx），並不是「System RAM」。而真正的 System RAM 在 0x80000000-0xbfffffff，mask=2 搶到的是那裡的高位址——**超出了 VSP 硬體能存取的位址視窗**，VSP 往那寫就飛了，硬體看門狗直接重置。

**教訓三：同一個 mask 名字在不同上下文裡可能完全不是一回事。** 我看到「廠商用 mask=2 能成功」，就以為 mask=2 = System RAM = 安全的另一塊池——但那兩個 mask=2 的分配落到了完全不同的實體區域，一個是 0x9f8xxxxx（carveout），一個是 0x8xxxxxxx（真 RAM）。**參數名相同不等於語義相同，必須看實際實體位址。**

好在這個方案在造成硬體損壞之前就被測了出來，沒有造成更大後果。回復到 `mask=8`。

## 五、還有一個坑：cached 池是空的

順手查池的時候還發現：

```
carveout_mm:  10 order 4 highmem pages in uncached pool = 655360 total
               0 order 4 highmem pages in   cached pool =       0 total
```

**cached 池一頁都沒有。** 也就是說 `flags=1` 的分配在 carveout 上是去一個空池搶頁，搶不到就失敗。如果不處理，一次分配失敗就會讓廠商後面所有的 C1 分配連鎖 OOM。

所以 cached 分配必須帶退路：

```c
if (ioctl(g_ionfd, 0xc0144900, &ad) != 0) {
    if (ad.flags) {
        ad.flags = 0;                          /* 回退 uncached */
        if (ioctl(g_ionfd, 0xc0144900, &ad) != 0) continue;
        g_cached_mode = 0;                     /* 全域關掉 cached */
        P("  [ion] cached 配置失敗, 回退 uncached\n");
    } else continue;
}
```

**教訓四：最佳化開關必須自帶降級路徑。** 同一個開關，開/關是兩種都能跑的狀態，而不是「開了就快、不開就慢」的二選一。

## 六、再進一步：把渲染的 30ms 也拆開

改完 cached，我給 `fb_render` 加了分段計時（轉換 vs 寫 fb）：

```
[perf] fb_render 均值 32ms (换算上限 31 fps) | 转换 30ms 写fb 1ms
```

**寫 fb 只佔 1ms**——3.6MB 寫進 mmap 的 framebuffer 幾乎不花錢（記憶體頻寬足夠）。30ms 全在「NV12 → ARGB + 旋轉 + 3/2 降取樣」這段純算術上。

但純算術不該這麼慢。算一下：92 萬像素，每像素 3 次乘法 + 6 次位移 + 6 次分支 clamp，**總共 200 多萬次乘加**，在 Cortex-A7 上撐死 1~2ms。差的 28ms 去哪了？

**快取未命中。** 渲染的記憶體存取模式是轉置的——輸出第 (oy, ox) 像素取源圖的 `[1079-ox*3/2][oy*3/2]`，源行隨輸出列走、源列隨輸出行走，每個源像素的相鄰輸出像素在源圖裡隔了 1.5 像素。源圖 3MB，一影格要跨 1080 個源行各取 720 個點，**每次換源行都是一次新的 cache line 擷取**。

這解釋了為什麼之前「查表化」反而更慢（39.3ms vs 32.5ms）——查表把 miss 從源側搬到了表側，淨收益為零。

解法不是改演算法，是**改分組粒度**：原來的實作每次處理 16 個輸出行（一個「帶」），每個源行只讀 24 位元組（約 37% 條 cache line）。改成 64 行後，每個源行讀 96 位元組，而相鄰帶讀的正是同一批 cache line 的相鄰段——**在 L2 裡就能重用**。

```c
#define BANDH 64     /* 16 → 64, 幾何公式完全不變, 只改分組 */
```

實測：渲染 34.3 → **30.3ms**，真實影格率 12.4 → **13.1fps**。截圖確認畫面幾何無任何變形（台標位置、字幕、色彩全部正常）。

**教訓五：算術便宜不代表記憶體存取便宜。** 同樣是 200 萬次乘加，純量和 NEON 差不多；但「每個源像素拉一次 cache line」和「每 4 個源像素拉一次」，差 10 倍。

## 七、這一輪的帳

| 項目 | 改前 | 改後 |
|---|---|---|
| 真實畫面更新率 | 8.45 fps | **13.1 fps** |
| 讀影格段耗時 | 44.3 ms | **2.7 ms** |
| 渲染段耗時 | 33.0 ms | **30.3 ms** |
| 每影格牆鐘 | 113.0 ms | **70.6 ms** |
| `[STAT]` 影格率統計定義 | 虛高 2 倍 | 真實影格數 |

廠商解碼 14ms 是硬底線，理論上限 1000/(14+30) ≈ 23fps。

## 八、這輪還踩了兩個坑，值得單獨記一筆

### 坑一：把「更省記憶體」當成「更好對齊」

我們的輸出 buffer 是 3.25MB，精確影格尺寸是 3.13MB——我以為首選精確尺寸能省 140KB、給廠商的 C1 多留點空間。結果 **OOM 從 1 次漲到 28 次**。

原因很樸素：3.13MB 湊不出 order-8 的整塊，3.25MB 能湊。**尺寸階梯的第一項不是「最省的」，是「最好對齊的」。**

### 坑二：perf 取樣係數寫死，兩個指標開始互相打架

把帶高從 16 改成 64 之後，`[perf] fb_render 均值` 報 133ms，而 `[perf] AU` 裡的「渲染=」報 30.3ms——**同一份程式碼，兩個指標差 4 倍**。

取樣換算係數是寫死的 `* 20`（80 個帶、每 20 個取樣一次）。帶高變 64 之後變成 20 個帶、每 5 個取樣一次，係數應該改成 `* 5`。這種「魔法數字」一旦和結構參數脫鉤，指標就廢了。

```c
#define FB_SAMPLE_MUL (1280 / BANDH / 5)   /* 係數必須跟結構參數聯動 */
```

**教訓六：效能工具本身也是需要維護的程式碼。** 它的常數跟受測物件耦合得越緊，改一邊就要改另一邊。

## 九、下一步

1. **帶高繼續加大**（64 → 128 / 256）：驗證 DRAM 流量是否還能降，直到渲染段不再隨帶高變化
2. **NEON 化 YUV→ARGB**：設備 CPU（ARMv7 rev5）**支援 neon**，編譯工具鏈也已帶 `-mfpu=neon-vfpv4`，
   之前只是沒人寫 intrinsics。算術部分（3 乘法 + clamp）用飽和指令 `vqmovun` 可以壓到 1/4
3. **換轉置的實作方式**：當前是「讀源側順序、寫輸出側轉置」，天然的快取災難。
   改成「雙線性縮放 + 先縮到 720×1280 再轉置」可能讓記憶體存取變連續
4. **fb 直寫最佳化**：當前是 mmap 寫 3 頁 fb + PAN，有沒有硬體 overlay 路徑
5. **池衝突根治**：讓我們的輸出分配排在廠商 C1 之後

---

**最後一句**：這輪最有價值的產出不是那 17 倍，而是**把「16.9fps」這個假數字變成「8.9fps」這個真數字**。一個虛高的指標會讓你以為「再最佳化一點就夠了」，而真實數字告訴你：還差得遠，但方向明確——不在解碼，在搬運。
