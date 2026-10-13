---
title: Mali-400 工作原理：TBDR 延遲渲染與它的壞脾氣
date: 2026-10-12 18:10:00
lang: zh-TW
search: true
categories:
- 嵌入式硬件
tag:
- Mali
- GPU
- TBDR
- OpenGL ES
permalink: zh-tw/2026/10/12/mali-400-tbdr-working-principle/
---

# Mali-400 是什麼

Mali-400 是 ARM 授權的嵌入式 GPU IP 核，在 SC9832A 這類低端 SoC 裡以 MP1（單核）形式出現。它不是獨立顯卡，而是掛在 AMBA AXI 總線上的一個協處理器：CPU（Cortex-A7）與 GPU 共享同一塊 DDR 內存，沒有獨立顯存。軟件棧從上到下是：OpenGL ES 2.0 應用 → libEGL/libGLESv2 用戶態驅動（通常是 Android 變體的 DDK）→ 內核驅動 mali.ko → 硬件。

# 雙核心架構

Mali-400 內部由兩個職責不同的處理器組成：

- **GP（Geometry Processor，幾何處理器）**：負責頂點著色、裁剪，只有 1 個頂點處理單元——幾何負載重時它就是瓶頸。
- **PP（Pixel Processor，像素處理器）**：負責片元著色與光柵化，吞吐約 1 像素/時鐘。500MHz 主頻下純填充上限約 5 億像素/秒。

兩級之間靠「分塊（Tiling）」環節銜接，這正是它與傳統 PC 顯卡最大的區別。

# TBDR：先記賬，後統一畫

傳統 PC 顯卡（IMR，立即渲染）來一個三角形就立刻光柵化，深度測試每個像素都要往返 DDR 讀深度值，帶寬消耗巨大。Mali-400 的渲染分兩遍：

1. **幾何遍**：GP 只計算頂點、做裁剪，然後不畫——把每個三角形登記進它所覆蓋的 16×16 瓦片（tile）列表。
2. **像素遍**：逐瓦片處理。把該瓦片涉及的所有三角形取出來，深度緩衝與顏色緩衝直接放在芯片內部的高速存儲裡完成計算，整個瓦片算完（遇到 resolve/flush）才一次性寫回 DDR。

對沒有獨立顯存、與 CPU 搶 DDR 帶寬的手機 SoC 來說，這套省帶寬的設計是生存必需。代價是「讀回中間結果」這件事在硬件契約上天然不友好。

# 實證出來的 DDK 契約

以下行為是我在 SC9832A 的 Mali-400 DDK（Android 變體驅動）上實測得出的：

1. **從 FBO 做 glReadPixels 讀回恆為 0**：幀數據在瓦片 resolve 之前只存在於片上緩衝，這顆 DDK 的 FBO 讀回通路等於沒有——glClear 後讀回是 0，真實 draw 後讀回也是 0。
2. **glClear 走特殊通路**：TBDR 裡 clear 只是給瓦片設初始值，可以完全不動內存，等回寫時才生效。中途去讀內存自然什麼都讀不到。
3. **pbuffer 表面真實 draw 後讀回正常**：pbuffer 走驅動完整的 resolve 交換路徑，所以數據能落到內存。
4. **裸 framebuffer 結構體餵給 eglCreateWindowSurface 會段錯誤**：這顆 DDK 是 Android ANativeWindow 變體，依賴 buffer queue 的 dequeue/queue 機制，裸的 fbdev window 撐不起這套流程。

# 對實際開發的啟示

- 要把 GPU 畫的內容取出來，別走 FBO 讀回；讓渲染落到 pbuffer/窗口面這類有完整 resolve 路徑的表面，再從那裡讀。
- 「屏上黑」要先分清三種情況：沒渲染、讀回失敗、翻頁失敗——統計 framebuffer 各頁的非零像素比肉眼看截圖可靠得多。
- 性能瓶頸先查幾何：GP 只有一個頂點單元，頂點負載重的場景（比如模擬器放大管線）很容易先卡在 GP 而不是 PP。

---

> **版權聲明**：本文為 whiteleibniz 原創文章，版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
