---
title: "Mali400_工作過程總結"
date: 2026-09-30 16:44:04
lang: zh-TW
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
permalink: zh-tw/2026/09/30/mali-01-mali400-md/
---


# 展訊 SC9832A Mali-400 GPU 打通 —— 工作過程總結

> 記錄從"Mali 用不了"到"GLES2 硬件渲染跑通 + 獨立 GPU 跑分程序可用"的完整分析路徑、關鍵決策、失敗路線與最終方案。
> 時間線：09-23 只讀勘察（結論"廢了"）→ 09-29 重大糾錯（其實能用）→ 09-30 bionic 路線打通 PSP 硬件渲染並落地 gpu_bench 跑分。

---

## 1. 任務背景與初始目標

設備是"保留安卓 6.0 內核（3.10.65）+ switchroot 到 Alpine Linux"的展訊 SC9832A 平板，720x1280 fb，2 核 1.3GHz，916MB 內存。用戶的目標：

> 1. Mali-400 到底能不能用？能不能用到顯示 / 視頻 / UI 上？
> 2. 仿魯大師/3DMark 做一個多場景 2D/3D GPU 跑分程序，屏幕上顯示幀率與評分，並在桌面放圖標入口。

## 2. 分析框架：先把"GPU 能用"拆成三層

動手前先建立心智模型——Mali-400 能用，需要三層全部打通：

```
① 內核驅動層   mali.ko 是否 insmod、/dev/mali0 是否出現？
② 用戶態層     有沒有可用的 EGL/GLES 庫？musl 還是 bionic？
③ 應用層       程序怎麼調用？回讀怎麼取像素？顯示怎麼上屏？
```

每一層都有明確的"驗通標準"，不通就往下一層排查。

## 3. 攻堅過程（按時間線）

### 階段 A：09-23 只讀勘察 —— 結論"Mali 用不了"

- 查 `/dev/dri`、`/sys/class/drm` 都不存在；mesa 有 `libEGL.so` 但無 `lima_dri.so`；`mali.ko` 未加載。
- 唯一 Mali DDK `libGLES_mali.so` 是 bionic 二進制，musl 加載不了 → 下結論"用不起來，GPU 不治卡頓"。
- **教訓**：只查了 `/dev/dri`（mesa/DRM 路子）就下結論，漏了 Mali 專有驅動路徑 `/dev/mali0`。

### 階段 B：09-29 重大糾錯 —— 其實能用（關鍵轉折）

- 發現 Mali 專有驅動走 `/dev/mali0`，`mali.ko` 模塊就在本機（`/lib/modules/mali.ko`，4.6MB，vermagic 匹配）。
- `insmod /lib/modules/mali.ko` → `/dev/mali0` 出現。
- 搭 bionic 運行環境：`/system/bin/linker` + `/system/lib` + `egl/libGLES_mali.so` 軟鏈。
- ★ 用 **musl gcc 編出 bionic 程序**成功：`-nostdlib -Wl,--entry=main -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib -lGLESv2 -lEGL`。
- 實測：`GL_RENDERER=Mali-400 MP`，GLES2 跑通，480x272 清屏+quad 300 次 **0.15ms/次 = 864 Mpixel/s**；CPU 軟渲同樣活 **9.7ms → 慢 65 倍**。
- **結論翻轉**：PSP 卡頓真因是我們在用 CPU 幹 GPU 的活（SoftGPU），不是 CPU 不行。

### 階段 C：09-30 bionic 路線打通 PSP 硬件渲染

- 前端 `miniretro_psp_hw`（musl gcc 編的 bionic 程序）：EGL pbuffer + ES2 → `SET_HW_RENDER` → `glReadPixels` → R/B 交換 → `scale_rotate90` → FBIOPAN。
- core = `ppsspp_libretro_hw.so`（bionic 重編，自帶 shim）。
- 實測遊戲加載、Mali GLES2 出畫面，**20~36fps**（軟渲上限 10fps）；乾淨環境 34~38fps（core 總 ~28ms：GL回讀~11.7 / 縮放寫屏~9.1 / core 本身~7）。
- ★ 前端必須在 `av_info` 後調 `context_reset()`，否則 `draw_=NULL` 段錯誤。
- ★ 判活/殺進程一律按 `/proc/<pid>/cmdline`：PPSSPP 把主線程名改成 `{Main}`，`ps -o pid,comm|awk` 必漏。
- 遺留：商業 ISO 開場動畫處凍結/隨機段錯誤（已 ptrace 定位 PPSSPP 內部 IO 死鎖，未修）。

### 階段 D：獨立驗收 / 測試 / 跑分程序（不依賴 PSP）

- `mali_check.c → /root/mali_check`：7 項驗收（mali0/EGL/RENDERER/漸變quad回讀/填充率/回讀速度/CPU對照）+ 第8項掃 PSP maps。
- `gpu_test.c → /usr/local/bin/gpu_test`：全屏圖形測試（三角形+網格，顯示 `GPU:Mali-400 MP` / `FPS` / `READ` / `SCALE`），實測穩定 **32.8fps**。
- `gpu_bench.c → /usr/local/bin/gpu_bench`：仿 3DMark 五場景跑分（2D SPRITE / 2D OVERDRAW / 3D PARTICLES / 3D TERRAIN / 3D SHADER），按純 GPU 渲染時間計分，幾何平均出總分，實測 **6636~9052（GOOD 級）**。
- 桌面"GPU測試"圖標 → `/usr/local/bin/gpu_test` 軟鏈到 `gpu_bench`，點擊走 `patch_launcher_gputest.py` 讓出 fb 範式。

### 階段 E：回讀不可靠天坑（顯示致命，至今未根治）

- 現象：`glReadPixels` 在 pbuffer 上 clear/普通 2D 四邊形回讀**全黑或陳舊紅**；僅帶深度大網格（TERRAIN）偶發正確。
- 已驗證四種辦法**均無效**：① FBO 離屏渲染再回讀 ② 去掉 glFinish 直接讀 ③ eglSwapBuffers 強制解析 ④ 全局開 GL_DEPTH_TEST。
- 根因 = **Mali TBDR 惰性解析 + pbuffer 回讀路徑缺陷**（PSP 前端靠 PPSSPP 核心內部 flush 才正常出圖；`_gldump.c` 最小測試任何 clear/draw 全黑且不別名 fb）。
- 後果：屏幕 3D/2D 場景發黑，只有 CPU 直寫 fb 的 HUD（幀率/分數/標題）可見；**評分與幀率不受影響**（計時只量 render+glFinish，不含回讀）。

## 4. 關鍵決策與教訓

| 決策點 | 選擇 | 理由 |
|---|---|---|
| Mali 能不能用 | 先 insmod 看 /dev/mali0 | 別隻查 /dev/dri，專有驅動有獨立路徑 |
| 用戶態 GL 棧 | 搭 bionic 環境 + musl gcc 編 bionic 程序 | 本機唯一 DDK 是 bionic，mesa 無 lima |
| 架構 | musl 主程序 fork+exec bionic 子進程 | musl 與 bionic 不能共存同一進程 |
| 屏幕出圖 | 暫未根治回讀 | 直渲 fb 的 window surface 探針在 linker 階段崩潰待排 |
| 評分 | 只量 render+glFinish | 繞開不可靠回讀對分數的汙染 |

**經驗教訓**：

1. 查不到 `/dev/dri` 不等於 GPU 廢了——先看專有驅動路徑（`/dev/mali0`）。
2. musl 與 bionic 不能共存於同一進程，但可以兩個進程各用各的（fork+exec 架構）。
3. 回讀（`glReadPixels`）在這套 Mali-400 + pbuffer 上是顯示殺手，不是加速；要出圖優先直渲 fb。
4. 判據落到最末端：Mali 是否真在幹活，看 `GL_RENDERER` / maps 裡 `libGLES_mali.so` / `MaliWorker` 線程，而非 insmod 成功。
5. bionic 獨立程序交叉編譯鏈路已跑通，關鍵腳本/符號補全集中在 `bionic_shim.cpp` 與 `_build_hw.sh`，新病人先複用。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
