---
title: "WiFi芯片打通操作手冊"
date: 2026-09-13 15:27:33
lang: zh-TW
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
permalink: zh-tw/2026/09/13/wifi-06-wifi-md/
---


# WiFi 芯片打通 —— 人工操作手冊

> **適用設備**：spd-box（SC9832A 四核，armv7l，Android 6 內核 3.10.65 + switchroot Alpine Linux 3.21 armhf）
> **WiFi 芯片**：Marlin SC2331（SDIO 接口，`mmc2:8800:1`，device 0x2331）
> **文檔目標**：不依賴任何 AI 輔助，人工按本手冊從零把該設備的板載 WiFi 打通到"可掃描、可連接"狀態。
> **文檔版本**：v1.0　|　2026-09

---

## 目錄

1. [背景與問題定義](#1-背景與問題定義)
2. [工具與物料清單](#2-工具與物料清單)
3. [總體思路](#3-總體思路)
4. [操作流程](#4-操作流程)
   - 4.1 設備與系統確認
   - 4.2 從 Android 對照機取證
   - 4.3 提取並替換 Android 原版設備樹（DTB）
   - 4.4 搭建 Android 用戶態 chroot 環境
   - 4.5 執行固件下載（download 上電序列）
   - 4.6 驗證 SDIO 枚舉
   - 4.7 加載 WiFi 驅動
   - 4.8 安裝並配置 wpa_supplicant
   - 4.9 掃描驗證
   - 4.10 開機自啟動固化
5. [故障排查速查表](#5-故障排查速查表)
6. [注意事項與風險](#6-注意事項與風險)

---

## 1. 背景與問題定義

- 設備出廠為 Android 6.0，WiFi/藍牙在 Android 下**完全可用**（硬件無故障）。
- 用戶將該設備 **switchroot** 為 Alpine Linux（保留 Android 內核 3.10.65，僅替換根文件系統）。
- 換到 Alpine 後 **WiFi 完全不工作**，典型現象：
  - `dmesg` 反覆出現 `SDIO dev not ready`；
  - GPIO94（芯片 READY 引腳）恆為 0；
  - 內核從未枚舉出 SDIO WiFi 設備（`/sys/bus/sdio/devices/` 為空）。
- **根因**：SC2331 芯片的**上電時序 + 固件下載**由 Android 系統裡的常駐 `download` 服務完成（寫 `/dev/power_ctl`、`/dev/download`，並把 `wcnfdl`/`wcnmodem` 分區的固件刷進芯片）。Alpine 沒有這套服務，芯片從未被"激活"。

---

## 2. 工具與物料清單

| 類別 | 工具/物料 | 用途 | 備註 |
|---|---|---|---|
| 遠程操作 | SSH 客戶端（paramiko / PuTTY / OpenSSH） | 連接 Alpine 設備 | `root@<設備IP>` |
| 對照取證 | WatchTools adb（`AndroidWatch_ADB_ToolBox\adb\adb.exe`） | 連接同型號 Android 機 H709 | 需 root（Magisk） |
| 分區讀寫 | `dd`、`cat`、`ls` | 提取/寫入分區、設備節點 | 設備內自帶（BusyBox/coreutils） |
| 系統跟蹤 | `strace` | 定位 download 服務失敗原因 | Alpine 用 `apk add strace` |
| 固件文件 | `download`（Android 二進制）、`libiwnpi.so`、`wcnfdl`/`wcnmodem` 分區鏡像 | 上電 + 固件下載 | 從 Android 系統提取 |
| 設備樹 | `android_orig.dtb`（約 53,967 字節） | 替換 p16 分區中的 dtb | 從 Android boot 鏡像提取 |
| 內核模塊 | `marlin_fm.ko`、`sprdwl.ko` | WiFi 驅動 | 放在 `/lib/modules/` |
| 用戶態 | `wpa_supplicant` + `wpa_cli`（v2.10-r11） | 掃描/連接 | Alpine armhf 包 |
| 依賴庫 | `libnl3`、`pcsc-lite-libs` | wpa_supplicant 依賴 | Alpine armhf 包 |
| 輔助 | `chroot`、`mount --bind` | 運行 Android 二進制 | 設備自帶 |

---

## 3. 總體思路

> **一句話**：芯片的上電與固件下載邏輯在 Android 用戶態（`download` 服務）裡，Alpine 缺它 → 把 Android 原版 `download` 二進制 + 固件 + 設備節點搬進 chroot，在 Alpine 裡"借殼"跑完上電序列，讓內核枚舉出 SDIO 芯片，再加載驅動、配 wpa_supplicant。

鏈路分四段，缺一不可：

```
[1] 正確的 DTB（Android 原版）
        ↓
[2] download 上電 + 固件下載（chroot 跑 Android 二進制）
        ↓
[3] 內核枚舉 SDIO 設備 + insmod 驅動 → wlan0 出現
        ↓
[4] wpa_supplicant 配置 → 掃描 / 連接
```

---

## 4. 操作流程

### 4.1 設備與系統確認

```sh
# 連接設備
ssh root@<設備IP>          # 密碼 <密碼>

# 確認系統
uname -a                          # 應看到 3.10.65 Android 內核 + armv7l
cat /etc/os-release               # Alpine 3.21 armhf

# 確認分區映射（by-name）
ls -l /dev/block/platform/sdio_emmc/by-name/
# 關鍵分區：
#   boot    -> p16   （含內核 + 設備樹）
#   wcnfdl  -> p14   （WiFi/藍牙 固件 A）
#   wcnmodem-> p15   （WiFi/藍牙 固件 B）
#   system  -> p17   （Android system，只讀掛載可提取文件）
#   recovery-> p21

# 確認芯片當前狀態（未打通的典型表現）
cat /sys/bus/sdio/devices/mmc2:*/device 2>/dev/null   # 空 = 未枚舉
dmesg | grep -i -E "sdio|mmc2|wlan|2331"              # 可見 SDIO dev not ready
```

### 4.2 從 Android 對照機取證

> 需要一臺**同型號、Android 系統正常**的設備（H709），WiFi/藍牙都好的那臺。

```sh
# 電腦端 adb 連接（WatchTools 的 adb）
D:\Program Files (x86)\watchTools\AndroidWatch_ADB_ToolBox\adb\adb.exe devices
adb shell id                          # 確認 root（Magisk）

# 查看分區表（拿到 by-name 到分區號的映射）
adb shell ls -l /dev/block/platform/sdio_emmc/by-name/
#   記錄：boot=p16  wcnfdl=p14  wcnmodem=p15  system=p17  recovery=p21

# 提取 boot 鏡像（內含 dtb）
adb shell dd if=/dev/block/mmcblk0p16 of=/sdcard/boot_p16_android.img bs=4096
adb pull /sdcard/boot_p16_android.img ./

# 提取 WiFi/藍牙固件（兩個分區）
adb shell dd if=/dev/block/mmcblk0p14 of=/sdcard/wcnfdl.img bs=4096
adb shell dd if=/dev/block/mmcblk0p15 of=/sdcard/wcnmodem.img bs=4096
adb pull /sdcard/wcnfdl.img ./
adb pull /sdcard/wcnmodem.img ./

# 提取 download 服務及其依賴（Android 用戶態上電程序）
adb shell cp /system/bin/download /sdcard/download
adb shell cp /system/lib/libiwnpi.so /sdcard/libiwnpi.so
adb pull /sdcard/download ./
adb pull /sdcard/libiwnpi.so ./

# 提取 Android 內核模塊（sprdwl 等，備選方案，通常 Alpine 裡已有）
adb shell ls /system/lib/modules/ | grep -i -E "sprdwl|marlin|fm"
```

### 4.3 提取並替換 Android 原版設備樹（DTB）

> Android 原版 DTB 裡含 WiFi 電源/時鐘的正確描述。這是後續 download 能正常工作的前提之一。

**4.3.1 電腦端：從 boot 鏡像提取 DTB**

```sh
# boot 鏡像頭為 ANDROID!，內核之後、ramdisk 之前是 dtb 段
# 用 unpack_bootimg（或手動）：
# Android 6 內核鏡像內嵌 dtb，偏移約 0xB71800（以實際解析為準）
# 工具：abootimg / unpack_bootimg / dtbTool

unpack_bootimg --boot_img boot_p16_android.img --out boot_extract/
# 得到 dtb 文件（約 53,967 字節）→ 命名 android_orig.dtb

# 校驗
file android_orig.dtb        # Device Tree Blob version 17
```

**4.3.2 設備端：寫入 p16 分區**

```sh
# 把 android_orig.dtb 上傳到設備 /tmp/
# 寫入 p16 的 dtb 偏移處：
#   dtb 在 boot 內的偏移 = 0x9C5000（字節）= 20008 個 512 字節塊
dd if=/tmp/android_orig.dtb of=/dev/block/mmcblk0p16 bs=512 seek=20008 conv=notrunc

# 備份當前 boot 以防萬一
dd if=/dev/block/mmcblk0p16 of=/root/p16_boot_backup.img bs=4096

# 重啟後驗證
reboot
dmesg | grep -i -E "sdio|mmc2|2331"   # 觀察枚舉情況
```

> ⚠️ 寫入 boot 分區有風險，務必先做備份。若刷錯可 `dd` 回備份。

### 4.4 搭建 Android 用戶態 chroot 環境

> 目的：讓 Android 原版 `download` 二進制能在 Alpine 裡運行（它依賴 Android 的庫、設備節點、分區鏈接）。

```sh
# 1) 建目錄並鋪 Android 用戶態文件
mkdir -p /tmp/aand/{bin,lib,etc,dev}
cp /tmp/download          /tmp/aand/bin/download
cp /tmp/libiwnpi.so       /tmp/aand/lib/
cp -r /mnt/android_sys/lib/*.so  /tmp/aand/lib/   # 從 p17 掛載的 Android system 複製全套 so
chmod +x /tmp/aand/bin/download

# 2) 固件與配置
#    Android 的 download 會讀 /etc/marlinba/*.ini（WiFi/藍牙固件路徑配置）
cp -r /mnt/android_sys/etc/marlinba /tmp/aand/etc/

# 3) 關鍵設備節點（download 需要 /dev/power_ctl 和 /dev/download）
mount --bind /dev /tmp/aand/dev

# 4) 固件分區鏈接（download 按 by-name 找分區）
mkdir -p /tmp/aand/dev/block/platform/sdio_emmc/by-name
ln -sf /dev/block/mmcblk0p14 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnfdl
ln -sf /dev/block/mmcblk0p15 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnmodem

# 5) 驗證 chroot 內可運行
chroot /tmp/aand /bin/download --help 2>&1 | head -20
# 若報缺庫/找不到，用 strace 定位：
chroot /tmp/aand strace /bin/download 2>&1 | grep -E "open|ENOENT" | head -30
```

> 排錯要點：`strace` 看到 `open("/dev/power_ctl")` 失敗 → 確認 `mount --bind /dev`；看到 `open(...wcnfdl)` 失敗 → 確認 by-name 鏈接。

### 4.5 執行固件下載（download 上電序列）

```sh
# 在 chroot 裡運行 Android 原版 download（帶參數，參考 Android 的調用方式）
chroot /tmp/aand /bin/download -i wlan0 2>&1 | tee /tmp/dl_run.log

# 預期動作（由 download 內部完成）：
#   1) 打開 /dev/power_ctl，寫入 SLEEP → POWER_ON → POWER_RST 上電序列
#   2) 打開 ttyS0（115200）與芯片握手
#   3) 把 wcnfdl / wcnmodem 分區固件以 SDIO 大塊寫入芯片
#   4) 芯片完成啟動，SDIO 從設備就緒

# 觀察內核日誌，應出現：
dmesg | tail -30
#   mmc2: new high speed SDIO card at address 8800
#   mmc2:8800:1  (device 0x2331)
#   sprd_download_sdio_write ... 131080 ...   （大塊固件寫入）
```

> 若固件下載失敗（卡在握手/寫入錯誤），檢查：DTB 是否正確（回 4.3）、`/dev/power_ctl` 是否可寫、固件分區是否為原版。

### 4.6 驗證 SDIO 枚舉

```sh
# 芯片已枚舉（此時 GPIO94 READY 應為 1）
cat /sys/bus/sdio/devices/mmc2:8800:1/device
# 期望輸出：0x2331

ls /sys/bus/sdio/devices/
# 期望出現 mmc2:8800:1
```

### 4.7 加載 WiFi 驅動

```sh
# 1) 先加載 FM 輔助模塊（提供 fm_read 等符號）
insmod /lib/modules/marlin_fm.ko
# 2) 再加載主 WiFi 驅動
insmod /lib/modules/sprdwl.ko

# 3) 驗證接口出現
ip link show wlan0
#   出現 wlan0，MAC a2:d2:f3:bf:8c:10 即為成功

# 4) 打開接口
ip link set wlan0 up
```

> ⚠️ 加載順序不能反：`sprdwl.ko` 依賴 `marlin_fm.ko` 導出的符號（`fm_read`），反過來會報 `Unknown symbol`。

### 4.8 安裝並配置 wpa_supplicant

> Alpine 官方源若不可用，直接下載 armhf 的 apk 手動安裝。

```sh
# 1) 準備 apk 包（armhf）：
#    wpa_supplicant-2.10-r11.apk
#    libnl3.apk
#    pcsc-lite-libs-2.2.3-r1.apk
apk add --allow-untrusted /tmp/wpa_supplicant.apk /tmp/libnl3.apk /tmp/pcsc.apk

# 2) 寫配置
cat > /etc/wpa_supplicant/wpa_supplicant.conf <<'EOF'
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
EOF

# 3) 啟動
/sbin/wpa_supplicant -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf -B

# 4) 確認狀態
wpa_cli -i wlan0 status
#   wpa_state=INACTIVE 屬正常（未連接任何網絡）
```

### 4.9 掃描驗證

```sh
wpa_cli -i wlan0 scan
sleep 5
wpa_cli -i wlan0 scan_results
# 出現多個熱點（CMCC-*、ChinaNet-* 等）即打通成功

# 連接示例（開放網絡直連）
wpa_cli -i wlan0 add_network
wpa_cli -i wlan0 set_network 0 ssid '"CMCC-dtGM"'
wpa_cli -i wlan0 set_network 0 key_mgmt NONE
wpa_cli -i wlan0 enable_network 0
wpa_cli -i wlan0 save_config
```

### 4.10 開機自啟動固化

> 設備重啟後，內核枚舉、固件、驅動、wpa_supplicant 都要自動恢復。

```sh
# 1) 驅動開機加載：寫入 /etc/modules-load.d/wifi.conf
cat > /etc/modules-load.d/wifi.conf <<'EOF'
marlin_fm
sprdwl
EOF

# 2) 固件下載 + wpa_supplicant 開機腳本：/etc/local.d/wifi_setup.start
cat > /etc/local.d/wifi_setup.start <<'EOF'
#!/bin/sh
# 1. chroot 跑 download 完成上電+固件下載
mount --bind /dev /tmp/aand/dev
chroot /tmp/aand /bin/download -i wlan0 &
sleep 8
# 2. 確認接口並 up
ip link set wlan0 up
# 3. 啟動 wpa_supplicant
/sbin/wpa_supplicant -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf -B
EOF
chmod +x /etc/local.d/wifi_setup.start

# 3) 啟用 local 服務（Alpine openrc）
rc-update add local default
rc-service local start
```

---

## 5. 故障排查速查表

| 現象 | 可能原因 | 排查/修復 |
|---|---|---|
| `dmesg` 一直 `SDIO dev not ready` | 芯片未上電/固件未下載 | 確認跑過 download（4.5），看 `/dev/power_ctl` 是否可寫 |
| GPIO94 READY 恆 0 | 上電序列沒執行 | 用 `strace` 跟蹤 download 的 ioctl/write 是否報錯 |
| `download` 報 open 設備失敗 | chroot 內缺設備節點 | `mount --bind /dev /tmp/aand/dev` |
| `download` 報找不到 wcnfdl/wcnmodem | 缺 by-name 鏈接 | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl` |
| `download` 跑完但 SDIO 無枚舉 | DTB 不對 | 確認 p16 已是 Android 原版 dtb（4.3） |
| `insmod sprdwl.ko` 報 Unknown symbol | 模塊加載順序錯 | 先 `insmod marlin_fm.ko` |
| wlan0 不出現 | 固件下載未完成就加載驅動 | 等 dmesg 出現 `mmc2:8800:1` 再 insmod |
| `wpa_cli scan` 失敗 | wpa_supplicant 未跑 / 接口未 up | `ip link set wlan0 up` + 確認 supplicant 進程 |
| `wpa_cli` 找不到 | PATH 缺 /sbin | `export PATH=$PATH:/sbin` |
| 重啟後 WiFi 丟失 | 未做自啟動 | 按 4.10 固化 |
| 拔插 USB 外設後 SSH 斷 | 設備 USB 口複用（網口/鍵盤） | 重插電腦 USB 並重啟設備恢復 |

---

## 6. 注意事項與風險

1. **刷 p16（boot）分區有變磚風險**——必須先備份（`/root/p16_boot_backup.img`），刷錯可回滾。
2. **USB 口複用**：設備的 USB 口既做 SSH 網口又插外設。插入鍵盤/鼠標會斷 SSH，需要拔掉外設、插回電腦 USB 並重啟設備。
3. **固件版本匹配**：download 上電成功後，驅動和固件要來自同一 Android 版本，否則可能出現 wlan0 有接口但掃描失敗。
4. **模塊路徑**：確認 `marlin_fm.ko` / `sprdwl.ko` 在 `/lib/modules/` 且與內核 3.10.65 匹配（不匹配會 `invalid module format`）。
5. **wpa_supplicant 版本**：設備 armhf，務必用 armhf 包；x86_64 包會報 Exec format error。
6. **dtb 偏移**：寫 p16 時 `seek=20008`（512 字節塊）對應字節偏移 `0x9C5000`，不同固件可能不同，先解析 boot 鏡像確認。

---

*本手冊基於實際打通過程整理，操作順序不可顛倒，關鍵步驟（DTB → 上電 → 驅動 → supplicant）缺一不可。*
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
