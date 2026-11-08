---
title: "netTV 硬解（40）：第二 IDR 取證三件套工具化——判決代碼要先於判決被測試"
date: 2026-11-09 02:40:00
tags:
  - 嵌入式
  - 展訊 SC9832A
  - VSP
  - 硬解
  - 調試方法
categories:
  - [項目筆記, netTV 硬解]
  - [嵌入式, 展訊平台]
  - [工程實踐, 調試方法]
copyright: "本文由 whiteleibniz 原創，採用 CC BY-NC-SA 4.0 協議，轉載請註明出處 whiteleibniz.github.io"
---

> 🌐 語言：[简体中文](https://whiteleibniz.github.io/2026/11/09/nettv-40-forensic-toolkit-second-idr/) · [繁體中文](https://whiteleibniz.github.io/2026/11/09/zh-tw/nettv-40-forensic-toolkit-second-idr-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/09/nettv-40-forensic-toolkit-second-idr-en/)

> 系列第 40 篇。設備連續第 12 輪沒上電，在線實驗繼續排隊。上輪（39）已用靜態審計把我方
> 代碼嫌疑清場，本輪做的是純工具活：把 11-08 定下的「第二 IDR SIGSEGV 在線取證三件套」
> 從三條散落的計劃落成**兩個可以直接上機的零改碼工具**，設備一上電就能跑。

## 1. 三件套是什麼、為什麼是它

第二 IDR 必 SIGSEGV（addr=0x747474）這個頭號問題，39 篇已排除我方越界寫，嫌疑收斂到
「廠商庫內部」和「輸入 buffer 頭信任」。要再往下分，只有兩條路：在線抓現場，或者繼續猜。
猜不值錢，所以本輪把取證方案固化成工具。三件套分別是：

1. **segv 現場 PC → 符號映射**：崩潰處理器輸出的 `pc-off` + `lib=` 只是「庫內偏移」，
   要落到「哪個函數」才好歸因；
2. **`NETTV_IDRREPLAY=K` 重投二分**：v32 內置的診斷開關（2026-10-19 加的，一直沒機會跑），
   捕獲首 IDR 後零累積連投 K 次——重投即掛是「組件狀態」問題（A），重投後才掛是
   「累積漂移」問題（B），修法完全不同；
3. **`[inbuf]`/`[split]` 輸入側日誌**：端口重配後輸入 buffer 頭被改的假設，靠它驗證。

關鍵前提核對：v32 現網二進制裡這三個探針**全部已內置**，所以整套取證不需要編譯任何新代碼，
符合項目「離線只產零改碼測量工具」的鐵律。

## 2. 工具一：`_pcmap.py`（PC 端，符號映射器）

輸入就是 segv 日誌原文。解析兩類行：

```
*** SIGSEGV sig=b addr=00747474 step: feed-idr
  >>> pc-off=0x3d7c lib=/system/lib/libstagefright_sprd_h264dec.so
```

對每條 `(lib, pc-off)`，在本地 ELF（複用 38 篇那套極簡動態符號表解析器）裡二分找
「值 ≤ off 的最近符號」，輸出形如：

```
pc-off=0x3d7c lib=libstagefright_sprd_h264dec.so
  → _ZN7android14SPRDAVCDecoder20onPortFlushCompletedEj+0x0 [符號內]
```

本地沒有的庫會明確提示「需從設備拉取」而不是靜默跳過——**缺證據要大聲說出來**，
這也是這輪反覆強調的原則。用真庫自測：已知 `SPRDAVCDecoder::onPortFlushCompleted`
在 0x3d7c，映射器精確命中；換一個不存在的庫名，正確報缺。

## 3. 工具二：`_ntseg2.sh`（設備端，兩臂取證編排）

單腳本一次跑完兩臂（每臂默認 600s ≈ 4×150s 故障週期，符合泊松觀測鐵律）：

- **A0 基線臂**（`IDRREPLAY=0`）：歷史穩定復現配置，**必須崩**，否則整輪
  `NOT_REPRODUCED` 禁止下結論——這是把 11-03「對照臂不復現時實驗臂的『潔』不具判決力」
  的方法論直接搬過來；
- **R 重投臂**（`IDRREPLAY=3`，`NTSEG2_K` 可調）：首 IDR 連投 3 次。

兩臂之外順手取證（不作判據）：每 20s 逐線程 SigBlk 掩碼巡檢（H2 判據命中計數）、
每 90s 快照 worker 的 maps（崩潰後進程沒了，lib 基址靠它補）、segv.log 按臂歸檔。

判決是純函數，8 組模擬分流自檢全過：狀態 A、狀態 B、R 不崩、基線不復現、零幀判廢、
env 未生效判廢、重投完成後久掛、門檻優先於結果。**兩臂跑完 PC 端只需輪詢一個
`/tmp/ntseg2.log`**，收尾一律 SIGTERM + usleep 900ms，絕不碰解碼中的進程。

## 4. 本輪最值錢的教訓：判讀代碼自己也會撒謊

寫採樣器時第一版用 shell 的 `case "$sb" in ????)` 做「SigBlk 長度守衛」——只匹配 4 或
8 個字符的值。但真實的 `/proc/.../status` 裡 SigBlk 是 **32 位十六進制串**
（如 `00000000000000000000000000000400`），case 守衛會讓所有真實值全部落進
`*) continue`，**掩碼巡檢靜默採到恆 0**，最後日誌裡「maskedhit=0」會被讀成
「沒有線程屏蔽 SIGSEGV」——一條徹頭徹尾的假陰性證據。

這和 11-07 那個「curl 探針只認 200 把 206 的好源判死」是同一類錯誤：
**測量工具自身的解析 bug 會偽裝成被測系統的正常表現**。修法也一樣——工具的取值邏輯
必須先用真實數據形態測試過（SigBlk 用 32 位串測），而不是用想當然的短串。現在代碼裡
留了註釋：`# 真實 SigBlk 是 32 位十六進制串, 不能用 case 長度守衛——會漏採`。

## 5. 下次在線怎麼跑（約 22 分鐘）

```
# 上傳 outputs/_ntseg2.sh 後設備端執行：
sh /tmp/_ntseg2.sh 600
# 輪詢 /tmp/ntseg2.log，先看兩臂 GATE V= 全 1，再看 VERDICT
# 拿到 segv 現場後 PC 端：
python outputs/_pcmap.py <segv日誌>
```

INVALID 整輪重跑、禁改碼；NOT_REPRODUCED 則把 A0 延到 1200s。拿到判決後再決定走
GOP 邊界軟復位（A）還是洩漏排查（B）。

---

*本文由 whiteleibniz 原創，採用 CC BY-NC-SA 4.0 協議，轉載請註明出處 whiteleibniz.github.io*
