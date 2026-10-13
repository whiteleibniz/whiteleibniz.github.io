---
title: "SC9832A_設備軟硬件信息報告"
date: 2026-09-24 21:36:03
lang: zh-TW
search: true
categories:
- 设备档案
tag:
- SC9832A
permalink: zh-tw/2026/09/24/device-report/
---


# SC9832A 智能終端 · 設備軟硬件信息報告

> 採集時間：2026-09-24 21:31 · 採集方式：SSH 只讀探測（/proc、/sys、dmesg、命令行工具）
> 主機名 `spd-box` · IP `192.168.137.100`（rndis0）

---

## 1. 系統概覽

| 項目 | 值 |
|---|---|
| 產品形態 | 手持智能終端（豎屏 720×1280，帶 4 物理鍵） |
| SoC | Spreadtrum **SC9832A**（Hardware: sc9832） |
| 序列號 | `CB02317100000B83`（androidboot.serialno） |
| 操作系統 | **Alpine Linux 3.21.3**（musl + busybox 用戶態） |
| 內核 | **Linux 3.10.65 #13 SMP PREEMPT**（armv7l，2018-04-27 由 gcc 4.8 編譯，`renjie@admin007-Server`） |
| 啟動參數 | `console=ttyS1,115200n8 init=/init root=/dev/ram0 androidboot.hardware=sc9832 lcd_id=ID9881 mem_cs0_sz=40000000(1GB)` |
| 運行環境 | BusyBox v1.37.0、gcc 14.2.0（Alpine）、Python 3.12.14（設備自帶） |
| 採樣時負載 | up 37min，load 1.90 / 2.69 / 2.29 |

## 2. 處理器（CPU）

| 項目 | 值 |
|---|---|
| 架構 | ARMv7 **Cortex-A7**（implementer 0x41, part 0xc07, rev 5, v7l） |
| 設計核數 | 4 核（SC9832A 規格） |
| 當前在線 | **2 核**（cpu0/cpu1；其餘核 hotplug 下線，`/proc/cpuinfo` 僅枚舉 2 個） |
| 頻率策略 | cpufreq：**768MHz（當前）～1.3GHz（max）**，governor=`interactive` |
| 特性 | swp half thumb fastmult vfp edsp neon vfpv3 tls vfpv4 idiva idivt vfpd32 |
| BogoMIPS | 1545.76 |
| ⚠️ hotplug 雷 | `/sys/.../cpu*/online` 是觸發式寫，重複寫會讓核掉線且只能重啟恢復，勿手寫 |

## 3. 內存（RAM）

| 項目 | 值 |
|---|---|
| 總容量 | **938,404 kB ≈ 916MB**（cmdline mem_cs0_sz=0x40000000 = 1GB 規格） |
| 採樣時使用 | 43.5MB used / 130MB free / 764MB buff+cache（含 647MB Cached） |
| Swap | 無 |

## 4. 存儲（eMMC）

| 項目 | 值 |
|---|---|
| eMMC 型號 | **FNX2MB**（CID `150100464e58324d42...`，廠商 0x15 Samsung） |
| 總容量 | 7,634,944 blocks ≈ **7.3GB**（mmcblk0，含 boot0/boot1/rpmb） |
| 根分區 | `mmcblk0p23` 6.2G（ext4），清理後用 81%、可用 1.2G |
| Android 系統分區 | `mmcblk0p17` 610M → 掛載 `/mnt/android_sys`（用 78%） |
| 分區表 | 共 23 個主分區（p1~p6 1~5MB 小分區、p7 19M、p15 10M、p16 20M、p17 800M(819200KB)、p20 200M、p21 18M、p23 6.2G 根） |
| 內存盤 | /run 183M tmpfs、/dev/shm 458M、/dev 10M tmpfs |

## 5. 顯示

| 項目 | 值 |
|---|---|
| 屏幕面板 | **ILI9881**（MIPI DSI，cmdline `lcd_id=ID9881`，驅動 `lcd_ili9881_mipi`） |
| 幀緩衝 | `/dev/fb0` 驅動 **sprdfb**，720×1280 豎屏、**32bpp**、虛擬尺寸 720×3840（3 頁翻頁緩衝） |
| 物理字節序 | fb 落盤實際為 `[R,G,B,X]`（與驅動報告相反，LVGL 需 R/B 交換） |
| 背光 | `/sys/class/backlight/sprd_backlight`，0~255 |
| GPU | **Mali-400 MP**（3D GPU；本系統 musl 用戶態用不起來：bionic DDK 無法加載、無 /dev/dri） |
| 硬件加速 | **VSP/GSP/VPP built-in**：`/dev/sprd_vsp`（硬解）、`/dev/sprd_gsp`（縮放/旋轉）、`/dev/sprd_vpp`（後處理）、`/dev/ion`（零拷貝緩衝），均可用 |

## 6. 輸入設備

| event | 名稱 | 說明 |
|---|---|---|
| event0 | sprd-gpio-keys | 板載物理鍵（LEFT=114 服務=102 ENTER=115 BACK=116 耳機=30） |
| event1 | sprd-eic-keys | EIC 按鍵 |
| event2 | headset-keyboard | 耳機線控 |
| event3/4 | **2.4G Composite Device**（Vendor 4037:2804） | USB 2.4G 無線鍵鼠接收器（當前已插入枚舉） |

- USB 主控：dwc_otg（20200000.usb），host 模式支持熱插拔；`mode`/`hprt0` sysfs 只讀調試口
- USB 外設口：rndis（PC 網絡），SSH 走此通道

## 7. 網絡

| 接口 | IP | 說明 |
|---|---|---|
| lo | 127.0.0.1 | 迴環 |
| **rndis0** | 192.168.137.100/24 | USB 虛擬網卡（連接 PC） |
| **wlan0** | 192.168.1.52/24 + 全局 IPv6 | WiFi（MAC `8a:b3:92:1f:09:94`，驅動模塊 `sprdwl` 84.5KB） |

- 內核模塊僅 2 個：`sprdwl`（WiFi）、`marlin_fm`（FM 收音機，17554 字節）
- FM 現狀：AP 音頻子系統不工作（sipc 僅暴露 LTE 通道，無音頻 DSP 通道），場強/搜臺不可做

## 8. 電池與溫度

| 項目 | 採樣值 |
|---|---|
| 電池 | Li-ion，**電量 100%（Full）**，電壓 4.185V，健康 Good |
| 電池溫度 | **35.3°C**（353，單位 0.1°C） |
| ARM 溫度 | **55.8°C**（thermal_zone sensor_arm） |
| 供電 | usb ONLINE=1（USB 供電中）、ac ONLINE=0 |
| 電量計 | sprdfgu（Spreadtrum FGU） |

## 9. 音頻

| 聲卡 | 名稱 | 說明 |
|---|---|---|
| card0 | all-i2s | I2S 接口 |
| card1 | **sprdphone** | 板載 codec（主輸出） |
| card2 | saudiolte | LTE 語音通道 |
| card3 | saudiovoip | VoIP 通道 |

- ALSA pcm 設備齊全（C0~C3 各 4 路 pcm），但 AP 側音頻子系統歷史結論：card0 EIO、DMA 不搬運 → 用戶態出聲不可行
- 藍牙：WCN 模塊（@wcnd 守護），鏈路真相 `/tmp/bt_audio.fifo` 讀者；link key 失效為一級排查項

## 10. 其他外設

| 項目 | 值 |
|---|---|
| LED | `blue` `green` `red` 三色（/sys/class/leds） |
| GPIO | gpiochip0 / 288 / 304 |
| 串口 | /dev/ttyS0~S3（console=ttyS1） |
| LTE 調制解調器 | SC9832A 內置（sipc 共享內存通道） |

## 11. 軟件棧（本機應用）

| 組件 | 說明 |
|---|---|
| 主程序 | `/usr/local/bin/lvgl_demo`（LVGL **9.6** 自編譯，`/root/lvgl_install` 安裝樹：liblvgl.a 含自啟用 montserrat_48） |
| 頁面框架 | 自研 lv_page_manager（activity 棧 + onCreate/onResume/onPause/onDestroy） |
| 模擬器 | miniretro（FC，git 原版）+ miniretro_gba（mgba core）+ miniretro_psp（PPSSPP core，JIT+480x272），直寫 /dev/fb0 |
| 視頻播放 | ffmpeg 移植（VSP 硬解 / rotate 替代 scale） |
| 守護 | `/root/lvgl_watchdog.sh`（5s 拉起）、`log_rotate.sh` + busybox crond |
| 開機 | `/etc/local.d/00_lvgl_demo.start`（setsid 方式） |
| 應用數 | launcher 內置 18 應用 + 最多 16 個外部進程應用 |
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
