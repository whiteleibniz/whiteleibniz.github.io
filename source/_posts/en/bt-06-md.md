---
title: "Bluetooth Chip Bring-up: Operation Manual"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/bt-06-md/
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# Spreadtrum SC9832A Bluetooth Chip Bring-up — Manual Operation Manual

> Scope: Spreadtrum SC9832A devices retaining the Android kernel + switchroot to Alpine Linux (hostname `spd-box`, kernel `Linux 3.10.65`)
> Purpose: without relying on an AI assistant, manually bring up the Bluetooth lower layers, verify the HCI channel, deploy the userland daemon, and set up boot auto-start
> All commands in this article have been verified on the device

---

## 0. Prerequisite Concepts (building intuition in 30 seconds)

This device's WiFi and Bluetooth are **the same Spreadtrum Marlin combo chip** (WCN); SDIO carries the data channel, and UART (ttyS0) carries the Bluetooth HCI control channel. The chip firmware does not "reside" in the system; at every boot, the original Android `download` bootloader must burn the firmware into the chip before the chip can work.

```
开机 → download 烧固件 → SDIO 枚举 → 蓝牙固件由 wcnd 触发 BT-OPEN → btwrite 周期性唤醒 → HCI 通道可用
```

| Role | File/process | What it does |
|---|---|---|
| Firmware burning | `/tmp/aand/bin/download` (chroot Android environment) | burns the wcnfdl/wcnmodem partition firmware into the chip via SDIO, powering on and starting the chip |
| Power-on sequence | `/tmp/aand/bin/wcnd` | drives the Bluetooth subsystem to power on after receiving the BT-OPEN command |
| Power-on confirmation | `/tmp/bt_once 900` | sends BT-OPEN; returning `WCNBTWIFI-CMD OK` means success |
| Periodic wake-up | `/tmp/bt_wake.sh` | writes 1 to `/proc/bluetooth/sleep/btwrite` every 1.5~2 seconds, preventing the Bluetooth engine from sleeping |
| HCI service | `/usr/local/bin/bt_user_daemon` | opens /dev/ttyS0 (3M+CRTSCTS) speaking H4, providing a unix socket for application queries |

---

## 1. Environment Preparation

### 1.1 Device state confirmation

```sh
# SSH 登录
ssh root@<设备IP>        # 
# 或
ssh root@<WiFi-IP>           # WiFi 网络地址

# 确认内核与主机名
uname -a                        # 期望: Linux 3.10.65 ... armv7l
hostname                        # 期望: spd-box

# 确认 chroot 安卓环境存在（download 依赖它）
ls /tmp/aand/bin/download /tmp/aand/bin/wcnd
ls /tmp/aand/etc/marlinba/     # 期望有 connectivity_configure.ini 等
```

> ⚠️ If `/tmp/aand` does not exist: the Android userland chroot environment must be rebuilt (create directories, lay out Android system libraries, mount --bind /dev, create wcnfdl/wcnmodem partition symlinks). See Chapter 4 of the WiFi operation manual for details.

### 1.2 Tools Inventory

| Tool | Purpose | Location |
|---|---|---|
| `download` | firmware download bootloader | `/tmp/aand/bin/download` (executed inside chroot) |
| `wcnd` | Bluetooth/WiFi power-on daemon | `/tmp/aand/bin/wcnd` (executed inside chroot) |
| `bt_once` | one-shot BT-OPEN power-on trigger | `/tmp/bt_once` |
| `bt_wake.sh` | periodic btwrite wake-up script | `/tmp/bt_wake.sh` |
| `bt_probe_full` | HCI full-sequence probe (diagnostics) | `/tmp/bt_probe_full` |
| `hci_3m` | 3M baud rate raw HCI test | `/tmp/hci_3m` (early diagnostics) |
| `bt_user_daemon` | userland HCI daemon (production) | `/usr/local/bin/bt_user_daemon` |
| python3 | unix socket client | bundled with the device |

---

## 2. Step One: Bring up WiFi (Bluetooth prerequisite; cannot be skipped)

The Bluetooth chip shares the same firmware and power domain as WiFi, so **the WiFi chip must be brought up first** for Bluetooth to have a physical basis.

```sh
# 1) 清理残留（不要杀 download！）
pkill -9 -f logdw 2>/dev/null
pkill -9 -f 'wcnd' 2>/dev/null
pkill -9 -x bt_once 2>/dev/null

# 2) 启动固件下载通道守护
setsid /tmp/logdw >/dev/null 2>&1 </dev/null &

# 3) 固件下载（WiFi 模式，常驻勿杀）
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl_run.log 2>&1 </dev/null &

# 4) 等待 SDIO 枚举（10~30 秒）
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # 期望: 0x2331
ls /sys/bus/sdio/devices/                        # 期望出现 mmc2:8800:1

# 5) 加载 WiFi 驱动（顺序不能反）
insmod /lib/modules/marlin_fm.ko
insmod /lib/modules/sprdwl.ko
ip link set wlan0 up
ip link show wlan0                              # 出现 wlan0 即成功
```

> Verification criterion: the `mmc2:8800:1` device number is `0x2331`, and the `wlan0` interface exists.

---

## 3. Step Two: Bluetooth Power-On Sequence (BT-OPEN)

### 3.1 Fix mdbg permissions (critical! must be done after every reboot)

The number one cause of BT-OPEN failure: `/tmp/aand/proc/mdbg/*` inside the chroot has permissions 600, causing the power-on command to get no response.

```sh
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null
```

### 3.2 Start wcnd + trigger BT-OPEN

```sh
# wcnd（蓝牙/WiFi 上电守护）
ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2

# BT-OPEN 一次性触发，期望输出 push(17): WCNBTWIFI-CMD OK
setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 3
cat /tmp/bt_once.log          # 看到 "WCNBTWIFI-CMD OK" 即上电成功
```

> If the output is `FAIL`: re-run the chmod from 3.1 (most likely a permission issue), then re-run this step.

---

## 4. Step Three: Periodic btwrite Wake-up (HCI gets no response without it)

After the Bluetooth firmware powers on, it defaults to power-saving mode, so **periodic wake-up is mandatory** for HCI responses.

```sh
# 启动周期唤醒脚本（每 1.5~2 秒写 1）
setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &

# 手动验证唤醒节点存在且可写
cat /proc/bluetooth/sleep/btwrite          # 应返回 0 或 1
echo 1 > /proc/bluetooth/sleep/btwrite && echo WRITE_OK
```

> Typical symptom of skipping this step: after `bt_probe_full` sends an HCI Reset, no response is received at all (or only a single `55 7e ... 53 50 52 44 33` (SPRD3) identity frame is received, with nothing after).

---

## 5. Step Four: HCI Channel Diagnostics (optional; verifies the lower layers)

```sh
# 完整 HCI 探针：六步全通 = 底层 OK
/tmp/bt_probe_full 20 2>&1 | tail -30

# 期望看到：
#   Reset            → 04 0e 04 01 03 0c 00
#   Read Local Ver   → HCI 6.0, 制造商标识 0x1380（展讯）
#   Read BD_ADDR     → 11:22:14:31:93:27
#   Read Buffer Size / Features → ff ff 8d fe（与 pskey feature_set 一致）
#   Write Scan Enable → 成功
```

| Probe step | Meaning |
|---|---|
| HCI Reset | chip HCI engine start |
| Read Local Version | firmware version / vendor identification |
| Read BD_ADDR | chip Bluetooth MAC |
| Read Buffer Size | HCI buffer capability |
| Read Features | feature set (verifies whether the pskey is in effect) |
| Set Event Mask + Write Scan Enable | preparation for scanning |

---

## 6. Step Five: Deploy the Userland HCI Daemon (production approach)

> Note: why not use the kernel hci_uart driver? This device's kernel is a custom Android 3.10.65; a user-compiled hci_uart.ko has hardcoded tty_struct offsets that do not match, so hci0 registers but `TX=0` and `hciconfig up` times out — the driver route does not work. The userland approach reads/writes /dev/ttyS0 directly, does not depend on the kernel protocol stack, and is the most reliable.

### 6.1 Compile the daemon

The source code `bt_user_daemon.c` (saved locally) is compiled on the device:

```sh
gcc -O2 -o /usr/local/bin/bt_user_daemon /tmp/bt_user_daemon.c -lpthread
```

Key implementation points (for reference during maintenance):
- Open `/dev/ttyS0`: `B3000000` (3M) + `CRTSCTS`, `VMIN=1` (blocking read)
- H4 protocol: read complete frames per the frame header `buf[1]=evt / buf[2]=len`
- Before scanning, you must first send `Write Scan Enable (0x0c1a, 0x03)` before Inquiry (GIAC `0x33 0x8b 0x9e`); otherwise the firmware does not return an Inquiry Result
- unix socket `/tmp/bt_ctl.sock` (0666), text commands: `state` / `on` / `off` / `scan <N>` / `list` / `connect <bd>`

### 6.2 Deploy + auto-start (openrc)

```sh
# 单实例启动
pkill -9 -x bt_user_daemon 2>/dev/null
setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &

# openrc 自启
cat > /etc/init.d/bt_daemon << 'EOF'
#!/sbin/openrc-run
command="/usr/local/bin/bt_user_daemon"
command_background=yes
pidfile="/run/bt_daemon.pid"
EOF
chmod +x /etc/init.d/bt_daemon
rc-update add bt_daemon default
rc-service bt_daemon start
```

### 6.3 Verify (unix socket client)

python3 on the device (no socat):

```sh
# 查状态
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"
# 期望: OK ON

# 扫描 15 秒（读到 EOF）
printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"
# 期望: OK <N>  + 每行一个设备:  bd_addr class rssi
# 实测:  OK 1 / 48:f1:ae:25:7e:48 5a420c 0
```

---

## 7. Boot Auto-Start Chain (fully automatic after reboot)

After the device reboots, it is brought up automatically by the `/etc/local.d/` script chain:

```
/etc/local.d/wifi.start    → logdw + download（常驻）+ WiFi 驱动 + wlan0
/etc/local.d/lvgl_demo.start → 启动 LVGL 桌面（/usr/local/bin/lvgl_demo）
/etc/init.d/bt_daemon      → bt_user_daemon（openrc）
```

> Key red lines:
> - **download is resident — do not kill it** — killing everything breaks the WiFi/Bluetooth firmware state, requiring a device reboot to recover
> - After reboot, the `chmod 666 /tmp/aand/proc/mdbg/*` from 3.1 must be re-run (already automated in the script)
> - Process cleanup always uses `pkill -9 -x bt_user_daemon`; do not use the `ps | grep` inline pattern (it kills the shell executing the command itself)

---

## 8. Common Faults Quick Reference

| Symptom | Cause | Fix |
|---|---|---|
| BT-OPEN returns FAIL | `/tmp/aand/proc/mdbg/*` permissions 600 | retry after `chmod 666 /tmp/aand/proc/mdbg/*` |
| No HCI response / only a single SPRD3 frame | missing btwrite wake-up | start `/tmp/bt_wake.sh`; confirm `/proc/bluetooth/sleep/btwrite` is writable |
| No devices found by scanning | Write Scan Enable not sent first | use the daemon's `scan` command (handled internally); do not send bare Inquiry |
| socket connect failure | daemon multiple instances fighting over the socket | restart as a single instance after `pkill -9 -x bt_user_daemon` |
| daemon log reports "Not a tty" | tty ldisc occupied | python `fcntl.ioctl(fd, 0x5421, b'\x00\x00\x00\x00')` to restore N_TTY |
| Kernel hci0 registers but TX=0 | 3.10 kernel hci_uart offsets do not match | abandon the kernel driver; use the userland daemon |
| WiFi fails to come up | download was killed by mistake | reboot the device and re-bring-up per Chapter 2 |

---

## 9. Key Nodes / Parameters Quick Reference

| Item | Value |
|---|---|
| SDIO device | `/sys/bus/sdio/devices/mmc2:8800:1`, device=0x2331 |
| HCI serial port | `/dev/ttyS0`, baud rate 3M (B3000000) + CRTSCTS, H4 protocol |
| Wake-up node | `/proc/bluetooth/sleep/btwrite` (write 1, every 1.5~2s) |
| UART configuration node | `/sys/devices/70000000.uart/uart_conf` (0x1a1=115200, 0x341=57600) |
| socket | `/tmp/bt_ctl.sock` (0666) |
| Debug logs | `/tmp/btud_dbg.log` (TX/RX hex), `/tmp/btud.log` (stdout) |
| Firmware real MAC | `11:22:14:31:93:27` (firmware response, not spoofed) |
| pskey | `/mnt/android_sys/lib/modules/pskey_bt.txt` (feature_set/device_addr), delivered by download via `connectivity_configure.ini` [SETCTION 6] |
| Known scannable device | `48:f1:ae:25:7e:48` (class=5a420c phone) |
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
