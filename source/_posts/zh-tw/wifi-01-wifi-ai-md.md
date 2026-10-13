---
title: "WiFi打通_AI指導手冊"
date: 2026-09-13 15:27:33
lang: zh-TW
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
permalink: zh-tw/2026/09/13/wifi-01-wifi-ai-md/
---


# 展訊 SC9832A 設備（HT0）WiFi 打通 —— AI 執行指導手冊

> **讀者對象**：AI 助手（豆包 / 其他大模型），需在同類設備（展訊 SC9832A，安卓內核 + Alpine 用戶態）上快速解決 WiFi 不可用 / 無法連接問題
> **使用方式**：先讀 §1–§3 建立上下文 → 按 §5 標準流程執行 → 按 §6 驗證 → 遇故障查 §7 決策表
> **核心價值**：本文所有命令均取自設備上實測通過的 `wifi.start` 開機腳本；照著做可在同類設備上直接拉起 WiFi，避免重複踩坑
> **關聯**：WiFi 與藍牙共用同一顆 Marlin combo 芯片，WiFi 是藍牙的物理前提（見藍牙 AI 指導手冊）

---

## 1. 設備與環境速覽

| 項目 | 值 |
|---|---|
| 設備型號 | HT0（對照機：H709，跑安卓 6.0，可作信息源） |
| 主機名 / 內核 | `spd-box` / `Linux 3.10.65 #13 SMP PREEMPT armv7l` |
| 系統組合 | **保留安卓 6.0 內核 + switchroot 到 Alpine Linux**（關鍵！） |
| SSH | `root@<設備IP>`（RNDIS 調試口）/ WiFi 聯網後 `<WiFi-IP>` |
| WiFi 芯片 | 展訊 **Marlin combo WCN**（SC2331，WiFi+藍牙同芯片，SDIO 接口） |
| WiFi 接口 | `wlan0`（驅動 sprdwl.ko + marlin_fm.ko） |
| 固件下載 | 安卓原版 `download` 二進制，在 chroot `/tmp/aand` 內運行 |
| 當前狀態 | WiFi 已打通：download → 驅動 → wpa_supplicant → DHCP，開機腳本已固化 |

> ⚠️ 重啟後 SSH 可能短暫不可達（USB 口切換），需輪詢重試；`/tmp` 重啟後保留（chroot 環境、工具都在）。

---

## 2. 已確認的硬事實（無需重新探查，直接信任）

1. **WiFi 固件必須由安卓原版 download 燒錄**：`chroot /tmp/aand /bin/download -i wlan0`，芯片才有固件可跑；WiFi 與藍牙固件是一體的，**WiFi 拉起 = 藍牙固件也已就緒**。
2. **download 依賴完整的 chroot 安卓用戶態**：`/tmp/aand` 內需有 Android 的 lib（含 libiwnpi.so）、`/etc/marlinba/*.ini` 配置、設備節點、分區軟鏈（by-name: wcnfdl→mmcblk0p14、wcnmodem→mmcblk0p15、boot→mmcblk0p16）。這些 `wifi.start` 已自動搭建。
3. **SDIO 枚舉是固件下載成功的標誌**：`/sys/bus/sdio/devices/mmc2:8800:1` 出現且 device=**0x2331**。
4. **驅動加載順序硬約束**：`marlin_fm.ko` **必須先於** `sprdwl.ko`（sprdwl 依賴 marlin_fm 導出的 fm_read 符號），反了報 Unknown symbol。
5. **download 必須常駐**：全殺 download/logdw 會破壞芯片固件狀態，只能整機重啟恢復。
6. **wpa_supplicant 配置**：`/etc/wpa_supplicant/wpa_supplicant.conf`，`ctrl_interface=/run/wpa_supplicant`，`update_config=1`；LVGL 網絡頁通過 `wpa_cli` 與該配置交互。
7. **LVGL 網絡設置頁**（`lv_pages/network_page.c`）：開關=ip link up/down，掃描=`wpa_cli -i wlan0 scan` + `scan_results`，連接=`add_network`→`set_network`→`select_network`→`save_config`→`reconnect`。
8. **開機腳本已固化**：`/etc/local.d/wifi.start`（冪等設計，已就緒步驟自動跳過），git 副本在 `shell/wifi.start`。
9. **DHCP**：用 `udhcpc -i wlan0`（Alpine 默認）；若持續"獲取中"，優先查 wpa 連接狀態與驅動。
10. **時間問題**：設備 RTC 曾退回 2016 年，已用 hwclock/ntpd 修復並固化（`/etc/local.d/time_sync.start` 之類腳本），若日期錯亂先修時間再排網絡（證書/握手會受日期影響）。

---

## 3. 已驗證死路（不要重試，浪費輪次）

| 路線 | 結果 | 原因 |
|---|---|---|
| 殺掉 download/logdw "乾淨重來" | 芯片固件狀態被破壞，WiFi/藍牙一起失效 | 必須整機重啟才能恢復；正確做法是讓 wifi.start 冪等重跑 |
| 用主線 Linux 內核替換安卓內核 | 未採用 | 安卓內核含展訊專屬定製（SDIO/電源/固件時序），主線內核無對應支持，風險極高 |
| 改 USB OTG / 網絡模式 | 用戶明確禁止 | 會破壞 RNDIS 調試口 / 網絡拓撲 |
| 直接 insmod sprdwl.ko 不加載 marlin_fm | Unknown symbol 加載失敗 | 模塊符號依賴，順序不能反 |
| 重啟後 22 端口不通時反覆重連同一 IP | 無效 | USB 口切換導致，需輪詢雙 IP 重試 |
| 手寫自研 download 替代安卓原版 | 高風險不採用 | 固件下載時序（power_ctl 上電序列 + UART 握手 + SDIO 大塊寫入）是芯片保密協議，原版二進制最可靠 |

---

## 4. 系統模型：分層 + 每層驗證標準

```
① 固件/物理層    logdw + download → 芯片上電 + 固件燒錄
                 驗證: cat /sys/bus/sdio/devices/mmc2:8800:1/device → 0x2331
② 驅動層         insmod marlin_fm.ko → insmod sprdwl.ko → wlan0 出現
                 驗證: lsmod | grep sprdwl; ls /sys/class/net/wlan0
③ 協議層         ip link up → wpa_supplicant → 掃描/連接
                 驗證: iwconfig wlan0（ESSID 關聯）; wpa_cli status
④ 網絡層         DHCP → IPv4 地址
                 驗證: ip addr show wlan0 有 inet 地址 + 默認路由
```

**排查紀律**：哪一層驗證不過，只在這一層及其上游找原因。例：連不上 WiFi 先查 wpa_supplicant 狀態（③），而不是去重燒固件（①）。

---

## 5. 標準執行流程（可直接複製）

### 5.1 完整鏈路（對應 wifi.start，建議直接依賴開機腳本冪等重跑）

```sh
# 直接重跑開機腳本（冪等，安全）
sh /etc/local.d/wifi.start 2>&1 | tail -20
# 日誌: /var/log/wifi_boot.log
```

### 5.2 手動分步（調試時用）

```sh
# 1) 環境（若 /tmp/aand 不存在，wifi.start 會自動搭建；手動確認）
ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/connectivity_configure.ini
mountpoint -q /tmp/aand/dev || mount --bind /dev /tmp/aand/dev
mountpoint -q /tmp/aand/proc || mount -t proc proc /tmp/aand/proc

# 2) 殺淨殘留 + 啟動 logdw + download（常駐）
for p in $(ps -eo pid,comm | awk '$2=="download"||$2=="logdw"{print $1}'); do kill -9 "$p"; done
setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
sleep 1
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
sleep 2
ps -eo pid,comm | grep download    # 確認 download 在跑

# 3) 等 SDIO 枚舉（最多 90s）
for i in $(seq 1 18); do
  [ -e /sys/bus/sdio/devices/mmc2:8800:1 ] && break
  sleep 5
done
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # 期望 0x2331

# 4) 驅動（順序不能反）
lsmod | grep -q marlin_fm || insmod /lib/modules/marlin_fm.ko
sleep 1
lsmod | grep -q sprdwl || insmod /lib/modules/sprdwl.ko
sleep 2
ls /sys/class/net/wlan0 || { rmmod sprdwl 2>/dev/null; rmmod marlin_fm 2>/dev/null; sleep 1;
                             insmod /lib/modules/marlin_fm.ko; sleep 1; insmod /lib/modules/sprdwl.ko; sleep 4; }

# 5) 接口 up + wpa_supplicant
ip link set wlan0 up
sleep 2
pgrep -x wpa_supplicant || wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf

# 6) DHCP
udhcpc -i wlan0 -q -n 2>&1 | tail -5
ip addr show wlan0 | grep inet
```

### 5.3 連接 WiFi（wpa_cli 交互，LVGL 網絡頁同款邏輯）

```sh
wpa_cli -i wlan0 scan                              # 觸發掃描
sleep 3
wpa_cli -i wlan0 scan_results                      # 查看熱點
# 添加/配置網絡
ID=$(wpa_cli -i wlan0 add_network | tail -1)
wpa_cli -i wlan0 set_network $ID ssid '"MySSID"'
wpa_cli -i wlan0 set_network $ID psk '"<WiFi密碼>"'
wpa_cli -i wlan0 set_network $ID scan_ssid 1
wpa_cli -i wlan0 set_network $ID priority 10
wpa_cli -i wlan0 enable_network $ID
wpa_cli -i wlan0 select_network $ID
wpa_cli -i wlan0 save_config
udhcpc -i wlan0 -q
```

---

## 6. 驗證標準清單（逐項確認）

| # | 檢查 | 期望 |
|---|---|---|
| 1 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 2 | `lsmod \| grep sprdwl` | sprdwl + marlin_fm（依賴關係 1 sprdwl） |
| 3 | `ip -br link show wlan0` | `UP` |
| 4 | `iwconfig wlan0` | ESSID 已關聯 / 無 ESSID 則未連 |
| 5 | `pgrep -x wpa_supplicant` | 進程存在 |
| 6 | `wpa_cli -i wlan0 status` | `wpa_state=COMPLETED` |
| 7 | `ip addr show wlan0 \| grep 'inet '` | 有 IPv4 地址 |
| 8 | `ip route` | 有 default via 網關 |
| 9 | LVGL 網絡頁 | 開關/掃描/已保存/附近列表/連接均正常 |

---

## 7. 故障 → 根因 → 修復 決策表

| 症狀 | 大概率根因 | 修復 |
|---|---|---|
| 日誌 `ERROR: SDIO not enumerated, download may have failed` | 固件下載未完成（時序/權限/節點問題） | 看 `/tmp/logdw.log` 尾部；確認 /dev/power_ctl 可寫、by-name 軟鏈存在；重跑 wifi.start |
| 日誌 `bind logdw failed: No such file or directory` | logdw 未就位（/tmp/logdw 不存在或非可執行） | `ls -la /tmp/logdw`；從 /mnt/android_sys/bin/ 重新拷貝 |
| `download started pid=`（pid 空） | download 進程沒起來 | `ps -eo pid,comm \| grep download`；chroot 環境是否完整 |
| wlan0 不出現在驅動加載後 | 驅動加載失敗 / 芯片未枚舉 | `dmesg \| tail`；先確認 SDIO 0x2331；rmmod 重載 |
| 掃描為空 | wpa_supplicant 未起 / 接口未 up | `pgrep wpa_supplicant`；`ip link set wlan0 up`；`wpa_cli scan` 後再 `scan_results` |
| 連上但 IP 一直"獲取中" | DHCP 未跑 / wpa 未 COMPLETED | `wpa_cli status` 看 wpa_state；`udhcpc -i wlan0 -q -n` 手動跑 |
| 重啟後 SSH 不通 | RNDIS 口未恢復 / IP 變化 | 輪詢 <設備IP> 與 <WiFi-IP>；等開機腳本跑完 |
| 日期 2016 年 | RTC 未同步 | hwclock -s / ntpd 同步，寫入 /etc/local.d 開機腳本（已固化，勿重複） |
| WiFi 正常但藍牙起不來 | 藍牙鏈未跑 | 見藍牙 AI 指導手冊 §5（mdbg 權限 / wcnd / bt_once / btwrite） |

---

## 8. 組件架構（改動/維護必讀）

```
開機
 └─ /etc/local.d/wifi.start（冪等）
      ├─ 掛載 /mnt/android_sys（mmcblk0p17, Android system 只讀）
      ├─ 搭建 chroot /tmp/aand（bin/lib/etc/marlinba + bind /dev /proc /sys + 分區 mknod + by-name 軟鏈）
      ├─ 殺淨殘留 download/logdw
      ├─ setsid /tmp/logdw
      ├─ setsid chroot /tmp/aand /bin/download -i wlan0   ← 常駐
      ├─ 等 SDIO 枚舉 mmc2:8800:1 = 0x2331（≤90s）
      ├─ insmod marlin_fm.ko → sprdwl.ko（順序硬約束）
      ├─ ip link set wlan0 up
      └─ wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
之後
 ├─ LVGL 網絡頁（network_page.c）通過 wpa_cli 掃描/連接
 └─ udhcpc 取 IP（Alpine 網絡棧）
```

**chroot 關鍵節點**（download 依賴，缺失即 SDIO 枚舉失敗）：
- `/tmp/aand/bin/download`（安卓原版）
- `/tmp/aand/lib/libiwnpi.so` + 全套 Android lib
- `/tmp/aand/etc/marlinba/connectivity_configure.ini`（固件路徑/校準配置，也含藍牙 pskey）
- `/tmp/aand/dev/block/platform/sdio_emmc/by-name/{wcnfdl→mmcblk0p14, wcnmodem→mmcblk0p15, boot→mmcblk0p16}`
- `/dev/power_ctl`（download 寫入 SLEEP→POWER_ON→POWER_RST 上電序列）

**LVGL 網絡頁**（`lv_pages/network_page.c`，1677 行，WiFi 設置 UI 模板）：
- 開關：`ip link set wlan0 up/down` + `wpa_cli disconnect/reconnect`
- 掃描：`wpa_cli scan` → 定時 3s → `wpa_cli scan_results` → 解析 bssid/signal/flags/ssid
- 連接：add_network / set_network（ssid/psk/key_mgmt/scan_ssid/priority）/ select_network / save_config
- 已保存列表：`wpa_cli list_networks`

---

## 9. 紅線與運維紀律

1. **download 常駐勿殺** —— 全殺破壞芯片固件狀態，只能整機重啟。
2. **驅動順序**：`marlin_fm.ko` 先、`sprdwl.ko` 後。
3. **wifi.start 冪等** —— 想重來直接 `sh /etc/local.d/wifi.start`，它會先殺淨再拉起，不要手動零散操作。
4. **不要改 USB OTG / 網絡模式配置**（用戶明確約束）。
5. **不要換主線內核** —— 展訊專屬定製（SDIO/電源/固件）依賴安卓內核。
6. **日期必須正確** —— WiFi 握手/證書受系統時間影響，先修時間再排網絡。
7. **進程清理用 pkill -9 -x <名>**，勿用 `ps | grep` 內嵌模式（誤殺自身 shell）。

---

## 10. 設備上已有工具/文件清單（複用，勿重造）

| 工具/文件 | 位置 | 用途 |
|---|---|---|
| wifi.start | `/etc/local.d/wifi.start`（git: `shell/wifi.start`） | WiFi 開機自啟 + 全鏈路（冪等） |
| 啟動日誌 | `/var/log/wifi_boot.log` | wifi.start 輸出（排障首選） |
| download | `/tmp/aand/bin/download` | 固件下載（chroot 內） |
| logdw | `/tmp/logdw` | 固件下載日誌守護 |
| 安卓用戶態 | `/mnt/android_sys`（mmcblk0p17） | Android system 只讀掛載（庫/配置源） |
| 驅動 | `/lib/modules/marlin_fm.ko`、`/lib/modules/sprdwl.ko` | WiFi 驅動（設備預編譯） |
| wpa 配置 | `/etc/wpa_supplicant/wpa_supplicant.conf` | wpa_supplicant 配置（含已保存網絡） |
| 網絡頁 | `lv_pages/network_page.c`（LVGL 項目） | WiFi 設置 UI（wpa_cli 交互模板） |
| DHCP | `udhcpc`（Alpine 自帶） | 獲取 IP |

---

## 11. 後續增強方向（當前未完成）

| 項 | 說明 | 建議路徑 |
|---|---|---|
| IPv4 穩定性 | 部分場景 IPv6 有地址而 IPv4 未取到 | 檢查 wpa_state=COMPLETED 後立即 udhcpc，加 `-n` 重試與日誌 |
| 自動重連策略 | 掉線後僅靠 wpa_supplicant 自動重連 | 可加網絡頁"斷開重連"按鈕與信號強度展示（scan_results signal 已有） |
| 多網絡優先級 | 當前單 network 配置 | 擴展 wpa_cli list_networks 管理 + 排序 UI |
| 與藍牙共存 | WiFi 常駐 + 藍牙掃描並行 | 共用 download/wcnd，實測無衝突，但可加互斥電源管理 |

---

## 12. 5 分鐘快速驗收路徑

```sh
# 1) 三層狀態一條命令
cat /sys/bus/sdio/devices/mmc2:8800:1/device && ip -br link show wlan0 && pgrep -x wpa_supplicant
# 2) 連接狀態
wpa_cli -i wlan0 status | grep -E 'wpa_state|ip_address'
# 3) IPv4
ip addr show wlan0 | grep 'inet '
```

以上通過 → WiFi 底層 + 協議 + 網絡全鏈路 OK；不通過 → 按 §7 決策表逐項定位。

---

*文檔版本：v1.0（WiFi 打通後沉澱）*
*關聯文檔：WiFi 操作手冊（人用）、WiFi 啟動流程對比、WiFi 工作過程總結、藍牙打通 AI 指導手冊*
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
