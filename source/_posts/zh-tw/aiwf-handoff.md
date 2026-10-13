---
title: "handoff_doubao_2026-10-10"
date: 2026-10-10 17:10:35
lang: zh-TW
search: true
categories:
- AI工作流
- 方法论与资产
tag:
- AI协作
- 交接
permalink: zh-tw/2026/10/10/aiwf-handoff/
---


# 交接文檔 — SC9832A 設備 PSP 硬渲恢復（2026-10-10）

> 交接對象：豆包。讀完本文檔即可繼續幹活。設備=展訊 SC9832A armv7l，Alpine chroot，720x1280 豎屏 fb，LVGL 9.6 桌面 + 模擬器/網絡電視。

## 1. 連接與工具（必讀）

- 設備經 PC ICS NAT 上網：USB RNDIS(192.168.137.x) → PC → WiFi。環境變量 `DEV_IP`（當前 192.168.137.100）。
- **SSH 一律走工程裡的 `ssh_tools/dev.py`**（paramiko）：`DEV_IP=192.168.137.100 python dev.py "<cmd>"`；跑本地腳本 `python dev.py --run <script> [timeout]`；傳文件 `MSYS_NO_PATHCONV=1 python devput.py <local> <remote>`（**必須帶 MSYS_NO_PATHCONV=1**，否則 Git Bash 吃掉遠端路徑）。裸 `ssh` 會被拒（非密鑰登錄）。
- ★ 本機 sandbox 會 SIGTERM 跑久的命令 → **SSH 命令一律 <20s 完成**；長任務用 `--run` 後臺跑。被殺的 SSH 會話洩漏會耗盡 dropbear（症狀：TCP22 通但 banner 立即斷，只能設備斷電重啟）。
- ★ 設備 SFTP 損壞 → 不要用 dev.py --get 拉大文件；文本/小文件用 devput（inline base64）。
- 設備有 python3.12、GNU ld 2.43.1（無 gold/lld）、gcc14（apk 升級過，新工具鏈產物老 bionic linker 不認，見 §3）。
- 截圖：`ssh_tools/grab_screen.py <out.png>`（讀 /dev/fb0）。
- 抓屏黑≠沒畫面：先 `python3` pread /dev/fb0 各頁統計非零像素再下結論。

## 2. 今日主線成果：PSP 硬渲恢復，實測 33fps

背景：PSP = `extern/miniretro/miniretro_psp_hw`（前端）+ ppsspp_libretro core。此前軟渲只有 20fps（cpu2/3 拉不起來，只有 2xA7）。今天把硬渲（Mali-400）修通，抓屏實證 FPS:33。

### 三層根因（按排查順序）

1. **reloc type 17 = R_ARM_TLS_DTPMOD32**：新 binutils 2.43 鏈接老 .o 時不再做 TLS GD→LE 靜態收斂 → 老 bionic linker dlopen 直接拒。已嘗試源頭消滅 TLS（call_once→atomic、sol.hpp 去 thread_local、非 TLS `__cxa_get_globals` shim `/root/eh_shim.cpp`——**shim 必須放在 libstdc++.a 之前鏈接**），動態 TLS reloc 清零，但新 core 仍 dlopen 崩在構造函數（二分定位 init_array[0] = libstdc++ globals_io.cc 的 std::ios_base::Init；老 core 同一個 ctor 卻能跑，新工具鏈 ctor 鏈問題未解）。**結論：放棄新 core，回退老 core**（git HEAD 0af7630 時代那份 = 當年 34-38fps 的原件，dlopen 實證 OK）。現部署的 `extern/miniretro/ppsspp_libretro_hw.so` 就是老 core；新 core 產物在 `/home/PSPgame/ppsspp_git/build_bionic/lib/ppsspp_libretro.so`（備份 .bak_ctor0），TLS 補丁源碼已落盤留檔。
2. **黑屏真因（最大反轉）**：這顆 Mali DDK **FBO(glReadPixels from FBO) 讀回全空**（glClear 特殊通路也壞），只有**默認幀緩衝（pbuffer）真實 draw 後讀回正常**。此前前端改成了"自建 FBO → 渲到 FBO → 讀回"路徑 = 黑屏主因。已恢復 0af7630 已驗證路徑：`hw_get_current_framebuffer()` 返回 0、`hw_present()` 直接 glReadPixels 默認面、EGL_SURFACE_TYPE 只留 EGL_PBUFFER_BIT、刪掉 fbo_setup/prog_make/窗口面實驗（egl_setup 對齊歷史版）。
3. **PPSSPP useEmuThread**：GL 後端激活時 PPSSPP 會在自己線程跑 GL，上下文 current 在前端線程 → 全部 GL 調用無效。core 源碼 `libretro/libretro.cpp` ~1492 行已補 `useEmuThread = false;`（備份 .bak_emuthread）。老 core 是補丁前編譯的？——注意：**老 core 能跑說明當年那份已含等價邏輯或前端線程模型兼容，實測 33fps 為準，勿再動**。

### 前端改動文件（設備端，未提交 git）

- `extern/miniretro/miniretro_psp_hw.c`：恢復 fb0 直讀路徑 + egl_setup 精簡。備份鏈：`.bak_fb0`（FBO 路徑改前）、`.bak_egl2`/`.bak_egl3`（egl 精簡前後）。
- 編譯：`cd extern/miniretro && sh build_hw.sh`（bionic 配方：-nostdlib + /root/bionic_shim.o + -L/system/lib -lEGL -lGLESv2）。
- 源文件以 LF 為主、混少量 CRLF → **改代碼用 python 字節級錨點替換，別按行號**（會炸）。
- 調試環境變量：`MINIRETRO_SHOW_FPS=1`（屏上 fps overlay）、`MINIRETRO_DUMP=1`（第 N 幀落盤 /tmp/fbo.raw 與 /tmp/fb_dst.raw）。

### 啟動命令（測試用）

```
cd /home/lvgl_demo/lvgl_demo/extern/miniretro
MINIRETRO_SHOW_FPS=1 timeout -k 3 30 ./miniretro_psp_hw ./ppsspp_libretro_hw.so /home/lvgl_demo/lvgl_demo/sdcard/game/psp/9100053.iso
```
遊戲目錄 `/home/lvgl_demo/lvgl_demo/sdcard/game/psp/`（9100053.iso、Cube 旋轉立方體.pbp 等）。

## 3. ★★ 重啟後必做清單（不做全是坑）

1. **默認路由**：設備跑 `route add default gw 192.168.137.1`（否則上不了外網）。
2. **PC 側 ICS 重綁**：RNDIS 重新枚舉後 PC 跑 `outputs/_ics_rebind.ps1`。判據：GW_OK+EXT_FAIL=ICS 掉了。
3. **mount p17**：`mount -r /dev/mmcblk0p17 /mnt/android_sys`（重啟後 gpu_env_ensure 的 stamp 兜底**不生效**；不掛 → /system/lib/libEGL.so 斷鏈 → EGL 失敗靜默退軟渲 20fps）。
4. **insmod mali**：`insmod /lib/modules/mali.ko`（硬件加速默認關、app 不拉驅動；不加載同樣靜默退軟渲）。
5. 判別硬渲/軟渲：屏上 FPS overlay 硬渲 ~33、軟渲 ~20+frameskip；日誌裡 `video_cb pitch=0` = 硬渲、pitch=1920 = 軟渲。

## 4. 本日新踩的坑（高複用價值）

- **fb mmap 斷連**：fb 驅動被多次 FBIOPAN/FBIOPUT 實驗折騰後，**新進程 mmap /dev/fb0 的寫入到不了真實顯存**（pread 全 0、memset 也無效）。**重啟恢復**。診斷法：python `os.pwrite/pread` 走文件路徑驗證讀寫一致性，再對比進程自己 mmap 的 dump。
- FBIOPAN 用**真 fb_var_screeninfo**（yoffset 在 struct 偏移 20、yres@4、yres_virtual@12）；假短結構體會內核崩（老坑重申）。
- bionic 裸探針三件套：`_start`（`exit(main())`）+ /root/bionic_shim.o + 正確 sigaction（**bionic sigset_t 只有 16 字節**，按 glibc 128B 排會截胡）。參考 /tmp/dlprobeA.c。
- bionic 裸 main 沒有 libc_init → dlopen libEGL 可以，但鏈接器後續初始化可能 fault 0x30——探針結論要在"先 dlopen libGLESv2 再 dlopen core"的環境下驗證（/tmp/dlprobe9.c 模式）。
- `pidof` 會匹配殭屍進程（busybox 看 comm）；服務健康判斷一律用功能真值（socket/文件/數據），老坑 10-10 已大修過一輪。
- 前端進程會被 `timeout` 的 TERM 吞掉不退 → 一律 `timeout -k 2 <N>`。
- pgrep/stale 進程記得先清場（`kill -9` 遺留 miniretro）再測，否則抓屏抓到舊幀。

## 5. 設備其他現狀（10-10 已定案部分，勿重複踩）

- WiFi/藍牙開關式上電已提交推送（`eb755bd`）。marlinba 必須真實目錄（軟鏈=RF fail 發不出幀）。修 wifi=`outputs/_fixwifi.sh`。
- Mali 去腳本化已實現未提交：01_mali.start 已刪，bionic 環境 = `lv_hardware/gpu_env.c gpu_env_ensure()` + deploy.sh 第 7 節；mali.ko = 設置頁「硬件加速」開關（默認關）。**PSP 前端測硬渲時要手動 insmod（見 §3.4）**。
- PSP 硬渲黑屏舊結論（_winsurf 直渲待做）作廢一半：pbuffer 讀回這條路今天已實測可用，窗口面（fbdev_window 喂 eglCreateWindowSurface）仍段錯誤（DDK 是 ANativeWindow 變體）。
- 觸摸：本機無觸摸（內核無驅動、i2c 沒綁定），只有 3 個按鍵。
- git：唯一倉庫在設備 /home/lvgl_demo/lvgl_demo（gitee javaren/wxb_lvgl，master），推送走 push_via_bundle.py + GITEE_TOKEN。提交須「文件清單+中文說明」徵得用戶同意。

## 6. 待辦（按優先級）

1. **Cube 旋轉立方體.pbp 黑屏 20fps**：日誌顯示 pitch=0（硬渲在跑）但讀回黑 + fps 掉到 20。懷疑該 demo 的渲染目標/深度用法踩了 DDK 的 FBO 黑洞。可先試 `MINIRETRO_DUMP=1` 看它讀回的是 FBO 還是默認面。
2. **前端偶發靜默退出（RC=0，~10-30s 不定）**：今天多次出現，無 tombstone、非崩潰。懷疑方向：retro_run 主循環某條件 break / EGL surface 丟失回調。加日誌抓退出路徑。
3. **git 提交**：確認穩定後提交 miniretro_psp_hw.c（fb0 路徑恢復）+ 源碼 TLS 補丁留檔說明。提交前列文件清單徵用戶同意。
4. deploy 包一致性：確認 deploy/ 裡 miniretro_psp_hw.c 是否要同步更新。
5. （遠期）新 core 的 ctor 崩潰若想再攻：對比新老 .so 的 .init_array 項對應 TU、逐個 -fno- 剪；性價比不高。

## 7. 關鍵路徑速查

| 項 | 路徑 |
|---|---|
| 前端源碼/編譯 | 設備 /home/lvgl_demo/lvgl_demo/extern/miniretro/（build_hw.sh） |
| PPSSPP 源碼/構建樹 | /home/PSPgame/ppsspp_git（build_bionic/，增量） |
| 老 core 原件 | git HEAD 的 extern/miniretro/ppsspp_libretro_hw.so |
| 當前部署 core 備份 | extern/miniretro/ppsspp_libretro_hw.so.bak_tls |
| bionic shim | /root/bionic_shim.cpp/.o、/root/eh_shim.cpp（非 TLS __cxa_get_globals） |
| dlopen 探針 | /tmp/dlprobe{2..A}.c（dlprobe9=先載 GLES 的正確姿勢） |
| 修 wifi 腳本 | 本地 outputs/_fixwifi.sh；ICS 重綁 outputs/_ics_rebind.ps1 |
| 今日完整日誌 | 本地 .workbuddy/memory/2026-10-10.md |
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
