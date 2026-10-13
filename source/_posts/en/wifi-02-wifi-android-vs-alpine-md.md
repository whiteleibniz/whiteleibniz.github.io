---
title: "WiFi Chip Boot Process Comparison_Android_vs_Alpine"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/wifi-02-wifi-android-vs-alpine-md/
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# WiFi Chip Boot Process Comparison — Stock Android vs Alpine Linux (this device)

> **Topic**: a comparison of the boot processes of the Marlin SC2331 WiFi chip under Android 6.0 (factory system) and Alpine Linux (after switchroot), the underlying differences, and "how to replicate Android's boot sequence in Alpine".
> **Document version**: v1.0　|　2026-09

---

## 1. Why Compare These Two

- The device ships with **Android 6.0**, where WiFi/Bluetooth work **normally** — this shows the hardware, firmware, and drivers themselves are fine.
- After switchroot to **Alpine Linux 3.21** (keeping the Android kernel 3.10.65), WiFi **completely fails**, and the kernel cannot enumerate the chip.
- The hardware has not changed, the kernel has not changed; only the **root filesystem** has changed. The difference must lie in the **user-space boot logic**.
- Therefore: comparing Android's boot process with Alpine's boot process step by step can precisely locate "what Alpine is missing".

---

## 2. Hardware and Chip Background

| Item | Description |
|---|---|
| SoC | Spreadtrum SC9832A (quad-core ARMv7, with an integrated WCN subsystem controller) |
| WiFi/BT chip | Marlin SC2331 (combo chip), **SDIO interface** |
| Kernel enumeration address | `mmc2:8800:1`, device `0x2331` |
| Key pin | GPIO94 = the chip's READY signal (pulled high after power-up completes) |
| Firmware partitions | `wcnfdl` (p14), `wcnmodem` (p15) |
| Power/download control nodes | `/dev/power_ctl`, `/dev/download` (created by the kernel driver) |

> Typical characteristics of SC2331: **without powering up and downloading firmware first, the slave device on the SDIO bus will not be ready**, so the kernel naturally cannot enumerate it. This is the physical root cause of the entire problem.

---

## 3. Stock Android 6.0 Boot Process

```
Boot
  │
  ▼
Kernel boot (boot partition kernel + DTB)
  │  (the DTB describes wlan power, clocks, the SDIO controller, GPIO94)
  ▼
Driver initialization
  ├─ The sdio controller driver enumerates mmc2 (at this point the chip is not powered, so no slave device)
  ├─ power_ctl / download character device registration (created by the WCN controller driver)
  └─ ttyS0 serial port (for handshaking with the chip)
  │
  ▼
Android init (init.rc)
  │
  ▼
【Key】Resident download service (/system/bin/download)
  │  Started by init per the rc file, resident at boot
  │
  ├─ Open /dev/power_ctl
  │    Write the power-up sequence: SLEEP → POWER_ON → POWER_RST (loop/timing control)
  ├─ Open /dev/download
  │    Per the path configuration in /etc/marlinba/*.ini, read the wcnfdl/wcnmodem partition firmware
  ├─ ttyS0 @115200 handshakes with the chip's bootloader
  ├─ Write the firmware to the chip in bulk over SDIO (sprd_download_sdio_write, block size e.g. 131080)
  │
  ▼
The chip completes boot → GPIO94 READY pulled high → SDIO slave device ready
  │
  ▼
The kernel enumerates mmc2:8800:1 (device 0x2331)
  │
  ▼
The wlan driver (sprdwl.ko + marlin_fm.ko) binds wlan0
  │
  ▼
wpa_supplicant (bundled with Android) → scan/connect
```

**Three key points of the Android process**:

1. **Power-up + firmware download is done by a "user-space service"**, not automatically completed by the kernel at boot;
2. The firmware, ini configurations, and device nodes the service reads **are all in the Android filesystem**;
3. The DTB provides the correct power/clock descriptions, so the download service can power up correctly.

---

## 4. Stock Alpine Linux (after switchroot) Boot Process (failure state)

```
Boot
  │
  ▼
Kernel boot (the same Android kernel 3.10.65 + DTB)
  │   ↓ If the DTB was modified on the Alpine side (power attributes missing/wrong) → everything after is wrong
  ▼
Driver initialization (same as Android: sdio controller, power_ctl, download nodes)
  │
  ▼
Alpine init (openrc / busybox init)
  │
  ▼
【Gap】No download service!
  ├─ /system/bin/download is not in the Alpine root filesystem
  ├─ /dev/power_ctl has never been written → the chip has never been powered
  ├─ wcnfdl / wcnmodem firmware has never been downloaded
  └─ No one opens ttyS0 to handshake with the chip
  │
  ▼
The chip stays powered off → GPIO94 READY is always 0 → the SDIO slave device does not exist
  │
  ▼
The kernel's dmesg repeats: SDIO dev not ready
  │
  ▼
insmod sprdwl.ko → wlan0 does not appear (or appears but cannot work)
```

**Three gaps in Alpine's failure state**:

1. **Missing power-up action** (no one writes `/dev/power_ctl`);
2. **Missing firmware download** (no one reads wcnfdl/wcnmodem and writes it into the chip);
3. **Missing the correct DTB** (during some trial phases, the Alpine-side DTB's power attributes were incomplete).

---

## 5. Step-by-Step Comparison Table

| Step | Android 6.0 (working) | Alpine (original, failing) | Nature of Difference |
|---|---|---|---|
| Kernel | 3.10.65 Android kernel | the same kernel | ✅ identical |
| Device tree DTB | stock Android (power/clock complete) | initially the stock Android one, with a risk of being corrupted midway | ⚠️ must ensure the stock version |
| SDIO controller driver | initialized | initialized | ✅ identical |
| power_ctl / download nodes | registered | registered | ✅ identical |
| **Power-up sequence** | the download service writes `/dev/power_ctl` | **not performed by anyone** | ❌ **core gap** |
| **Firmware download** | the download service reads wcnfdl/wcnmodem and flashes them into the chip | **not performed by anyone** | ❌ **core gap** |
| ttyS0 chip handshake | handled by the download service | not performed by anyone | ❌ core gap |
| GPIO94 READY | pulled high after power-up completes | always 0 | result difference |
| SDIO slave device enumeration | `mmc2:8800:1` (0x2331) | does not exist | result difference |
| WiFi driver | sprdwl.ko + marlin_fm.ko | present but ineffective when loaded (the chip has not come up) | depends on prerequisites |
| User-space configuration | Android wpa_supplicant | an Alpine version of wpa_supplicant must be installed separately | needs to be filled in |
| Boot auto-start | init.rc keeps download resident | openrc has no corresponding service | needs to be filled in |

---

## 6. Principle Analysis: Why Alpine Cannot Work Directly

### 6.1 Direct Cause

The SC2331 chip **does not work if powered up without firmware download**, and the firmware download is done in Android by a **resident user-space service**, not automatic kernel behavior. Alpine only replaced the user space, so no one does this.

### 6.2 Deeper Cause (why you cannot simply "install a driver")

- The driver `sprdwl.ko` depends on **the chip having been enumerated** (`mmc2:8800:1` existing) before it can bind;
- chip enumeration depends on **firmware having been downloaded**;
- firmware download depends on **the power-up sequence executing correctly**;
- the power-up sequence depends on **DTB power descriptions + /dev/power_ctl being writable + Android's download binary and its accompanying libraries/firmware**.

This is a **one-way dependency chain**; any missing link makes WiFi appear as "broken hardware".

### 6.3 Why Android's wpa_supplicant Cannot Be Used Directly

It was once attempted to run Android's wpa_supplicant 2.5 directly in an Alpine chroot:
- reports `CANNOT LINK` (missing libraries) → after adding `/mnt/android_sys/lib/*.so` it still Aborted;
- reason: Android's Bionic libc is incompatible with the glibc/musl environment and linker mechanisms, so the binary cannot run stably.
- Conclusion: **use Alpine's native package for the user-space supplicant** (armhf), reusing only Android's **underlying firmware download logic**.

---

## 7. Principle of the Solution: "Borrowing a Shell" from Android in Alpine

Rather than rewriting the power-up logic, **reuse the stock Android download binary** and give it a minimal runtime environment:

```
Alpine side
  │
  ├─ /tmp/aand/  = mini Android user space (chroot root)
  │    ├─ bin/download        (the stock Android power-up + firmware download program)
  │    ├─ lib/*.so            (Android system libraries)
  │    ├─ etc/marlinba/*.ini  (firmware path configuration)
  │    └─ dev/                (mount --bind /dev, including power_ctl/download)
  │
  ├─ by-name links: wcnfdl → mmcblk0p14, wcnmodem → mmcblk0p15
  │
  └─ chroot /tmp/aand /bin/download -i wlan0
        = fully replicating Android's power-up + firmware download sequence in Alpine
```

**Why it works**:
- The power-up sequence's hardware operations (writing power_ctl, ttyS0 handshake, writing firmware over SDIO) are **kernel-driver ioctl/device operations**, independent of the user-space libc;
- as long as the download binary can find the device nodes, firmware, and ini, it can drive the kernel to complete the whole set of actions;
- so as long as the chroot environment **has complete files + bound device nodes + linked firmware partitions**, the Android binary can work as-is on the Alpine kernel.

**Summary of the division of labor in principle**:

| Layer | Who is responsible | How to obtain it in Alpine |
|---|---|---|
| Power/clock descriptions | kernel + DTB | use the stock Android DTB |
| Power-up timing | Android download user space | chroot reuses the Android binary |
| Firmware download | Android download user space | chroot reuses the Android binary |
| Chip enumeration | kernel (automatic) | appears automatically once prerequisites are complete |
| WiFi data path | sprdwl.ko driver | Alpine kernel module (already prepared) |
| Scan/connect | wpa_supplicant | Alpine armhf native package |
| Boot auto-start | openrc | custom /etc/local.d script |

---

## 8. A Complete "Ideal Boot Timing" (after bring-up)

```
Kernel boot (stock Android DTB)
  → sdio controller initialization, registers power_ctl/download nodes
  → [local script] mount --bind /dev → chroot to run download
  → download: SLEEP→POWER_ON→POWER_RST → ttyS0 handshake → flash wcnfdl/wcnmodem
  → chip READY pulled high → the kernel enumerates mmc2:8800:1 (0x2331)
  → insmod marlin_fm.ko → insmod sprdwl.ko → wlan0 appears
  → ip link set wlan0 up
  → wpa_supplicant -i wlan0 -B
  → wpa_cli scan / connect
```

**Key difference in one sentence**: Android relies on init.rc's resident download service to complete the chip's "initialization"; Alpine uses chroot + local scripts to **manually replicate this step**, after which everything else (drivers, supplicant) returns to the conventional Linux flow.

---

*Comparison conclusion: the hardware and kernel are the same; the differences are concentrated in the user-space "power-up + firmware download" service. Replicate it, and WiFi works.*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
