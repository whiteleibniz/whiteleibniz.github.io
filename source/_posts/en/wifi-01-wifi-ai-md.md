---
title: "WiFi Bring-up_AI Instruction Manual"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/wifi-01-wifi-ai-md/
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# Bringing Up WiFi on a Spreadtrum SC9832A Device (HT0) — AI Execution Instruction Manual

> **Target readers**: AI assistants (Doubao / other large models), who need to quickly resolve WiFi "unavailable / cannot connect" issues on similar devices (Spreadtrum SC9832A, Android kernel + Alpine user space)
> **How to use**: first read §1–§3 to build context → follow the standard procedure in §5 → verify per §6 → on failure, consult the decision table in §7
> **Core value**: every command in this article is taken from the `wifi.start` boot script that was verified to work on the device; following it can bring up WiFi on similar devices directly, avoiding repeated pitfalls
> **Related**: WiFi and Bluetooth share the same Marlin combo chip; WiFi is the physical prerequisite for Bluetooth (see the Bluetooth AI Instruction Manual)

---

## 1. Device and Environment Overview

| Item | Value |
|---|---|
| Device model | HT0 (reference machine: H709, running Android 6.0, usable as an information source) |
| Hostname / kernel | `spd-box` / `Linux 3.10.65 #13 SMP PREEMPT armv7l` |
| System combination | **Keep the Android 6.0 kernel + switchroot to Alpine Linux** (key!) |
| SSH | `root@<device IP>` (RNDIS debug port) / `<WiFi-IP>` after WiFi networking |
| WiFi chip | Spreadtrum **Marlin combo WCN** (SC2331, WiFi+Bluetooth on the same chip, SDIO interface) |
| WiFi interface | `wlan0` (drivers sprdwl.ko + marlin_fm.ko) |
| Firmware download | the stock Android `download` binary, run inside the chroot `/tmp/aand` |
| Current status | WiFi brought up: download → driver → wpa_supplicant → DHCP; the boot script is fixed |

> ⚠️ After a reboot, SSH may be briefly unreachable (USB port switching); retries with polling are needed. `/tmp` persists across reboots (the chroot environment and tools are all there).

---

## 2. Confirmed Hard Facts (no re-investigation needed; trust them directly)

1. **WiFi firmware must be flashed by the stock Android download binary**: `chroot /tmp/aand /bin/download -i wlan0`, so the chip has firmware to run; the WiFi and Bluetooth firmware are one unit, **bringing up WiFi = Bluetooth firmware is also ready**.
2. **download depends on a complete chroot Android user space**: `/tmp/aand` must contain Android's lib (including libiwnpi.so), `/etc/marlinba/*.ini` configurations, device nodes, and partition symlinks (by-name: wcnfdl→mmcblk0p14, wcnmodem→mmcblk0p15, boot→mmcblk0p16). `wifi.start` sets all of these up automatically.
3. **SDIO enumeration is the sign of successful firmware download**: `/sys/bus/sdio/devices/mmc2:8800:1` appears and device=**0x2331**.
4. **Driver load order is a hard constraint**: `marlin_fm.ko` **must precede** `sprdwl.ko` (sprdwl depends on the fm_read symbol exported by marlin_fm); reversing the order reports Unknown symbol.
5. **download must stay resident**: killing all download/logdw processes corrupts the chip's firmware state, recoverable only by a full reboot.
6. **wpa_supplicant configuration**: `/etc/wpa_supplicant/wpa_supplicant.conf`, `ctrl_interface=/run/wpa_supplicant`, `update_config=1`; the LVGL network page interacts with this configuration via `wpa_cli`.
7. **LVGL network settings page** (`lv_pages/network_page.c`): toggle=ip link up/down, scan=`wpa_cli -i wlan0 scan` + `scan_results`, connect=`add_network`→`set_network`→`select_network`→`save_config`→`reconnect`.
8. **The boot script is fixed**: `/etc/local.d/wifi.start` (idempotent design; ready steps are skipped automatically), with a git copy in `shell/wifi.start`.
9. **DHCP**: use `udhcpc -i wlan0` (Alpine's default); if it stays "acquiring", check the wpa connection status and the driver first.
10. **Time problem**: the device's RTC once reverted to 2016; fixed and fixed in place with hwclock/ntpd (scripts like `/etc/local.d/time_sync.start`); if the date is wrong, fix the time before touching networking (certificates/handshakes are affected by the date).

---

## 3. Verified Dead Ends (do not retry; do not waste turns)

| Route | Result | Reason |
|---|---|---|
| Kill download/logdw for a "clean restart" | the chip's firmware state is corrupted; WiFi and Bluetooth fail together | a full reboot is required to recover; the correct approach is to let wifi.start idempotently re-run |
| Replace the Android kernel with a mainline Linux kernel | not adopted | the Android kernel contains Spreadtrum-specific customizations (SDIO/power/firmware timing); the mainline kernel has no corresponding support, and the risk is extremely high |
| Change the USB OTG / network mode | explicitly forbidden by the user | would break the RNDIS debug port / network topology |
| Directly insmod sprdwl.ko without loading marlin_fm | Unknown symbol load failure | module symbol dependency; the order cannot be reversed |
| Reconnecting to the same IP repeatedly when port 22 is unreachable after reboot | ineffective | caused by USB port switching; poll both IPs and retry |
| Hand-writing a self-developed download to replace the stock Android one | high risk, not adopted | the firmware download timing (power_ctl power-up sequence + UART handshake + SDIO bulk writes) is the chip's proprietary protocol; the stock binary is the most reliable |

---

## 4. System Model: Layers + Verification Criteria per Layer

```
① Firmware/physical layer    logdw + download → chip power-up + firmware flashing
                 verification: cat /sys/bus/sdio/devices/mmc2:8800:1/device → 0x2331
② Driver layer         insmod marlin_fm.ko → insmod sprdwl.ko → wlan0 appears
                 verification: lsmod | grep sprdwl; ls /sys/class/net/wlan0
③ Protocol layer         ip link up → wpa_supplicant → scan/connect
                 verification: iwconfig wlan0 (ESSID associated); wpa_cli status
④ Network layer         DHCP → IPv4 address
                 verification: ip addr show wlan0 has an inet address + default route
```

**Investigation discipline**: whichever layer fails verification, look for the cause only in that layer and its upstream. Example: if WiFi cannot connect, first check the wpa_supplicant status (③), rather than re-flashing firmware (①).

---

## 5. Standard Execution Procedure (directly copyable)

### 5.1 Full chain (corresponding to wifi.start; it is recommended to rely on the boot script's idempotent re-run)

```sh
# Directly re-run the boot script (idempotent, safe)
sh /etc/local.d/wifi.start 2>&1 | tail -20
# Log: /var/log/wifi_boot.log
```

### 5.2 Manual step-by-step (for debugging)

```sh
# 1) Environment (if /tmp/aand does not exist, wifi.start will set it up automatically; verify manually)
ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/connectivity_configure.ini
mountpoint -q /tmp/aand/dev || mount --bind /dev /tmp/aand/dev
mountpoint -q /tmp/aand/proc || mount -t proc proc /tmp/aand/proc

# 2) Kill all residual processes + start logdw + download (resident)
for p in $(ps -eo pid,comm | awk '$2=="download"||$2=="logdw"{print $1}'); do kill -9 "$p"; done
setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
sleep 1
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
sleep 2
ps -eo pid,comm | grep download    # confirm download is running

# 3) Wait for SDIO enumeration (up to 90s)
for i in $(seq 1 18); do
  [ -e /sys/bus/sdio/devices/mmc2:8800:1 ] && break
  sleep 5
done
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # expect 0x2331

# 4) Drivers (order cannot be reversed)
lsmod | grep -q marlin_fm || insmod /lib/modules/marlin_fm.ko
sleep 1
lsmod | grep -q sprdwl || insmod /lib/modules/sprdwl.ko
sleep 2
ls /sys/class/net/wlan0 || { rmmod sprdwl 2>/dev/null; rmmod marlin_fm 2>/dev/null; sleep 1;
                             insmod /lib/modules/marlin_fm.ko; sleep 1; insmod /lib/modules/sprdwl.ko; sleep 4; }

# 5) Interface up + wpa_supplicant
ip link set wlan0 up
sleep 2
pgrep -x wpa_supplicant || wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf

# 6) DHCP
udhcpc -i wlan0 -q -n 2>&1 | tail -5
ip addr show wlan0 | grep inet
```

### 5.3 Connecting to WiFi (wpa_cli interaction, same logic as the LVGL network page)

```sh
wpa_cli -i wlan0 scan                              # trigger a scan
sleep 3
wpa_cli -i wlan0 scan_results                      # view hotspots
# Add/configure a network
ID=$(wpa_cli -i wlan0 add_network | tail -1)
wpa_cli -i wlan0 set_network $ID ssid '"MySSID"'
wpa_cli -i wlan0 set_network $ID psk '"<WiFi password>"'
wpa_cli -i wlan0 set_network $ID scan_ssid 1
wpa_cli -i wlan0 set_network $ID priority 10
wpa_cli -i wlan0 enable_network $ID
wpa_cli -i wlan0 select_network $ID
wpa_cli -i wlan0 save_config
udhcpc -i wlan0 -q
```

---

## 6. Verification Checklist (confirm item by item)

| # | Check | Expected |
|---|---|---|
| 1 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 2 | `lsmod \| grep sprdwl` | sprdwl + marlin_fm (dependency relation 1 sprdwl) |
| 3 | `ip -br link show wlan0` | `UP` |
| 4 | `iwconfig wlan0` | ESSID associated / no ESSID means not connected |
| 5 | `pgrep -x wpa_supplicant` | process exists |
| 6 | `wpa_cli -i wlan0 status` | `wpa_state=COMPLETED` |
| 7 | `ip addr show wlan0 \| grep 'inet '` | has an IPv4 address |
| 8 | `ip route` | has default via gateway |
| 9 | LVGL network page | toggle/scan/saved/nearby list/connect all work |

---

## 7. Failure → Root Cause → Fix Decision Table

| Symptom | Most Likely Root Cause | Fix |
|---|---|---|
| Log `ERROR: SDIO not enumerated, download may have failed` | firmware download incomplete (timing/permissions/node issues) | look at the tail of `/tmp/logdw.log`; confirm /dev/power_ctl is writable and the by-name symlinks exist; re-run wifi.start |
| Log `bind logdw failed: No such file or directory` | logdw not in place (/tmp/logdw missing or not executable) | `ls -la /tmp/logdw`; re-copy from /mnt/android_sys/bin/ |
| `download started pid=` (pid empty) | the download process did not come up | `ps -eo pid,comm \| grep download`; whether the chroot environment is complete |
| wlan0 does not appear after driver load | driver load failure / chip not enumerated | `dmesg \| tail`; first confirm SDIO 0x2331; rmmod and reload |
| Scan returns empty | wpa_supplicant not started / interface not up | `pgrep wpa_supplicant`; `ip link set wlan0 up`; `wpa_cli scan` then `scan_results` |
| Connected but IP stays "acquiring" | DHCP not run / wpa not COMPLETED | `wpa_cli status` to check wpa_state; run `udhcpc -i wlan0 -q -n` manually |
| SSH unreachable after reboot | RNDIS port not restored / IP changed | poll <device IP> and <WiFi-IP>; wait for the boot script to finish |
| Date is 2016 | RTC not synced | hwclock -s / ntpd sync, written into the /etc/local.d boot script (already fixed in place; do not repeat) |
| WiFi works but Bluetooth does not come up | the Bluetooth chain has not run | see the Bluetooth AI Instruction Manual §5 (mdbg permissions / wcnd / bt_once / btwrite) |

---

## 8. Component Architecture (must read before modifying/maintaining)

```
Boot
 └─ /etc/local.d/wifi.start (idempotent)
      ├─ Mount /mnt/android_sys (mmcblk0p17, Android system read-only)
      ├─ Build the chroot /tmp/aand (bin/lib/etc/marlinba + bind /dev /proc /sys + partition mknod + by-name symlinks)
      ├─ Kill all residual download/logdw
      ├─ setsid /tmp/logdw
      ├─ setsid chroot /tmp/aand /bin/download -i wlan0   ← resident
      ├─ Wait for SDIO enumeration mmc2:8800:1 = 0x2331 (≤90s)
      ├─ insmod marlin_fm.ko → sprdwl.ko (hard order constraint)
      ├─ ip link set wlan0 up
      └─ wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
Afterwards
 ├─ LVGL network page (network_page.c) scans/connects via wpa_cli
 └─ udhcpc gets an IP (Alpine network stack)
```

**Key chroot nodes** (download depends on them; missing any means SDIO enumeration fails):
- `/tmp/aand/bin/download` (stock Android)
- `/tmp/aand/lib/libiwnpi.so` + the full set of Android lib
- `/tmp/aand/etc/marlinba/connectivity_configure.ini` (firmware path/calibration configuration, also contains the Bluetooth pskey)
- `/tmp/aand/dev/block/platform/sdio_emmc/by-name/{wcnfdl→mmcblk0p14, wcnmodem→mmcblk0p15, boot→mmcblk0p16}`
- `/dev/power_ctl` (download writes the SLEEP→POWER_ON→POWER_RST power-up sequence)

**LVGL network page** (`lv_pages/network_page.c`, 1677 lines, a WiFi settings UI template):
- Toggle: `ip link set wlan0 up/down` + `wpa_cli disconnect/reconnect`
- Scan: `wpa_cli scan` → timed 3s → `wpa_cli scan_results` → parse bssid/signal/flags/ssid
- Connect: add_network / set_network (ssid/psk/key_mgmt/scan_ssid/priority) / select_network / save_config
- Saved list: `wpa_cli list_networks`

---

## 9. Red Lines and Operational Discipline

1. **download is resident, do not kill it** — killing all corrupts the chip's firmware state, recoverable only by a full reboot.
2. **Driver order**: `marlin_fm.ko` first, `sprdwl.ko` second.
3. **wifi.start is idempotent** — to start over, directly run `sh /etc/local.d/wifi.start`; it kills residuals first and then brings things up; do not operate manually in scattered steps.
4. **Do not change the USB OTG / network mode configuration** (explicit user constraint).
5. **Do not switch to the mainline kernel** — Spreadtrum-specific customizations (SDIO/power/firmware) depend on the Android kernel.
6. **The date must be correct** — WiFi handshakes/certificates are affected by the system time; fix the time before troubleshooting networking.
7. **Use pkill -9 -x <name> for process cleanup**, not the `ps | grep` inline pattern (which would kill your own shell).

---

## 10. Existing Tools/Files Inventory on the Device (reuse; do not reinvent)

| Tool/File | Location | Purpose |
|---|---|---|
| wifi.start | `/etc/local.d/wifi.start` (git: `shell/wifi.start`) | WiFi boot auto-start + full chain (idempotent) |
| Boot log | `/var/log/wifi_boot.log` | wifi.start output (first choice for troubleshooting) |
| download | `/tmp/aand/bin/download` | firmware download (inside chroot) |
| logdw | `/tmp/logdw` | firmware download log daemon |
| Android user space | `/mnt/android_sys` (mmcblk0p17) | Android system read-only mount (library/config source) |
| Drivers | `/lib/modules/marlin_fm.ko`, `/lib/modules/sprdwl.ko` | WiFi drivers (pre-compiled on the device) |
| wpa config | `/etc/wpa_supplicant/wpa_supplicant.conf` | wpa_supplicant configuration (including saved networks) |
| Network page | `lv_pages/network_page.c` (LVGL project) | WiFi settings UI (wpa_cli interaction template) |
| DHCP | `udhcpc` (bundled with Alpine) | get an IP |

---

## 11. Future Enhancement Directions (currently incomplete)

| Item | Description | Suggested Path |
|---|---|---|
| IPv4 stability | in some scenarios IPv6 has an address but IPv4 is not obtained | run udhcpc immediately after checking wpa_state=COMPLETED, adding `-n` retries and logging |
| Auto-reconnect strategy | after disconnection, relies only on wpa_supplicant's auto-reconnect | a "disconnect/reconnect" button and signal strength display can be added to the network page (scan_results already has signal) |
| Multi-network priority | currently a single network configuration | extend wpa_cli list_networks management + sorting UI |
| Coexistence with Bluetooth | WiFi resident + Bluetooth scanning in parallel | share download/wcnd; measured no conflict, but mutually exclusive power management can be added |

---

## 12. 5-Minute Quick Acceptance Path

```sh
# 1) Three-layer status in one command
cat /sys/bus/sdio/devices/mmc2:8800:1/device && ip -br link show wlan0 && pgrep -x wpa_supplicant
# 2) Connection status
wpa_cli -i wlan0 status | grep -E 'wpa_state|ip_address'
# 3) IPv4
ip addr show wlan0 | grep 'inet '
```

If all the above pass → WiFi's underlying layer + protocol + network full chain is OK; if not → locate item by item per the §7 decision table.

---

*Document version: v1.0 (precipitated after bringing up WiFi)*
*Related documents: WiFi Operation Manual (for humans), WiFi Boot Process Comparison, WiFi Work Process Summary, Bluetooth Bring-up AI Instruction Manual*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
