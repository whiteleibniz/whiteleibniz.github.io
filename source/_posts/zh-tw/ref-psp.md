---
title: "ref_PSP模擬器"
date: 2026-09-24 14:18:10
lang: zh-TW
search: true
categories:
- 多媒体与模拟器
- PSP
tag:
- PPSSPP
- 模拟器
permalink: zh-tw/2026/09/24/ref-psp/
---


# PSP 模擬器（2026-09-24 起）

> 頂層 MEMORY.md §12 只留結論；本文是明細。

## A. 方案與可行性

- **沿用 GBA 架構**：miniretro 前端直寫 `/dev/fb0` + libretro core。core = **PPSSPP**（v1.18.x，`-DLIBRETRO=ON`）
- **★ 關鍵：這臺機器沒有 GL/Vulkan**，所以必須讓 PPSSPP 走純 CPU 軟渲染。  
  前端在 `env_cb(RETRO_ENVIRONMENT_GET_VARIABLE)` 裡主動應答 **`ppsspp_backend=none`**  
  → 落到 `LibretroSoftwareContext`（源碼 `libretro/LibretroGraphicsContext.cpp` 的軟渲染兜底分支）。  
  不主動給的話它會依次試 GLCore→GL→Vulkan 三次全失敗；更糟的是 .so 一旦鏈接了 libGL，  
  **dlopen 階段就過不去**，連兜底機會都沒有
- 其餘注入的 core option：`cpu_core=JIT`（ARM32 dynarec，無它慢一個量級）、  
  `internal_resolution=480x272`、`frameskip=1`、`auto_frameskip=disabled`、  
  `gpu_hardware_transform=disabled`、`memstick_inserted=enabled`（不給→部分遊戲拒絕存檔）、  
  `io_timing_method=Fast`、`cache_iso=disabled`（內存僅 916MB，別整張 ISO 緩存）
- `RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY` → `/home/PSPgame/saves`

## B. 源碼獲取與編譯

- **本機** `git clone --depth 1 --recurse-submodules -j 8 https://github.com/hrydgard/ppsspp.git`  
  （Makefile 路線硬性依賴 ffmpeg 頭文件 → 必須走 CMake）
- 裁剪打包：排除 `.git / ffmpeg / ext/vulkan / assets / android / Qt / SDL / Windows / UWP / ios /
  macOS / headless / unittest / Tools / pspautotests / source_assets / icons / dx9sdk / gradle` → 55MB
- `assets` 後來發現是**必需的整份**（flash0 + 字體 atlas + meta），單獨補傳
- CMake：`-DLIBRETRO=ON -DUSE_FFMPEG=OFF -DVULKAN=OFF -DOPENGL=OFF -DUSE_SYSTEM_ZLIB=ON
  -DUSE_SYSTEM_LIBPNG=ON -DMOBILE_DEVICE=ON -DCMAKE_BUILD_TYPE=Release`
- **★ 編譯 flags 必須顯式給**：`-march=armv7-a -mtune=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard`  
  （不加則 gcc 默認編 armv6 → **沒有 ARM32 動態重編譯，直接慢一個量級**）
- **★ 坑：`-DVULKAN=OFF` 並不會停掉 `ext/vma` 目標**，它仍要 `ext/vulkan/vulkan.h`；  
  而在國內/這臺機器上精簡打包時最容易把它整目錄排掉 → 報錯 `fatal error: ext/vulkan/vulkan.h`。  
  解法：只傳**頭文件**（排除 iOS 26MB / macOS 12MB / libvulkan.so 3.3MB 後僅 177KB）
- 編譯放後臺 `setsid nohup make -j4 > /tmp/ppsspp_build3.log`（增量，已編 .o 全部保留）

## C. 派生（禁止手寫第二*份*）

`ssh_tools/make_psp_from_gba.py` 一次性產出 4 個文件，`ssh_tools/deploy_psp.py` 部署+重編，  
`ssh_tools/finish_psp.py` 收尾（校驗依賴 → 安裝 .so → 可選加載自測）。

- 從 `miniretro_gba.c` 派生 `miniretro_psp.c`，只改 5 處：  
  `PSP_SRC_W/H=480x272`、`SR_ROT_MAX 256²→512²`（272×480 旋轉畫布塞不進 256²，否則黑屏）、  
  `temp32` 容量、**白名單從"枚舉機種尺寸"改成"上限判定"**（`width>PSP_SRC_W` 才拒）、  
  env_cb 加 GET_VARIABLE + GET_SAVE_DIRECTORY。其餘（雙緩衝翻頁/退出策略 v3/音頻自適應重採樣）全繼承
- 頁面從 `gba_game_page.c` 派生：後綴 `.iso/.cso/.pbp/.elf`；**Makefile 用 `wildcard lv_pages/*.c`**，  
  新頁面丟進去自動進編譯
- **★ 替換次序雷**：複合標識符（`mgba_libretro.so`、`miniretro_gba`）必須**排在通用規則  
  `gba_->psp_` 之前**替換，否則 `mgba_libretro.so` 會被先寫成 `mpsp_libretro.so`，  
  後面的精確替換再也匹配不上（頁面查不到 core）
- **★ 中文字體雷**：派生源的 label 一律沒設字體 → 中文 ROM 名全是豆腐塊。  
  腳本已對所有 `lv_label_create` 補 `lv_obj_set_style_text_font(x, &lv_font_cn_16, 0)`
  - `LV_FONT_DECLARE`，並給 list 容器兜一層

## D. ROM

目錄 `/home/lvgl_demo/lvgl_demo/sdcard/game/psp/`（已放 5 個）

| 文件                                                          | 大小      | 來源                                          | 用途                   |
| ----------------------------------------------------------- | ------- | ------------------------------------------- | -------------------- |
| `Tetris 俄羅斯方塊.pbp`                                          | 16KB    | github.com/zPSP-Dev/tetris-psp release v1.0 | **首選**：真遊戲、極輕，軟渲染扛得住 |
| `Beatbox.pbp`                                               | 1.0MB   | github.com/Babkock/Beatbox 倉庫內 EBOOT.PBP    | 鼓機：驗多鍵輸入 + 音頻        |
| `Cube 旋轉立方體.pbp` / `Controller 按鍵測試.pbp` / `HelloWorld.pbp` | 40~76KB | PPSSPP 自帶 `pspautotests/demos/`             | 幀率/按鍵/基礎渲染探針         |

**★ 下載可用性（國內實測）**：`dlhb.gamebrew.org` **403**、`archive.org` 與 `raw.githubusercontent.com`  
**HTTP 000 不可達**、GitHub API/搜索容易 403 限流。  
→ **唯一可靠的是 `github.com` 本體**：`git clone --depth 1` 或 `github.com/<repo>/releases/download/<tag>/<文件>`。  
GameBrew 網頁只用來 WebFetch 提取直鏈。

## E. 鍵盤 / 輸入

- 設備上 `/dev/input/event0/1/2` 只有板載 3 個；**USB 鍵盤插入後熱插拔自動生效** ——  
  `input_poll_cb()` 每次輪詢都調 `input_scan()` 重掃 `/dev/input/eventN`
- `extern/miniretro/keymap_psp.conf` 映射（從 GBA 同源派生）：  
  WASD/方向鍵 = 方向；`Z`/`J`/空格 = B(○)；`X`/`K`/左Ctrl = A(×)；`Q`/`E` = Y(□)/X(△)；  
  `1`/`2` = L/R；回車 = START；左Shift/退格 = SELECT；**ESC = 退出**  
  板載 4 物理鍵沿用（點餐114=左、服務102=右、福利115=A、買單116=退出）
- 未按預期映射的鍵會在 stderr 打 `未映射按鍵 code=xxx`，照提示補進 conf

## F. 編制竄綢

| 動作            | 命令要點                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| 查編譯狀態         | `tail -1 /tmp/ppsspp_build3.log`；`grep -c 'error:'`                                                   |
| 改並行度（保留已完成目標） | 對 `ps -o pid,comm \| awk '$2=="make"'` 的 PID 發 **SIGTERM**（**禁用 `pkill -f`**），等 cc1 退出後 `make -jN` 續跑 |
| 觀察實際並行        | `ps -o pid,comm \| awk '$2=="cc1"\|\|$2=="cc1plus"' \| wc -l`                                         |

- 4 併發時內存 used 224~294MB / 916MB total，**未 OOM**
- 中斷後可能有半成品 `.o`（時間戳比源新 → make 認為不用重編 → 鏈接才炸）。  
  **★ BusyBox `find` 無 `-newermt`**，用 `-mmin N` / `-newer FILE`
- **別去寫 `/sys/devices/system/cpu/cpuN/online`**（見 MEMORY §10 hotplug 雷）；  
  實測編譯負載下 `sprd_hotplug` 會自動把 4 核全拉起來（`online=0-3`）

## ★ core 編譯：併發上限 -j2（OOM 實錘）
- `-j4` 在 50% 被 OOM kill（`glslang_tab.cpp` 單文件峰值），整條 make 靜默 Error 2 停死
- 正確啟動方式（只編需要的 target，非 `all`）：
  `cd /home/PSPgame/ppsspp_git/build && nohup setsid make -j2 ppsspp_libretro > /tmp/ppsspp_build4.log 2>&1 &`
- 判斷存活必須 grep 日誌裡的 `Killed` / `make.*Error 2`，**只看進程會誤判**

## ★ 裁剪源碼的坑：android/jni 頭必須保留（至少 2 個）
- `Common/File/AndroidStorage.cpp` 等 **無條件** `#include "android/jni/app-android.h"`，整刪 `android/` 會在 52% 炸掉
- 修復：原樣放回真 `app-android.h`（libretro 下 `PPSSPP_PLATFORM(ANDROID)` 為假，且 `<jni.h>` 還包在
  `!defined(__LIBRETRO__)` 裡 → 不需要 NDK）+ 真 `AndroidAudio.h`；**`OpenSLContext.h` 依賴 `SLES/*.h`，留佔位頭**
- 通用教訓：裁剪前先 `grep -rn '#include "<目錄>'` 排查非條件 include；補文件優先"原樣放回真文件"，別手搓佔位

## ★★ 冒煙測試鐵律：必須 setsid
`./miniretro_psp ... &` 掛在腳本 sh 下時，**busybox sh 會立刻給後臺作業發 SIGTERM**（si_pid=ppid 實錘），
表現為"啟動 100ms 就退出"，極易誤判成 core 崩潰。正確：
`setsid ./miniretro_psp <絕對路徑 core> <rom> keymap_psp.conf > /tmp/x.log 2>&1 &`
（另：musl 的 dlopen 對不含斜槓的名字**不搜當前目錄** → core 必須傳絕對路徑）

## ★ PPSSPP core 跑起來的 4 個要件
1. 實現 `RETRO_ENVIRONMENT_GET_LOG_INTERFACE`(cmd 27) —— 否則 core 報錯全不可見；放行級別限 WARN 以上
2. assets 放 `<system_dir>/PPSSPP/`（22MB），不是 system 根目錄
3. system dir 不能為 NULL（前端原默認 NULL，已改 `/home/PSPgame/system`）
4. `ppsspp_backend=none` → `Using Software backend`，480x270@59.94fps，JIT 走 ARM32

遺留：退出末尾 `terminate called without an active exception`（發生在 fb 復位之後，與 dlclose 無關，暫留）
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
