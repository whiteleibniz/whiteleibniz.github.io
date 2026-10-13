---
title: "Bluetooth Boot Process: Android vs Alpine Comparison"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/bt-03-vsalpine-md/
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# Spreadtrum SC9832A Bluetooth Boot Process — Android vs Alpine (this device) Comparison

> Hardware: Spreadtrum Marlin combo WCN chip (WiFi + Bluetooth on the same chip)
> This device: retains the Android 6.0 kernel (3.10.65) + switchroot to Alpine Linux
> Purpose: explain the complete Bluetooth flow from boot to usability, comparing the principle differences between native Android and the current Alpine approach

---

## 1. Chip Physical Architecture (shared by both systems)

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
        │                     │      │ sleep/btwrite    │  ← 唤醒节点
        └─────────────────────┘      └──────────────────┘
```

- **SDIO**: data channel (WiFi data and bulk Bluetooth firmware downloads both go through here)
- **UART ttyS0**: Bluetooth HCI control channel (3M baud rate + hardware flow control CRTSCTS, H4 protocol)
- **btwrite node**: `/proc/bluetooth/sleep/btwrite` — writing 1 wakes the Bluetooth engine (power-saving mode management)

---

## 2. Native Android 6.0 Bluetooth Boot Process

Key information on the Android side comes from the original machine's `init.board.rc` / `init.rc` / `ueventd.rc`:

### 2.1 Boot Chain

```
开机
 └─ init 执行 init.board.rc
     ├─ chmod 660 /proc/bluetooth/sleep/btwrite    ← 唤醒节点权限
     ├─ chmod 660 /sys/devices/70000000.uart/uart_conf ← UART 配置节点
     ├─ chown bluetooth system ...（属主）
     ├─ service download  /system/bin/download     ← 固件下载（class core, oneshot）
     │     user system / group system shell wifi bluetooth
     ├─ service btld /system/bin/btld -lpm 0 -hb 3000000  ← 蓝牙低功耗管理（3M 波特率）
     │     user root / group bluetooth net_bt_admin
     ├─ service bt_rm /system/bin/bt_rm             ← 蓝牙射频管理
     ├─ #service hciattach /system/bin/hciattach -n /dev/sttybt0 sprd_shark（被注释掉）
     └─ Bluedroid 协议栈（bluetooth.default.so + libbt-vendor）
           ├─ libbt-vendor: btwrite 唤醒（H709 日志可见每 30s 周期写 1→1.5s→写 2）
           ├─ libbt-vendor: 读 uart_conf、发 pskey（BT_PSKEY_CONFIG_INFO_T）
           ├─ 固件回 SPRD3 身份帧 → HCI 标准命令就绪
           └─ BluetoothCtrl 管理（扫描/配对/连接）
```

### 2.2 Key Android Points

| Stage | Android approach |
|---|---|
| Firmware download | `download` runs oneshot at boot, reads `connectivity_configure.ini` (includes Bluetooth pskey [SETCTION 6]) + calibration, writes in bulk over SDIO |
| Power-on control | `wcnd` (BT-OPEN command triggers Bluetooth subsystem power-on) |
| Wake-up management | libbt-vendor periodically wakes with `btwrite` (H709 log: writes 1 every 30s → 1.5s → writes 2) |
| HCI channel | traditionally hciattach uses /dev/sttybt0 sprd_shark; this machine actually relies on libbt-vendor managing the UART directly (uart_conf controls the baud rate) |
| Protocol stack | Bluedroid (bluetooth.default.so + libbt-vendor.so) |
| User tools | BluetoothCtrl (Spreadtrum custom Bluetooth control) |
| Nodes/permissions | init.board.rc does unified chmod/chown at boot |

---

## 3. Alpine (this device) Bluetooth Boot Process

### 3.1 Boot Chain (currently hardened)

```
开机
 ├─ /etc/local.d/wifi.start        （local 脚本）
 │     ├─ setsid /tmp/logdw                       ← 固件下载日志通道
 │     ├─ setsid chroot /tmp/aand /bin/download -i wlan0   ← 固件下载（常驻）
 │     ├─ SDIO 枚举验证 mmc2:8800:1 = 0x2331
 │     ├─ insmod marlin_fm.ko → sprdwl.ko         ← WiFi 驱动
 │     └─ ip link set wlan0 up
 ├─ /etc/local.d/lvgl_demo.start
 │     └─ setsid /usr/local/bin/lvgl_demo         ← LVGL 桌面（含蓝牙设置页）
 ├─ /etc/init.d/bt_daemon          （openrc）
 │     ├─ chmod 666 /tmp/aand/proc/mdbg/*         ← 修复 BT-OPEN 权限（重启后必做）
 │     ├─ setsid chroot /tmp/aand /bin/wcnd       ← 上电守护
 │     ├─ setsid /tmp/bt_once 900                 ← BT-OPEN（期望 WCNBTWIFI-CMD OK）
 │     ├─ setsid /tmp/bt_wake.sh                  ← btwrite 周期唤醒
 │     └─ setsid /usr/local/bin/bt_user_daemon    ← 用户态 HCI 守护（unix socket 服务）
 └─ LVGL 蓝牙设置页
       ├─ 开关 → socket `on`/`off`
       ├─ 搜索 → socket `scan N`
       └─ 设备列表 ← socket 返回 bd_addr class rssi
```

### 3.2 Key Alpine Points

| Stage | Alpine approach |
|---|---|
| Firmware download | **reuses the original Android download**, running inside the chroot `/tmp/aand` (depends on Android libraries/nodes/partition symlinks), with the parameter `-i wlan0` (WiFi mode; the Bluetooth firmware is downloaded together with the combo) |
| Power-on control | reuses the original Android wcnd (inside chroot) + bt_once to trigger BT-OPEN |
| Wake-up management | self-written `/tmp/bt_wake.sh` writes btwrite=1 every 1.5~2s (more frequent than Android's 30s, ensuring stable HCI response) |
| HCI channel | **self-written userland daemon** opens /dev/ttyS0 directly (3M+CRTSCTS, H4), not depending on the kernel hci_uart driver |
| Protocol stack | no Bluedroid; the daemon implements a minimal HCI command set (Reset/Version/BD_ADDR/Features/Scan) |
| User tools | LVGL Bluetooth settings page (communicates with the daemon via unix socket) |
| Nodes/permissions | boot script chmod 666 mdbg + bt_daemon openrc management |

---

## 4. Stage-by-Stage Comparison Table

| Comparison item | Native Android 6.0 | Alpine (this device) | Reason for the difference |
|---|---|---|---|
| Firmware download | download (oneshot, system user) | download (chroot, resident) | Alpine has no Android init; the process must be kept alive to prevent the chip from losing firmware |
| Firmware source | partitions wcnfdl/wcnmodem | same partitions (by-name symlinks into the chroot) | same kernel, partition layout unchanged |
| pskey delivery | libbt-vendor sends VSC at initialization | delivered via connectivity_configure.ini when download runs | the firmware already received the pskey during the download phase (feature_set verified live) |
| BT power-on | wcnd + BT-OPEN (triggered by init) | wcnd (chroot) + bt_once | reuses the original; only the executor differs |
| Wake-up | libbt-vendor btwrite every 30s | bt_wake.sh btwrite every 1.5~2s | no libbt-vendor in userland; a more frequent self-written wake-up ensures no missed responses |
| HCI channel | libbt-vendor manages the UART directly | self-written daemon reads /dev/ttyS0 directly | both bypass the kernel protocol stack and operate the serial port directly |
| Kernel driver | no hci_uart (vendor manages directly) | tried hci_uart.ko → abandoned (TX=0) | the 3.10 kernel's tty_struct offsets do not match the newer driver |
| Protocol stack | Bluedroid (complete stack) | no protocol stack; the daemon is HCI layer only | Alpine has no Bluedroid; the LVGL application layer consumes HCI scan results directly |
| Scan implementation | Bluedroid Inquiry | daemon Inquiry + Write Scan Enable first | Spreadtrum firmware behavior: without enabling scan first, no Inquiry Result is returned |
| Management tool | BluetoothCtrl | LVGL Bluetooth settings page (socket) | custom UI for desktop applications |
| Baud rate | 115200 → 3M (switched by uart_conf) | opens ttyS0 directly at 3M | the firmware switches to 3M after BT initialization; the daemon always uses 3M |

---

## 5. Key Principles (why it works)

1. **The same combo chip has WiFi+BT combined firmware** — when download downloads with `-i wlan0`, the Bluetooth firmware portion has already entered the chip along with the combo image; therefore "after WiFi is up, the Bluetooth firmware is ready", and only power-on + wake-up + HCI communication are needed afterwards; there is no need to burn the Bluetooth firmware separately.

2. **The SPRD3 identity frame is the engine start signal** — after wake-up the firmware returns `55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e` ("SPRD3" = Spreadtrum chip identifier), indicating the Bluetooth engine is running and the HCI channel is alive; only after this can standard HCI commands be sent.

3. **btwrite is the power-saving switch** — the Bluetooth engine enters low power when idle, so 1 must be written periodically to wake it; without this step, HCI commands sent out get no response (one of the common root causes of all early test failures).

4. **Write Scan Enable is the prerequisite for scanning** — the Spreadtrum firmware requires sending `0x0c1a (0x03)` first to enable scan, and only then will Inquiry return the Inquiry Result event; a bare Inquiry is accepted (CMD_STATUS 0x00) but results never come.

5. **Userland approach vs kernel driver** — this device's kernel is a custom Android 3.10.65; the tty_struct internal layout that hci_uart.ko depends on is inconsistent with mainline, and the hardcoded offsets cause TX=0 and up timeouts. Reading/writing /dev/ttyS0 directly from userland bypasses the kernel protocol stack and is instead the most reliable (the Android vendor did exactly this).

---

## 6. One-Sentence Summary

> **Android**: init → download → wcnd/BT-OPEN → libbt-vendor (btwrite wake-up + pskey + HCI) → Bluedroid → BluetoothCtrl
> **Alpine (this device)**: boot scripts → chroot download (WiFi mode, combo firmware downloaded together) → wcnd/bt_once → bt_wake.sh (btwrite) → self-written userland daemon (H4 HCI) → LVGL Bluetooth settings page

The underlying hardware chain is exactly the same; the difference lies only in "who executes it": Android relies on init + a complete protocol stack, while this device relies on boot scripts + a self-written userland daemon, replacing that entire set of Android dependencies with a minimal implementation.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
