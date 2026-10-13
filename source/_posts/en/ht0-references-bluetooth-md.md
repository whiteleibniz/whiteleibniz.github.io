---
title: "bluetooth"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/ht0-references-bluetooth-md/
search: true
categories:
- AI工作流
- 可复用资产
tag:
- HT0
- WCN
- 技能
---


# Unisoc SC9832A Device (HT0) Bluetooth Bring-Up — AI Execution Guide

> **Audience**: AI assistants (Doubao / other large models) that need to quickly resolve Bluetooth unavailability on similar devices (Unisoc SC9832A, Android kernel + Alpine user space)
> **How to use**: Read §1–§3 first to build context → execute the standard procedure in §5 → verify per §6 → on faults, consult the decision table in §7
> **Core value**: All facts in this article have been verified by measurement; following it confirms whether the underlying layers are working in as little as 5 minutes, avoiding days of repeated pitfalls

---

## 1. Device and Environment Overview

| Item | Value |
|---|---|
| Device model | HT0 (reference machine: H709, running Android 6.0, usable as an information source) |
| Hostname / kernel | `spd-box` / `Linux 3.10.65 #13 SMP PREEMPT armv7l` |
| System combination | **Keep the Android 6.0 kernel + switchroot to Alpine Linux** (critical!) |
| SSH | `root@<设备IP>` (RNDIS debug port; password recorded in the environment notes) / WiFi: `<WiFi-IP>` |
| Wireless chip | Unisoc **Marlin combo WCN** (WiFi + Bluetooth on the same chip) |
| Bluetooth HCI | `/dev/ttyS0`, 3M baud rate + CRTSCTS, H4 protocol |
| Bluetooth wake-up | `/proc/bluetooth/sleep/btwrite` (write 1) |
| Current status | The underlying layers are up; the user-space daemon + LVGL Bluetooth settings page are deployed, with boot autostart |

> ⚠️ After a reboot, SSH may be briefly unreachable (USB port switching); poll and retry. The `/tmp` directory persists across reboots (chroot environment, with the tools inside).

---

## 2. Confirmed Hard Facts (No Need to Re-explore; Trust Them Directly)

1. **Bluetooth firmware is downloaded together with WiFi**: when running `chroot /tmp/aand /bin/download -i wlan0`, the combo firmware (including the Bluetooth part) is already burned into the chip as a whole → **WiFi up = Bluetooth firmware ready**; there is no need to flash Bluetooth firmware separately.
2. **pskey is already in effect**: download reads [SETCTION 6] of `/tmp/aand/etc/marlinba/connectivity_configure.ini` and issues the Bluetooth pskey; the measured Read Features returns `ff ff 8d fe`, exactly matching the feature_set in `pskey_bt.txt` → **do not fuss over "missing pskey"; it does not need to be sent separately**.
3. **The number one root cause of BT-OPEN failure**: the permissions of `/tmp/aand/proc/mdbg/*` inside the chroot are 600 → after `chmod 666 /tmp/aand/proc/mdbg/*`, it returns `WCNBTWIFI-CMD OK`. This must be done after every reboot.
4. **btwrite is a prerequisite for HCI responsiveness**: the Bluetooth engine sleeps for power saving, so 1 must be written periodically (every 1.5~2 s) to wake it; without it → HCI does not respond or returns only a single SPRD3 identity frame.
5. **SPRD3 identity frame = engine startup signal**: `55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e` ("SPRD3" = the Unisoc identifier); receiving it means the HCI channel is alive.
6. **Scanning prerequisite**: you must **first send Write Scan Enable (0x0c1a, 0x03) and then Inquiry** (GIAC `0x33 0x8b 0x9e`); otherwise the Inquiry is accepted (CMD_STATUS 0x00) but never produces an Inquiry Result.
7. **The firmware's real MAC**: `11:22:14:31:93:27` (a probe response value, not fabricated).
8. **Baud rate**: after the firmware's BT initialization, 115200→3M; the daemon opens ttyS0 directly at 3M.
9. **Sample of scanned devices**: `48:f1:ae:25:7e:48 class=5a420c` (a phone, BR/EDR).
10. **Process chain**: `logdw → download(resident) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)`.

---

## 3. Verified Dead Ends (Do Not Retry; They Waste Turns)

| Route | Result | Reason |
|---|---|---|
| Kernel `hci_uart.ko` driver | hci0 can register (DOWN INIT RUNNING), but `hciconfig up` times out and TX=0 | The 3.10 Android-customized kernel has tty_struct offsets that do not match the driver; compiling old kernel modules with Alpine gcc14.2 reports invalid module format |
| vhci virtual solution | Explicitly rejected by the user | — |
| Repeatedly trying boot command sequences as a black box | Incomplete, unstable state | The boot protocol requires packet capture on the reference machine, and it **does not affect achieving the scanning function**, so it is not worth obsessing over |
| Killing the daemon with an inline `ps \| grep` pattern | Accidentally kills the shell itself executing the command | Use `pkill -9 -x bt_user_daemon` |
| `/tmp/reset_tty` to restore ldisc | Segmentation fault | Use python `fcntl.ioctl(fd, 0x5421, b'\x00\x00\x00\x00')` (TIOCSETD=0x5421, N_TTY=0) |
| Killing download to "restart a clean environment" | Corrupts the WiFi/Bluetooth firmware state; requires a full device reboot to recover | **Keep download resident; never kill it** |

---

## 4. System Model: Four Layers + Verification Criteria per Layer

```
① 固件/物理层    download 烧固件 → SDIO 枚举 0x2331
                 验证: cat /sys/bus/sdio/devices/mmc2:8800:1/device  → 0x2331
② 上电层         wcnd + BT-OPEN → WCNBTWIFI-CMD OK
                 验证: cat /tmp/bt_once.log 含 "WCNBTWIFI-CMD OK"
③ 引擎层         btwrite 唤醒 → HCI 响应 + SPRD3 帧
                 验证: bt_probe_full 收到 Reset 响应 04 0e 04 01 03 0c 00
④ 应用层         daemon socket → LVGL 页面
                 验证: printf 'scan 15\n' 客户端 → OK N + 设备行
```

**Troubleshooting discipline**: whichever layer fails verification, look for the cause only within that layer and its upstream; do not try randomly across layers.

---

## 5. Standard Execution Procedure (Directly Copyable)

### 5.1 Confirm the Environment

```sh
uname -a; hostname
ls /tmp/aand/bin/download /tmp/aand/bin/wcnd /tmp/bt_once /tmp/bt_wake.sh
ls /usr/local/bin/bt_user_daemon /tmp/bt_probe_full
```

### 5.2 Bring Up WiFi (Prerequisite for Bluetooth)

```sh
pkill -9 -f logdw 2>/dev/null; pkill -9 -f 'wcnd' 2>/dev/null; pkill -9 -x bt_once 2>/dev/null
setsid /tmp/logdw >/dev/null 2>&1 </dev/null &
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl_run.log 2>&1 </dev/null &
sleep 15
cat /sys/bus/sdio/devices/mmc2:8800:1/device     # 期望 0x2331
insmod /lib/modules/marlin_fm.ko; insmod /lib/modules/sprdwl.ko
ip link set wlan0 up
```

### 5.3 Bluetooth Power-Up + Wake-Up + daemon

```sh
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null

ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_once' || setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 3
grep -q 'CMD OK' /tmp/bt_once.log || echo "BT-OPEN FAIL, 检查 chmod 是否生效"

ps -ef | grep -q '[b]t_wake' || setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &

pgrep -x bt_user_daemon >/dev/null || setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
```

### 5.4 Verify (python3 on the device; no socat)

```sh
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"                    # 期望 OK ON

printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"                                # 期望 OK N + 设备行
```

---

## 6. Verification Criteria Checklist (Confirm Item by Item)

| # | Check | Expected |
|---|---|---|
| 1 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 2 | `grep 'CMD OK' /tmp/bt_once.log` | `push(17): WCNBTWIFI-CMD OK` |
| 3 | `/tmp/bt_probe_full 20` | All six steps pass (Reset/Ver/BD_ADDR/Buffer/Features/Scan Enable) |
| 4 | `cat /proc/bluetooth/sleep/btwrite` is writable | `echo 1 > ...` returns WRITE_OK |
| 5 | socket `state` | `OK ON` |
| 6 | socket `scan 15` | `OK N` + device lines (if there are no devices, N=0, which does not count as failure) |
| 7 | `pgrep -x bt_user_daemon` | Single instance |
| 8 | LVGL desktop "Bluetooth" icon → toggle/search/list | The page works normally |

---

## 7. Fault → Root Cause → Fix Decision Table

| Symptom | Most likely root cause | Fix |
|---|---|---|
| BT-OPEN FAIL | mdbg permissions are 600 | Retry with `chmod 666 /tmp/aand/proc/mdbg/*` |
| HCI does not respond / returns SPRD3 only once | Missing btwrite wake-up | Start bt_wake.sh; confirm btwrite is writable |
| Scan returns no results | Write Scan Enable was not sent first | Use the daemon scan command (already handled internally) |
| socket connect fails | Multiple daemon instances competing for the socket | `pkill -9 -x bt_user_daemon` → restart as a single instance |
| daemon log "Not a tty" | tty ldisc is occupied | python ioctl TIOCSETD=0x5421 to restore N_TTY |
| WiFi/Bluetooth both gone | download was killed | Reboot the whole device and re-bring-up per §5.2 |
| The screen program repeatedly "reverts to the old version" | The watchdog/boot script points to the build path | Change all to `/usr/local/bin/lvgl_demo` (done) |
| Port 22 unreachable after a reboot | USB port switching | Poll and reconnect (bt_auto_resume.py can be reused on this device) |

---

## 8. User-Space daemon Architecture (Must Read Before Changes/Maintenance)

```
┌─────────────┐   unix socket    ┌──────────────────────────┐
│ LVGL 蓝牙页 │  /tmp/bt_ctl.sock │  bt_user_daemon           │
│ (C, LVGL9)  │ ────────────────► │  ┌────────────────────┐  │
└─────────────┘   state/on/off/   │  │ H4 HCI 引擎         │  │
                  scan/list/      │  │ ttyS0 3M+CRTSCTS    │  │
                  connect         │  └─────────┬──────────┘  │
                                  │            │ HCI 帧       │
                                  │     ┌──────▼──────┐      │
                                  │     │ Marlin 芯片  │      │
                                  │     └─────────────┘      │
                                  └──────────────────────────┘
```

**Protocol** (text lines; the client reads until EOF after shutdown(SHUT_WR)):
- `state` → `OK ON` / `OK OFF`
- `on` / `off` → turn Bluetooth on/off (HCI Reset + Scan Enable enable/disable)
- `scan N` → scan for N seconds, returning `OK <count>` + one line per device of `bd_addr class rssi`
- `list` → list the most recent scan results
- `connect <bd>` → attempt to connect (when the BR/EDR peer does not accept, it returns RC -2, which is expected)

**Implementation points** (do not break these when refactoring):
- `B3000000` + `CRTSCTS`, blocking read with `VMIN=1`
- Frame reading per the H4 frame header: `buf[1]=evt`, `buf[2]=len`, with select timeout protection
- The scan procedure is fixed: `Write Scan Enable(0x0c1a,0x03)` → `Inquiry(0x0401, 33 8b 9e)` → receive Inquiry Result
- socket 0666, single instance (managed by openrc command_background)
- Logs: `/tmp/btud.log` (stdout), `/tmp/btud_dbg.log` (TX/RX hex)

---

## 9. Red Lines and Operational Discipline

1. **Keep download resident; never kill it** — killing it entirely corrupts the firmware state, recoverable only by a full device reboot.
2. **Driver load order**: `marlin_fm.ko` first, `sprdwl.ko` after (symbol dependency).
3. **Killing processes**: always use `pkill -9 -x <name>`; the inline `ps | grep` pattern is forbidden.
4. **Must be done after a reboot**: mdbg chmod 666 (the boot script does it automatically; do not forget it during manual debugging).
5. **Keep btwrite wake-up during Bluetooth scanning** (do not stop bt_wake.sh).
6. **Do not touch the USB OTG / network mode configuration** (an explicit user constraint).
7. Multiple instances fighting = clean them up with `pkill` first before starting; do not stack on top of leftovers.

---

## 10. Inventory of Existing Tools on the Device (Reuse Them; Do Not Rebuild)

| Tool | Location | Purpose |
|---|---|---|
| bt_user_daemon | `/usr/local/bin/bt_user_daemon` | Production daemon (deployed) |
| bt_probe_full | `/tmp/bt_probe_full` | HCI six-step probe diagnostics |
| hci_3m | `/tmp/hci_3m` | 3M raw HCI testing |
| bt_once | `/tmp/bt_once` | BT-OPEN trigger |
| bt_wake.sh | `/tmp/bt_wake.sh` | Periodic btwrite wake-up |
| bt_daemon | `/etc/init.d/bt_daemon` | openrc autostart (rc-update add default) |
| wifi.start | `/etc/local.d/wifi.start` | Boot-time WiFi + download chain |
| lvgl_demo | `/usr/local/bin/lvgl_demo` | LVGL desktop (includes the Bluetooth page; committed to git) |
| pskey_bt.txt | `/mnt/android_sys/lib/modules/pskey_bt.txt` | Authoritative Bluetooth parameter values |
| btud_dbg.log | `/tmp/btud_dbg.log` | daemon TX/RX hex log |

---

## 11. Future Enhancement Directions (Currently Incomplete)

| Item | Description | Suggested path |
|---|---|---|
| Real pairing/connection | The daemon `connect` has only been tested at the BR/EDR layer (RC -2 is expected) | Capture the complete ttyS0 traffic when Bluetooth is enabled on the reference machine H709, and replay the initialization sequence (including boot commands) |
| BLE support | Only BR/EDR scanning has been verified so far | Extend to HCI LE commands (LE Set Scan Parameters/Enable) |
| Audio A2DP | No protocol stack; unavailable for now | Requires introducing BlueZ or a lightweight A2DP stack |
| daemon connection state persistence | Connection attempts are currently not saved | The page can add a "connected devices" status display |

---

## 12. 5-Minute Quick Acceptance Path

```sh
# 1) 三层状态一条命令
grep 'CMD OK' /tmp/bt_once.log && cat /sys/bus/sdio/devices/mmc2:8800:1/device && pgrep -x bt_user_daemon
# 2) 应用层一次 socket 调用
printf 'scan 8\n' | timeout 15 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"
```

If both of the above pass → the Bluetooth underlying layers + application chain are all OK, and you can proceed directly to the "enhancement directions" work; if they do not pass → locate the issue item by item per the §7 decision table.

---

*Document version: v1.0 (distilled after the Bluetooth bring-up)*
*Related documents: the operation manual (for humans), the startup procedure comparison, the work process summary*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
