---
title: "WiFi Chip Bring-up Work Process and Approach Summary"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/wifi-05-wifi-md/
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# WiFi Chip Bring-up — Work Process and Approach Summary

> **Topic**: a review of the complete investigation and resolution process from "WiFi completely broken under Alpine" to "scannable, connectable".
> **Document goal**: to record my (the executor's) **analytical approach, step-by-step breakdown, key decisions and reasons**, for easy review and transfer to similar problems.
> **Document version**: v1.0　|　2026-09

---

## 1. Problem Definition (getting the question right first)

**Symptoms**:
- Device spd-box (SC9832A, Android 6 kernel 3.10.65 + Alpine Linux 3.21 armhf);
- WiFi/Bluetooth work under Android;
- after switchroot, WiFi fails: `dmesg` repeatedly shows `SDIO dev not ready`, GPIO94 READY stays at 0, and the kernel cannot enumerate the chip.

**The first thing I did was "define the problem boundary"**:
- Is the hardware broken? → the user explicitly said it works under Android, and there is a same-model H709 working normally → **hardware fault ruled out**.
- Is the kernel wrong? → the kernel is still Android 3.10.65, not replaced → **the kernel is most likely not the root cause**.
- Then the only differences left are two: **the root filesystem (user space)** and **DTB/configuration**.

This "rule out the impossible first" definition kept the follow-up investigation from going down the wrong path of recompiling the kernel or suspecting hardware.

---

## 2. Phase 1: Frontal Attempts (about 6 approaches, all failed)

Before getting the reference machine, I first tried to "manually simulate" power-up in Alpine; all failed, recorded as follows:

| # | Attempted Approach | Result | Reason for Failure (attributed afterwards) |
|---|---|---|---|
| 1 | manual ioctl combinations (various orders of POWER_ON/POWER_RST) | ineffective | the power-up timing is not something simple ioctls can replicate; a complete state machine is needed |
| 2 | injecting power attributes into the DTB (vddwifipa/vddcon/always-on/runtime) | ineffective | the attributes themselves are not missing; what is missing is the action of "user-space driving firmware download" |
| 3 | GPIO sampling guidance (tracking pin levels to find the timing) | ineffective | READY staying at 0 shows the chip was never activated at all |
| 4 | /dev/mem mmap direct register writes | ineffective | register-level operations cannot replace the chip's boot protocol |
| 5 | compiling kernel modules on the device (wanting to add driver logic) | failed | the device has no kernel build directory, and the cross-compilation toolchain is unavailable |
| 6 | p21 (recovery) dtb modification | ineffective | not the active partition; changes have no effect |

**Key insight (why I stopped)**:
- the common point of failures 1-4 is that "I was **imitating** a protocol whose complete details I did not know";
- the chip's power-up + firmware download is a **vendor-private protocol**; reverse-engineering it is extremely costly with a low success rate;
- **Change of approach**: since there is a ready-made implementation in Android (the download service), **rather than imitating, reuse it**.

> Methodology 1: when facing a problem of "unknown protocol", prioritize finding a "ready-made implementation" rather than reverse-engineering the protocol.

---

## 3. Phase 2: Forensics from the Reference Machine (using facts instead of guesses)

The user made a key suggestion: there is a **same-model device with working Android** that can be used for a control experiment. This solved the problem of "not knowing what the correct behavior is".

### 3.1 Connection and Forensics

Connected to the H709 (root=Magisk) via WatchTools adb (`AndroidWatch_ADB_ToolBox\adb\adb.exe`):

Facts obtained:

| Item | Value |
|---|---|
| Partition mapping | boot=p16, wcnfdl=p14, wcnmodem=p15, system=p17, recovery=p21 |
| boot image | `boot_p16_android.img` (20MB, `ANDROID!` header, FDT @0xB71800) |
| Stock DTB | `android_orig.dtb` (53,967 bytes) |
| Power-up program | `/system/bin/download` + `/system/lib/libiwnpi.so` |
| Firmware partitions | wcnfdl (p14), wcnmodem (p15) |
| User-space configuration | `/etc/marlinba/*.ini` |

**Why these are decisive**:
- the partition mapping tells me "where the firmware is, where boot is";
- the download binary tells me "how Android powers the chip";
- the stock DTB tells me "how the hardware should be described".

> Methodology 2: take forensics by comparing against a "known-correct system", turning guesses into verifiable facts. Forensics should take **things that run** (binaries, firmware, configurations), not just look at logs.

### 3.2 Key Decision: chroot Reuse of the Android Binary

After observing Android's architecture, I judged:
- the download service's hardware operations (writing `/dev/power_ctl`, ttyS0 handshake, writing firmware over SDIO) are **all done through kernel drivers**;
- it is itself an **ordinary ELF**; as long as it can be loaded into memory and find the device nodes/firmware, it can drive the kernel to do the work;
- it needs Android's libraries and linker → use a **chroot** to provide a mini Android filesystem.

**So the approach was finalized**:
```
Build a /tmp/aand/ mini Android environment in Alpine
  → chroot into it and run download
  → chip power-up + firmware download
  → return to Alpine to continue
```

> Methodology 3: when facing a "user-space component depends on a specific root filesystem" problem, chroot is a low-cost isolation-reuse means — without changing the main system, only a minimal dependency set is built.

---

## 4. Phase 3: Breaking Down chroot Run Obstacles One by One (strace-driven)

The first run of download after `chroot` will certainly error out. I used the **strace localization method** (no guessing; look at system calls):

| Error Signal (seen via strace) | Root Cause | Fix |
|---|---|---|
| `open("/dev/power_ctl")` fails | /dev inside the chroot is empty | `mount --bind /dev /tmp/aand/dev` |
| `open(...wcnfdl)` fails | download finds firmware partitions by by-name | create links `wcnfdl → /dev/block/mmcblk0p14`, `wcnmodem → /dev/block/mmcblk0p15` |
| missing .so libraries | the mini environment is incomplete | copy the full set of `.so` from `/mnt/android_sys/lib/` |

**Key breakthrough**: after `mount --bind /dev`, download could open the kernel nodes; after linking wcnfdl/wcnmodem, it could find the firmware. **Once running, decisive evidence appeared in dmesg**:

```
mmc2: new high speed SDIO card at address 8800
mmc2:8800:1
device 0x2331
sprd_download_sdio_write ... 131080 ...   (bulk firmware write)
```

**This moment means**:
- the chip was successfully powered up;
- the firmware was successfully written;
- GPIO94 READY was pulled high;
- the kernel enumerated the SDIO slave device.

> Methodology 4: use `strace` to see "what it is actually looking for"; every ENOENT is a precise fix instruction. Far more efficient than reading documentation/guessing configurations.

---

## 5. Phase 4: DTB Correction (eliminating hidden variables)

**Symptom**: even when download runs through, it is sometimes still unstable. Further checking found traces that the dtb in p16 had been modified (early attempts injected power attributes).

**Decision**: directly overwrite the dtb section in p16 with the stock Android DTB:

```sh
dd if=/tmp/android_orig.dtb of=/dev/block/mmcblk0p16 bs=512 seek=20008 conv=notrunc
```

- `seek=20008` (512B blocks) corresponds to the dtb's byte offset within boot of `0x9C5000`;
- after restoring the stock version, the power/clock descriptions matched Android's, eliminating this DTB hidden variable.

**Why this must be done**: download's power-up timing was designed **against the stock Android DTB's power model**; after the DTB was modified, even if the program logic is correct, the hardware descriptions no longer match.

> Methodology 5: when "the program is correct but the behavior is wrong", check whether the **environment description layer** (DTB/configuration files) has been modified. Restore the factory baseline first, then talk about optimizations.

---

## 6. Phase 5: Drivers and User-Space Supplicant

Chip enumeration success ≠ WiFi usable; the data path must also be completed:

### 6.1 Driver Loading (order-sensitive)

```sh
insmod /lib/modules/marlin_fm.ko   # first: provides fm_read and other symbols
insmod /lib/modules/sprdwl.ko      # second: the main WiFi driver
```

- Reversing the order reports `Unknown symbol`;
- on success, `wlan0` appears (MAC `a2:d2:f3:bf:8c:10`) → the driver bound successfully.

### 6.2 wpa_supplicant (decisions made through pitfalls)

**First attempt**: directly run the **stock Android wpa_supplicant 2.5** in the Alpine chroot:
- reports `CANNOT LINK` (missing libraries) → after copying `/mnt/android_sys/lib/*.so` it still `Aborted`;
- root cause: **Android's Bionic libc is incompatible with the glibc/musl environment**, and the linker mechanisms differ.

**Decision shift**: no longer reuse Android's supplicant, switching to the **Alpine armhf native package**:
- `wpa_supplicant-2.10-r11.apk` + `libnl3.apk` + `pcsc-lite-libs-2.2.3-r1.apk`;
- Alpine's official/mirror repositories were unavailable at the time (certificates/expired), so the apks were downloaded on the PC and installed to the device with `apk add --allow-untrusted`.

**Configuration**:
```
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
```

**Why this division of labor is reasonable**:
- **underlying firmware download** (vendor-private, kernel-related) → reuse the Android binary (chroot);
- **user-space supplicant** (standard network protocol, libc-related) → use the Alpine native package.

> Methodology 6: split the reuse boundary by "degree of coupling with the kernel/hardware" — hardware-private parts reuse the vendor's, standardized parts use the new system's native implementation. Neither side is forced.

### 6.3 Scan Success

```sh
wpa_cli -i wlan0 scan
wpa_cli -i wlan0 scan_results
# CMCC-dtGM(-29) / CMCC-PcZt(-42) / CMCC-xxfS(-51) ... 6~11 hotspots in total
```

**At this point the WiFi chip is fully brought up**: power-up → firmware → enumeration → driver → scan.

---

## 7. Timeline Overview

| Phase | Key Actions | Result |
|---|---|---|
| Defining the problem | ruling out hardware/kernel, locking onto user space + DTB | correct direction |
| Frontal attempts | 6 categories of manual power-up simulation | all failed (private protocol cannot be imitated) |
| Reference forensics | adb connect to H709, take partitions/firmware/download/DTB | obtained the full set of materials for "correct behavior" |
| chroot approach | build the /tmp/aand mini Android environment | approach finalized |
| strace troubleshooting | bind /dev + firmware links + patch libraries | download runs through, chip enumerated |
| DTB correction | restore the stock Android dtb | hidden variable eliminated |
| Driver | marlin_fm.ko → sprdwl.ko | wlan0 appears |
| Supplicant | Alpine armhf native package | scan/connect available |
| UI layer | launcher network page wiring | the user can operate on the interface |

---

## 8. Methodology Precipitation (transferable to other boards/chips)

1. **Rule out the impossible first** (hardware/kernel/system), then concentrate firepower on the real differential layer;
2. **Do not reverse-engineer private protocols, reuse them** — find the original system's ready-made implementation (binary/service);
3. **Reference machine forensics**: a same-model working device is the most authoritative source of "correct behavior"; get materials that run whenever possible;
4. **chroot isolation reuse**: build a minimal dependency set for third-party binaries, without polluting the main system;
5. **strace-driven troubleshooting**: every open/ENOENT is a precise fix instruction, no guessing;
6. **Restore the factory baseline**: if the environment description layer (DTB/configuration) has been modified, restore it first before making new changes;
7. **Split the reuse boundary by coupling**: hardware-private parts reuse the vendor's, standardized parts use native implementations;
8. **One-way dependency chain thinking**: power-up→firmware→enumeration→driver→supplicant, verify level by level, and only advance to the next level with dmesg/log evidence for each.

---

## 9. Remaining Items and Future Directions

- **Boot auto-start fixed in place**: download power-up + driver loading + wpa_supplicant have been fixed in place via local scripts/module configuration (details in "Operation Manual" 4.10);
- **Bluetooth**: SC2331 is a combo chip; Bluetooth shares the same path and can be brought up by following the same "chroot download + driver + user space" process (not yet expanded);
- **Connection stability**: scanning is already stable; connection/roaming behavior requires long-term real-network testing;
- **UI layer**: the launcher network configuration page can already scan, display lists, and connect; in the future, "saved network management and signal strength ranking optimization" can be added.

---

*This summary reviews the complete chain from "symptom" to "root cause" to "solution". The core in one sentence: the chip is not broken, the kernel is not broken; what is broken is "Alpine lacks Android's chip initialization service" — borrow this step back with chroot, and the chain is connected.*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
