---
title: "Bluetooth Bring-up: Work Process Summary"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/bt-05-md/
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# Spreadtrum SC9832A Bluetooth Bring-up — Work Process Summary

> Records the complete analysis path, key decisions, failed routes, and final solution from "Bluetooth unusable" to "LVGL Bluetooth settings page usable"
> Timeline: after the WiFi bring-up, the Bluetooth effort lasted several days and ultimately concluded with the userland approach

---

## 1. Task Background and Initial Goals

The device is a Spreadtrum SC9832A tablet with "the Android 6.0 kernel (3.10.65) retained + switchroot to Alpine Linux"; WiFi was already up (download → insmod drivers → wpa_supplicant → udhcpc, with the boot script hardened). The user's goal:

> Add a "Bluetooth settings" app to the LVGL launcher, with the same features as the WiFi settings: **on/off + search list + connect**.
> The user gave full authority: "Open up all permissions, use your most reasonable approach, I only look at results, and even a self-written userland program is fine."

---

## 2. Analytical Framework: First Split "Bluetooth" into Four Layers

Before starting, establish a mental model first — for Bluetooth to work, all four layers must be connected:

```
① 物理/固件层   Firmware burned into the chip? Chip powered on? (download / wcnd / BT-OPEN)
② 通道层        Is the HCI control channel readable/writable? (ttyS0 3M + H4 protocol)
③ 引擎层        Is the Bluetooth engine awake and responding to standard HCI? (btwrite wake-up + SPRD3 identity frame)
④ 应用层        How does the UI call it? (no Bluedroid → self-written daemon + LVGL page)
```

Each layer has a clear "pass criterion"; if a layer fails, investigate the next layer, avoiding wasted time at the wrong level.

---

## 3. The Effort Process (by timeline)

### Stage A: BT-OPEN failure investigation — discovering the mdbg permission root cause

**Symptom**: after bringing things up per the WiFi flow, `bt_once` sending BT-OPEN keeps returning FAIL.

**Investigation**:
1. Compared with the successful WiFi path: WiFi does not depend on BT-OPEN (after download, drivers load directly), but Bluetooth must power on via BT-OPEN
2. strace wcnd and observe what it accesses during BT-OPEN → points to `/tmp/aand/proc/mdbg/*`
3. Inspection found the mdbg node permissions inside the chroot are **600**, so wcnd, running as the system user, cannot read them

**Fix**: `chmod 666 /tmp/aand/proc/mdbg/*` → BT-OPEN returns `WCNBTWIFI-CMD OK`

**Lesson**: the Android userland inside the chroot needs to access proc nodes; the permission model (600) is the easiest pitfall after porting.

### Stage B: HCI channel verification — confirming the firmware is alive

**Method**: without depending on any driver, open /dev/ttyS0 directly from userland and send an HCI Reset.

**Result**: `hci_3m` (3M + CRTSCTS) received the firmware response `04 0e 04 01 03 0c 00` — **the firmware HCI channel is completely normal**.

**Significance**: proves the chip, firmware, and UART are all OK, and the problem lies only in how the upper layers hook in.

### Stage C: Kernel driver route — tried then abandoned (important decision)

**Attempt**:
- Loaded the device's bundled precompiled hci_uart.ko + custom attach → hci0 registers (DOWN INIT RUNNING)
- `hciconfig hci0 up` times out, TX=0

**Root cause analysis**: this kernel is a custom Android 3.10.65; the tty_struct offsets hardcoded inside hci_uart.ko do not match this kernel → data cannot be sent out.
- Alpine gcc 14.2 compiling the old 3.10 kernel module → insmod invalid module format (symbol/signature mismatch)

**Decision**: **abandon the kernel driver route**. Reasons:
1. The kernel module can only use the existing precompiled version on the device; it cannot be modified
2. The user rejected the vhci virtual approach ("Stop using virtualization")
3. The original Android vendor never used the kernel hci_uart — libbt-vendor operates the UART directly, so the userland approach is the "orthodox" one

### Stage D: Birth of the userland daemon (v1 → v4 iterations)

**Approach**: write a C daemon, going H4 directly on /dev/ttyS0 at 3M+CRTSCTS, serving externally over a unix socket.

**Bugs stepped on during iteration** (each a real lesson):

| Version | Problem | Fix |
|---|---|---|
| v1 | compile failure | missing `<stdint.h>` / `<sys/stat.h>` |
| v2 | frame read truncation (non-blocking read n=7) | changed to blocking read (VMIN=1) + select timeout, reading the full length per the H4 frame header (buf[1]=evt, buf[2]=len) |
| v3 | multiple instances fighting, socket connect dropping | clean up with `pkill -9 -x bt_user_daemon` (do not use the `ps\|grep` inline pattern, which kills the shell itself) |
| v4 | Inquiry Result not received when scanning | see Stage F |

### Stage E: btwrite wake-up — the final kick to get HCI through

**Symptom**: HCI Reset gets a response, but after sending standard commands the firmware goes silent.

**Investigation**:
- Disassembled the device's original bt_vendor.default.so; strings confirm the complete flow: **btwrite wake-up → connect to wcnd (BT-OPEN) → read uart_conf → send pskey → HCI**
- Discovered that `/proc/bluetooth/sleep/btwrite` exists and is writable (previously misjudged as "the kernel has no such driver")
- The H709 reference machine's log shows Bluetooth writes 1 with btwrite every 30s periodically

**Fix**: `echo 1 > /proc/bluetooth/sleep/btwrite` → **HCI responds immediately!** The firmware returns the SPRD3 identity frame (`55 7e ... 53 50 52 44 33 ...`)
→ self-write `/tmp/bt_wake.sh` to wake every 1.5~2s (more frequent than Android's 30s, ensuring no missed responses during scanning)

**Key insight**: the Bluetooth engine has a power-saving mode; wake-up is a continuous, periodic action, not a one-time thing.

### Stage F: Root cause of scan failure — Write Scan Enable must come first

**Symptom**: Inquiry is accepted (CMD_STATUS 0x00) but an Inquiry Result never arrives.

**Investigation**: compared probe rounds — the round that scanned devices had done Write Scan Enable.

**Fix**: send `Write Scan Enable 0x0c1a (0x03)` before scanning → **Inquiry Result returns stably immediately**
Live test: `OK 1 / 48:f1:ae:25:7e:48 5a420c 0` (a real phone was scanned)

**This is a hidden requirement of the Spreadtrum firmware**: without enabling scan first, Inquiry simply "sinks like a stone".

### Stage G: The pskey mystery — clarified rather than ground on

**Question**: the Android libbt-vendor must send pskey before the firmware is ready; am I missing this?

**Conclusion (decisive evidence)**:
- the [SETCTION 6] section of `connectivity_configure.ini` is the Bluetooth pskey structure (pskey_cmd=0x001C0101, device_addr, UART0 HCI configuration)
- **download reads this file** → the pskey was already delivered during the firmware download phase
- the measured Read Features returns `ff ff 8d fe`, **exactly matching** the feature_set in pskey_bt.txt → the pskey is already in effect

**Decision**: no need to send pskey separately, avoiding wasted time on a non-question.

### Stage H: Protocol frame details — SLIP and the SPRD3 boot frame

**Symptom**: standard H4 raw frames sometimes get no response, and the firmware returns `7e 00 8b 00 00 cb ab 7e` (a bootloader state error frame).

**Analysis**:
- Frame format confirmed: `7e <type:2B> <len:2B> <data> <crc16> 7e` (same as the download protocol)
- CRC decoded: XMODEM (0x1021/init 0), stored little-endian
- The firmware steadily returning the SPRD3 identity frame = the engine is in a boot loop, waiting for a specific initialization sequence

**Decision**: black-box boot command trials are incomplete; the most reliable approach is to capture and replay the complete ttyS0 traffic when the reference machine (H709) enables Bluetooth. The user assisted by using WatchTools ADB to connect to the reference machine and collect Android-side information (init.rc, ueventd.rc, pskey_bt.txt, bt_vendor library) — **after confirming the approach is viable, stop grinding on the boot sequence**, because:
1. Standard HCI commands (Reset/Version/BD_ADDR/Features/Scan) all respond already
2. The scan function is through → the application-layer goal (search list) is satisfied
3. The boot sequence only affects the complete initialization of "pairing/connection", which is a future enhancement

### Stage I: Hardening boot auto-start

- openrc `/etc/init.d/bt_daemon` (command_background=yes), `rc-update add default`
- Together with wifi.start (resident download) + lvgl_demo.start, forms the complete boot chain
- Live test after reboot: SDIO 0x2331, wcnd/bt_once/logdw/download/bt_wake all running, daemon single instance

### Stage J: LVGL Bluetooth settings page

- Written bluetooth_page.c/h following the verified network_page.c (WiFi template)
- Launcher registered in three places: enum + s_apps array + open_app switch (LV_SYMBOL_BLUETOOTH exists)
- daemon text protocol: state/on/off/scan/list/connect
- Fixed a deployment path issue: the boot script and watchdog originally pointed to build/lvgl_demo (the old version); changed uniformly to /usr/local/bin/lvgl_demo

---

## 4. Key Decisions Review (why it is done this way)

| Decision point | Choice | Reason |
|---|---|---|
| Kernel driver vs userland | **userland** | kernel 3.10 offsets do not match (TX=0); the original Android vendor manages the UART directly in userland; the user rejected vhci |
| Self-written daemon vs porting Bluedroid | **self-written minimal daemon** | Alpine lacks the Bluedroid dependency chain (libraries/property service/HAL); the porting cost is far higher than writing the HCI layer yourself |
| Reusing the original Android download/wcnd | **reuse (chroot)** | the firmware download/power-on sequence is the chip's closely guarded timing; the original binaries are the most reliable; self-writing download is high-risk, low-reward |
| Whether to send pskey separately | **do not send** | the evidence chain is complete: download already delivered it (configure.ini) + Read Features confirms it is in effect |
| Black-box boot sequence vs reference machine packet capture | **stop once viability is confirmed** | the application goal (scan list) is achieved; the boot sequence is a pairing enhancement and does not block the main line |
| Wake-up period 1.5~2s | **more frequent than Android's 30s** | the userland has no power-saving coordination of a complete protocol stack; frequent wake-ups ensure stable HCI responses |

---

## 5. Final Results and Distillation

```
底层链路（每步已验证）：
  杀净残留 → logdw → download(-i wlan0, 常驻) → SDIO 0x2331
  → chmod 666 mdbg → wcnd → bt_once(BT-OPEN OK)
  → bt_wake.sh(btwrite) → bt_user_daemon(H4 HCI) → socket

应用层：
  LVGL launcher "蓝牙" 图标 → 蓝牙设置页（开关/搜索/设备列表）
  开关=on/off，搜索=scan N（自动 Write Scan Enable + Inquiry）

开机自启：
  /etc/local.d/wifi.start + /etc/init.d/bt_daemon（openrc）
  重启后全链路自动拉起

已提交：
  git 973e3b5 新增蓝牙设置应用（含蓝牙页 + 路径统一）
```

---

## 6. Lessons Learned (reusable for other modules)

1. **Layer first, then localize** — each layer has a clear pass criterion (BT-OPEN OK / HCI Reset response / SPRD3 / Inquiry Result); do not skip layers and try blindly.
2. **Permission problems are the number one pitfall in porting** — proc node 600 permissions inside the chroot caused the BT-OPEN failure; `chmod 666` solved it in a minute, whereas hours might have been wasted before.
3. **The reference machine is a goldmine** — the original Android init.rc / ueventd.rc / pskey_bt.txt / bt_vendor library provided the complete truth of the flow; disassembly + string extraction turned "not knowing how to do it" into "just follow it".
4. **Understand vendor firmware behavior** — Write Scan Enable coming first is a hidden requirement of the Spreadtrum firmware; this kind of "does not work unless stated" behavior can only be discovered through comparison experiments.
5. **Do not get stuck on dead ends** — abandoned the kernel driver's TX=0 decisively; when black-box boot sequences are incomplete, stop grinding, and after evaluating "current results already satisfy the user's goal", stop and put energy into the application layer.
6. **Process hygiene** — multiple instances fighting over the socket, ps|grep killing itself, the watchdog auto-starting the old path — these "operational details" repeatedly create the illusion of "it was fixed but it reverted".
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
