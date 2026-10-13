---
title: "Mali400_新應用接入操作手冊"
date: 2026-09-30 17:52:17
lang: zh-TW
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
permalink: zh-tw/2026/09/30/mali-04-mali400-md/
---


# 展訊 SC9832A Mali-400 —— 新應用接入操作手冊

> 適用範圍：要讓一個**新 App** 用上 Mali-400 GPU。
> 前提：Alpine/musl 根系統 + `mali.ko` 已加載 + `/system` 骨架就緒（由 `/etc/local.d/01_mali.start` 自動準備）。
> 校驗時間：2026-09-30，實跑 `/root/mali_check` 全綠。

---

## 0. 一句話流程

**新 App 用 GPU = 編成 bionic 程序 → EGL pbuffer 拿上下文 → GLES2 畫 → 按需要出圖/回讀 →（可選）加桌面圖標。**

唯一要習慣的彆扭點：必須用 **musl gcc 編出一個跑 bionic 動態鏈接器的 ELF**（詳見 §2），因為 EGL/GLES 庫是安卓的。

---

## 1. 前置檢查（先看 GPU 是否就緒）

```bash
lsmod | grep mali                 # 應有 mali 模塊
ls -l /dev/mali0                  # 設備節點要存在
ls -l /system/lib/libEGL.so /system/lib/libGLESv2.so /system/bin/linker
timeout -s TERM -k 2 10 /root/mali_check     # ★ 一鍵驗收工具，全綠才算就緒
```

**必須看到（本機實測）**：

```
/dev/mali0 : 可打開 ✔  |  mali 內核模塊 : 已加載 ✔
EGL_VENDOR : Android  | EGL_VERSION : 1.4 Android META-EGL
1280x720 pbuffer + ES2 context : 就緒 ✔
```

> 若缺 `mali.ko`：`insmod /lib/modules/mali.ko`；若缺 `/system` 骨架：由 `01_mali.start` 自動搭建（它還會造 `/dev/mali0` 等）。
> `WARNING: linker: unused DT entry / unsupported flags` 是**無害**警告，可忽略。

---

## 2. 唯一正確的編譯方法（musl gcc → bionic）

```bash
gcc -O1 -march=armv7-a -mtune=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard -I/usr/include \
    -nostdlib -Wl,--entry=main -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib \
    <app>.c /root/bionic_shim.o -L/system/lib \
    -lEGL -lGLESv2 -lc -lm -ldl -lgcc -o <app>
```

**必須遵守**：
- `-Wl,--entry=main`：**缺了就崩**（無 crt 時 ld 默認入口 = `.text` 首字節）。
- `-nostdlib` + `--dynamic-linker=/system/bin/linker` + `-rpath=/system/lib`：整套橋接三件套，缺一不可。
- 鏈接 `/root/bionic_shim.o`（已存在，10592 B），補 musl↔bionic ABI 差異。

**編完自檢（必須為空）**：

```bash
nm -D <app> | grep -E ' (mmap|munmap|lseek|fseeko|ftello|ftruncate|open|close)$'   # 應無輸出
```
有輸出 = exe 導出了 shim 符號 → 依賴庫會綁走 musl-ABI 的 `mmap` 導致**死循環**。

---

## 3. 代碼骨架（EGL + GLES2）

```c
#include <EGL/egl.h>
#include <GLES2/gl2.h>

EGLDisplay dpy; EGLSurface surf; EGLContext ctx;

EGLint cfg_attr[] = {
    EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,        /* ★ 必須 pbuffer */
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,     /* ★ ES2 */
    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
    EGL_DEPTH_SIZE, 16,                          /* 3D 場景才需要 */
    EGL_NONE
};

dpy  = eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(dpy, &major, &minor);              /* 實測 EGL 1.4 */
eglChooseConfig(dpy, cfg_attr, &cfg, 1, &n);
eglCreatePbufferSurface(dpy, cfg, (EGLint[]){EGL_WIDTH, RW, EGL_HEIGHT, RH, EGL_NONE});
eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, (EGLint[]){EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE});
eglMakeCurrent(dpy, surf, surf, ctx);
glViewport(0, 0, RW, RH);

/* ... 建 shader、上傳頂點、每幀 draw ... */

glFinish();            /* 計時用；本幀 GPU 真正畫完 */
```

**要點**
- 本機像素格式實測：**RGBA 8888**（`R8 G8 B8 A8`），帶深度時 cfg 報 `depth=24 stencil=8 samples=0`。
- **內部分辨率儘量小**：`glReadPixels` 只有 **~55MB/s**，成本 ∝ 像素數（720p 約 68ms，480x272 約 9.3ms）。推薦內部 360x640、`scale_to_fb` 放大到 720x1280 —— 這是提幀率**最有效**的槓桿。
- 全屏四邊形：`glDrawArrays(GL_TRIANGLE_STRIP,0,4)` 在本機**畫不出東西**，必須用 `glDrawElements(GL_TRIANGLES,6,GL_UNSIGNED_SHORT,idx)`。

---

## 4. 三種出圖模式（按需求選型）

| 模式 | 做法 | 適用 | 注意事項 |
|---|---|---|---|
| **A 離屏 / 跑分 / 濾鏡** | pbuffer 渲染 → `glFinish()` 計時 →（可選）`glReadPixels` 存盤 | 評測、GPU 計算、不需要實時出圖 | **評分不受回讀影響**（計時只算 render+finish） |
| **B 全屏獨佔出圖到屏幕** | 渲染 → 回讀 → `scale`/`rotate90` → `mmap(/dev/fb0)` 寫幀 → `FBIOPAN` 翻頁；**退出無條件歸位第 0 頁** | 模擬器/播放器/全屏 App | ⚠️ 見下方"回讀坑" |
| **C 軟件備胎** | Mesa 軟渲（不用 Mali） | 兜底/調試對照 | 非 GPU，性能差 1~2 個量級 |

**⚠️ 回讀坑（本機最致命）**：pbuffer 的 `glReadPixels` **不可靠**——純 clear 或普通 2D 四邊形回讀會變成**全黑/陳舊紅**，只有帶深度的大網格（TERRAIN）偶發正確。已驗證**四種辦法均無效**：改 FBO 離屏渲染 / 去掉 `glFinish` / 加 `eglSwapBuffers` / 全局開深度。根因是 Mali **TBDR 惰性解析** + pbuffer 回讀路徑缺陷。

**對策**：
- 要出圖 → **照抄已成功出圖的實現**：`_tmp/miniretro_psp_hw.c` 的顯示段（pbuffer → 回讀 → `scale_rotate90` → `FBIOPAN`，實測 **34~38fps 出圖**）。它靠 PPSSPP 核心內部 flush 才觸發解析，是目前本機**唯一真出過圖**的路線。
- HUD / 文字 / 幀率：**CPU 直寫 fb 必然可見**，不受回讀影響 → 場景區用 GPU、文字疊加用 CPU，是當下**最穩的組合**。
- 若將來要徹底解決：見《Mali400_擺脫安卓可行性分析》方案①/②（換 Linux DDK 或 Mesa Lima + 補 DRM）。

---

## 5. 桌面圖標集成（讓 App 能被點開）

**關鍵事實**：外部 `app.ini` 機制**只有掃描、沒有點擊分支**；要能點，必須改 launcher 內置數組。

1. 編輯設備端 `/home/lvgl_demo/lvgl_demo/lv_pages/launcher_page.c` 的內置 **`s_apps[]`**，加入新條目（圖標/名稱/命令）。
2. 拉起全屏外部程序照抄 `psp_game_page.c` 的範式：**暫停 LVGL → 釋放輸入 grab → 攔截器 → wait 子線程 → 退出時無條件 `FBIOPAN` 歸位第 0 頁**（冪等，否則桌面回不來）。
3. 重新 `make` 部署 lvgl_demo。
4. **省事捷徑**：現有的 `GPUTEST_BIN` 入口已硬編碼為 `/usr/local/bin/gpu_test`，把它**軟鏈**到你的 App 即可沿用現有圖標入口（本次 gpu_bench 就是這麼接上的）：
   ```bash
   ln -sf /usr/local/bin/<app> /usr/local/bin/gpu_test
   ```
5. ⚠️ **調試前先停 watchdog**（每 5s 拉起 lvgl_demo），否則改完被立刻覆蓋。

---

## 6. 必守的坑（血淚清單）

| # | 坑 | 症狀 | 規避 |
|---|---|---|---|
| 1 | 缺 `-Wl,--entry=main` | 一跑就崩 | 構建命令裡必須有 |
| 2 | exe 導出 shim 符號 | `mmap` 被綁到 musl-ABI → **死循環** | shim 用 `-fvisibility=hidden` 編譯（不能用 `#pragma`） |
| 3 | `__dlsym_time64` 自引用 | musl 把 `dlsym` 重定向回它 → `b .` 死循環 | 用 `__asm__("dlsym")` 繞過 |
| 4 | 用 `thread_local` | bionic 不認 TLS reloc | 去掉；已用 `_patchtls.py` 改過的 core 需重新打 patch |
| 5 | 全局構造器做重活 | 構造期崩潰；**清零構造 = 自殺**（RELATIVE 把 0 變 ELF 頭 → 調魔數 SIGILL） | 構造指向無害函數；必要時源碼級短路（如 ArmCPUDetect） |
| 6 | 用 `printf` 輸出診斷 | abort 時緩衝區丟失，**看不到現場** | 用 `write(1,...)` |
| 7 | 用 `ps -o pid,comm` 判活 | PPSSPP 會把主線程名改成 `{Main}` → **必然漏判**（曾攢 7 個殭屍實例堆滿 CPU） | 一律看 `/proc/<pid>/cmdline` |
| 8 | 重鏈後不打補丁 | core 崩潰 / TLS 錯 | `ppsspp` 類 core 重鏈後需重打：`.py`(libpng/z) + TLS + ctor patch（地址隨鏈接漂移，`nm` 複查） |
| 9 | libretro 前端漏調 `context_reset()` | `draw_=NULL` → DrawEngineGLES ctor 段錯誤 | 必須在 `av_info` 之後調用 |

---

## 7. 參考文件清單（照抄對象）

| 用途 | 文件 | 說明 |
|---|---|---|
| GPU 就緒自檢 | `/root/mali_check`（源 `ssh_tools/mali_check.c`） | 一鍵驗收，先跑它 |
| 跑分/多場景/HUD 完整骨架 | `/root/gpu_bench.c`（`ssh_tools/gpu_bench.c`） | 5 場景 + 實時 fps + 結果頁 + `fb_restore()`，最適合當 App 模板 |
| **唯一真出圖的全屏管線** | `_tmp/miniretro_psp_hw.c` | 回讀→`scale_rotate90`→`FBIOPAN`，實測 34~38fps |
| bionic 橋 | `/root/bionic_shim.o`（源 `bionic_shim.cpp`） | 編譯必須鏈接 |
| 部署/構建腳本 | `ssh_tools/deploy_bench2.py` | 上傳→編譯→原子替換→軟鏈，照改即可 |
| 圖標入口 | `ssh_tools/patch_launcher_gputest.py` | `GPUTEST_BIN` 入口 + fork/exec/等待/歸位範式 |
| 故障排查 | `ssh_tools/mali400_docs/Mali400_故障排查手冊.md` | 分層速查 |
| 擺脫安卓 | `ssh_tools/mali400_docs/Mali400_擺脫安卓可行性分析.md` | 回讀坑的根因與出路 |
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
