---
title: "WiFi芯片打通_故障排查手冊"
date: 2026-09-13 15:58:12
lang: zh-TW
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
permalink: zh-tw/2026/09/13/wifi-03-wifi-md/
---


# 展訊 SC9832A WiFi 故障排查手冊 —— HT0 / spd-box

> **用途**：WiFi 起不來、掃不到、連不上、IP 獲取不到時，按本手冊定位根因。每一行命令均取自設備實測。
> **使用方式**：先看 §1 分層速查總表定位到層 → 跳到對應章節 → 用「定位命令」確認 → 按「修復」處理。
> **配套**：人工操作手冊（第 5 章速查表）、AI 指導手冊（§7 決策表）為精簡版；本文是全量版。

---

## 0. 排障紀律（先讀）

1. **四層模型，分層定位**：①固件/物理（download→SDIO 0x2331）→ ②驅動（marlin_fm→sprdwl→wlan0）→ ③協議（up→wpa_supplicant→掃描/連接）→ ④網絡（DHCP→IPv4→路由）。哪層不過只查該層及其上游。
   - 例：連不上 WiFi 先查 `wpa_cli status`（③），而不是重燒固件（①）。
2. **先看日誌**：`/var/log/wifi_boot.log`（wifi.start 輸出，排障首選）→ `/tmp/logdw.log` → `dmesg | tail`。
3. **download 常駐勿殺**：全殺破壞芯片固件狀態，只能整機重啟恢復。
4. **想重來就冪等重跑**：`sh /etc/local.d/wifi.start`（腳本會先殺淨殘留再拉起），不要手動零散操作。
5. **驅動順序硬約束**：`marlin_fm.ko` 必須先於 `sprdwl.ko`。
6. **先修時間再排網絡**：設備日期曾退回 2016，證書/握手受系統時間影響。
7. 殺進程用 `pkill -9 -x <名字>`，禁止 `ps | grep` 內嵌模式。

---

## 1. 分層故障速查總表（一頁定位）

| 現象（症狀） | 大概率根因 | 定位命令 | 章節 |
|---|---|---|---|
| 日誌 `ERROR: SDIO not enumerated, download may have failed` | 固件下載未完成 / 環境/時序問題 | `tail -20 /tmp/logdw.log` | §2 |
| `bind logdw failed: No such file or directory` | logdw 未就位 | `ls -la /tmp/logdw` | §2 |
| `download started pid=`（pid 空） | download 進程沒起來 | `ps -eo pid,comm \| grep download` | §2 |
| `dmesg` 一直 `SDIO dev not ready` / GPIO94=0 | 芯片未上電/固件未下載 | `cat /dev/power_ctl` 可寫性 | §2 |
| download 報 open 設備失敗 | chroot 缺設備節點 | `mountpoint -q /tmp/aand/dev` | §2 |
| download 報找不到 wcnfdl/wcnmodem | 缺 by-name 軟鏈 | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | §2 |
| download 跑完但 SDIO 無枚舉 | DTB 不對（boot 分區） | `dmesg \| grep -i -E "sdio\|mmc2\|2331"` | §2 |
| `insmod sprdwl.ko` 報 Unknown symbol | 模塊順序錯 | `lsmod \| grep marlin_fm` | §3 |
| wlan0 不出現 | 固件未完成就加載驅動 | `ls /sys/class/net/wlan0` | §3 |
| `insmod` 報 invalid module format | 模塊與內核版本不匹配 | `uname -r; modinfo sprdwl.ko` | §3 |
| `wpa_cli scan` 失敗 / 掃描為空 | supplicant 未跑 / 接口未 up | `pgrep -x wpa_supplicant` | §4 |
| `wpa_cli` 找不到命令 | PATH 缺 /sbin | `which wpa_cli` | §4 |
| 連上但 IP 一直"獲取中" | DHCP 未跑 / wpa 未 COMPLETED | `wpa_cli -i wlan0 status` | §5 |
| 有 IPv6 無 IPv4 | DHCP 時序/接口狀態 | `ip addr show wlan0` | §5 |
| 重啟後 WiFi 丟失 | 未固化自啟 | `ls /etc/local.d/`、`rc-update show` | §6 |
| 重啟後 SSH 不通 | USB 口複用切換 | 輪詢 `<設備IP>` / `<WiFi-IP>` | §6 |
| 日期 2016 年 | RTC 未同步 | `date` | §6 |

---

## 2. 物理 / 固件層（① DTB → download → SDIO）

### 2.1 `ERROR: SDIO not enumerated, download may have failed`

- **定位**：
  ```sh
  tail -20 /tmp/logdw.log            # 固件下載守護日誌
  cat /sys/bus/sdio/devices/mmc2:8800:1/device   # 空 = 未枚舉
  dmesg | tail -30                    # 看 mmc2 / sprd_download 消息
  ```
- **根因與修復**：

| 根因 | 確認 | 修復 |
|---|---|---|
| chroot 環境不全 | `ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/` | 重建 chroot 或重跑 `sh /etc/local.d/wifi.start` |
| `/dev/power_ctl` 不可寫 | `[ -w /dev/power_ctl ] && echo OK` | 檢查節點權限（download 寫上電序列依賴它） |
| by-name 軟鏈缺失 | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl; ln -sf /dev/block/mmcblk0p15 .../wcnmodem` |
| 掛載缺失 | `mountpoint -q /tmp/aand/dev || echo NOT_MOUNTED` | `mount --bind /dev /tmp/aand/dev; mount -t proc proc /tmp/aand/proc` |
| DTB 不對 | `dmesg \| grep -i sdio`（boot 分區 dtb 不含正確電源描述） | 寫回 Android 原版 dtb（見 WiFi 操作手冊 4.3，seek=20008） |
| 固件版本不匹配 | 驅動與固件來自不同 Android 版本 | 統一從同一 Android system 提取 |

### 2.2 `bind logdw failed: No such file or directory`

- **根因**：`/tmp/logdw` 不存在或不可執行（download 的日誌守護）。
- **修復**：`ls -la /tmp/logdw`；缺失則從 Android system 拷：`cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw; chmod +x /tmp/logdw`。

### 2.3 `download started pid=`（pid 為空）

- **根因**：download 進程沒起來（chroot 缺庫 / 參數錯 / 直接退出）。
- **定位**：`ps -eo pid,comm | grep download`；`tail -30 /tmp/dl.log`
- **修復**：
  ```sh
  pkill -9 -f logdw; pkill -9 -f 'wcnd'; sleep 1
  setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
  sleep 1
  setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
  sleep 2
  ps -eo pid,comm | grep download   # 應看到進程
  ```
- 仍失敗用 strace 定位缺什麼：`chroot /tmp/aand strace /bin/download 2>&1 | grep -E "open|ENOENT" | head -30`。

### 2.4 GPIO94 READY 恆 0 / dmesg 反覆 SDIO dev not ready

- **根因**：芯片上電序列沒執行（download 沒跑成功）。
- **定位**：`strace` 跟蹤 download 的 ioctl/write 是否報錯（open power_ctl、write SLEEP/POWER_ON/POWER_RST）。
- **修復**：按 2.1 表格逐項核對環境；確認後重跑 wifi.start。

---

## 3. 驅動層（② marlin_fm → sprdwl → wlan0）

### 3.1 `insmod sprdwl.ko` 報 Unknown symbol

- **根因**：模塊加載順序反了——sprdwl.ko 依賴 marlin_fm.ko 導出的 `fm_read` 符號。
- **修復**：
  ```sh
  lsmod | grep -q marlin_fm || insmod /lib/modules/marlin_fm.ko
  sleep 1
  lsmod | grep -q sprdwl || insmod /lib/modules/sprdwl.ko
  ```

### 3.2 wlan0 不出現

- **根因**：固件下載未完成就加載驅動，或芯片未枚舉。
- **定位**：`cat /sys/bus/sdio/devices/mmc2:8800:1/device`（必須先為 0x2331）；`dmesg | tail`
- **修復**：確認 SDIO 枚舉後再重載驅動：
  ```sh
  rmmod sprdwl 2>/dev/null; rmmod marlin_fm 2>/dev/null; sleep 1
  insmod /lib/modules/marlin_fm.ko; sleep 1; insmod /lib/modules/sprdwl.ko; sleep 4
  ls /sys/class/net/wlan0
  ```

### 3.3 `insmod` 報 invalid module format

- **根因**：模塊與內核 3.10.65 不匹配（不同內核版本/編譯器）。
- **定位**：`uname -r`；`modinfo /lib/modules/sprdwl.ko | grep vermagic`
- **修復**：使用設備 `/lib/modules/` 中預編譯的同源模塊；不要用 Alpine 新 gcc 編老內核模塊。

---

## 4. 協議層（③ up → wpa_supplicant → 掃描/連接）

### 4.1 `wpa_cli scan` 失敗 / 掃描結果為空

- **定位**：`pgrep -x wpa_supplicant`；`ip -br link show wlan0`（需 UP）；`wpa_cli -i wlan0 status`
- **修復**：
  ```sh
  ip link set wlan0 up; sleep 2
  pgrep -x wpa_supplicant || wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
  wpa_cli -i wlan0 scan; sleep 5; wpa_cli -i wlan0 scan_results
  ```

### 4.2 `wpa_cli` 找不到命令

- **根因**：PATH 缺 `/sbin`（wpa_cli 在 /sbin）。
- **修復**：`export PATH=$PATH:/sbin`；或 `which wpa_cli` 確認路徑。

### 4.3 掃描能看到但連接不上（wpa_state 卡 INACTIVE / SCANNING）

- **定位**：`wpa_cli -i wlan0 status | grep -E 'wpa_state|ssid'`
- **修復**：確認網絡配置正確（ssid 引號、psk 類型）；`wpa_cli -i wlan0 remove_network 0` 後重加；檢查 `wpa_cli -i wlan0 list_networks`。
- **常見**：開放網絡 `key_mgmt NONE`；加密網絡 `psk` 需帶引號字符串。

---

## 5. 網絡層（④ DHCP → IPv4）

### 5.1 連上但 IP 一直"獲取中"

- **定位**：`wpa_cli -i wlan0 status | grep wpa_state`（必須 COMPLETED）；`udhcpc -i wlan0 -q -n 2>&1 | tail -5`
- **修復**：
  ```sh
  # wpa 未 COMPLETED → 回 §4；已 COMPLETED → 手動跑 DHCP
  udhcpc -i wlan0 -q -n
  ip addr show wlan0 | grep inet
  ```

### 5.2 有 IPv6 無 IPv4 / 無默認路由

- **根因**：DHCP 時序（接口剛關聯就觸發）、或 DHCP 應答慢。
- **修復**：`wpa_cli status` 確認 COMPLETED 後**立即** `udhcpc -i wlan0 -q -n`；加 `-n` 失敗退出便於觀察；確認 `ip route` 出現 default via 網關。
- **注意**：部分場景 IPv6 先取到而 IPv4 未取到，重跑 udhcpc 即可。

---

## 6. 自啟 / 系統層

### 6.1 重啟後 WiFi 丟失

- **定位**：`ls /etc/local.d/`（應有 wifi.start）；`rc-update show | grep local`；`cat /var/log/wifi_boot.log | tail`
- **修復**：確認 `/etc/local.d/wifi.start` 存在且可執行、`local` 在 default runlevel：
  ```sh
  rc-update add local default
  sh /etc/local.d/wifi.start 2>&1 | tail -20   # 冪等，可立即重跑
  ```

### 6.2 重啟後 SSH 不通

- **根因**：設備 USB 口複用（RNDIS 網口/鍵盤/鼠標），重啟後網口未恢復或 IP 變化。
- **修復**：輪詢 `<設備IP>` 與 `<WiFi-IP>` 兩個地址（本機可用 skill 的 `ssh_wait.py`）；等開機腳本跑完（download 固件下載需 60~90s）。

### 6.3 日期退回 2016 年

- **根因**：RTC 未同步（無電池供電時每次重啟復位）。
- **修復**：`hwclock -s`（從 RTC 讀）或 `ntpd -q`（網絡校時）；已固化 `/etc/local.d/time_sync.start`，勿重複創建。

---

## 7. 診斷工具箱（關鍵節點速查）

| 項目 | 路徑/命令 | 期望 |
|---|---|---|
| 開機腳本日誌 | `/var/log/wifi_boot.log` | 無 ERROR、SDIO ready |
| SDIO 枚舉 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 驅動 | `lsmod \| grep -E 'sprdwl\|marlin_fm'` | 兩者都在 |
| 接口 | `ip -br link show wlan0` | `UP` |
| wpa 進程 | `pgrep -x wpa_supplicant` | 有 PID |
| wpa 狀態 | `wpa_cli -i wlan0 status` | `wpa_state=COMPLETED` |
| IPv4 | `ip addr show wlan0 \| grep 'inet '` | 有地址 |
| 路由 | `ip route` | default via 網關 |
| 下載日誌 | `/tmp/logdw.log`、`/tmp/dl.log` | download 完成 |
| chroot 環境 | `ls /tmp/aand/bin/download /tmp/aand/etc/marlinba/` | 文件齊全 |

**進程鏈**：`logdw → download(常駐) → (SDIO 0x2331) → marlin_fm.ko + sprdwl.ko → wlan0 UP → wpa_supplicant → udhcpc → IPv4`

---

## 8. 已驗證死路（不要重試）

| 路線 | 結果 |
|---|---|
| 殺 download/logdw "乾淨重來" | 破壞固件狀態，WiFi/藍牙一起失效，只能整機重啟 |
| 手寫自研 download 替代安卓原版 | 固件下載時序是芯片保密協議，原版最可靠 |
| 換主線 Linux 內核 | 安卓內核含展訊專屬定製（SDIO/電源/固件時序），主線無支持 |
| 改 USB OTG / 網絡模式 | 用戶明確禁止，破壞 RNDIS/網絡拓撲 |
| 先 insmod sprdwl 再 marlin_fm | Unknown symbol |
| 重啟後反覆重連同一 IP | USB 口切換導致，需輪詢雙 IP |

---

## 9. 紅線（任何情況下）

1. **download 常駐勿殺**。
2. **驅動順序**：`marlin_fm.ko` 先、`sprdwl.ko` 後。
3. **冪等重跑**：`sh /etc/local.d/wifi.start`，勿手動零散操作。
4. 不修改 USB OTG / 網絡模式配置。
5. 不換主線內核。
6. 時間必須先正確（影響證書/握手）。

---

*配套：WiFi芯片打通操作手冊（人用）、WiFi打通_AI指導手冊（AI 用）、WiFi芯片打通_部署交付文檔（部署用）*
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
