---
title: "ref_模擬器_渲染與退出"
date: 2026-09-29 18:05:26
lang: zh-TW
search: true
categories:
- 多媒体与模拟器
- 模拟器通用
tag:
- 模拟器
- 渲染
permalink: zh-tw/2026/09/29/ref-emulator-render/
---


# 參考（細節）— 遊戲模擬器：渲染管線與退出策略

> 由 `MEMORY.md §11` 拆出，避免主筆記超限。結論級摘要仍在 MEMORY.md。
> 原始證據：`AI工作流/bugfix/bugfix_20260923_09~14*.md`、`outputs/bugfix_20260923/`、Skill `child-exit-hang-diagnosis`

## A. 渲染管線五坑（已實證；改 `video_cb` / `scale_rotate90` 前必讀）

1. **必須放行 240×160**（原硬編碼 256×240 過濾 → GBA 幀全丟 = 黑屏）；
   **必須按 pitch 逐行讀**（mGBA pitch=512=256px/行，寬只 240，線性讀 → 縱向條紋）
2. **雙緩衝頁翻轉治撕裂**：整幀渲染到後臺頁再 `FBIOPAN_DISPLAY`；`FBIO_WAITFORVSYNC` 本機 EPERM 不可用
   → **這條正是"頁翻轉地雷"的來源**（見 MEMORY.md §3）
3. **★ R/B 交換全鏈路只能做一次**（內部 `0xAARRGGBB`，寫前換一次）→ 換兩次 = 紅藍反轉
4. **音頻真實速率 ≠ 核心上報**：mGBA 報 32768，實測每 `retro_run` 交付 1097 幀（≈65536Hz）→ 按上報換算超產一倍
   被截斷 = 持續滋滋。正解 `s_fpc × s_fps_meas`；緩衝 ≥8192 int16；**開局 300ms 不發聲**（首幀只 82 幀會算錯比率灌爆 fifo）
5. **★ CPU 100% 打滿，miniretro 上限 ≈56fps**（<59.73）→ 只能按實測幀率把音頻拉伸到實時，音高低 ~6%

## B. 退出策略（定版 v3 + 無條件翻頁 = bugfix 16 / 18）

- **判據只有一個硬事件：子進程真的消失**。兩頁一律**阻塞 `waitpid`，無上限、無標誌位、無超時**
  （FC 的 `fc_wait_thread` 一直這麼寫，從沒出過故障 —— 這才是基準）
- **順序**：輸入攔截器收到退出鍵 → `kill(SIGTERM)`（**立刻返回，絕不 sleep**）→ 創建**專職補刀線程**
  `gba_kill_later`（600ms 後仍在才 `SIGKILL`）→ 收屍線程阻塞 `waitpid` → `gba_reset_fb_page()` →
  `hardware_keys_set_grab(true)` → `app_runtime_set_lvgl_paused(false)` → `lv_async_call(整屏重繪)`
  → **最後**摘攔截器。`gba_on_destroy` 另走 `SIGTERM` + 300ms 保護 `.sav`
- **前端側**：`on_quit_signal`(SIGTERM→quit=1) + `fb_restore()` + 正常 `return 0`。
  **`fb_restore()` 無條件 pan 回第 0 頁，絕不清屏**（清屏 = 那 ~1s 變純黑 = "卡黑屏"）；
  **也不再整頁 `memcpy`**（bugfix 16 去掉：那等於把內容寫進 LVGL 永遠繪製的那頁）
- **★★ 翻頁一律【無條件】**（bugfix 18，頁面側 5 個調用點全部）：`FBIOPAN_DISPLAY(yoffset=0)` 冪等
  → **絕不加前置判斷**；發完回讀校驗一次、不對就重發。且**翻頁與整屏重繪必須同拍**
  （主線程重繪回調裡緊挨著重繪再翻一次）→ 見 §C-7
- **實測**：發信號 → 子進程"真正消失"**兩前端都 ~1015~1020ms**（內核回收 evdev/fb 的固有開銷，前端無法影響；
  刻意接受的代價，別再想優化）；退出後**兩前端都定格遊戲最後一幀** = **黑屏窗口 0**
- **★ `yoffset` 回讀的定位（三版結論，最終版）**：它**能反映**前端在不在翻頁（當觀測手段可用），
  但**不能當"要不要翻頁"的門禁** —— 記賬值不保證等於掃描輸出(LCDC)正在讀的那一頁；
  兩者一旦不一致，`if(yoffset != 0)` 就跳過翻頁 = **偶發殘留上一畫面**（bugfix 18 的真兇）

## C. 已被證偽的路，別再走

1. **給等待循環設"跑滿 N 秒就算退出"的上限** ← "卡黑屏"真兇：遊戲正常跑滿即被誤判 → 摘掉按鍵攔截器
   （**退出鍵失效**）+ LVGL 搶回 fb0 與遊戲互相覆蓋。**FC 用無上限阻塞 waitpid，這是"FC 好/GBA 壞"的分水嶺**
2. `_exit(0)` **省不掉**內核時間（只跳過用戶態 close，進程**更久**不消失）
3. 把"等收屍"循環放在**互斥鎖內** → UI 恢復被拖滿
4. 用 `setenv` 做單子進程開關（**主進程級**，會跨頁面殘留）→ **一律在 `fork()` 後 `execl()` 前的子進程裡設**
5. **前端退出時清屏**（"黑"由清屏造成、"卡"是兩前端共有的 ~1s 開銷 —— 別當同一個問題查）
6. **只歸位自己那一層**：父進程補 SIGKILL 打斷子進程"落存檔 + 翻頁" → **必須父子雙層兜底**
7. **★「冪等操作 + 前置判斷」**（bugfix 18）：`if(yoffset!=0) pan()` 這類寫法把"**一定做**"變成
   "**偶發不做**" —— 因果鏈是「回讀值 ≠ 真實狀態 → 判斷為假 → 後端復位整段被跳過」。
   冪等且成本可忽略的操作**直接做，不要問**。
   **偶發故障的第一偵查方向是"判斷條件"，而不是時序**：先問"這段代碼有沒有可能在輸入正確時選擇不做"
8. **把"翻頁"和"重繪"分處兩個執行流**：它們是同一個視覺事務的兩半，分開就留中間態（bugfix 18）

## D. 工具與探針

- 頁翻轉診斷 `fbpan`：`/tmp/fbpan [頁號]`（源碼 `ssh_tools/_tmp/fbpan.c`，設備 gcc 編）
- 抓當前可見頁 `ssh_tools/grab_screen.py`；端到端復現 `ssh_tools/gba_repro.py`；
  凍住前端驗證兜底 `verify_gba_guard.py`；完整流程 `verify_gba_final.py`
- 音頻探針 `MINIRETRO_AUDIO_DEBUG=1 miniretro ...` 每秒打
  `peak/samples/out/drop/fps/calls/fpc/in_rate/out_rate/busy_ms`
- 已知限制：本機僅 4 物理鍵（左/右/A/退出），GBA 的 L/R/START/SELECT 需 USB 手柄或改 keymap

---

## E. 幀率預算與提速（2026-09-29，GBA）

### E.1 三個必知數字
1. **`FBIOPAN_DISPLAY` 阻塞 17.46ms/次（裸測 100 次）⇒ 面板刷新 57.3Hz**。
   它等下一個 vsync 才返回 ⇒ **只要每幀都翻頁，幀率上限就是 57.3Hz**（GBA 標稱 59.73 永遠達不到）。
   別再去"優化到 60fps"——物理上限就在這。
2. **每幀真正做事 ≈ 10ms**：mGBA core_run 自身 ~5ms + conv 0.4ms + scale_rotate90 4.85ms；
   剩下 7ms 是 pan 在等 vsync（無事可做，但單線程下串行佔用主循環）。
3. **掉幀機制**："頓一下"= 某幀做事超過當前 vsync 相位剩餘預算 → 錯過一班車 → 該幀 34.9ms（半速）。
   所以提速的正確目標是**加大餘量**，不是提高峰值幀率。

### E.2 分段探針（怎麼量）
`MINIRETRO_PERF=1 miniretro_gba <core> <rom> <keymap>` 每秒打印
`fps / core / conv / scale / pan (ms/幀) / 總 busy`；`vf` = 每秒 video_cb 次數。
（`MINIRETRO_AUDIO_DEBUG=1` 是音頻那路的探針，兩者獨立。）

### E.3 已做的兩處提速
- **scale_rotate90**：① 目標列 gather 查表 → **源列區間表 `sr_xstart[]` + 連續鋪寫**；
  ② 78 萬次 4B uncached 寫 → **cached 行緩衝 `sr_rowbuf` + `fb_store_row()` NEON 16B 寬寫**（19.4 萬次）。
  實測 6.7ms → 4.85ms。寫顯存是 uncached，**減少總線訪問次數**才是關鍵（不是減少像素數）。
- **governor**：運行期 `performance`（768~900MHz → 1.3GHz），退出還原 `interactive`。
- **★ 編譯**：GBA 必須 `-O2 -march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard`；
  本機 gcc `-dumpmachine` = `armv6-alpine-linux-musleabihf`、默認 `-mfpu=vfpv2`
  → 不顯式指定時 `arm_neon.h` 報 `inlining failed ... target specific option mismatch`。
  SC9832A = Cortex-A7，顯式開 armv7-a+NEON 實測可編譯可運行。
- **未做（可選）**：關雙緩衝（省掉 pan 的 4~7ms，但會撕裂）；mGBA 跳幀；GSP 硬件縮放/旋轉。

### E.4 幀率顯示
- 開關：設置頁"遊戲幀率" → `lv_conf/settings.conf` 的 `show_fps=1`；
  前端直接解析該文件（**不能 setenv**，見 §"setenv 汙染"教訓），
  環境變量 `MINIRETRO_SHOW_FPS=1/0` 可臨時覆蓋。
- 畫法：5x7 點陣（0-9/F/P/S/:）放大 3 倍，**必須畫在 `FBIOPAN_DISPLAY` 之前的後臺頁**，
  否則下一幀翻頁就被頂掉；顏色用 `FBPIX(r,g,b)` 宏（fb 物理 [R,G,B,X]）。
- 位置：`x=12, y=fb_h-7*3-14`（左下角），帶黑底襯。

### E.5 PSP 性能天花板 = 10fps（2026-09-29 實測定論）
- 分段（`MINIRETRO_PERF=1`）：core_run 96ms（其中我們出圖 9.7ms）/ 10.2fps。
  **出圖只佔 10%**，其餘是 PPSSPP 每幀固定成本；**與 ROM 負載無關**（Tetris 同速）。
- 已排除：分辨率（PPSSPP 只收 ≥480x272）、音頻（MUTE 無差異）、CPU 限頻（1.3GHz 實測 214M iter/s）、
  JIT vs IR（同速）。`frameskip=2` 最優，**=8 反而更慢**。
- ★ **core option 名/值必須用 GET_VARIABLE 回執實證**（寫錯的變量 core 靜默忽略）；
  **同一 key 在表裡寫兩條 → lookup 只回第一條**。
- ★ **絕不要 `MINIRETRO_NOAUDIO=1`（不註冊音頻回調）→ PPSSPP 段錯誤**。
- 幀率疊加/分段打印/調參環境變量：見 `2026-09-29.md`"PSP 卡頓定位與優化"。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
