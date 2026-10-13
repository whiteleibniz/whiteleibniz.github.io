---
title: "Bluetooth Bring-up: AI Guidance Manual"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/bt-04-ai-md/
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# Spreadtrum SC9832A Device (HT0) Bluetooth Bring-up — AI Execution Guidance Manual

> **Intended audience**: AI assistants (Doubao / other large models) that need to quickly resolve Bluetooth unavailability on similar devices (Spreadtrum SC9832A, Android kernel + Alpine userland)
> **How to use**: first read §1–§3 to build context → execute per the standard flow in §5 → verify per §6 → consult the decision table in §7 when problems occur
> **Core value**: all facts in this article have been verified by live testing; following it confirms whether the lower layers are connected in as little as 5 minutes, avoiding days of repeated pitfall-hitting

---

## 1. Device and Environment at a Glance

| Item | Value |
|---|---|
| Device model | HT0 (reference machine: H709, running Android 6.0, usable as an information source) |
| Hostname / kernel | `spd-box` / `Linux 3.10.65 #13 SMP PREEMPT armv7l` |
| System combination | **retains the Android 6.0 kernel + switchroot to Alpine Linux** (critical!) |
| SSH | `root@<设备IP>` (RNDIS debug port, password in the environment record) / WiFi: `<WiFi-IP>` |
| Wireless chip | Spreadtrum **Marlin combo WCN** (WiFi + Bluetooth on the same chip) |
| Bluetooth HCI | `/dev/ttyS0`, 3M baud rate + CRTSCTS, H4 protocol |
| Bluetooth wake-up | `/proc/bluetooth/sleep/btwrite` (write 1) |
| Current state | lower layers are up; the userland daemon + LVGL Bluetooth settings page are deployed, with boot auto-start |

> ⚠️ After reboot, SSH may be briefly unreachable (USB port switching); polling retries are needed. The `/tmp` directory survives reboot (the chroot environment and tools are all there).

---

## 2. Confirmed Hard Facts (no need to re-investigate; trust directly)

1. **Bluetooth firmware is downloaded together with WiFi**: when `chroot /tmp/aand /bin/download -i wlan0` runs, the combo firmware (including the Bluetooth part) has already been burned into the chip as a whole → **WiFi up = Bluetooth firmware ready**; there is no need to burn the Bluetooth firmware separately.
2. **pskey is already in effect**: download reads the [SETCTION 6] section of `/tmp/aand/etc/marlinba/connectivity_configure.ini` to deliver the Bluetooth pskey; the measured Read Features returns `ff ff 8d fe`, exactly matching the feature_set in `pskey_bt.txt` → **do not fuss over "missing pskey"; it does not need to be sent separately**.
3. **Number one root cause of BT-OPEN failure**: permissions 600 on `/tmp/aand/proc/mdbg/*` inside the chroot → after `chmod 666 /tmp/aand/proc/mdbg/*` it returns `WCNBTWIFI-CMD OK`. This must be done after every reboot.
4. **btwrite is the prerequisite for HCI responses**: the Bluetooth engine sleeps to save power, so 1 must be written periodically (1.5~2s) to wake it; without it → no HCI response, or only a single SPRD3 identity frame in reply.
5. **SPRD3 identity frame = engine start signal**: `55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e` ("SPRD3" = Spreadtrum identifier); receiving it means the HCI channel is alive.
6. **Scanning prerequisite**: you must **first send Write Scan Enable (0x0c1a, 0x03) before Inquiry** (GIAC `0x33 0x8b 0x9e`); otherwise Inquiry is accepted (CMD_STATUS 0x00) but never returns an Inquiry Result.
7. **Firmware real MAC**: `11:22:14:31:93:27` (probe response value, not spoofed).
8. **Baud rate**: after firmware BT initialization, 115200→3M; the daemon opens ttyS0 directly at 3M.
9. **Sample scanned device**: `48:f1:ae:25:7e:48 class=5a420c` (phone, BR/EDR).
10. **Process chain**: `logdw → download(resident) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)`.

---

## 3. Verified Dead Ends (do not retry; it wastes turns)

| Route | Result | Reason |
|---|---|---|
| Kernel `hci_uart.ko` driver | hci0 registers (DOWN INIT RUNNING) but `hciconfig up` times out, TX=0 | custom Android 3.10 kernel; tty_struct offsets do not match the driver; Alpine gcc14.2 building the old kernel module reports invalid module format |
| vhci virtual approach | explicitly rejected by the user | — |
| Repeatedly trying boot command sequences black-box | incomplete, unstable state | the boot protocol needs packet capture from a reference machine, and **it does not affect achieving the scan function**; not worth grinding on |
| `ps \| grep` inline pattern to kill the daemon | accidentally kills the shell executing the command itself | use `pkill -9 -x bt_user_daemon` |
| `/tmp/reset_tty` to restore ldisc | segmentation fault | use python `fcntl.ioctl(fd, 0x5421, b'\x00\x00\x00\x00')` (TIOCSETD=0x5421, N_TTY=0) |
| Killing download to "restart a clean environment" | breaks WiFi/Bluetooth firmware state; requires a full machine reboot to recover | **download is resident — do not kill it** |

---

## 4. System Model: Four Layers + a Pass Criterion per Layer

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

**Troubleshooting discipline**: whichever layer fails verification, look for the cause only in that layer and its upstream; do not skip layers and try blindly.

---

## 5. Standard Execution Flow (directly copyable)

### 5.1 Confirm the environment

```sh
uname -a; hostname
ls /tmp/aand/bin/download /tmp/aand/bin/wcnd /tmp/bt_once /tmp/bt_wake.sh
ls /usr/local/bin/bt_user_daemon /tmp/bt_probe_full
```

### 5.2 Bring up WiFi (Bluetooth prerequisite)

```sh
pkill -9 -f logdw 2>/dev/null; pkill -9 -f 'wcnd' 2>/dev/null; pkill -9 -x bt_once 2>/dev/null
setsid /tmp/logdw >/dev/null 2>&1 </dev/null &
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl_run.log 2>&1 </dev/null &
sleep 15
cat /sys/bus/sdio/devices/mmc2:8800:1/device     # 期望 0x2331
insmod /lib/modules/marlin_fm.ko; insmod /lib/modules/sprdwl.ko
ip link set wlan0 up
```

### 5.3 Bluetooth power-on + wake-up + daemon

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

### 5.4 Verify (python3 on the device, no socat)

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

## 6. Verification Checklist (confirm item by item)

| # | Check | Expected |
|---|---|---|
| 1 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 2 | `grep 'CMD OK' /tmp/bt_once.log` | `push(17): WCNBTWIFI-CMD OK` |
| 3 | `/tmp/bt_probe_full 20` | all six steps pass (Reset/Ver/BD_ADDR/Buffer/Features/Scan Enable) |
| 4 | `cat /proc/bluetooth/sleep/btwrite` writable | `echo 1 > ...` returns WRITE_OK |
| 5 | socket `state` | `OK ON` |
| 6 | socket `scan 15` | `OK N` + device lines (N=0 if no devices, not a failure) |
| 7 | `pgrep -x bt_user_daemon` | single instance |
| 8 | LVGL desktop "Bluetooth" icon → on/off/search/list | page works normally |

---

## 7. Fault → Root Cause → Fix Decision Table

| Symptom | Most likely root cause | Fix |
|---|---|---|
| BT-OPEN FAIL | mdbg permissions 600 | `chmod 666 /tmp/aand/proc/mdbg/*` and retry |
| No HCI response / only a single SPRD3 reply | missing btwrite wake-up | start bt_wake.sh; confirm btwrite is writable |
| No scan results | Write Scan Enable not sent first | use the daemon scan command (handled internally) |
| socket connect failure | daemon multiple instances fighting over the socket | `pkill -9 -x bt_user_daemon` → restart as a single instance |
| daemon log "Not a tty" | tty ldisc occupied | python ioctl TIOCSETD=0x5421 to restore N_TTY |
| WiFi/Bluetooth both gone | download was killed | full machine reboot, re-bring-up per §5.2 |
| Screen program repeatedly "reverts to the old version" | watchdog/boot script points to the build path | change uniformly to `/usr/local/bin/lvgl_demo` (already done) |
| Port 22 unreachable after reboot | USB port switching | poll and reconnect (bt_auto_resume.py is reusable on the local machine) |

---

## 8. Userland Daemon Architecture (required reading for modifications/maintenance)

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
- `on` / `off` → toggle Bluetooth (HCI Reset + Scan Enable enable/disable)
- `scan N` → scan for N seconds, returns `OK <count>` + one line per device `bd_addr class rssi`
- `list` → list the most recent scan results
- `connect <bd>` → attempt to connect (returns RC -2 when the BR/EDR peer does not accept, which is expected)

**Implementation points** (do not break these when refactoring):
- `B3000000` + `CRTSCTS`, `VMIN=1` blocking read
- frame reading per the H4 frame header: `buf[1]=evt`, `buf[2]=len`, with select timeout protection
- the scan flow is fixed as: `Write Scan Enable(0x0c1a,0x03)` → `Inquiry(0x0401, 33 8b 9e)` → receive Inquiry Result
- socket 0666, single instance (managed by openrc command_background)
- logs: `/tmp/btud.log` (stdout), `/tmp/btud_dbg.log` (TX/RX hex)

---

## 9. Red Lines and Operational Discipline

1. **download is resident — do not kill it** — killing everything breaks firmware state; recovery is only possible with a full machine reboot.
2. **Driver load order**: `marlin_fm.ko` first, `sprdwl.ko` second (symbol dependency).
3. **Killing processes**: always `pkill -9 -x <name>`; the `ps | grep` inline pattern is forbidden.
4. **Must-do after reboot**: mdbg chmod 666 (already automated in the boot script; do not forget during manual debugging).
5. **Keep the btwrite wake-up active during Bluetooth scanning** (do not stop bt_wake.sh).
6. **Do not touch USB OTG / network mode configuration** (explicit user constraint).
7. Multiple instances fighting = `pkill` clean first, then start; do not stack on top of leftovers.

---

## 10. Existing Tools Inventory on the Device (reuse; do not reinvent)

| Tool | Location | Purpose |
|---|---|---|
| bt_user_daemon | `/usr/local/bin/bt_user_daemon` | production daemon (already deployed) |
| bt_probe_full | `/tmp/bt_probe_full` | HCI six-step probe diagnostics |
| hci_3m | `/tmp/hci_3m` | 3M raw HCI test |
| bt_once | `/tmp/bt_once` | BT-OPEN trigger |
| bt_wake.sh | `/tmp/bt_wake.sh` | periodic btwrite wake-up |
| bt_daemon | `/etc/init.d/bt_daemon` | openrc auto-start (rc-update add default) |
| wifi.start | `/etc/local.d/wifi.start` | boot WiFi + download chain |
| lvgl_demo | `/usr/local/bin/lvgl_demo` | LVGL desktop (includes the Bluetooth page; committed to git) |
| pskey_bt.txt | `/mnt/android_sys/lib/modules/pskey_bt.txt` | authoritative values of Bluetooth parameters |
| btud_dbg.log | `/tmp/btud_dbg.log` | daemon TX/RX hex log |

---

## 11. Future Enhancement Directions (currently incomplete)

| Item | Description | Suggested path |
|---|---|---|
| Real pairing/connection | the daemon `connect` has only been tested at the BR/EDR layer (RC -2 is expected) | capture the complete ttyS0 traffic when the reference machine H709 enables Bluetooth, and replay the initialization sequence (including boot commands) |
| BLE support | only BR/EDR scanning is verified so far | extend the HCI LE commands (LE Set Scan Parameters/Enable) |
| Audio A2DP | no protocol stack, temporarily unavailable | needs to introduce BlueZ or a lightweight A2DP stack |
| daemon connection state persistence | current connection attempts are not saved | the page can add a "connected devices" status display |

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

Both commands above pass → the entire Bluetooth lower layer + application chain is OK; proceed directly to the "enhancement directions" work. If they do not pass → localize item by item per the decision table in §7.

---

*Document version: v1.0 (distilled after the Bluetooth bring-up)*
*Related documents: operation manual (for humans), boot process comparison, work process summary*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
