---
title: "WiFi芯片打通_部署交付文檔"
date: 2026-09-13 15:58:12
lang: zh-TW
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
permalink: zh-tw/2026/09/13/wifi-04-wifi-md/
---


# HT0 設備 WiFi 拉起 —— 部署交付文檔

> 目的：回答"整個 WiFi 流程到底涉及哪些腳本/程序？在新設備上怎麼部署才能拉起 WiFi？"
> 內容：① 鏈路全景 → ② 產物清單（設備端/本機/Git）→ ③ 新設備部署步驟 → ④ 驗證 → ⑤ 常見問題
> 適用：同型號設備（HT0 / 展訊 SC9832A，安卓內核 + Alpine 用戶態）

---

## 1. WiFi 鏈路全景（誰拉起誰）

```
開機
 ├─ /etc/local.d/wifi.start        ① 掛載安卓 system + 搭 chroot + download 燒固件 + 驅動 + wlan0 + wpa
 ├─ /etc/local.d/bt_bringup.start   ② （藍牙鏈，見藍牙部署交付文檔——WiFi 是藍牙物理前提）
 ├─ /etc/init.d/bt_daemon          ③ （藍牙 daemon）
 └─ LVGL 桌面                     ④ 網絡設置頁（wpa_cli 與 supplicant 交互）
```

**依賴關係**：download 燒的 combo 固件含 WiFi+藍牙兩部分 → **WiFi 拉起 = 藍牙固件也已就緒**；① 是 ②③④ 的前提。

### wifi.start 內部步驟（冪等，可反覆重跑）

```
① 掛載 /mnt/android_sys（mmcblk0p17, Android system 只讀）
② 搭建 chroot /tmp/aand（bin/lib/etc/marlinba + bind /dev /proc /sys + by-name 軟鏈）
③ 殺淨殘留 download/logdw → setsid /tmp/logdw → setsid chroot /tmp/aand /bin/download -i wlan0（常駐）
④ 等 SDIO 枚舉 mmc2:8800:1 = 0x2331（≤90s）
⑤ insmod marlin_fm.ko → sprdwl.ko（順序硬約束）→ ip link set wlan0 up
⑥ wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
```

---

## 2. 產物清單

### 2.1 設備端已部署（HT0 現狀，實測核對）

| 類別 | 路徑 | 說明 |
|---|---|---|
| 開機腳本 | `/etc/local.d/wifi.start` | **WiFi 全鏈路自啟（冪等）**，日誌 `/var/log/wifi_boot.log` |
| chroot 環境 | `/tmp/aand/bin/download` | 固件下載引導器（安卓原版） |
| | `/tmp/aand/bin/wcnd` | WiFi/藍牙上電守護 |
| | `/tmp/aand/etc/marlinba/*.ini` | 固件配置（含藍牙 pskey） |
| | `/tmp/aand/lib/libiwnpi.so` | download 依賴庫 |
| 日誌守護 | `/tmp/logdw` | download 日誌守護 |
| 驅動 | `/lib/modules/marlin_fm.ko`、`/lib/modules/sprdwl.ko` | WiFi 驅動（順序：fm 先、wl 後） |
| 協議 | `/etc/wpa_supplicant/wpa_supplicant.conf` | wpa_supplicant 配置（含已保存網絡） |
| DHCP | `udhcpc`（Alpine 自帶） | 獲取 IP |
| 分區軟鏈 | `/dev/block/platform/sdio_emmc/by-name/{wcnfdl→p14, wcnmodem→p15, boot→p16}` | download 按名找分區 |
| 系統時間 | `/etc/local.d/time_sync.start` | RTC 校時（防退回 2016） |
| LVGL 桌面 | `/usr/local/bin/lvgl_demo` | 桌面（含網絡設置頁 network_page.c） |

### 2.2 本機（Windows 工作目錄）源碼與部署腳本

| 文件 | 用途 |
|---|---|
| `shell/wifi.start` | **開機腳本副本（git 已歸檔）** |
| `lv_pages/network_page.c` | **LVGL 網絡設置頁源碼（1677 行，WiFi UI）** |
| 四份文檔 | 操作手冊 / 啟動流程對比 / 工作過程總結 / AI 指導手冊 |

### 2.3 Git 提交（設備項目 /home/lvgl_demo/lvgl_demo）

WiFi 底層打通相關提交見 git log（`git log --oneline | head -10`），涉及：
- `shell/wifi.start`（開機腳本）
- `lv_pages/network_page.c`（網絡設置頁 + launcher 註冊）
- AI工作流/01_WiFi打通/（docs + deploy/wifi.start）

### 2.4 Skill 封裝（可移植）

`workspace\.user_skills\ht0-wcn-radio\` —— SKILL.md + references/wifi.md + scripts（wifi_bringup.py / ssh_wait.py），任何 AI 加載後可直接操作同型設備。

---

## 3. 新設備部署步驟（從零拉起 WiFi）

> 前提：同型號設備（HT0/SC9832A）、已 switchroot Alpine、SSH root 可用。

### Step 0 確認基礎環境

```sh
ssh root@<設備IP>
uname -a                              # Linux 3.10.65 ... armv7l
ls /dev/block/platform/sdio_emmc/by-name/   # wcnfdl=p14 wcnmodem=p15 boot=p16 system=p17
```

### Step 1 準備固件與 Android 用戶態（chroot）

```sh
# 1) 掛載安卓 system（只讀）
mkdir -p /mnt/android_sys
mount -r /dev/block/mmcblk0p17 /mnt/android_sys

# 2) 提取 download 及依賴（本機 adb 從對照機拉取後 scp 上傳，或直接從 system 拷）
mkdir -p /tmp/aand/{bin,lib,etc,dev}
cp /tmp/download            /tmp/aand/bin/download
cp /tmp/libiwnpi.so         /tmp/aand/lib/
cp -r /mnt/android_sys/lib/*.so /tmp/aand/lib/
cp -r /mnt/android_sys/etc/marlinba /tmp/aand/etc/
chmod +x /tmp/aand/bin/download

# 3) 設備節點 + 分區軟鏈
mount --bind /dev /tmp/aand/dev
mkdir -p /tmp/aand/dev/block/platform/sdio_emmc/by-name
ln -sf /dev/block/mmcblk0p14 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnfdl
ln -sf /dev/block/mmcblk0p15 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnmodem
ln -sf /dev/block/mmcblk0p16 /tmp/aand/dev/block/platform/sdio_emmc/by-name/boot

# 4) 驗證 chroot 可運行
chroot /tmp/aand /bin/download --help 2>&1 | head -5
```

> 若 dtb 不是 Android 原版（換過 boot），先按 WiFi 操作手冊 4.3 寫回原版 dtb 並重啟。

### Step 2 固件下載（download 上電序列）

```sh
# logdw 日誌守護（常駐）
setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
sleep 1
# download（常駐勿殺）
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
# 等 SDIO 枚舉（≤90s）
for i in $(seq 1 18); do [ -e /sys/bus/sdio/devices/mmc2:8800:1 ] && break; sleep 5; done
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # 期望 0x2331
```

### Step 3 加載驅動（順序不能反）

```sh
insmod /lib/modules/marlin_fm.ko    # 先
sleep 1
insmod /lib/modules/sprdwl.ko       # 後（依賴 fm_read 符號）
sleep 2
ip link set wlan0 up
ip link show wlan0                  # 出現 wlan0 即成功
```

### Step 4 配置 wpa_supplicant

```sh
cat > /etc/wpa_supplicant/wpa_supplicant.conf <<'EOF'
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
EOF
wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
wpa_cli -i wlan0 status              # wpa_state=INACTIVE 屬正常
```

### Step 5 開機自啟固化

```sh
# 驅動開機加載
cat > /etc/modules-load.d/wifi.conf <<'EOF'
marlin_fm
sprdwl
EOF
# 開機腳本（完整鏈，內容以 AI工作流 deploy/wifi.start 為準）
cp /home/lvgl_demo/lvgl_demo/AI工作流/01_WiFi打通/deploy/wifi.start /etc/local.d/wifi.start
chmod +x /etc/local.d/wifi.start
rc-update add local default
```

> 完整 `wifi.start` 含 chroot 搭建、logdw/download 拉起、SDIO 等待、驅動、wlan0、wpa_supplicant——新設備可直接部署該腳本一票到底，不必手動分步。

### Step 6 驗證

```sh
# 分層驗證
cat /sys/bus/sdio/devices/mmc2:8800:1/device        # 0x2331
lsmod | grep -E 'sprdwl|marlin_fm'
ip -br link show wlan0                              # UP
pgrep -x wpa_supplicant                             # 有 PID
wpa_cli -i wlan0 scan && sleep 5 && wpa_cli -i wlan0 scan_results   # 出現熱點
udhcpc -i wlan0 -q -n                               # 取 IP
ip addr show wlan0 | grep inet
```

---

## 4. 驗證標準（全部滿足 = 部署成功）

| # | 檢查 | 期望 |
|---|---|---|
| 1 | SDIO device | `0x2331` |
| 2 | lsmod | sprdwl + marlin_fm 都在 |
| 3 | `ip -br link show wlan0` | `UP` |
| 4 | wpa_supplicant 進程 | 存在 |
| 5 | `wpa_cli status` | `wpa_state=COMPLETED`（已連）或 `INACTIVE`（未連，正常） |
| 6 | 掃描 | `scan_results` 出現熱點 |
| 7 | IPv4 | `ip addr show wlan0` 有 inet 地址 + 默認路由 |
| 8 | LVGL 網絡頁 | 開關/掃描/已保存/附近列表/連接均正常 |
| 9 | 重啟後 | ①②③ 全自動拉起（不用手動） |
| 10 | 藍牙（同芯片） | `grep 'CMD OK' /tmp/bt_once.log` 有值（固件含藍牙） |

---

## 5. 常見問題（新設備部署時最可能踩的坑）

| 現象 | 原因 | 處理 |
|---|---|---|
| `SDIO not enumerated` | chroot 環境不全 / 時序 / 權限 | 看 `/tmp/logdw.log`；確認 power_ctl 可寫、by-name 軟鏈存在；重跑 wifi.start |
| `bind logdw failed` | /tmp/logdw 缺失 | `cp /mnt/android_sys/bin/logdw /tmp/logdw; chmod +x` |
| `download started pid=` 空 | 進程沒起來 | chroot 缺庫；`strace` 定位；確認 /tmp/aand 完整 |
| wlan0 不出現 | 固件未完成就加載驅動 | 等 SDIO 0x2331 再 insmod；rmmod 後按序重載 |
| `Unknown symbol` | 驅動順序反 | 先 marlin_fm 再 sprdwl |
| `invalid module format` | 模塊與內核不匹配 | 用設備 /lib/modules/ 同源模塊 |
| 掃描為空 | supplicant 未起 / 接口未 up | `ip link set wlan0 up` + 確認進程 |
| IP 一直獲取中 | DHCP 未跑 / wpa 未 COMPLETED | `wpa_cli status`；`udhcpc -i wlan0 -q -n` 手動跑 |
| 重啟後 WiFi 丟失 | 未固化自啟 | 部署 wifi.start + `rc-update add local default` |
| 日期 2016 | RTC 未同步 | 校時並固化 time_sync.start |
| SSH 重啟後不通 | USB 口複用切換 | 輪詢 `<設備IP>` / `<WiFi-IP>` |
| WiFi 正常但藍牙起不來 | 藍牙鏈未跑 | 見藍牙部署交付文檔（mdbg/wcnd/bt_once/bt_wake/daemon） |

---

## 6. 一句話總結部署路徑

```
環境確認 → 建 chroot(/tmp/aand + 軟鏈) → download 燒固件 → 等 SDIO 0x2331
→ insmod marlin_fm → sprdwl → wlan0 up → wpa_supplicant
→ udhcpc 取 IP → 固化 wifi.start 自啟 → 驗證(0x2331+UP+scan+IPv4)
```

所有產物都有本機副本與 Skill 封裝（`ht0-wcn-radio`），新設備部署全程可複用。

---

*配套：WiFi芯片打通操作手冊（人用）、WiFi芯片打通_故障排查手冊、WiFi打通_AI指導手冊（AI 用）*
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
