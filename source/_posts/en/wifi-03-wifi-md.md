---
title: "WiFi Chip Bring-up_Troubleshooting Manual"
date: 2026-09-13 15:58:12
lang: en
permalink: en/2026/09/13/wifi-03-wifi-md/
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# Spreadtrum SC9832A WiFi Troubleshooting Manual — HT0 / spd-box

> **Purpose**: when WiFi will not come up, cannot be scanned, cannot connect, or cannot get an IP, use this manual to locate the root cause. Every command is taken from measurements on the device.
> **How to use**: first look at §1's layered quick-reference master table to locate the layer → jump to the corresponding section → confirm with the "locating commands" → handle per "fix".
> **Companion**: the Manual Operation Manual (chapter 5 quick-reference table) and the AI Instruction Manual (§7 decision table) are condensed versions; this article is the full version.

---

## 0. Troubleshooting Discipline (read first)

1. **Four-layer model, locate by layer**: ①firmware/physical (download→SDIO 0x2331) → ②driver (marlin_fm→sprdwl→wlan0) → ③protocol (up→wpa_supplicant→scan/connect) → ④network (DHCP→IPv4→routing). Whichever layer fails, investigate only that layer and its upstream.
   - Example: if WiFi cannot connect, first check `wpa_cli status` (③), rather than re-flashing firmware (①).
2. **Check logs first**: `/var/log/wifi_boot.log` (wifi.start output, first choice for troubleshooting) → `/tmp/logdw.log` → `dmesg | tail`.
3. **download is resident, do not kill it**: killing all corrupts the chip's firmware state, recoverable only by a full reboot.
4. **To start over, run idempotently**: `sh /etc/local.d/wifi.start` (the script kills residuals first and then brings things up); do not operate manually in scattered steps.
5. **Driver order is a hard constraint**: `marlin_fm.ko` must precede `sprdwl.ko`.
6. **Fix the time before troubleshooting networking**: the device's date once reverted to 2016; certificates/handshakes are affected by the system time.
7. Use `pkill -9 -x <name>` to kill processes; the `ps | grep` inline pattern is forbidden.

---

## 1. Layered Failure Quick-Reference Master Table (locate in one page)

| Symptom | Most Likely Root Cause | Locating Command | Section |
|---|---|---|---|
| Log `ERROR: SDIO not enumerated, download may have failed` | firmware download incomplete / environment/timing issues | `tail -20 /tmp/logdw.log` | §2 |
| `bind logdw failed: No such file or directory` | logdw not in place | `ls -la /tmp/logdw` | §2 |
| `download started pid=` (pid empty) | the download process did not come up | `ps -eo pid,comm \| grep download` | §2 |
| `dmesg` constantly `SDIO dev not ready` / GPIO94=0 | the chip is not powered / firmware not downloaded | `cat /dev/power_ctl` writability | §2 |
| download reports open device failure | the chroot is missing device nodes | `mountpoint -q /tmp/aand/dev` | §2 |
| download reports wcnfdl/wcnmodem not found | missing by-name symlinks | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | §2 |
| download finishes but SDIO has no enumeration | wrong DTB (boot partition) | `dmesg \| grep -i -E "sdio\|mmc2\|2331"` | §2 |
| `insmod sprdwl.ko` reports Unknown symbol | wrong module order | `lsmod \| grep marlin_fm` | §3 |
| wlan0 does not appear | the driver was loaded before firmware download completed | `ls /sys/class/net/wlan0` | §3 |
| `insmod` reports invalid module format | the module does not match the kernel version | `uname -r; modinfo sprdwl.ko` | §3 |
| `wpa_cli scan` fails / scan returns empty | supplicant not running / interface not up | `pgrep -x wpa_supplicant` | §4 |
| `wpa_cli` command not found | PATH missing /sbin | `which wpa_cli` | §4 |
| Connected but IP stays "acquiring" | DHCP not run / wpa not COMPLETED | `wpa_cli -i wlan0 status` | §5 |
| Has IPv6 but no IPv4 | DHCP timing/interface state | `ip addr show wlan0` | §5 |
| WiFi lost after reboot | auto-start not fixed in place | `ls /etc/local.d/`, `rc-update show` | §6 |
| SSH unreachable after reboot | USB port multiplexing switch | poll `<device IP>` / `<WiFi-IP>` | §6 |
| Date is 2016 | RTC not synced | `date` | §6 |

---

## 2. Physical / Firmware Layer (① DTB → download → SDIO)

### 2.1 `ERROR: SDIO not enumerated, download may have failed`

- **Locating**:
  ```sh
  tail -20 /tmp/logdw.log            # firmware download daemon log
  cat /sys/bus/sdio/devices/mmc2:8800:1/device   # empty = not enumerated
  dmesg | tail -30                    # look for mmc2 / sprd_download messages
  ```
- **Root causes and fixes**:

| Root Cause | Confirm | Fix |
|---|---|---|
| the chroot environment is incomplete | `ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/` | rebuild the chroot or re-run `sh /etc/local.d/wifi.start` |
| `/dev/power_ctl` not writable | `[ -w /dev/power_ctl ] && echo OK` | check node permissions (download depends on it to write the power-up sequence) |
| missing by-name symlinks | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl; ln -sf /dev/block/mmcblk0p15 .../wcnmodem` |
| missing mounts | `mountpoint -q /tmp/aand/dev || echo NOT_MOUNTED` | `mount --bind /dev /tmp/aand/dev; mount -t proc proc /tmp/aand/proc` |
| wrong DTB | `dmesg \| grep -i sdio` (the boot partition's dtb lacks the correct power descriptions) | write back the stock Android dtb (see WiFi Operation Manual 4.3, seek=20008) |
| firmware version mismatch | driver and firmware come from different Android versions | extract uniformly from the same Android system |

### 2.2 `bind logdw failed: No such file or directory`

- **Root cause**: `/tmp/logdw` does not exist or is not executable (the log daemon for download).
- **Fix**: `ls -la /tmp/logdw`; if missing, copy from the Android system: `cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw; chmod +x /tmp/logdw`.

### 2.3 `download started pid=` (pid empty)

- **Root cause**: the download process did not come up (chroot missing libraries / wrong parameters / exited directly).
- **Locating**: `ps -eo pid,comm | grep download`; `tail -30 /tmp/dl.log`
- **Fix**:
  ```sh
  pkill -9 -f logdw; pkill -9 -f 'wcnd'; sleep 1
  setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
  sleep 1
  setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
  sleep 2
  ps -eo pid,comm | grep download   # should see the process
  ```
- If it still fails, use strace to locate what is missing: `chroot /tmp/aand strace /bin/download 2>&1 | grep -E "open|ENOENT" | head -30`.

### 2.4 GPIO94 READY always 0 / dmesg repeatedly SDIO dev not ready

- **Root cause**: the chip's power-up sequence was not executed (download did not run successfully).
- **Locating**: use `strace` to trace whether download's ioctl/write report errors (open power_ctl, write SLEEP/POWER_ON/POWER_RST).
- **Fix**: check the environment item by item per the 2.1 table; after confirming, re-run wifi.start.

---

## 3. Driver Layer (② marlin_fm → sprdwl → wlan0)

### 3.1 `insmod sprdwl.ko` reports Unknown symbol

- **Root cause**: the module load order is reversed — sprdwl.ko depends on the `fm_read` symbol exported by marlin_fm.ko.
- **Fix**:
  ```sh
  lsmod | grep -q marlin_fm || insmod /lib/modules/marlin_fm.ko
  sleep 1
  lsmod | grep -q sprdwl || insmod /lib/modules/sprdwl.ko
  ```

### 3.2 wlan0 does not appear

- **Root cause**: the driver was loaded before firmware download completed, or the chip was not enumerated.
- **Locating**: `cat /sys/bus/sdio/devices/mmc2:8800:1/device` (must be 0x2331 first); `dmesg | tail`
- **Fix**: after confirming SDIO enumeration, reload the drivers:
  ```sh
  rmmod sprdwl 2>/dev/null; rmmod marlin_fm 2>/dev/null; sleep 1
  insmod /lib/modules/marlin_fm.ko; sleep 1; insmod /lib/modules/sprdwl.ko; sleep 4
  ls /sys/class/net/wlan0
  ```

### 3.3 `insmod` reports invalid module format

- **Root cause**: the module does not match kernel 3.10.65 (different kernel version/compiler).
- **Locating**: `uname -r`; `modinfo /lib/modules/sprdwl.ko | grep vermagic`
- **Fix**: use the same-origin pre-compiled modules in the device's `/lib/modules/`; do not compile old-kernel modules with Alpine's new gcc.

---

## 4. Protocol Layer (③ up → wpa_supplicant → scan/connect)

### 4.1 `wpa_cli scan` fails / scan results are empty

- **Locating**: `pgrep -x wpa_supplicant`; `ip -br link show wlan0` (needs UP); `wpa_cli -i wlan0 status`
- **Fix**:
  ```sh
  ip link set wlan0 up; sleep 2
  pgrep -x wpa_supplicant || wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
  wpa_cli -i wlan0 scan; sleep 5; wpa_cli -i wlan0 scan_results
  ```

### 4.2 `wpa_cli` command not found

- **Root cause**: PATH is missing `/sbin` (wpa_cli is in /sbin).
- **Fix**: `export PATH=$PATH:/sbin`; or use `which wpa_cli` to confirm the path.

### 4.3 Scan works but connection fails (wpa_state stuck at INACTIVE / SCANNING)

- **Locating**: `wpa_cli -i wlan0 status | grep -E 'wpa_state|ssid'`
- **Fix**: confirm the network configuration is correct (ssid quotes, psk type); `wpa_cli -i wlan0 remove_network 0` then re-add; check `wpa_cli -i wlan0 list_networks`.
- **Common**: open networks use `key_mgmt NONE`; encrypted networks' `psk` must be a quoted string.

---

## 5. Network Layer (④ DHCP → IPv4)

### 5.1 Connected but IP stays "acquiring"

- **Locating**: `wpa_cli -i wlan0 status | grep wpa_state` (must be COMPLETED); `udhcpc -i wlan0 -q -n 2>&1 | tail -5`
- **Fix**:
  ```sh
  # wpa not COMPLETED → back to §4; already COMPLETED → run DHCP manually
  udhcpc -i wlan0 -q -n
  ip addr show wlan0 | grep inet
  ```

### 5.2 Has IPv6 but no IPv4 / no default route

- **Root cause**: DHCP timing (triggered just as the interface associates), or a slow DHCP response.
- **Fix**: after `wpa_cli status` confirms COMPLETED, **immediately** run `udhcpc -i wlan0 -q -n`; add `-n` to exit on failure for easier observation; confirm `ip route` shows default via a gateway.
- **Note**: in some scenarios IPv6 is obtained first while IPv4 is not; simply re-running udhcpc suffices.

---

## 6. Auto-start / System Layer

### 6.1 WiFi lost after reboot

- **Locating**: `ls /etc/local.d/` (should have wifi.start); `rc-update show | grep local`; `cat /var/log/wifi_boot.log | tail`
- **Fix**: confirm `/etc/local.d/wifi.start` exists and is executable, and that `local` is in the default runlevel:
  ```sh
  rc-update add local default
  sh /etc/local.d/wifi.start 2>&1 | tail -20   # idempotent, can be re-run immediately
  ```

### 6.2 SSH unreachable after reboot

- **Root cause**: the device's USB port multiplexing (RNDIS network port/keyboard/mouse); after reboot the network port has not recovered or the IP has changed.
- **Fix**: poll both addresses `<device IP>` and `<WiFi-IP>` (on this machine, the skill's `ssh_wait.py` can be used); wait for the boot script to finish (download firmware download takes 60~90s).

### 6.3 Date reverts to 2016

- **Root cause**: RTC not synced (resets on every reboot when there is no battery power).
- **Fix**: `hwclock -s` (read from the RTC) or `ntpd -q` (network time sync); `/etc/local.d/time_sync.start` is already fixed in place; do not create it again.

---

## 7. Diagnostic Toolbox (quick reference for key nodes)

| Item | Path/Command | Expected |
|---|---|---|
| Boot script log | `/var/log/wifi_boot.log` | no ERROR, SDIO ready |
| SDIO enumeration | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| Driver | `lsmod \| grep -E 'sprdwl\|marlin_fm'` | both present |
| Interface | `ip -br link show wlan0` | `UP` |
| wpa process | `pgrep -x wpa_supplicant` | has a PID |
| wpa status | `wpa_cli -i wlan0 status` | `wpa_state=COMPLETED` |
| IPv4 | `ip addr show wlan0 \| grep 'inet '` | has an address |
| Routing | `ip route` | default via gateway |
| Download logs | `/tmp/logdw.log`, `/tmp/dl.log` | download complete |
| chroot environment | `ls /tmp/aand/bin/download /tmp/aand/etc/marlinba/` | files complete |

**Process chain**: `logdw → download(resident) → (SDIO 0x2331) → marlin_fm.ko + sprdwl.ko → wlan0 UP → wpa_supplicant → udhcpc → IPv4`

---

## 8. Verified Dead Ends (do not retry)

| Route | Result |
|---|---|
| Kill download/logdw for a "clean restart" | corrupts firmware state; WiFi and Bluetooth fail together; only a full reboot recovers |
| Hand-write a self-developed download to replace the stock Android one | the firmware download timing is the chip's proprietary protocol; the stock one is the most reliable |
| Switch to the mainline Linux kernel | the Android kernel contains Spreadtrum-specific customizations (SDIO/power/firmware timing); the mainline has no support |
| Change the USB OTG / network mode | explicitly forbidden by the user; breaks RNDIS/network topology |
| insmod sprdwl before marlin_fm | Unknown symbol |
| Reconnecting to the same IP repeatedly after reboot | caused by USB port switching; poll both IPs |

---

## 9. Red Lines (under any circumstances)

1. **download is resident, do not kill it**.
2. **Driver order**: `marlin_fm.ko` first, `sprdwl.ko` second.
3. **Idempotent re-run**: `sh /etc/local.d/wifi.start`; do not operate manually in scattered steps.
4. Do not modify the USB OTG / network mode configuration.
5. Do not switch to the mainline kernel.
6. The time must be correct first (affects certificates/handshakes).

---

*Companion: WiFi Chip Bring-up Operation Manual (for humans), WiFi Bring-up AI Instruction Manual (for AI), WiFi Chip Bring-up Deployment Delivery Document (for deployment)*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
