---
title: "Mali400_故障排查手冊"
date: 2026-09-30 16:44:04
lang: zh-TW
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
permalink: zh-tw/2026/09/30/mali-03-mali400-md/
---


# 展訊 SC9832A Mali-400 GPU 故障排查手冊 —— spd-box

> **用途**：Mali/GPU 程序起不來、RENDERER 不對、回讀黑屏、bionic 程序崩潰時，按本手冊定位根因。每一行命令均取自設備實測。
> **使用方式**：先看 §1 分層速查總表定位到層 → 跳到對應章節 → 用「定位命令」確認 → 按「修復」處理。
> **配套**：原理 Wiki（§3 概念）、工作過程總結（階段 B/E 決策）為精簡版；本文是全量版。

---

## 0. 排障紀律（先讀，違反會浪費時間）

1. **分層定位，不跨層瞎試**：①內核(mali.ko→/dev/mali0) → ②bionic 環境(linker/lib/軟鏈) → ③編譯(musl gcc 編 bionic) → ④應用(gpu_bench/gpu_test/PSP前端) → ⑤回讀/顯示(glReadPixels/TBDR)。哪層不過只查該層及其上游。
2. **先看現象再看進程**：RENDERER 不對先跑 `/root/mali_check`；崩潰先看 `dmesg | tail`。
3. **殺進程一律按 `/proc/<pid>/cmdline` 匹配**，禁止 `ps -o pid,comm|awk`（PPSSPP 主線程名是 `{Main}`，必漏）。
4. **bionic 程序輸出用 `write(1,...)` 不用 `printf`**（abort 時緩衝區丟失看不到現場）。

---

## 1. 分層故障速查總表（一頁定位）

| 現象（症狀） | 大概率根因 | 定位命令 | 章節 |
|---|---|---|---|
| `GL_RENDERER` 不是 Mali-400 MP / EGL 初始化 0x3001 | mali.ko 未 insmod 或 egl 軟鏈缺失 | `ls -la /dev/mali0; ls -l /system/lib/egl/` | §2 |
| `insmod mali.ko` 失敗 | vermagic 不符 / 模塊不在 | `modinfo /lib/modules/mali.ko \| head` | §2 |
| bionic 程序一運行就崩（before main） | 缺 `-Wl,--entry=main` | `readelf -l <bin> \| grep interpreter` | §3 |
| 鏈接報錯 `__clock_gettime64 undefined` | musl 64 位 time_t 重定向 | `nm <bin> \| grep clock_gettime` | §3 |
| dlopen 內死循環燒 CPU | exe 導出表含 mmap/lseek 等 | `nm -D <bin> \| grep -E ' mmap\|lseek'` | §3 |
| 屏幕場景發黑、只有 HUD 可見 | pbuffer glReadPixels 不可靠(TBDR) | 看 gpu_bench dump 日誌中心像素 | §5 |
| 回讀全黑/陳舊紅 | 未觸發 TBDR 解析 | 跑 `_gldump.c` 最小測試 | §5 |
| 桌面"GPU測試"圖標拉起舊程序 | gpu_test 未軟鏈 gpu_bench | `ls -l /usr/local/bin/gpu_test` | §4 |

---

## 2. 內核 / 驅動層（① mali.ko → /dev/mali0）

### 2.1 RENDERER 不是 Mali-400 / EGL_NOT_INITIALIZED

- **定位**：`ls -la /dev/mali0`；`ls -l /system/lib/egl/` 應有 `libGLES_mali.so` 軟鏈；`/root/mali_check` 看第 1~2 項。
- **修復**：
  ```sh
  insmod /lib/modules/mali.ko            # rc=0 才繼續
  ls -la /dev/mali0                      # crw-rw---- 10, 22
  mkdir -p /system/bin /system/lib/egl
  cp /tmp/aand/system/bin/linker /system/bin/linker
  for f in /tmp/aand/system/lib/*.so /mnt/android_sys/lib/*.so; do ln -sf "$f" /system/lib/; done
  ln -sf /mnt/android_sys/lib/egl/libGLES_mali.so /system/lib/egl/
  ```
- **注意**：不要手動 `/system/bin/linker xxx`——argv[0] 是 linker 會打印 helper 提示退出；讓內核讀 INTERP 自動加載 linker（直接執行程序）。

---

## 3. 用戶態 bionic 編譯層（③ musl gcc 編 bionic）

### 3.1 程序一運行就崩（before main）

- **根因**：`-nostdlib` 時 ld 默認入口 = .text 首字節。
- **修復**：編譯加 `-Wl,--entry=main`。

### 3.2 `__clock_gettime64` undefined

- **根因**：musl 32 位 time_t 是 64 位、bionic 是 32 位，clock_gettime 被重定名。
- **修復**：自實現 `{long tv_sec; long tv_usec;}` + `syscall(78, &t, 0)`（見 `bionic_shim.cpp`）。

### 3.3 dlopen 內死循環（燒 CPU）

- **根因**：exe 的 `--version-script` 導出 `mmap/lseek/ftruncate/fseeko/ftello`，搶佔 bionic 內部同名調用 → 參數錯位死循環。
- **修復**：這幾個符號只放 core 自己鏈的 shim，**exe 導出表絕不能含它們**（`nm -D <bin>` 自查）。

### 3.4 其他 shim 必補符號

`__dso_handle` / `__errno_location` / `__tls_get_addr` / `__nanosleep_time64` / `getentropy` / `secure_getenv`（設備 `bionic_shim.cpp` 已驗證）。

---

## 4. 應用層（④ gpu_bench / gpu_test / PSP 前端）

### 4.1 桌面圖標拉起舊程序

- **定位**：`ls -l /usr/local/bin/gpu_test`（應軟鏈到 gpu_bench）。
- **修復**：`ln -sf /usr/local/bin/gpu_bench /usr/local/bin/gpu_test`。

### 4.2 評分異常低 / 幀率顯示但場景黑

- 見 §5（回讀問題，不影響評分計時）。

---

## 5. 回讀 / 顯示層（⑤ glReadPixels / TBDR）—— 已知無解，先認清

### 5.1 屏幕 3D/2D 場景發黑、只 HUD 可見

- **根因**：Mali TBDR 惰性解析 + pbuffer 回讀路徑缺陷，`glReadPixels` 拿不到當前幀（clear/2D 四邊形全黑或陳舊紅，僅帶深度大網格偶發正確）。
- **已試四種辦法均無效**：FBO 離屏再回讀 / 去 glFinish 直接讀 / eglSwapBuffers / 全局開深度。
- **對策（當前）**：評分與幀率基於 `render+glFinish` 計時，不受回讀影響，跑分仍可用；屏幕畫面待改"直渲 fb 的 EGL window surface"根治（`_winsurf` 探針在 bionic linker 階段崩潰待排）。
- 退出時 `fb_restore()` 無條件翻回第 0 頁，桌面可恢復。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
