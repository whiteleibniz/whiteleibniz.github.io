---
title: "netTV 只出 4 影格的真因：VSP mbinfo 記憶體池耗盡觸發硬解降級軟解（不是「第二個 IDR」的鍋）"
date: 2026-10-13 02:30:00
tags:
  - nettv
  - VSP 硬解
  - ION
  - CMA
  - 故障修復
categories:
  - 排障手記
  - 影片播放
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback/) · [繁體中文](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback-en/)

# netTV 只出 4 影格的真因

## 一、現象

展訊 SC9832A 設備上「網路電視」播放 1080p m3u8 直播流，每輪只能出 **4 影格**，然後畫面定格；等餵到第二個 IDR 時必崩（`SIGSEGV addr=0x747474`）或永久掛起，只能靠監控行程重啟，表現為「4 影格一輪」的幻燈模式。

前幾輪排查一直把結論記成「廠商函式庫缺陷：第二個 IDR 必掛死」，並做了繞過（檢測到第二個 IDR 就主動重生）。**這個結論是錯的**——第二個 IDR 只是次生現象。

## 二、真正的根因鏈

關鍵做法：不要只看「崩在哪一輪」，要把**每一輪投餵的返回碼**拉成一條時間線。用正則把日誌裡每個 AU 的 `decRet / frameEffective / consume byte` 抽出來，結果一目了然：

```
AU[  3] sz= 106336 t=5  ret=0   eff=0 cons=106336   ← 第一个 IDR，解码成功
AU[  4] sz=   8983 t=1  ret=0   eff=0 cons=8983
...
AU[  9] sz=  13967 t=1  ret=0   eff=0 cons=13967    ← 出第 4 帧
AU[ 10] sz=  17116 t=1  ret=-3  eff=0 cons=17116    ← ★ 突变点
AU[ 11] sz=  13424 t=1  ret=-9  eff=0 cons=13424    ← 从此恒 -9
AU[ 12..35]                 ret=-9  needIVOP:1 ...
```

拉出 AU[10] 那一輪的廠商日誌，真因就寫在那兒：

```
VSP_malloc_mbinfo_cb, 1770, idx: 4, size_mbinfo: 653824
ioctl c0144900 failed with code -1: Out of memory
[ion] C1 /dev/ion alloc(653824,heap=0,align=8) FAILED rc=-12
[ion] get_phy_addr: heapID=0 base=0x0 -> fail
mPmem_mbinfo[4]: get phy addr fail -1
H264Dec_init_picture, 648, mbinfo memory is not enough
H264Dec_Process_slice, 117, error_flag=0x2
decRet: -3
failed to allocate memory.
change to sw decoder.
```

下一輪立刻：

```
onQueueFilled, 1122, change to sw decoder, mThumbnailMode: 0
H264Dec_ReleaseRefBuffers, 32
openDecoder, lib: libomx_avcdec_sw_sprd.so
decRet: -9, needIVOP: 1, SPS:0, PPS:0
```

串起來就是：

1. VSP 每解約 2 影格就要一塊 **653824 位元組的 mbinfo**（宏塊資訊），而且**從不 free**，按 idx 遞增申請；
2. CMA 連續記憶體池只有 ~7MB，扣掉輸出影格緩衝 3.1MB、輸入緩衝 1.5MB，只夠放 **4 塊** mbinfo；
3. 第 5 塊 `ion_alloc` 返回 `-ENOMEM` → `decRet=-3`；
4. 元件的處理是 **永久切換軟體解碼器**（`libomx_avcdec_sw_sprd.so`）——這是一道**單向門**；
5. 軟解路徑拿不到之前餵進去的 SPS/PPS（`SPS:0 PPS:0`），於是每輪返回 `-9 needIVOP`（要 I 影格），永遠出不了影格；
6. 畫面定格在 4 影格，再餵第二個 IDR 時，在軟解上下文裡崩掉或者掛死。

**所以「第二個 IDR 崩潰」不是 bug，是硬解已經死掉之後的必然結果。**

## 三、修法（三處，都圍繞「絕不能讓它切軟解」）

### 1. mbinfo 分配失敗時復用舊塊

原先的 LRU 復用只在「池滿（`g_c1r_n >= C1_REUSE_MAX=5`）」時觸發。可實際 CMA 只夠 4 塊，第 5 塊申請直接失敗，**永遠輪不到復用邏輯**。改成兩條觸發路徑：池滿 **或** 本次 `ion_alloc` 失敗。

```c
static int c1_reuse(void *self, const char *name, unsigned size)
{
    if (size != C1_REUSE_SZ || g_c1r_n <= 0) return 0;
    int s = g_c1r_next % g_c1r_n;   /* 注意是 %g_c1r_n，不是 %MAX */
    g_c1r_next++;
    ...  /* 把舊塊的 fd/base/handle/PA 填進新的 MemoryHeapIon 物件 */
    map_add(g_c1r[s].buf_fd, g_c1r[s].pa, size);
    return 1;
}
```

代價是有可能復用到仍被 DPB 參照的塊（可能花影格），但和「永久軟解」相比，這個代價值得付。

### 2. 分配失敗時逐級降低對齊重試

原來的對齊演算法是 `order = ceil(log2(size))`，上限 8。639KB 的 mbinfo 會被算成 **1MB 對齊**申請，CMA 很快碎成沒法用的大塊。失敗時按 `6/4/2/0` 逐級降對齊重試，只改對齊不改大小，能多擠出一兩塊。

### 3. 檢測到「切軟解」立刻主動重生

軟解是單向門，在裡面掙扎沒有任何意義。廠商日誌會打 `change to sw decoder`，在 `__android_log_print` 勾子裡抓這個串，置標誌位，投餵迴圈下一輪立即 `usleep(800ms)` 排空 DMA 後 `_exit(9)`，讓監控 0.15s 拉起一個乾淨的硬解行程。

## 四、順帶挖出來的坑：根分區 100% 滿

排查過程中發現的另一件事：`df -h /` 顯示 6.2G 根分區**一個位元組都不剩**。後果是 `curl` 寫 `/tmp/nettv.raw` 失敗（退出碼 23），播放器把它誤判成「頻道源不可達」（退出碼 98），表現跟源失效一模一樣。

清掉三個除錯日誌（`btud_dbg.log` 326MB、`nt_live.log` 239MB、`dis.txt` 158MB）後釋放 724MB。

**教訓**：嵌入式設備上「網路失敗」和「磁碟寫不進去」在應用層看起來是同一個現象，排查網路問題前先 `df`。

## 五、另一條紀律：SSH 命令必須短

我跑了一條前台 gcc 編譯命令（超過 20 秒），被本地沙箱 SIGTERM 掉，殘留的連線把設備上的 sshd 拖死——22 埠變成 `Connection refused`，遠端無法恢復，只能斷電重啟。

**在資源緊張的嵌入式設備上，長任務一律「背景腳本 + 短輪詢」，前台命令永遠包 `timeout` 且控制在 20 秒內。**

## 六、經驗總結

1. **把逐輪返回碼拉成時間線，比盯崩潰點有用得多**。崩潰點往往在因果鏈的最末端（本例是第二個 IDR），真正的突變點（本例是 `decRet` 從 0 變 -3 再變 -9）要靠時間線才能看見。
2. **警惕「單向門」狀態切換**。硬體解碼器資源不足時切軟體解碼，聽著很優雅，但如果切過去之後拿不到 SPS/PPS、又切不回來，那就是死路。遇到單向門，正確的策略是**檢測它並整體重生**，而不是在降級狀態裡繼續投餵。
3. **記憶體池類故障要看「申請序號」**。`idx: 4` 這個數字直接告訴你池子容量是 4，而程式碼裡寫死的 `MAX=5` 就是永遠不會觸發的死邏輯——**用常數描述資源上界，一定要用實測值，不要用估計值**。
4. **對齊方式會決定 CMA 能用多久**。`align = ceil(log2(size))` 對非 2 的冪尺寸是很大的浪費，639KB 按 1MB 對齊，碎片速度是 4KB 對齊的幾十倍。
5. **排查前先做環境體檢**（`df`、`free`、路由）。本例如果一上來就 `df`，能省掉一整輪「源是不是又掛了」的誤判。

---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文連結：https://whiteleibniz.github.io
