---
title: "WiFi Chip Bring-up_Deployment Delivery Document"
date: 2026-09-13 15:58:12
lang: en
permalink: en/2026/09/13/wifi-06-wifi-md/
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# Bringing Up WiFi on the HT0 Device — Deployment Delivery Document

> Purpose: to answer "which scripts/programs are involved in the entire WiFi process? How do you deploy on a new device to bring up WiFi?"
> Content: ① full chain overview → ② artifacts list (device side/local machine/Git) → ③ new device deployment steps → ④ verification → ⑤ common issues
> Applicable: same-model devices (HT0 / Spreadtrum SC9832A, Android kernel + Alpine user space)

---

## 1. WiFi Full Chain Overview (who brings up whom)

```
Boot
 ├─ /etc/local.d/wifi.start        ① mount the Android system + build the chroot + download flashes firmware + driver + wlan0 + wpa
 ├─ /etc/local.d/bt_bringup.start   ② (Bluetooth chain, see the Bluetooth Deployment Delivery Document — WiFi is Bluetooth's physical prerequisite)
 ├─ /etc/init.d/bt_daemon          ③ (Bluetooth daemon)
 └─ LVGL desktop                     ④ network settings page (wpa_cli interacts with supplicant)
```

**Dependency relationship**: the combo firmware flashed by download contains both WiFi and Bluetooth parts → **bringing up WiFi = Bluetooth firmware is also ready**; ① is the prerequisite for ②③④.

### Internal steps of wifi.start (idempotent, can be re-run repeatedly)

```
① Mount /mnt/android_sys (mmcblk0p17, Android system read-only)
② Build the chroot /tmp/aand (bin/lib/etc/marlinba + bind /dev /proc /sys + by-name symlinks)
③ Kill all residual download/logdw → setsid /tmp/logdw → setsid chroot /tmp/aand /bin/download -i wlan0 (resident)
④ Wait for SDIO enumeration mmc2:8800:1 = 0x2331 (≤90s)
⑤ insmod marlin_fm.ko → sprdwl.ko (hard order constraint) → ip link set wlan0 up
⑥ wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
```

---

## 2. Artifacts List

### 2.1 Already deployed on the device (HT0's current state, verified by measurement)

| Category | Path | Description |
|---|---|---|
| Boot script | `/etc/local.d/wifi.start` | **WiFi full-chain auto-start (idempotent)**, log `/var/log/wifi_boot.log` |
| chroot environment | `/tmp/aand/bin/download` | firmware download bootloader (stock Android) |
| | `/tmp/aand/bin/wcnd` | WiFi/Bluetooth power-up daemon |
| | `/tmp/aand/etc/marlinba/*.ini` | firmware configuration (including the Bluetooth pskey) |
| | `/tmp/aand/lib/libiwnpi.so` | library download depends on |
| Log daemon | `/tmp/logdw` | download log daemon |
| Drivers | `/lib/modules/marlin_fm.ko`, `/lib/modules/sprdwl.ko` | WiFi drivers (order: fm first, wl second) |
| Protocol | `/etc/wpa_supplicant/wpa_supplicant.conf` | wpa_supplicant configuration (including saved networks) |
| DHCP | `udhcpc` (bundled with Alpine) | get an IP |
| Partition symlinks | `/dev/block/platform/sdio_emmc/by-name/{wcnfdl→p14, wcnmodem→p15, boot→p16}` | download finds partitions by name |
| System time | `/etc/local.d/time_sync.start` | RTC time sync (prevents reverting to 2016) |
| LVGL desktop | `/usr/local/bin/lvgl_demo` | desktop (including the network settings page network_page.c) |

### 2.2 Local machine (Windows working directory) source code and deployment scripts

| File | Purpose |
|---|---|
| `shell/wifi.start` | **boot script copy (archived in git)** |
| `lv_pages/network_page.c` | **LVGL network settings page source code (1677 lines, WiFi UI)** |
| Four documents | Operation Manual / Boot Process Comparison / Work Process Summary / AI Instruction Manual |

### 2.3 Git commits (device project /home/lvgl_demo/lvgl_demo)

WiFi underlying bring-up related commits can be found in git log (`git log --oneline | head -10`), involving:
- `shell/wifi.start` (boot script)
- `lv_pages/network_page.c` (network settings page + launcher registration)
- AI工作流/01_WiFi打通/ (docs + deploy/wifi.start)

### 2.4 Skill Packaging (portable)

`workspace\.user_skills\ht0-wcn-radio\` — SKILL.md + references/wifi.md + scripts (wifi_bringup.py / ssh_wait.py); any AI can operate same-model devices directly after loading it.

---

## 3. New Device Deployment Steps (bringing up WiFi from scratch)

> Prerequisites: a same-model device (HT0/SC9832A), already switchroot'ed to Alpine, SSH root available.

### Step 0 Confirm the Basic Environment

```sh
ssh root@<device IP>
uname -a                              # Linux 3.10.65 ... armv7l
ls /dev/block/platform/sdio_emmc/by-name/   # wcnfdl=p14 wcnmodem=p15 boot=p16 system=p17
```

### Step 1 Prepare the Firmware and Android User Space (chroot)

```sh
# 1) Mount the Android system (read-only)
mkdir -p /mnt/android_sys
mount -r /dev/block/mmcblk0p17 /mnt/android_sys

# 2) Extract download and its dependencies (pulled from the reference machine via adb on the PC then uploaded via scp, or copied directly from the system)
mkdir -p /tmp/aand/{bin,lib,etc,dev}
cp /tmp/download            /tmp/aand/bin/download
cp /tmp/libiwnpi.so         /tmp/aand/lib/
cp -r /mnt/android_sys/lib/*.so /tmp/aand/lib/
cp -r /mnt/android_sys/etc/marlinba /tmp/aand/etc/
chmod +x /tmp/aand/bin/download

# 3) Device nodes + partition symlinks
mount --bind /dev /tmp/aand/dev
mkdir -p /tmp/aand/dev/block/platform/sdio_emmc/by-name
ln -sf /dev/block/mmcblk0p14 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnfdl
ln -sf /dev/block/mmcblk0p15 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnmodem
ln -sf /dev/block/mmcblk0p16 /tmp/aand/dev/block/platform/sdio_emmc/by-name/boot

# 4) Verify the chroot is runnable
chroot /tmp/aand /bin/download --help 2>&1 | head -5
```

> If the dtb is not the stock Android one (boot was replaced), first write back the stock dtb per WiFi Operation Manual 4.3 and reboot.

### Step 2 Firmware Download (the download power-up sequence)

```sh
# logdw log daemon (resident)
setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
sleep 1
# download (resident, do not kill)
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
# Wait for SDIO enumeration (≤90s)
for i in $(seq 1 18); do [ -e /sys/bus/sdio/devices/mmc2:8800:1 ] && break; sleep 5; done
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # expect 0x2331
```

### Step 3 Load Drivers (order cannot be reversed)

```sh
insmod /lib/modules/marlin_fm.ko    # first
sleep 1
insmod /lib/modules/sprdwl.ko       # second (depends on the fm_read symbol)
sleep 2
ip link set wlan0 up
ip link show wlan0                  # wlan0 appearing means success
```

### Step 4 Configure wpa_supplicant

```sh
cat > /etc/wpa_supplicant/wpa_supplicant.conf <<'EOF'
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
EOF
wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
wpa_cli -i wlan0 status              # wpa_state=INACTIVE is normal
```

### Step 5 Fix Boot Auto-start in Place

```sh
# Boot-time driver loading
cat > /etc/modules-load.d/wifi.conf <<'EOF'
marlin_fm
sprdwl
EOF
# Boot script (full chain; content per AI工作流 deploy/wifi.start)
cp /home/lvgl_demo/lvgl_demo/AI工作流/01_WiFi打通/deploy/wifi.start /etc/local.d/wifi.start
chmod +x /etc/local.d/wifi.start
rc-update add local default
```

> The complete `wifi.start` includes chroot setup, logdw/download bring-up, SDIO waiting, drivers, wlan0, and wpa_supplicant — a new device can deploy this script directly end-to-end, with no need for manual step-by-step.

### Step 6 Verification

```sh
# Layered verification
cat /sys/bus/sdio/devices/mmc2:8800:1/device        # 0x2331
lsmod | grep -E 'sprdwl|marlin_fm'
ip -br link show wlan0                              # UP
pgrep -x wpa_supplicant                             # has a PID
wpa_cli -i wlan0 scan && sleep 5 && wpa_cli -i wlan0 scan_results   # hotspots appear
udhcpc -i wlan0 -q -n                               # get an IP
ip addr show wlan0 | grep inet
```

---

## 4. Verification Criteria (all satisfied = deployment success)

| # | Check | Expected |
|---|---|---|
| 1 | SDIO device | `0x2331` |
| 2 | lsmod | sprdwl + marlin_fm both present |
| 3 | `ip -br link show wlan0` | `UP` |
| 4 | wpa_supplicant process | exists |
| 5 | `wpa_cli status` | `wpa_state=COMPLETED` (connected) or `INACTIVE` (not connected, normal) |
| 6 | Scan | `scan_results` shows hotspots |
| 7 | IPv4 | `ip addr show wlan0` has an inet address + default route |
| 8 | LVGL network page | toggle/scan/saved/nearby list/connect all work |
| 9 | After reboot | ①②③ all brought up automatically (no manual work) |
| 10 | Bluetooth (same chip) | `grep 'CMD OK' /tmp/bt_once.log` has a value (firmware includes Bluetooth) |

---

## 5. Common Issues (the most likely pitfalls when deploying on a new device)

| Symptom | Cause | Handling |
|---|---|---|
| `SDIO not enumerated` | the chroot environment is incomplete / timing / permissions | look at `/tmp/logdw.log`; confirm power_ctl is writable and by-name symlinks exist; re-run wifi.start |
| `bind logdw failed` | /tmp/logdw missing | `cp /mnt/android_sys/bin/logdw /tmp/logdw; chmod +x` |
| `download started pid=` empty | the process did not come up | chroot missing libraries; `strace` to locate; confirm /tmp/aand is complete |
| wlan0 does not appear | the driver was loaded before firmware download completed | wait for SDIO 0x2331 before insmod; rmmod and reload in order |
| `Unknown symbol` | driver order reversed | marlin_fm first, sprdwl second |
| `invalid module format` | the module does not match the kernel | use the device's /lib/modules/ same-origin modules |
| Scan returns empty | supplicant not started / interface not up | `ip link set wlan0 up` + confirm the process |
| IP stays acquiring | DHCP not run / wpa not COMPLETED | `wpa_cli status`; run `udhcpc -i wlan0 -q -n` manually |
| WiFi lost after reboot | auto-start not fixed in place | deploy wifi.start + `rc-update add local default` |
| Date 2016 | RTC not synced | sync the time and fix time_sync.start in place |
| SSH unreachable after reboot | USB port multiplexing switch | poll `<device IP>` / `<WiFi-IP>` |
| WiFi works but Bluetooth does not come up | the Bluetooth chain has not run | see the Bluetooth Deployment Delivery Document (mdbg/wcnd/bt_once/bt_wake/daemon) |

---

## 6. One-Sentence Summary of the Deployment Path

```
Environment confirmation → build the chroot (/tmp/aand + symlinks) → download flashes firmware → wait for SDIO 0x2331
→ insmod marlin_fm → sprdwl → wlan0 up → wpa_supplicant
→ udhcpc gets an IP → fix wifi.start auto-start in place → verify (0x2331+UP+scan+IPv4)
```

All artifacts have local copies and Skill packaging (`ht0-wcn-radio`), so the entire new-device deployment is reusable.

---

*Companion: WiFi Chip Bring-up Operation Manual (for humans), WiFi Chip Bring-up Troubleshooting Manual, WiFi Bring-up AI Instruction Manual (for AI)*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
