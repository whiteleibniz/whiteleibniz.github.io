---
title: "Mali400原理與移植學習Wiki"
date: 2026-09-30 16:44:04
lang: zh-TW
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
permalink: zh-tw/2026/09/30/mali-05-mali400-wiki-md/
---


# HT0 Mali-400 原理與移植學習 Wiki

> 這份文檔不是操作手冊，而是**原理課**：講清楚這顆 Mali-400 為什麼能在這臺"安卓內核 + Alpine 用戶態"的機器上跑起來、安卓原來怎麼做、我們為什麼改成現在這樣、每一行關鍵代碼在幹什麼。
> 讀完你應該能：面對一臺"安卓內核 + 別的用戶態"的 Mali 設備，自己分析出該怎麼把 GPU 點亮。

---

## 0. 一句話先建立直覺

> Mali-400 不是顯示控制器，而是一顆**需要內核驅動 + 用戶態 GL 棧 + 正確 ABI 橋**才能點亮的 3D 渲染 GPU。
> 安卓用一整套 bionic 服務（SurfaceFlinger + hwcomposer + libGLES_mali）替你把這套棧搭好了；
> 我們把這套棧**用最小的交叉編譯橋**重寫了一遍，跑在 Alpine 的 musl 用戶態上。

---

## 1. 硬件長什麼樣

這顆芯片平臺是展訊 SC9832A，GPU 是 **Mali-400 MP**（ARM 的 Utgard 架構，OpenGL ES 2.0，TBDR 瓦片渲染）：

```
                ┌──────────────────────────────┐
                │       展訊 SC9832A AP        │
                │  ┌──────────┐   ┌───────────┐ │
                │  │ sprdfb    │   │ Mali-400  │ │
                │  │ (dispc)  │   │ (GPU)     │ │
                │  │ /dev/fb0 │   │ /dev/mali0│ │
                │  └────┬─────┘   └────┬──────┘ │
                └───────┼──────────────┼────────┘
                    掃描輸出        渲染目標(buffer)
                    顯示器          GPU 畫進內存再由 dispc 顯示
```

兩條"輸出"路徑，分工完全不同：

| 部件 | 幹什麼 | 用戶態看到 |
|---|---|---|
| sprdfb / dispc | 把內存裡的像素掃到屏幕 | `/dev/fb0`（最終輸出口） |
| Mali-400 | 把 3D/2D 圖形算進內存 buffer | `/dev/mali0` + EGL/GLES |
| VSP | 視頻硬解（H.264 等） | `/dev/sprd_vsp` |
| GSP | 2D 加速（縮放/YUV→RGB） | `/dev/sprd_gsp` + ION |

**關鍵認知**：GPU **不能接管顯示**——它只把圖畫進 buffer，再由 dispc 顯示。安卓靠 SurfaceFlinger 的 overlay 圖層完成這最後一步，本機沒有這套東西，所以我們的程序要自己"GPU 畫 → 回讀 → 寫 fb"。

---

## 2. GPU 能用的三層模型（最重要的分析框架）

任何 Mali 能用，都要三層全通。**每一層都有明確的"驗通標準"**，不通就停在那層查，別跨層瞎試。

```
① 內核驅動層   mali.ko 加載了嗎？/dev/mali0 出現嗎？
               驗通：insmod rc=0；ls /dev/mali0 有設備節點
② 用戶態層     有可用的 EGL/GLES 庫嗎？ABI 對得上嗎？
               驗通：eglInitialize 成功；GL_RENDERER=Mali-400 MP
③ 應用層       程序怎麼調？像素怎麼取？怎麼上屏？
               驗通：gpu_bench 出分；PSP 前端出畫面
```

我們這次幾乎每踩一個坑，都是"誤以為在上層，其實卡在下層"：

- RENDERER 不是 Mali → 不是程序錯，是 mali.ko 沒 insmod（第①層）；
- bionic 程序崩 before main → 不是邏輯錯，是缺 `-Wl,--entry=main`（第②層編譯）；
- 屏幕發黑 → 不是畫錯，是 pbuffer 回讀在 TBDR 下拿不到幀（第③層顯示）。

---

## 3. 關鍵概念逐個講透

### 3.1 bionic vs musl —— 為什麼需要 ABI 橋

本機用戶態是 Alpine 的 **musl libc**；而 Mali 唯一的 DDK `libGLES_mali.so` 是安卓 **bionic libc** 二進制。兩者 ABI 不兼容（符號名、結構體佈局、time_t 寬度都不同），musl 直接 `dlopen` 會崩。

**我們的橋**：

- 內核讀 ELF 的 INTERP 自動加載 `/system/bin/linker`（bionic 動態鏈接器），讓 bionic 程序自己跑；
- musl gcc 編譯但**不鏈 musl libc**，改用 `-nostdlib -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib -lGLESv2 -lEGL -lc` 去鏈 bionic 的 libc；
- 少量 musl 特有符號（time64、errno、tls、getentropy 等）用 `bionic_shim.cpp` 補樁。

### 3.2 EGL pbuffer + GLES2 context —— GPU 畫在哪

```c
// 創建離屏 pbuffer surface（不在屏幕上，畫進內存）
EGLSurface surf = eglCreatePbufferSurface(dpy, cfg, NULL);  // cfg 含 EGL_DEPTH_SIZE,16
eglMakeCurrent(dpy, surf, surf, ctx);
// 之後所有 gl* 都渲染到這個 pbuffer 的默認 framebuffer
```

PSP 前端與 gpu_bench 都用這套：GPU 把圖渲染進 pbuffer，再 `glReadPixels` 取回 CPU，最後縮放旋轉寫 `/dev/fb0`。

### 3.3 glReadPixels 回讀與 TBDR 惰性解析（最坑的一點）

Mali-400 是 **TBDR（Tile-Based Deferred Renderer）**：它把屏幕切成瓦片，延遲到 `glFinish`/swap 才真正把瓦片解析（resolve）進內存。

- 在 pbuffer 上，**回讀時機不對就拿不到這一幀**——表現為 clear/普通四邊形回讀全黑或陳舊紅，只有帶深度的大網格（驅動被迫提前解析）偶發正確。
- 已驗證 FBO / 去 glFinish / eglSwapBuffers / 開深度 四種辦法均無效，根因在驅動層 TBDR + pbuffer 回讀路徑，應用層繞不開。
- 對策：評分計時只量 `render+glFinish`（不含回讀），不受汙染；要真出畫面得改"直渲 fb 的 window surface"（不走回讀）。

### 3.4 字節序 R/B 交換

`glReadPixels` 回讀的是 **fb 真實字節序**，與驅動內部可能相反——依 PSP 前端實測：`g_swap_rb = 0`（**不交換** R/B）。回讀後直接按 `[R,G,B,X]` 寫 fb 即可。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
