---
title: PSP 硬渲恢復覆盤：從 20fps 到 33fps
date: 2026-10-12 18:00:00
lang: zh-TW
search: true
categories:
- 排障手记
tag:
- PPSSPP
- Mali
- ARM
- bionic
permalink: zh-tw/2026/10/12/psp-hardware-rendering-recovery/
---

# 背景

手頭有一臺展訊 SC9832A（2×Cortex-A7 @1.3GHz，Mali-400 MP1，720×1280 豎屏）的 Linux 設備，跑著自制 LVGL 桌面 + libretro 模擬器前端。PSP 模擬走 ppsspp_libretro core + 自研 miniretro 前端，此前一直走軟件渲染，只有 20fps。歷史上（更早的固件版本）曾實測過硬渲 34-38fps，因此目標明確：把硬渲修回來。

# 現象與排查路徑

整個排查經歷了三層根因，一層比一層深。記錄如下，希望後來的朋友少走彎路。

## 第一層：reloc type 17，新 core 無法加載

我嘗試用設備上新升級的工具鏈（gcc14 + binutils 2.43）重編 core，結果 dlopen 直接報 `unknown reloc type 17`。經過對最終 .so 的重定位表逐一排查，確認 17 號是 `R_ARM_TLS_DTPMOD32`——TLS 動態重定位。

根因不是新編譯的 .o 引入了 TLS，而是：同一批 .o，老 binutils 鏈接時會做 TLS GD（global-dynamic）→ LE（local-exec）的靜態收斂，最終產物裡動態 TLS 重定位為 0；新 binutils 2.43 不再做這個收斂，於是 4 個 DTPMOD32 留在了動態重定位表裡，而設備上的老 Android bionic linker 根本不支持動態 TLS。

我做了三步嘗試：

1. 把 4 處 `std::call_once` 改成原子標誌交換，把 sol2 頭文件裡的 `thread_local` 去掉；
2. 提供 non-TLS 版的 `__cxa_get_globals` shim，防止 libstdc++.a 的 eh_globals.o（TLS 版實現）被鏈接器拉入——注意 shim 必須放在 libstdc++.a **之前**參與鏈接，放後面會 multiple definition；
3. 試過 `-ftls-model=local-exec` 重編，被鏈接器以 `R_ARM_TLS_LE32 not permitted in shared object` 拒絕（shared lib 裡不能用 local-exec）。

以上做完，TLS 動態重定位確實清零了，但新 core 依然在 dlopen 時崩。用二分法關掉 init_array 裡的構造函數，定位到崩在 libstdc++ 的 `std::ios_base::Init` 全局構造；而老 core 裡同一個構造函數卻能正常跑。新工具鏈的構造函數鏈與老 bionic linker 之間還有更深的不兼容，我決定不再深挖——**老 core 本來就完好，回退**。

## 第二層：FBO 讀回黑洞

換回老 core 後 GL 後端能激活，但屏幕全黑，抓屏非黑像素佔比 0.08%。這裡我走了最長的彎路：之前我把前端改成了「自建 FBO → PPSSPP 渲染到 FBO → glReadPixels 讀回 → 軟件縮放旋轉 → 寫 framebuffer」的路徑，並且加過 POT 紋理、緩存掃除、rmmod/insmod 等各種排除實驗。

最終用一個專門寫的 EGL 探針程序做出判決：**這顆 Mali DDK 上，從 FBO 做 glReadPixels 讀回的內容恆為 0（連 glClear 都不行），但從默認幀緩衝（pbuffer）在真實 draw 之後讀回是正常的**。也就是說，0af7630 時代能跑通的老前端，`hw_get_current_framebuffer()` 返回的本來就是 0、讀的本來就是默認面——是我自己後來改壞了。

修復：把前端恢復成歷史驗證過的路徑——FB0 直讀、EGL_SURFACE_TYPE 只留 PBUFFER_BIT、刪掉自建 FBO 全套代碼。立即出畫面。

## 第三層：useEmuThread 與 GL 上下文

PPSSPP 的 libretro glue 有個邏輯：GL 後端激活時（`GetGPUCore() == GPUCORE_GLES`）會啟用 EmuThread，把所有 GL 調用搬到 core 自己的線程上跑。而 EGL 上下文 current 在前端線程，於是 GL 全部無效。core 源碼裡 `useEmuThread = false;` 一行修復。這個問題在老 core 上不存在（當年的構建已等價處理），但如果你要重編 core，這裡是必踩的坑。

# 額外的坑

- **fb mmap 斷連**：fb 驅動被多次 FBIOPAN/FBIOPUT 實驗折騰後，新進程 mmap /dev/fb0 的寫入到不了真實顯存（pread 讀回全 0，連 memset 都無效），重啟才恢復。診斷方法：用 python 的 `os.pwrite/os.pread` 走文件路徑驗證讀寫一致性，再對比進程自己 mmap 區域的內容。
- **重啟後靜默退軟渲**：設備重啟後必須 `mount` Android 分區（保證 /system/lib 的 EGL 庫鏈路存在）+ `insmod mali.ko`，否則 EGL 初始化失敗，前端靜默退回軟渲——表面症狀只是 fps 從 33 變 20。
- **bionic sigset_t 只有 16 字節**：在裸 bionic 探針裡裝信號處理器時，如果按 glibc 的 128 字節排布 sigaction 結構體，會靜默失敗。
- **bison linker 拒收 local-exec**：shared library 裡 `-ftls-model=local-exec` 編出的 `R_ARM_TLS_LE32` 不被允許，TLS 修復只能走「源頭消滅 TLS」路線。

# 結果

老 core + 恢復後的前端，實測 33fps（軟渲 20fps），性能提升 65%。遺留問題：個別遊戲（如某個旋轉立方體 demo）在硬渲下仍黑屏，懷疑其渲染目標用法踩了 FBO 黑洞，待查。

# 方法論總結

1. 改前端 GL 邏輯之前，先寫一個獨立 EGL 探針，把「這顆 GPU 什麼通路是好的」實證清楚，再動主程序。
2. dlopen 失敗先看動態重定位類型直方圖，新老產物的 ELF 元數據 diff 往往直接給出答案。
3. 「屏上黑」不等於「沒畫面」：先統計 framebuffer 各頁非零像素，再區分「沒渲染」「讀回失敗」「翻頁失敗」三種情況。

---

> **版權聲明**：本文為 whiteleibniz 原創文章，版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
