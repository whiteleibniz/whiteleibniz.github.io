---
title: "藍牙啟動流程_安卓vsAlpine對比"
date: 2026-09-13 15:27:33
lang: zh-TW
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
permalink: zh-tw/2026/09/13/bt-03-vsalpine-md/
---


# 展訊 SC9832A 藍牙啟動流程 —— 安卓 vs Alpine（本設備）對比

> 硬件：展訊 Marlin combo WCN 芯片（WiFi + 藍牙同芯片）
> 本設備：保留安卓 6.0 內核（3.10.65）+ switchroot 到 Alpine Linux
> 目的：說清藍牙從開機到可用的完整流程，對比安卓原生與當前 Alpine 方案的原理差異

---

## 1. 芯片物理架構（兩種系統共用）

```
                    ┌─────────────────────────────┐
                    │      Marlin combo WCN       │
                    │  ┌──────────┐  ┌──────────┐ │
                    │  │ WiFi     │  │ Bluetooth│ │
                    │  │ (wlan0)  │  │ (HCI)    │ │
                    │  └──────────┘  └──────────┘ │
                    └──────┬──────────────┬───────┘
                           │ SDIO         │ UART
                           │              │ ttyS0 (3M + CRTSCTS)
        ┌──────────────────┴──┐      ┌────┴─────────────┐
        │ mmc2:8800:1 (0x2331)│      │ /proc/bluetooth/ │
        │                     │      │ sleep/btwrite    │  ← 喚醒節點
        └─────────────────────┘      └──────────────────┘
```

- **SDIO**：數據通道（WiFi 數據、藍牙固件大塊下載都走這裡）
- **UART ttyS0**：藍牙 HCI 控制通道（3M 波特率 + 硬件流控 CRTSCTS，H4 協議）
- **btwrite 節點**：`/proc/bluetooth/sleep/btwrite` —— 寫 1 喚醒藍牙引擎（省電模式管理）

---

## 2. 安卓 6.0 原生藍牙啟動流程

安卓側關鍵信息來自原機 `init.board.rc` / `init.rc` / `ueventd.rc`：

### 2.1 啟動鏈

```
開機
 └─ init 執行 init.board.rc
     ├─ chmod 660 /proc/bluetooth/sleep/btwrite    ← 喚醒節點權限
     ├─ chmod 660 /sys/devices/70000000.uart/uart_conf ← UART 配置節點
     ├─ chown bluetooth system ...（屬主）
     ├─ service download  /system/bin/download     ← 固件下載（class core, oneshot）
     │     user system / group system shell wifi bluetooth
     ├─ service btld /system/bin/btld -lpm 0 -hb 3000000  ← 藍牙低功耗管理（3M 波特率）
     │     user root / group bluetooth net_bt_admin
     ├─ service bt_rm /system/bin/bt_rm             ← 藍牙射頻管理
     ├─ #service hciattach /system/bin/hciattach -n /dev/sttybt0 sprd_shark（被註釋掉）
     └─ Bluedroid 協議棧（bluetooth.default.so + libbt-vendor）
           ├─ libbt-vendor: btwrite 喚醒（H709 日誌可見每 30s 週期寫 1→1.5s→寫 2）
           ├─ libbt-vendor: 讀 uart_conf、發 pskey（BT_PSKEY_CONFIG_INFO_T）
           ├─ 固件回 SPRD3 身份幀 → HCI 標準命令就緒
           └─ BluetoothCtrl 管理（掃描/配對/連接）
```

### 2.2 安卓關鍵點

| 環節 | 安卓做法 |
|---|---|
| 固件下載 | `download` 開機 oneshot 執行，讀 `connectivity_configure.ini`（含藍牙 pskey [SETCTION 6]）+ calibration，SDIO 大塊寫入 |
| 上電控制 | `wcnd`（BT-OPEN 命令觸發藍牙子系統上電） |
| 喚醒管理 | libbt-vendor 週期性 `btwrite` 喚醒（H709 日誌：每 30s 寫 1 → 1.5s → 寫 2） |
| HCI 通道 | 傳統上 hciattach 走 /dev/sttybt0 sprd_shark；本機實際靠 libbt-vendor 直接管理 UART（uart_conf 控制波特率） |
| 協議棧 | Bluedroid（bluetooth.default.so + libbt-vendor.so） |
| 用戶工具 | BluetoothCtrl（展訊定製藍牙控制） |
| 節點/權限 | init.board.rc 開機統一 chmod/chown |

---

## 3. Alpine（本設備）藍牙啟動流程

### 3.1 啟動鏈（當前已固化）

```
開機
 ├─ /etc/local.d/wifi.start        （local 腳本）
 │     ├─ setsid /tmp/logdw                       ← 固件下載日誌通道
 │     ├─ setsid chroot /tmp/aand /bin/download -i wlan0   ← 固件下載（常駐）
 │     ├─ SDIO 枚舉驗證 mmc2:8800:1 = 0x2331
 │     ├─ insmod marlin_fm.ko → sprdwl.ko         ← WiFi 驅動
 │     └─ ip link set wlan0 up
 ├─ /etc/local.d/lvgl_demo.start
 │     └─ setsid /usr/local/bin/lvgl_demo         ← LVGL 桌面（含藍牙設置頁）
 ├─ /etc/init.d/bt_daemon          （openrc）
 │     ├─ chmod 666 /tmp/aand/proc/mdbg/*         ← 修復 BT-OPEN 權限（重啟後必做）
 │     ├─ setsid chroot /tmp/aand /bin/wcnd       ← 上電守護
 │     ├─ setsid /tmp/bt_once 900                 ← BT-OPEN（期望 WCNBTWIFI-CMD OK）
 │     ├─ setsid /tmp/bt_wake.sh                  ← btwrite 週期喚醒
 │     └─ setsid /usr/local/bin/bt_user_daemon    ← 用戶態 HCI 守護（unix socket 服務）
 └─ LVGL 藍牙設置頁
       ├─ 開關 → socket `on`/`off`
       ├─ 搜索 → socket `scan N`
       └─ 設備列表 ← socket 返回 bd_addr class rssi
```

### 3.2 Alpine 關鍵點

| 環節 | Alpine 做法 |
|---|---|
| 固件下載 | **複用安卓原版 download**，在 chroot `/tmp/aand` 內運行（依賴安卓庫/節點/分區軟鏈），參數 `-i wlan0`（WiFi 模式，藍牙固件隨 combo 一起下載） |
| 上電控制 | 複用安卓原版 wcnd（chroot 內）+ bt_once 觸發 BT-OPEN |
| 喚醒管理 | 自寫 `/tmp/bt_wake.sh` 每 1.5~2s 寫 btwrite=1（比安卓 30s 更勤，保證 HCI 穩定響應） |
| HCI 通道 | **自寫用戶態 daemon** 直接打開 /dev/ttyS0（3M+CRTSCTS，H4），不依賴內核 hci_uart 驅動 |
| 協議棧 | 無 Bluedroid；daemon 實現最小 HCI 命令集（Reset/Version/BD_ADDR/Features/Scan） |
| 用戶工具 | LVGL 藍牙設置頁（unix socket 與 daemon 通信） |
| 節點/權限 | 開機腳本 chmod 666 mdbg + bt_daemon openrc 管理 |

---

## 4. 逐環節對比表

| 對比項 | 安卓 6.0 原生 | Alpine（本設備） | 差異原因 |
|---|---|---|---|
| 固件下載 | download（oneshot，system 用戶） | download（chroot，常駐） | Alpine 無安卓 init，需保持進程防芯片掉固件 |
| 固件來源 | 分區 wcnfdl/wcnmodem | 同分區（by-name 軟鏈到 chroot） | 內核相同，分區佈局不變 |
| pskey 下發 | libbt-vendor 初始化時發 VSC | download 下載時經 connectivity_configure.ini 下發 | 固件已在下載階段拿到 pskey（實測 feature_set 生效） |
| BT 上電 | wcnd + BT-OPEN（init 觸發） | wcnd（chroot）+ bt_once | 複用原版，僅執行者不同 |
| 喚醒 | libbt-vendor 每 30s btwrite | bt_wake.sh 每 1.5~2s btwrite | 用戶態無 libbt-vendor，自寫更勤的喚醒保證不丟響應 |
| HCI 通道 | libbt-vendor 直接管 UART | 自寫 daemon 直接讀 /dev/ttyS0 | 同樣繞過內核協議棧，直接操作串口 |
| 內核驅動 | 無 hci_uart（vendor 直管） | 嘗試過 hci_uart.ko → 放棄（TX=0） | 3.10 內核 tty_struct 偏移與新版驅動不匹配 |
| 協議棧 | Bluedroid（完整 stack） | 無協議棧，daemon 僅 HCI 層 | Alpine 無 Bluedroid；LVGL 應用層直接消費 HCI 掃描結果 |
| 掃描實現 | Bluedroid Inquiry | daemon Inquiry + Write Scan Enable 前置 | 展訊固件特性：不先開掃描使能就不回 Inquiry Result |
| 管理工具 | BluetoothCtrl | LVGL 藍牙設置頁（socket） | 面向桌面應用的定製 UI |
| 波特率 | 115200 → 3M（uart_conf 切換） | 直接 3M 打開 ttyS0 | 固件 BT 初始化後切到 3M，daemon 固定用 3M |

---

## 5. 原理要點（為什麼能通）

1. **同一顆 combo 芯片，固件是 WiFi+BT 一體的** —— download 以 `-i wlan0` 下載時，藍牙固件部分已隨 combo 鏡像進入芯片，因此"WiFi 拉起後藍牙固件已就緒"，後續只需上電 + 喚醒 + HCI 通信，不需要單獨再燒藍牙固件。

2. **SPRD3 身份幀是引擎啟動信號** —— 喚醒後固件回 `55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e`（"SPRD3" = 展訊芯片標識），說明藍牙引擎在跑、HCI 通道活著；此後才能發標準 HCI 命令。

3. **btwrite 是省電開關** —— 藍牙引擎空閒進入低功耗，必須週期性寫 1 喚醒；缺這一步，HCI 命令發出去沒有響應（這是早期所有測試失敗的共同根因之一）。

4. **Write Scan Enable 是掃描前提** —— 展訊固件要求先發 `0x0c1a (0x03)` 開啟掃描使能，Inquiry 才會返回 Inquiry Result 事件；裸發 Inquiry 會被接受（CMD_STATUS 0x00）但永遠等不到結果。

5. **用戶態方案 vs 內核驅動** —— 該設備內核為安卓定製 3.10.65，hci_uart.ko 依賴的 tty_struct 內部佈局與主線不一致，硬編碼偏移導致 TX=0、up 超時。直接用戶態讀寫 /dev/ttyS0 繞開內核協議棧，反而最可靠（安卓 vendor 本來就是這麼幹的）。

---

## 6. 一句話總結

> **安卓**：init → download → wcnd/BT-OPEN → libbt-vendor（btwrite 喚醒 + pskey + HCI）→ Bluedroid → BluetoothCtrl
> **Alpine（本設備）**：開機腳本 → chroot download（WiFi 模式，combo 固件一起下）→ wcnd/bt_once → bt_wake.sh（btwrite）→ 自寫用戶態 daemon（H4 HCI）→ LVGL 藍牙設置頁

底層硬件鏈路完全一致，差異只在"由誰來執行"：安卓靠 init + 完整協議棧，本設備靠開機腳本 + 自寫用戶態守護進程，用最小實現換掉安卓那一整套依賴。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
