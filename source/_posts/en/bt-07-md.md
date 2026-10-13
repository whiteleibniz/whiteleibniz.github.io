---
title: "Bluetooth Chip Bring-up: Troubleshooting Manual"
date: 2026-09-13 15:58:12
lang: en
permalink: en/2026/09/13/bt-07-md/
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# Spreadtrum SC9832A Bluetooth Troubleshooting Manual — HT0 / spd-box

> **Purpose**: when Bluetooth fails to come up, cannot be scanned, or does not respond, use this manual to localize the root cause. Every command is taken from live testing on the device.
> **How to use**: first consult the layered quick-reference master table in §1 to localize the layer → jump to the corresponding chapter → confirm with the "localization command" → apply the "fix".
> **Companions**: the manual operation manual (Chapter 8 quick-reference table) and the AI guidance manual (§7 decision table) are condensed versions; this article is the full version.

---

## 0. Troubleshooting Discipline (read first; violating it wastes time)

1. **Localize by layers; do not skip layers and try blindly**: the four-layer model — ①firmware/physical (download→SDIO 0x2331) → ②power-on (wcnd+BT-OPEN→CMD OK) → ③engine (btwrite wake-up→HCI response) → ④application (daemon→socket→LVGL). Whichever layer fails, investigate only that layer and its upstream.
2. **Check logs before processes**: log order `/var/log/wifi_boot.log` (WiFi chain) → `/tmp/bt_once.log` (BT-OPEN) → `/tmp/btud.log` + `/tmp/btud_dbg.log` (daemon) → `dmesg | tail`.
3. **download is resident — do not kill it**: killing everything breaks the WiFi/Bluetooth firmware state; recovery is only possible with a full machine reboot.
4. **Killing processes always uses `pkill -9 -x <name>`**; the `ps | grep` inline pattern is forbidden (it kills the shell executing the command itself).
5. **mdbg chmod must be done after reboot** (already automated in the boot script; do not forget during manual debugging):
   `chmod 666 /tmp/aand/proc/mdbg/*; chmod 666 /proc/mdbg/*; echo 0 > /proc/mdbg/wdtirq`
6. **Confirm the WiFi layer first**: Bluetooth and WiFi are on the same chip; if WiFi is not up, Bluetooth is guaranteed dead. `cat /sys/bus/sdio/devices/mmc2:8800:1/device` must be `0x2331`.

---

## 1. Layered Fault Quick-Reference Master Table (localize in one page)

| Symptom | Most likely root cause | Localization command | Chapter |
|---|---|---|---|
| `SDIO not enumerated, download may have failed` | firmware download incomplete / incomplete chroot environment | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | §2 |
| `bind logdw failed: No such file or directory` | logdw not in place | `ls -la /tmp/logdw` | §2 |
| download stuck / pid empty | chroot missing libraries/nodes/symlinks | `ps -eo pid,comm \| grep download` | §2 |
| BT-OPEN returns FAIL | mdbg permissions 600 | `cat /tmp/bt_once.log` | §3 |
| wcnd not started / bt_once no output | process did not start / timing | `ps -ef \| grep '[w]cnd'` | §3 |
| No HCI response / only a single SPRD3 frame | missing btwrite wake-up | `[ -w /proc/bluetooth/sleep/btwrite ]` | §4 |
| daemon log "Not a tty" | tty ldisc occupied | `cat /tmp/btud.log` | §4 |
| No scan results (scan returns OK 0) | Write Scan Enable not sent first | use the daemon `scan` command | §5 |
| socket connect failure / state no response | daemon multiple instances / transient window | `ps -eo comm \| grep '[b]t_user_daemon'` | §5 |
| Bluetooth does not come up automatically after reboot | missing auto-start chain / wrong order | `rc-update show` | §6 |
| LVGL Bluetooth page repeatedly reverts to the old version | watchdog points to the build path | `cat /root/lvgl_watchdog.sh` | §6 |
| WiFi/Bluetooth both gone | download was killed | `dmesg \| tail` | §7 |
| SSH unreachable after reboot | USB port switching | poll `<设备IP>` / `<WiFi-IP>` | §7 |

---

## 2. Physical / Firmware Layer (① download → SDIO)

### 2.1 `SDIO not enumerated, download may have failed`

- **Localization**: `cat /sys/bus/sdio/devices/mmc2:8800:1/device` (empty = not enumerated); `tail -20 /tmp/logdw.log`; `dmesg | tail -30`
- **Possible root causes and fixes**:

| Root cause | Confirmation | Fix |
|---|---|---|
| incomplete chroot environment | `ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/connectivity_configure.ini` | rebuild the chroot (see WiFi operation manual 4.4) or re-run `sh /etc/local.d/wifi.start` |
| `/dev/power_ctl` not writable | `[ -w /dev/power_ctl ] && echo OK` | check node permissions; download relies on it to write the SLEEP→POWER_ON→POWER_RST power-on sequence |
| by-name symlinks missing | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl; ln -sf /dev/block/mmcblk0p15 .../wcnmodem` |
| mounts missing | `mountpoint -q /tmp/aand/dev || echo NOT` | `mount --bind /dev /tmp/aand/dev; mount -t proc proc /tmp/aand/proc` |
| wrong DTB (boot partition) | `dmesg \| grep -i sdio` | confirm p16 has the original Android dtb written (WiFi operation manual 4.3) |
| download did not start | `ps -eo pid,comm \| grep download` | `setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &` |

### 2.2 `bind logdw failed: No such file or directory`

- **Root cause**: `/tmp/logdw` does not exist or is not executable (logdw is download's log daemon).
- **Fix**: `ls -la /tmp/logdw`; if missing, `cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw; chmod +x /tmp/logdw`.

### 2.3 download process exits repeatedly / pid empty

- **Localization**: `ps -eo pid,comm | grep download`; `tail -30 /tmp/dl_run.log`
- **Fix**: first `pkill -9 -f logdw; pkill -9 -f 'wcnd'` to clear leftovers, then `setsid /tmp/logdw &` and `setsid chroot /tmp/aand /bin/download -i wlan0 &`; if it still exits, use `strace chroot /tmp/aand /bin/download -i wlan0 2>&1 | grep -E "open|ENOENT"` to see what is missing.

---

## 3. Bluetooth Power-On Layer (② wcnd + BT-OPEN)

### 3.1 BT-OPEN returns FAIL (the number one problem)

- **Localization**: `cat /tmp/bt_once.log` (expected `push(17): WCNBTWIFI-CMD OK`; FAIL means the 600 permission issue)
- **Root cause**: `/tmp/aand/proc/mdbg/*` inside the chroot has permissions 600, so wcnd has no permission to operate the modem debug nodes.
- **Fix**:
  ```sh
  chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
  chmod 666 /proc/mdbg/* 2>/dev/null
  echo 0 > /proc/mdbg/wdtirq 2>/dev/null
  # 重启 wcnd + 重发 BT-OPEN
  pkill -9 -f 'wcnd'; sleep 1
  setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
  sleep 2
  setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
  sleep 3; cat /tmp/bt_once.log
  ```
- **Note**: this permission is **lost after every reboot**; the boot script `bt_bringup.start` already executes it automatically; do not forget during manual debugging.

### 3.2 wcnd not started / bt_once produces no output at all

- **Localization**: `ps -ef | grep '[w]cnd'` (wcnd is a process inside the chroot; its `comm` may show a different name, so use `-ef` to see the full command line)
- **Fix**: after confirming WiFi is up (SDIO 0x2331), re-run the startup sequence from 3.1; note that wcnd depends on the `/tmp/aand` environment and a resident download.

---

## 4. Engine / Wake-up Layer (③ btwrite → HCI)

### 4.1 No HCI response / only a single SPRD3 frame (critical!)

- **Symptom**: `bt_probe_full` sends an HCI Reset and gets no response; or only a single `55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e` (SPRD3 identity frame) is received, with nothing after.
- **Root cause**: after the Bluetooth engine powers on, it defaults to power-saving sleep, so **periodic btwrite wake-up is mandatory** for HCI responses.
- **Localization**: `[ -w /proc/bluetooth/sleep/btwrite ] && echo WRITABLE || echo NO`; `ps -eo args | grep '[b]t_wake.sh'`
- **Fix**: start the wake-up script (writes 1 every 1.5~2s):
  ```sh
  setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &
  echo 1 > /proc/bluetooth/sleep/btwrite && echo WRITE_OK
  ```
- **Note**: `bt_wake.sh` must keep running throughout Bluetooth operation; it must especially not be stopped during scanning.

### 4.2 Meaning of the SPRD3 Frame

- `SPRD3` in `55 7e 00 81 ... 53 50 52 44 33 ...` is the Spreadtrum start identifier — **receiving it means the HCI channel is alive and the firmware is running**. At this point, if standard HCI commands get no response, check wake-up (4.1) and the daemon baud rate (4.3) first.

### 4.3 daemon log "Not a tty" / no HCI response at all

- **Root cause**: the line discipline (ldisc) of ttyS0 is occupied/corrupted (leftover from early testing), causing open failures or abnormal send/receive.
- **Localization**: `tail -10 /tmp/btud.log`
- **Fix**: use python to restore N_TTY (TIOCSETD=0x5421, N_TTY=0):
  ```sh
  python3 -c "import fcntl; f=open('/dev/ttyS0',2); fcntl.ioctl(f,0x5421,b'\x00\x00\x00\x00')"
  pkill -9 -x bt_user_daemon; sleep 1
  setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
  ```
- **Dead end**: `/tmp/reset_tty` restoring ldisc causes a segmentation fault; do not use it.

### 4.4 Baud rate / UART configuration issues

- **Node**: `/sys/devices/70000000.uart/uart_conf` (`0x1a1`=115200, `0x341`=57600, the daemon uses 3M)
- **Rule**: the daemon opens ttyS0 directly with `B3000000 + CRTSCTS`; **do not** change uart_conf arbitrarily after firmware initialization, otherwise the firmware and daemon baud rates mismatch → no HCI response.
- **Localization**: `cat /tmp/btud_dbg.log | tail -20` (check whether the TX/RX hex is garbled).

### 4.5 Kernel hci0 registers but TX=0

- **Root cause**: the custom Android 3.10.65 kernel and a self-compiled `hci_uart.ko` have mismatched tty_struct offsets; Alpine gcc14.2 compiling the old kernel module reports `invalid module format`.
- **Conclusion (dead end)**: **abandon the kernel driver route**; use the userland daemon (read/write /dev/ttyS0, not depending on the kernel Bluetooth protocol stack).

---

## 5. Application Layer (④ daemon → socket → LVGL)

### 5.1 socket connect failure

- **Localization**: `[ -S /tmp/bt_ctl.sock ] && echo YES || echo NO`; `ps -eo comm | grep '[b]t_user_daemon'`
- **Root cause**: daemon multiple instances fighting over the socket / leftover socket file.
- **Fix**:
  ```sh
  pkill -9 -x bt_user_daemon; sleep 1
  rm -f /tmp/bt_ctl.sock
  setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
  ```

### 5.2 state query no response (Terminated) / transient no response after reboot

- **Symptom**: after reboot the socket exists but the `state` query is killed after a 6s timeout (returns Terminated); a few seconds later it is normal again.
- **Root cause**: there is no ordering guarantee between the daemon startup and the Bluetooth power-on chain (bt_bringup.start); the daemon opens ttyS0 first and enters initialization while the engine is not ready, transiently blocking.
- **Fix (hardened)**: the `depend()` in `/etc/init.d/bt_daemon` should include `after local` (ensuring the power-on chain completes first); verify:
  ```sh
  cat /etc/init.d/bt_daemon | grep -A4 depend
  rc-service bt_daemon restart
  # 若仍无响应，等 10~15s 重试 state；仍不行按 5.1 单实例重启
  ```
- **Quick retry command**:
  ```sh
  printf 'state\n' | timeout 5 python3 -c "import socket,sys
  s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
  s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
  print(s.recv(4096).decode())"
  ```

### 5.3 No scan results (OK 0)

- **Root cause**: Inquiry is sent before `Write Scan Enable` — the firmware accepts Inquiry (CMD_STATUS 0x00) but never returns an Inquiry Result.
- **Fix**: **use the daemon's `scan` command** (the order is handled internally); do not send bare Inquiry:
  ```sh
  printf 'scan 15\n' | timeout 25 python3 -c "import socket,sys
  s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
  s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
  d=b''
  while True:
      x=s.recv(4096)
      if not x: break
      d+=x
  print(d.decode())"
  # 期望 OK <N> + 每行 bd_addr class rssi
  ```
- If the environment genuinely has no Bluetooth devices, N=0 is not a fault.

### 5.4 Bluetooth page on/off no response

- **Localization**: confirm the daemon is a single instance + state returns `OK ON` (pass 5.1/5.2 first); then check the LVGL log `/tmp/lvgl_demo.log` for socket errors.
- **Fix**: mostly a daemon-side problem; reset per 5.1; the page itself only does socket text interaction and does not hold HCI state.

---

## 6. System / Auto-Start Layer

### 6.1 Bluetooth does not come up automatically after reboot

- **Localization**: `rc-update show | grep -E 'bt_daemon|local'`; `ls /etc/local.d/` (should have wifi.start, bt_bringup.start, lvgl_demo.start)
- **Fix**:
  ```sh
  # 缺上电链脚本则创建（内容见 AI工作流 deploy/bt_bringup.start）
  # 缺 daemon 自启则：
  rc-update add bt_daemon default
  rc-service bt_daemon start
  ```
- **Complete auto-start chain**: `wifi.start` (WiFi prerequisite) → `bt_bringup.start` (sleep 8 + mdbg + wcnd + bt_once + bt_wake) → `bt_daemon` (openrc, `after local`).

### 6.2 daemon and power-on chain out of order

- **Symptom**: after reboot the daemon process exists but state has no response for a long time.
- **Fix**: confirm the `depend()` in `/etc/init.d/bt_daemon` includes `after local`; after changing, run `rc-update del bt_daemon default; rc-update add bt_daemon default; reboot` to verify.

### 6.3 LVGL Bluetooth page repeatedly reverts to the old version / page missing

- **Root cause**: the watchdog / boot script points to the old `build/` path.
- **Fix**: point uniformly to `/usr/local/bin/lvgl_demo`; confirm `bluetooth_page.c/h` is compiled into the image and registered (launcher icon).

---

## 7. General System Issues

| Symptom | Root cause | Fix |
|---|---|---|
| WiFi/Bluetooth both gone | download killed / firmware state corrupted | **full machine reboot**; do not manually "start clean"; the automatic chain recovers after reboot |
| SSH unreachable after reboot | USB port multiplexing switch | poll `<设备IP>` and `<WiFi-IP>` (the skill's ssh_wait.py is available on the local machine) |
| Date reverts to 2016 | RTC not synced | `hwclock -s` / ntpd; confirm `/etc/local.d/time_sync.start` exists |
| WiFi drops during Bluetooth scanning | rare coexistence issue | confirm download is resident + prioritize bringing up the WiFi chain after reboot |

---

## 8. Diagnostics Toolbox (key nodes quick reference)

| Item | Path/command | Expected |
|---|---|---|
| SDIO enumeration | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| Firmware download logs | `/var/log/wifi_boot.log`, `/tmp/logdw.log`, `/tmp/dl_run.log` | download complete, no ERROR |
| BT-OPEN result | `grep 'CMD OK' /tmp/bt_once.log` | `WCNBTWIFI-CMD OK` |
| Wake-up node | `[ -w /proc/bluetooth/sleep/btwrite ]` | WRITABLE |
| UART configuration | `cat /sys/devices/70000000.uart/uart_conf` | the daemon opens at 3M |
| HCI probe | `/tmp/bt_probe_full 20` | all six steps pass |
| daemon process | `ps -eo comm \| grep '[b]t_user_daemon'` | single instance |
| daemon logs | `/tmp/btud.log` (stdout), `/tmp/btud_dbg.log` (TX/RX hex) | no Not a tty, has RX |
| socket | `[ -S /tmp/bt_ctl.sock ]` | YES |
| Boot scripts | `ls /etc/local.d/`, `rc-update show` | wifi.start / bt_bringup.start / bt_daemon all in default |

**Process chain**: `logdw → download(resident) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)`

---

## 9. Verified Dead Ends (do not retry)

| Route | Result |
|---|---|
| Kernel `hci_uart.ko` | hci0 registers but TX=0 / up times out; driver offsets do not match |
| vhci virtual approach | rejected by the user |
| Repeatedly trying boot command sequences black-box | incomplete, unstable state, and does not affect the scan function |
| `/tmp/reset_tty` restoring ldisc | segmentation fault; use python ioctl |
| Killing download to "restart a clean environment" | breaks firmware state; only a full machine reboot recovers |
| `ps \| grep` inline pattern to kill processes | kills the shell itself |

---

## 10. Red Lines (under any circumstances)

1. **download is resident — do not kill it**.
2. **Driver order**: `marlin_fm.ko` first, `sprdwl.ko` second.
3. Killing processes: `pkill -9 -x <name>`.
4. mdbg chmod 666 after reboot (automated in the script).
5. `bt_wake.sh` does not stop during Bluetooth operation.
6. Do not modify USB OTG / network mode configuration.

---

*Companions: `蓝牙芯片打通_操作手册` (for humans), `蓝牙打通_AI指导手册` (for AI), `HT0蓝牙拉起_部署交付文档` (for deployment)*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
