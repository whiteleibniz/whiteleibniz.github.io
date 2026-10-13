---
title: "WiFi Chip Bring-up Operation Manual"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/wifi-04-wifi-md/
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# WiFi Chip Bring-up — Manual Operation Manual

> **Applicable devices**: spd-box (SC9832A quad-core, armv7l, Android 6 kernel 3.10.65 + switchroot Alpine Linux 3.21 armhf)
> **WiFi chip**: Marlin SC2331 (SDIO interface, `mmc2:8800:1`, device 0x2331)
> **Document goal**: without relying on any AI assistance, a human can follow this manual to bring the device's onboard WiFi from scratch to a "scannable, connectable" state.
> **Document version**: v1.0　|　2026-09

---

## Table of Contents

1. [Background and Problem Definition](#1-background-and-problem-definition)
2. [Tools and Materials List](#2-tools-and-materials-list)
3. [Overall Approach](#3-overall-approach)
4. [Operation Procedure](#4-operation-procedure)
   - 4.1 Device and System Confirmation
   - 4.2 Forensics from the Android Reference Machine
   - 4.3 Extracting and Replacing the Stock Android Device Tree (DTB)
   - 4.4 Building the Android User-Space chroot Environment
   - 4.5 Performing Firmware Download (the download power-up sequence)
   - 4.6 Verifying SDIO Enumeration
   - 4.7 Loading the WiFi Driver
   - 4.8 Installing and Configuring wpa_supplicant
   - 4.9 Scan Verification
   - 4.10 Fixing Boot Auto-start in Place
5. [Troubleshooting Quick-Reference Table](#5-troubleshooting-quick-reference-table)
6. [Notes and Risks](#6-notes-and-risks)

---

## 1. Background and Problem Definition

- The device ships with Android 6.0, where WiFi/Bluetooth work **completely** (no hardware fault).
- The user **switchroot**ed the device to Alpine Linux (keeping the Android kernel 3.10.65, replacing only the root filesystem).
- After switching to Alpine, **WiFi does not work at all**, with typical symptoms:
  - `dmesg` repeatedly shows `SDIO dev not ready`;
  - GPIO94 (the chip's READY pin) stays at 0;
  - the kernel has never enumerated an SDIO WiFi device (`/sys/bus/sdio/devices/` is empty).
- **Root cause**: the SC2331 chip's **power-up timing + firmware download** is completed by the resident `download` service in the Android system (writing `/dev/power_ctl`, `/dev/download`, and flashing the firmware from the `wcnfdl`/`wcnmodem` partitions into the chip). Alpine does not have this set of services, so the chip has never been "activated".

---

## 2. Tools and Materials List

| Category | Tool/Material | Purpose | Notes |
|---|---|---|---|
| Remote operation | SSH client (paramiko / PuTTY / OpenSSH) | connect to the Alpine device | `root@<device IP>` |
| Reference forensics | WatchTools adb (`AndroidWatch_ADB_ToolBox\adb\adb.exe`) | connect to the same-model Android machine H709 | root required (Magisk) |
| Partition read/write | `dd`, `cat`, `ls` | extract/write partitions, device nodes | built into the device (BusyBox/coreutils) |
| System tracing | `strace` | locate the cause of the download service's failure | on Alpine use `apk add strace` |
| Firmware files | `download` (Android binary), `libiwnpi.so`, `wcnfdl`/`wcnmodem` partition images | power-up + firmware download | extracted from the Android system |
| Device tree | `android_orig.dtb` (about 53,967 bytes) | replace the dtb in the p16 partition | extracted from the Android boot image |
| Kernel modules | `marlin_fm.ko`, `sprdwl.ko` | WiFi driver | placed in `/lib/modules/` |
| User space | `wpa_supplicant` + `wpa_cli` (v2.10-r11) | scan/connect | Alpine armhf package |
| Dependency libraries | `libnl3`, `pcsc-lite-libs` | wpa_supplicant dependencies | Alpine armhf package |
| Auxiliary | `chroot`, `mount --bind` | run Android binaries | built into the device |

---

## 3. Overall Approach

> **In one sentence**: the chip's power-up and firmware download logic lives in Android's user space (the `download` service), and Alpine lacks it → move the stock Android `download` binary + firmware + device nodes into a chroot, "borrow a shell" in Alpine to run the power-up sequence, let the kernel enumerate the SDIO chip, then load the driver and configure wpa_supplicant.

The chain has four segments, and none can be missing:

```
[1] The correct DTB (stock Android)
        ↓
[2] download power-up + firmware download (running the Android binary via chroot)
        ↓
[3] the kernel enumerates the SDIO device + insmod driver → wlan0 appears
        ↓
[4] wpa_supplicant configuration → scan / connect
```

---

## 4. Operation Procedure

### 4.1 Device and System Confirmation

```sh
# Connect to the device
ssh root@<device IP>          # password <password>

# Confirm the system
uname -a                          # should show 3.10.65 Android kernel + armv7l
cat /etc/os-release               # Alpine 3.21 armhf

# Confirm the partition mapping (by-name)
ls -l /dev/block/platform/sdio_emmc/by-name/
# Key partitions:
#   boot    -> p16   (contains the kernel + device tree)
#   wcnfdl  -> p14   (WiFi/Bluetooth firmware A)
#   wcnmodem-> p15   (WiFi/Bluetooth firmware B)
#   system  -> p17   (Android system, read-only mount to extract files)
#   recovery-> p21

# Confirm the chip's current state (typical of a not-yet-brought-up device)
cat /sys/bus/sdio/devices/mmc2:*/device 2>/dev/null   # empty = not enumerated
dmesg | grep -i -E "sdio|mmc2|wlan|2331"              # SDIO dev not ready may be visible
```

### 4.2 Forensics from the Android Reference Machine

> A **same-model device with a working Android system** (H709) is needed, the one with both WiFi and Bluetooth working.

```sh
# PC-side adb connection (WatchTools' adb)
D:\Program Files (x86)\watchTools\AndroidWatch_ADB_ToolBox\adb\adb.exe devices
adb shell id                          # confirm root (Magisk)

# View the partition table (get the by-name to partition number mapping)
adb shell ls -l /dev/block/platform/sdio_emmc/by-name/
#   record: boot=p16  wcnfdl=p14  wcnmodem=p15  system=p17  recovery=p21

# Extract the boot image (contains the dtb)
adb shell dd if=/dev/block/mmcblk0p16 of=/sdcard/boot_p16_android.img bs=4096
adb pull /sdcard/boot_p16_android.img ./

# Extract the WiFi/Bluetooth firmware (two partitions)
adb shell dd if=/dev/block/mmcblk0p14 of=/sdcard/wcnfdl.img bs=4096
adb shell dd if=/dev/block/mmcblk0p15 of=/sdcard/wcnmodem.img bs=4096
adb pull /sdcard/wcnfdl.img ./
adb pull /sdcard/wcnmodem.img ./

# Extract the download service and its dependencies (the Android user-space power-up program)
adb shell cp /system/bin/download /sdcard/download
adb shell cp /system/lib/libiwnpi.so /sdcard/libiwnpi.so
adb pull /sdcard/download ./
adb pull /sdcard/libiwnpi.so ./

# Extract the Android kernel modules (sprdwl etc., a fallback option, usually already present in Alpine)
adb shell ls /system/lib/modules/ | grep -i -E "sprdwl|marlin|fm"
```

### 4.3 Extracting and Replacing the Stock Android Device Tree (DTB)

> The stock Android DTB contains the correct descriptions of WiFi power/clocks. This is one of the prerequisites for download to work properly later.

**4.3.1 PC side: extract the DTB from the boot image**

```sh
# The boot image header is ANDROID!; after the kernel and before the ramdisk is the dtb section
# Use unpack_bootimg (or manually):
# The Android 6 kernel image embeds the dtb at an offset of about 0xB71800 (subject to actual parsing)
# Tools: abootimg / unpack_bootimg / dtbTool

unpack_bootimg --boot_img boot_p16_android.img --out boot_extract/
# Get the dtb file (about 53,967 bytes) → name it android_orig.dtb

# Verify
file android_orig.dtb        # Device Tree Blob version 17
```

**4.3.2 Device side: write to the p16 partition**

```sh
# Upload android_orig.dtb to the device's /tmp/
# Write to the dtb offset in p16:
#   dtb's offset within boot = 0x9C5000 (bytes) = 20008 blocks of 512 bytes
dd if=/tmp/android_orig.dtb of=/dev/block/mmcblk0p16 bs=512 seek=20008 conv=notrunc

# Back up the current boot just in case
dd if=/dev/block/mmcblk0p16 of=/root/p16_boot_backup.img bs=4096

# Verify after reboot
reboot
dmesg | grep -i -E "sdio|mmc2|2331"   # observe enumeration
```

> ⚠️ Writing the boot partition carries risk; be sure to back up first. If flashed incorrectly, `dd` back from the backup.

### 4.4 Building the Android User-Space chroot Environment

> Purpose: let the stock Android `download` binary run in Alpine (it depends on Android's libraries, device nodes, and partition links).

```sh
# 1) Create the directory and lay down Android user-space files
mkdir -p /tmp/aand/{bin,lib,etc,dev}
cp /tmp/download          /tmp/aand/bin/download
cp /tmp/libiwnpi.so       /tmp/aand/lib/
cp -r /mnt/android_sys/lib/*.so  /tmp/aand/lib/   # copy the full set of so from the Android system mounted on p17
chmod +x /tmp/aand/bin/download

# 2) Firmware and configuration
#    Android's download reads /etc/marlinba/*.ini (WiFi/Bluetooth firmware path configuration)
cp -r /mnt/android_sys/etc/marlinba /tmp/aand/etc/

# 3) Key device nodes (download needs /dev/power_ctl and /dev/download)
mount --bind /dev /tmp/aand/dev

# 4) Firmware partition links (download finds partitions by by-name)
mkdir -p /tmp/aand/dev/block/platform/sdio_emmc/by-name
ln -sf /dev/block/mmcblk0p14 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnfdl
ln -sf /dev/block/mmcblk0p15 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnmodem

# 5) Verify it runs inside the chroot
chroot /tmp/aand /bin/download --help 2>&1 | head -20
# If it reports missing libraries/not found, use strace to locate:
chroot /tmp/aand strace /bin/download 2>&1 | grep -E "open|ENOENT" | head -30
```

> Debugging essentials: if `strace` shows `open("/dev/power_ctl")` failing → confirm `mount --bind /dev`; if it shows `open(...wcnfdl)` failing → confirm the by-name links.

### 4.5 Performing Firmware Download (the download power-up sequence)

```sh
# Run the stock Android download in the chroot (with parameters, referring to Android's calling convention)
chroot /tmp/aand /bin/download -i wlan0 2>&1 | tee /tmp/dl_run.log

# Expected actions (performed internally by download):
#   1) Open /dev/power_ctl and write the SLEEP → POWER_ON → POWER_RST power-up sequence
#   2) Open ttyS0 (115200) to handshake with the chip
#   3) Write the wcnfdl / wcnmodem partition firmware into the chip in SDIO bulk writes
#   4) The chip completes boot and the SDIO slave device becomes ready

# Observe the kernel log; the following should appear:
dmesg | tail -30
#   mmc2: new high speed SDIO card at address 8800
#   mmc2:8800:1  (device 0x2331)
#   sprd_download_sdio_write ... 131080 ...   (bulk firmware write)
```

> If firmware download fails (stuck at the handshake/write errors), check: whether the DTB is correct (back to 4.3), whether `/dev/power_ctl` is writable, and whether the firmware partitions are the stock ones.

### 4.6 Verifying SDIO Enumeration

```sh
# The chip has been enumerated (at this point GPIO94 READY should be 1)
cat /sys/bus/sdio/devices/mmc2:8800:1/device
# Expected output: 0x2331

ls /sys/bus/sdio/devices/
# mmc2:8800:1 should appear
```

### 4.7 Loading the WiFi Driver

```sh
# 1) Load the FM auxiliary module first (provides fm_read and other symbols)
insmod /lib/modules/marlin_fm.ko
# 2) Then load the main WiFi driver
insmod /lib/modules/sprdwl.ko

# 3) Verify the interface appears
ip link show wlan0
#   wlan0 appearing with MAC a2:d2:f3:bf:8c:10 means success

# 4) Open the interface
ip link set wlan0 up
```

> ⚠️ The load order cannot be reversed: `sprdwl.ko` depends on the symbols exported by `marlin_fm.ko` (`fm_read`); reversing it reports `Unknown symbol`.

### 4.8 Installing and Configuring wpa_supplicant

> If Alpine's official repositories are unavailable, directly download the armhf apk and install it manually.

```sh
# 1) Prepare the apk packages (armhf):
#    wpa_supplicant-2.10-r11.apk
#    libnl3.apk
#    pcsc-lite-libs-2.2.3-r1.apk
apk add --allow-untrusted /tmp/wpa_supplicant.apk /tmp/libnl3.apk /tmp/pcsc.apk

# 2) Write the configuration
cat > /etc/wpa_supplicant/wpa_supplicant.conf <<'EOF'
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
EOF

# 3) Start
/sbin/wpa_supplicant -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf -B

# 4) Confirm the status
wpa_cli -i wlan0 status
#   wpa_state=INACTIVE is normal (not connected to any network)
```

### 4.9 Scan Verification

```sh
wpa_cli -i wlan0 scan
sleep 5
wpa_cli -i wlan0 scan_results
# Multiple hotspots (CMCC-*, ChinaNet-*, etc.) appearing means bring-up succeeded

# Connection example (open network direct connection)
wpa_cli -i wlan0 add_network
wpa_cli -i wlan0 set_network 0 ssid '"CMCC-dtGM"'
wpa_cli -i wlan0 set_network 0 key_mgmt NONE
wpa_cli -i wlan0 enable_network 0
wpa_cli -i wlan0 save_config
```

### 4.10 Fixing Boot Auto-start in Place

> After a device reboot, kernel enumeration, firmware, drivers, and wpa_supplicant must all recover automatically.

```sh
# 1) Boot-time driver loading: write to /etc/modules-load.d/wifi.conf
cat > /etc/modules-load.d/wifi.conf <<'EOF'
marlin_fm
sprdwl
EOF

# 2) Firmware download + wpa_supplicant boot script: /etc/local.d/wifi_setup.start
cat > /etc/local.d/wifi_setup.start <<'EOF'
#!/bin/sh
# 1. chroot to run download to complete power-up + firmware download
mount --bind /dev /tmp/aand/dev
chroot /tmp/aand /bin/download -i wlan0 &
sleep 8
# 2. Confirm the interface and bring it up
ip link set wlan0 up
# 3. Start wpa_supplicant
/sbin/wpa_supplicant -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf -B
EOF
chmod +x /etc/local.d/wifi_setup.start

# 3) Enable the local service (Alpine openrc)
rc-update add local default
rc-service local start
```

---

## 5. Troubleshooting Quick-Reference Table

| Symptom | Possible Cause | Investigation/Fix |
|---|---|---|
| `dmesg` constantly `SDIO dev not ready` | the chip is not powered / firmware not downloaded | confirm download has run (4.5); check whether `/dev/power_ctl` is writable |
| GPIO94 READY stays 0 | the power-up sequence was not executed | use `strace` to trace whether download's ioctl/write report errors |
| `download` reports open device failure | the chroot is missing device nodes | `mount --bind /dev /tmp/aand/dev` |
| `download` reports wcnfdl/wcnmodem not found | missing by-name links | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl` |
| `download` finishes but SDIO has no enumeration | wrong DTB | confirm p16 already has the stock Android dtb (4.3) |
| `insmod sprdwl.ko` reports Unknown symbol | wrong module load order | `insmod marlin_fm.ko` first |
| wlan0 does not appear | the driver was loaded before firmware download completed | wait for `mmc2:8800:1` to appear in dmesg before insmod |
| `wpa_cli scan` fails | wpa_supplicant not running / interface not up | `ip link set wlan0 up` + confirm the supplicant process |
| `wpa_cli` not found | PATH missing /sbin | `export PATH=$PATH:/sbin` |
| WiFi lost after reboot | boot auto-start not done | fix in place per 4.10 |
| SSH drops after plugging/unplugging USB peripherals | the device's USB port multiplexing (network port/keyboard) | re-plug the PC's USB and reboot the device to recover |

---

## 6. Notes and Risks

1. **Flashing the p16 (boot) partition carries a bricking risk** — you must back up first (`/root/p16_boot_backup.img`); if flashed incorrectly, you can roll back.
2. **USB port multiplexing**: the device's USB port serves as both an SSH network port and a peripheral port. Plugging in a keyboard/mouse will disconnect SSH; you need to unplug the peripheral, plug the PC's USB back in, and reboot the device.
3. **Firmware version matching**: after download powers up successfully, the driver and firmware must come from the same Android version, otherwise wlan0 may have an interface but scanning fails.
4. **Module path**: confirm `marlin_fm.ko` / `sprdwl.ko` are in `/lib/modules/` and match kernel 3.10.65 (mismatch causes `invalid module format`).
5. **wpa_supplicant version**: the device is armhf; be sure to use the armhf package; an x86_64 package reports Exec format error.
6. **dtb offset**: when writing p16, `seek=20008` (512-byte blocks) corresponds to byte offset `0x9C5000`; different firmware may differ, so parse the boot image first to confirm.

---

*This manual is compiled based on the actual bring-up process; the operation order must not be reversed, and the key steps (DTB → power-up → driver → supplicant) are all indispensable.*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
