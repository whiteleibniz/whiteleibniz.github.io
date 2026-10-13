---
title: "ht0-wcn-radio Skill 說明"
date: 2026-09-13 16:05:17
lang: zh-TW
search: true
categories:
- AI工作流
- 可复用资产
tag:
- HT0
- WCN
- 技能
permalink: zh-tw/2026/09/13/ht0-skill-md/
---


---
name: ht0-wcn-radio
description: "展訊 SC9832A 設備（HT0，安卓內核 + Alpine 用戶態）WiFi/藍牙 combo 芯片（Marlin WCN）的運維排障與打通。當用戶報告這類設備 WiFi 起不來、連不上網、藍牙無響應、需要重新拉起 WiFi/藍牙、需要診斷 download 固件下載/SDIO 枚舉/驅動加載/HCI 通道問題時使用。包含一鍵拉起腳本、分層驗證清單、故障決策表與完整參考手冊。觸發場景：WiFi 掃描為空、IP 一直獲取中、藍牙搜不到設備、BT-OPEN 失敗、SDIO not enumerated、hci 無響應、開機後無線不生效、HT0/H709/SC9832A/Marlin/sprdwl 相關任務。"
---

# HT0 WCN Radio — 展訊 SC9832A WiFi/藍牙 combo 芯片運維

## 何時使用

用戶提到 HT0 / H709 / SC9832A / spd-box / Alpine + 安卓內核 / Marlin / sprdwl / download 固件 / WiFi 拉不起 / 藍牙搜不到，或要求"拉起 WiFi / 藍牙"、"開機自動啟動 WiFi/藍牙"、"無線不生效"時，使用本 Skill。

## 設備速覽（30 秒上下文）

| 項 | 值 |
|---|---|
| 設備 | HT0（對照機 H709 跑安卓 6.0，可作信息源） |
| 內核/系統 | Linux 3.10.65（安卓定製內核）+ Alpine 用戶態，**保留安卓內核 switchroot** |
| SSH | `root@<設備IP>`（RNDIS 調試口）/ WiFi 聯網後 `<WiFi-IP>`，密碼見環境記錄 |
| 芯片 | 展訊 Marlin combo WCN（WiFi+藍牙同芯片，SDIO 數據 + ttyS0 UART HCI） |
| WiFi | wlan0（sprdwl.ko + marlin_fm.ko），固件由 chroot 安卓 download 燒錄 |
| 藍牙 | /dev/ttyS0 3M+CRTSCTS H4，btwrite 喚醒，用戶態 daemon 提供 unix socket `/tmp/bt_ctl.sock` |

## 紅線（違反 = 需整機重啟）

1. **download/logdw 常駐勿殺** —— 全殺破壞芯片固件狀態，只能整機重啟。
2. **驅動順序**：`marlin_fm.ko` 先、`sprdwl.ko` 後（符號依賴 fm_read）。
3. **藍牙 BT-OPEN 前置**：重啟後必 `chmod 666 /tmp/aand/proc/mdbg/*`。
4. **藍牙掃描前置**：必須先 `Write Scan Enable (0x0c1a,0x03)` 再 Inquiry，否則無 Inquiry Result。
5. 殺進程用 `pkill -9 -x <名>`，勿用 `ps | grep` 內嵌模式（誤殺自身 shell）。
6. 勿改 USB OTG / 網絡模式；勿換主線內核（展訊專屬定製依賴安卓內核）。

## 工作流

### A. 一鍵拉起 WiFi

```bash
python scripts/wifi_bringup.py --host <設備IP> --password '<pwd>'
```

或手動（冪等，安全）：`sh /etc/local.d/wifi.start`，日誌 `/var/log/wifi_boot.log`。

### B. 一鍵檢查藍牙全鏈路

```bash
python scripts/bt_status.py --host <設備IP> --password '<pwd>' [--scan 8]
```

### C. SSH 輪詢恢復

設備重啟後 USB 口切換導致 22 端口短暫不通：

```bash
python scripts/ssh_wait.py --hosts <設備IP>,<WiFi-IP> --password '<pwd>' --timeout 180
```

## 分層驗證（哪層不過，查哪層）

```
① 固件/物理層   download 燒錄 → SDIO 枚舉 0x2331
                cat /sys/bus/sdio/devices/mmc2:8800:1/device  → 0x2331
② 上電層(藍牙)  wcnd + bt_once → /tmp/bt_once.log 含 "WCNBTWIFI-CMD OK"
③ 驅動/接口層   lsmod | grep sprdwl; ip -br link show wlan0 → UP
④ 協議層        pgrep wpa_supplicant; wpa_cli -i wlan0 status → wpa_state=COMPLETED
⑤ 網絡層        ip addr show wlan0 | grep 'inet ' → 有 IPv4
⑥ 引擎層(藍牙)  /tmp/bt_probe_full 六步全通（Reset/Ver/BD_ADDR/Buffer/Features/Scan Enable）
⑦ 應用層(藍牙)  socket state → OK ON; scan N → OK <count> + 設備行
```

## 故障決策（速查，詳見 references）

| 症狀 | 根因 | 修復 |
|---|---|---|
| BT-OPEN FAIL | mdbg 權限 600 | `chmod 666 /tmp/aand/proc/mdbg/*` |
| HCI 無響應 / 只回一次 SPRD3 | 缺 btwrite 喚醒 | 起 `/tmp/bt_wake.sh` |
| 藍牙掃描無結果 | 未先 Write Scan Enable | 用 daemon scan（內部已處理） |
| WiFi SDIO not enumerated | 固件下載失敗 | 看 /tmp/logdw.log；確認 by-name 軟鏈；重跑 wifi.start |
| bind logdw failed | /tmp/logdw 缺失 | 從 /mnt/android_sys/bin/ 重拷 |
| WiFi 連上但 IP 獲取中 | DHCP 未跑 / wpa 未 COMPLETED | `wpa_cli status` 檢查；`udhcpc -i wlan0 -q` |
| socket connect 失敗 | daemon 多實例 | `pkill -9 -x bt_user_daemon` 後單實例 |
| daemon "Not a tty" | ldisc 被佔 | python `fcntl.ioctl(fd,0x5421,b'\0'*4)` 恢復 N_TTY |
| 重啟後 SSH 不通 | USB 口切換 | ssh_wait.py 輪詢雙 IP |

## 參考文檔（按需讀取，勿全量加載）

- **WiFi 完整手冊**：`references/wifi.md` —— WiFi 全流程、wifi.start 腳本結構、wpa_cli 交互、驗證清單、故障表
- **藍牙完整手冊**：`references/bluetooth.md` —— 藍牙全流程、daemon 架構/socket 協議、HCI 要點、驗證清單、故障表
- **快速驗收**：兩手冊第 12 節（5 分鐘驗收路徑），各兩條命令確認鏈路

## 腳本（本機運行，paramiko 直連設備）

| 腳本 | 用途 | 關鍵輸出 |
|---|---|---|
| `scripts/wifi_bringup.py` | 一鍵拉起 WiFi 並驗證 | SDIO 0x2331 / wlan0 UP / wpa 狀態 |
| `scripts/bt_status.py` | 一鍵檢查藍牙全鏈路（可帶掃描） | 各層狀態 + socket 結果 |
| `scripts/ssh_wait.py` | 輪詢等待 SSH 恢復 | 可用主機 + 連接成功標誌 |

腳本依賴本機 `paramiko`；密碼等憑據走 `--password` 參數或環境變量，勿硬編碼。

## 文檔同步規則（版本化，打 tag 時同步）

文檔**不隨每次迭代提交更新**（避免小改動消耗），按**版本定版（打 tag）**統一同步：

1. 日常迭代：只提交代碼/腳本/配置改動，commit 備註寫清改動內容；**不動文檔**。
2. 打 tag 定版（用戶確認功能完善/穩定）時，一次性完成：
   - 同步更新受影響文檔族：docs 文檔（操作手冊/故障排查手冊/AI指導手冊/部署交付文檔/流程對比/工作總結）+ references/*.md + 本 SKILL.md（工作流/紅線/決策表，如涉及）
   - 新增/改名/刪除文件時同步更新 AI工作流/README.md 目錄規範
   - **校驗**：文檔中的命令、路徑、產物與實際設備運行狀態一致（改過的層必須實測過）
   - 打 tag：git tag <vX.Y.Z>，備註中文，寫明「定版範圍 + 同步更新的文檔清單」
3. tag 提交應包含或緊隨文檔更新，保證「一個 tag = 一份完整文檔快照」可回溯。

## 隱私紅線（強制）

- 項目公開：**任何文檔、git 備註、歸檔文件中禁止出現真實 SSH 密碼、賬號、真實 IP**。
- 一律用佔位符：`<設備IP>` / `<WiFi-IP>` / `<密碼>`；憑據只在運行參數或環境變量中提供。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
