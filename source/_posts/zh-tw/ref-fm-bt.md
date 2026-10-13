---
title: "ref_FM_藍牙_硬件加速"
date: 2026-09-23 20:16:57
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 蓝牙
permalink: zh-tw/2026/09/23/ref-fm-bt/
---


# 參考（細節）— FM 收音機 / 藍牙 A2DP / 硬件加速

> 由 `MEMORY.md §8~10` 拆出，避免主筆記超限。結論級摘要仍在 MEMORY.md。
> 原始專文：`radio_docs/`（SEEK與場強、ioctl命令表、出聲藍牙路線、上電腳本、DMA勘察）、
> `outputs/FM收音機_進度快照_20260922.md`、`outputs/Mali400與硬件加速_勘察結論.md`

## A. FM 收音機（應用層完工；**出聲無解**）

- **★★ 結論：整個 AP 音頻子系統是死的**
  - `card0` capture `-5 EIO`；播放側 PCM start 後 DMA 從不搬運；DAPM `bias_level` 永遠 Off（codec 從沒上電）
  - 根因：**sipc 只暴露 LTE 通道、無音頻 DSP 通道 → AGDSP 無從加載**
  - FM 音頻 ioctl（`OVER_BT_ENABLE`/`I2S_SETTING`/`ANA_SWITCH`/`GET_AUDIO_INFO`）在本機 `.ko` 與上游 `marlin2_fm`
    全是空實現；藍牙協議棧無 FM
  - → **FM 經藍牙出聲在用戶態不可行**，只剩動內核（需廠商源碼）
- **上電鏈（FM 可用性的關鍵）**：`01_wifi.start` → `bt_bringup.start`（等 18s）→ 向 @wcnd 發 `"wcn FM-OPEN"`
  並**長期保連接**（abstract unix socket `sun_path[0]=0+"wcnd"`），否則 `set_marlin_wakeup ack timeout`
- **產物**：
  - `/usr/local/bin/fm_user_daemon`（常開 fd，因為 `close(/dev/fm)` 會阻塞 ~4s）
  - 開機 `/etc/local.d/zz_fm.start` → 調 `/root/fm_powerup.sh`（拉 daemon + 補電 + 拉 `fm_watchdog`）
  - 控制 socket `/tmp/fm_ctl.sock`：`state|on|off|tune <kHz>|vol|mute|ana|rssi|chipid|rds`
- **★ `daemon 在跑 ≠ FM 工作`**：必須再發 `on`(POWER_UP) 射頻才起；**socket 寫須 `MSG_NOSIGNAL` + 忽略 `SIGPIPE`**
  （否則客戶端斷開觸發 SIGPIPE 終止進程）；腳本禁用 `rssi`（每次固定 4.2s 超時）
- **★ 場強/搜臺都做不了（勿再試）**：`GETRSSI` 每次固定 4.2s `-ETIMEDOUT` 且回值不變；`SEEK` 驅動只取頻率低字節 →
  TUNE 到任意頻點 SEEK 全回 103.1 → **UI 不要做"搜臺"按鈕**

## B. 藍牙 A2DP —— "已連接"必須看末端證據（2026-09-23 修復）

- **★ `conn` 只表示 ACL 鏈路，不等於連接可用**；UI 絕不能拿 `conn` 當"已連接"
- **★ 唯一用戶態可見的 A2DP 真相 = `/tmp/bt_audio.fifo` 有無讀者**（非阻塞開寫端：`ENXIO`=無讀者=空鏈路）→
  已落地 `lv_pages/bluetooth_page.c` 的 `bp_a2dp_ready()`（三態：鏈路+音頻=綠 / 僅鏈路=橙 / 僅配對=灰）
- **★ link key 失效 = 音箱類設備一級排查項**：刪 `/tmp/bt_linkkey.conf` 該行 → 真重啟 daemon → 重連（走完整 SSP）
- **★ `openrc restart` 不換進程**：改了狀態要用真重啟（kill -9 + sleep + setsid 拉起 + sleep，並校驗 pid 變沒變）
- 自研 `bt_user_daemon`（74KB，含 A2DP Sink/Source）；音頻源 `/tmp/bt_audio.fifo`（44100/2ch/S16_LE）；
  配對設備"小愛音箱-1303"

## C. 硬件加速（詳見 `outputs/Mali400與硬件加速_勘察結論.md`）

- **Mali-400 是 3D GPU 不是顯示控制器**；顯示歸 `sprdfb`→`/dev/fb0`；視頻硬解在 AP 的 **VSP**
- **Mali 在本機用不起來**：`mali.ko` 可 insmod 但唯一 DDK 是 bionic 庫、musl 加載不了；mesa 無 `lima_dri.so`、
  `/dev/dri` 不存在 → **GPU 不能治卡頓**（卡是 CPU 軟解，`nproc=2`）
- **真正該挖的**：VSP 硬解 `/dev/sprd_vsp`、GSP 2D 加速 `/dev/sprd_gsp`+ION（硬件縮放 + YUV→RGB，省 swscale）
- 視頻預轉碼參數：720x1280 + H.264 baseline + 無 B 幀 + ≤1Mbps + 24fps；
  mplayer 在 `/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer`（不在 PATH）
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
