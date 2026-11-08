---
title: nettv-15：五連證偽——為什麼“想當然”的優化全部無效，以及裸 clone 線程是怎麼把設備搞重啟的
date: 2026-10-20 11:30:00
categories:
  - [嵌入式, 网络电视硬解]
  - [Linux, 性能优化]
tags:
  - sprd
  - SC9832A
  - VSP
  - ION
  - 性能分析
  - ARM
permalink: zh-tw/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash-en/)


> 系列第 15 篇。上一篇（nettv-14）我們把“卡”定性成了 ptsync 正反饋和 O_SYNC 日誌，
> 拿到 17fps 基線。這一篇是從 17fps 往 25fps 衝的過程——**基本全是反面教材**：
> 五個看起來很合理的優化，四個被 A/B 實驗直接證偽，一個把設備重啟了兩次。
> 結論比過程重要，所以先把結論拍在前面。

## 一句話結論

**每幀 116ms 的賬：解碼 21ms + 拷貝 43ms + 渲染 32ms。真正的瓶頸是 3MB 的 memcpy，
而它慢，是因為 ION buffer 是非緩存映射。** 所有對“解碼/渲染/流水線”的優化，
在 uncached 內存這堵牆面前都是隔靴搔癢。

## 背景：116ms 的牆

瀘縣 1080p 直播源，每 AU（一個訪問單元 ≈ 一幀）實測：

| 段 | 耗時 | 內容 |
|---|---|---|
| DRIVE | 21.1ms | 廠商庫同步解碼，其中硬件只算 14ms |
| 讀幀 | 43.4ms | 3MB 的 `memcpy(uncached ION → 緩存暫存)` |
| 渲染 | 31.8ms | NV12→ARGB + 旋轉合成 + 寫 fb |

監控 `[STAT] fps_x10=157`，即 15.7fps。目標 25fps，意味著總賬必須從 116ms 壓到 40ms 以內。
下面是我們依次試過的五件事。

## 證偽一：簽名掃描降頻——“讀幀 45ms 裡有 25ms 是掃描”

邏輯上無懈可擊：每幀對 Y/UV 平面做內容簽名（判重複幀用），步長 256 抽樣也要
8K+4K 次訪問，看著就像大頭。

改成“週期籤 + 回調計數判重”後 A/B 實測：

```
A 組(降頻後): 讀幀 44.6ms
B 組(每幀全籤): 讀幀 44.8ms
```

**差異是噪聲。** 簽名掃描從來就不是瓶頸，全部耗時是 memcpy 的。
教訓：你以為的“大頭”和真正的大頭之間，只隔一次單變量 A/B。

## 證偽二：fb_render 查表化——“消除每像素 3 次乘法”

BT.601 轉換 `r=y+f(v)` 這類公式，教科書式優化是預計算係數表：

```c
static short sRV[256], sGU[256], sGV[256], sBU[256];
static inline unsigned pxlut(int yv, int u, int v) {
    int r = yv + sRV[v];
    int g = yv - sGU[u] - sGV[v];
    int b = yv + sBU[u];
    ...
}
```

三乘六 clamp 變成四查表三加法，理論上很美。實測：

```
A 組(LUT):   渲染 39.3ms，fb_render 均值 39ms
B 組(標量):  渲染 32.5ms，fb_render 均值 36ms
```

**查錶慢了 20%。** Cortex-A7 的硬件乘法器一個週期完事，4 張 256 項表的
隨機索引訪問（相鄰像素的 U/V 跳躍）帶來的是 L1/L2 miss。我們最後把默認值
翻了回來（`NETTV_LUT=1` 才啟用），只留代碼作 A/B 教材。

## 證偽三：直讀 ION 省掉 memcpy——“copy 就是浪費”

既然 memcpy 佔 43ms，那讓渲染直接讀 ION buffer 不香嗎？`NETTV_STAGE=0` 就是
這個開關。實測：

```
5.8fps，fb_render 均值 335ms
```

**比拷貝版慢 10 倍。** 原因是 ION 分配時 `flags=0`，映射出來的是**非緩存
（uncached）內存**：copy 版是一次順序大塊讀（DRAM  burst、硬件預取都舒服），
之後所有訪問都落在緩存；直讀版是每像素一次 uncached 事務，每筆都是完整總線
週期。排序掃描/混合訪問在 uncached 內存上等於自殺。

**3MB memcpy 不是浪費，是最優解。** 但“43ms”這個數字本身成了新靶子。

## 翻車四：裸 clone 雙線程流水線——兩次重啟

到這一步單線程已經砍不動了，賬本上唯一的出路是流水線：
worker 解碼+拷貝，另起線程做渲染，兩者重疊。
裸 bionic（-nostdlib）沒有 pthread，我們直接用 `clone` syscall 拉了線程：

```c
#define CLONE_VM 0x00000100
long r = syscall(120 /* clone ARM EABI */,
                 CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD,
                 sp, 0, 0, 0);
if (r == 0) { fn(); syscall(1, 0); }
```

20 秒試跑，功能全對：render 線程啟動、DRIVE 降到 18ms、牆鍾 80ms。
換成 60 秒長測——**設備重啟了，而且是一天兩次**（連 `/tmp` 裡的二進制都被
截成 0 字節，典型的掉電級文件系統損壞）。

覆盤抓到的根因有兩條，都是“裸線程”特有的雷：

1. **沒設 TLS**。`clone` 時沒給 `CLONE_SETTLS`，新線程跑的是父線程的 TLS。
   而 render 線程裡調了 bionic 的 `snprintf`（日誌打印）——bionic stdio 內部走
   `__nbuf` 線程局部緩衝池，也就是 **TLS**。子線程拿著別人的 TLS 寫，線程結構
   被踩壞，什麼時候炸取決於時序（所以 20s 不炸、60s 炸）。
2. **共享信號 handler**。`CLONE_SIGHAND` 下 SIGSEGV/SIGALRM 的 handler 可能被
   任一線程執行，而 handler 裡有 `siglongjmp`——跨線程 longjmp 是未定義行為。

修復（v16i）：render 線程入口先 `rt_sigprocmask` 屏蔽進程handler 的所有信號；
線程內禁用一切涉 TLS 的 libc 調用（`P`/`snprintf` 改成手寫 `write` syscall，
memcpy 是純彙編、不用 TLS，保留）。修復後 60s 長測**不再崩**。

> **裸 clone 線程鐵律**：子線程內只允許 raw syscall 和編譯器內建的 memcpy；
   進線程第一件事是屏蔽信號；snprintf/P 宏一律算違禁品。

## 負優化五：修好之後，流水線反而更慢

不崩只是拿到了實驗資格，單變量對照的結果是：

```
A 組(雙線程流水線): 12.3fps，牆鍾 80ms（口徑含重疊）
B 組(單線程):       15.7fps，牆鍾 116ms
```

**慢 22%。** 歸因：
- DRIVE 確實從 21ms 降到 18ms，但 **memcpy 43ms 一動不動**（這是鏈尾瓶頸）；
- 兩個線程都在猛吃內存帶寬，L2 爭搶讓雙方的“讀”都變慢；
- 握手的 `usleep(200µs)` 粒度把本來想做流水的並行又卡回半串行；
- render 的 32ms 被 worker 的 62ms 完全掩埋，等於白乾。

安卓的 BufferQueue 能成立，前提是“輸出 buffer 多個輪轉 + 解碼器異步”；
我們 `g_nout=1`、單路輸出、解碼同步阻塞，把渲染線程掛上去也只是換了個
地方串行。**架構不匹配時，抄形態沒用。**

## 那到底怎麼才能快？

三個數放在一起，路線圖自己就出來了：

```
DRIVE 21ms（其中硬件解碼 14ms，庫側文書 7ms —— 已接近極限）
memcpy 43ms（3MB uncached —— 唯一的靶子）
渲染 32ms（可被流水線掩埋，但掩埋它沒有淨收益）
```

- **第一刀：ION 改緩存映射。** 分配時帶 `ION_FLAG_CACHED`，每幀 `ION_IOC_SYNC`
  做 invalidate。memcpy 從“uncached 順序大塊”變成“cached 大塊”，預期 43ms→10ms
  量級，總牆鍾 116→約 75ms，**20fps+**。風險是 DMA 一致性（VSP 寫、CPU 讀 cache
  stale → 花屏），必須灰度。
- **第二刀：DRIVE 庫側 7-18ms 的 phys ioctl 緩存化**（fd→PA 建表，一次查長期用）。
- **第三刀：fb_render 的 32ms**，在 ARMv7 編譯禁 NEON 的前提下做循環展開和
  8 像素預取。
- **玄學刀：顯示驅動 overlay。** 如果 sprd DPU 能直接吃 NV12+旋轉，CPU 合成整段
  消失——這是追平安卓 50fps 的真正大殺器，但需要 recon 驅動能力。

## 方法論沉澱

1. **“一眼可見的大頭”必須 A/B 驗證。** 本輪五個裡有三個（簽名、LUT、直讀）
   在實測面前翻了車，其中兩個翻得反直覺。
2. **每加一個優化，同時 A/B 一箇舊行為做反證。** 沒有 B 組就沒有結論，
   只有感覺。
3. **性能歸因要到內存屬性這一層。** uncached/cached、順序/隨機、命中/miss，
   比算法層面的優化更能解釋數量級差異。
4. ** risky 的運行時抽象（裸線程）上線前，先確認它能用滿 3 倍的時長。**
   20 秒能跑不代表 60 秒能跑——時序性 bug 不挑時間，只挑概率。
5. 設備重啟 = `/tmp` 文件被截斷的第一嫌疑對象。md5 對不上先懷疑掉電，再懷疑代碼。

---

*上一篇：nettv-14《從 6.3fps 到 17fps：O_SYNC 日誌與一次 dup2 誤判》*
