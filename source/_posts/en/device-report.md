---
title: "SC9832A device hardware and software information report"
date: 2026-09-24 21:36:03
lang: en
permalink: en/2026/09/24/device-report/
search: true
categories:
- 设备档案
tag:
- SC9832A
---


# SC9832A smart terminal · device hardware and software information report

> Collection time: 2026-09-24 21:31 · Collection method: SSH read-only probing (/proc, /sys, dmesg, command-line tools)
> Hostname `spd-box` · IP `192.168.137.100` (rndis0)

---

## 1. System overview

| Item | Value |
|---|---|
| Product form | handheld smart terminal (portrait 720×1280, with 4 physical keys) |
| SoC | Spreadtrum **SC9832A** (Hardware: sc9832) |
| Serial number | `CB02317100000B83` (androidboot.serialno) |
| Operating system | **Alpine Linux 3.21.3** (musl + busybox user space) |
| Kernel | **Linux 3.10.65 #13 SMP PREEMPT** (armv7l, built 2018-04-27 by gcc 4.8, `renjie@admin007-Server`) |
| Boot parameters | `console=ttyS1,115200n8 init=/init root=/dev/ram0 androidboot.hardware=sc9832 lcd_id=ID9881 mem_cs0_sz=40000000(1GB)` |
| Runtime environment | BusyBox v1.37.0, gcc 14.2.0 (Alpine), Python 3.12.14 (bundled with the device) |
| Load at sampling time | up 37min, load 1.90 / 2.69 / 2.29 |

## 2. Processor (CPU)

| Item | Value |
|---|---|
| Architecture | ARMv7 **Cortex-A7** (implementer 0x41, part 0xc07, rev 5, v7l) |
| Designed core count | 4 cores (SC9832A specification) |
| Currently online | **2 cores** (cpu0/cpu1; the rest are hotplugged offline, `/proc/cpuinfo` enumerates only 2) |
| Frequency policy | cpufreq: **768MHz (current) ~ 1.3GHz (max)**, governor=`interactive` |
| Features | swp half thumb fastmult vfp edsp neon vfpv3 tls vfpv4 idiva idivt vfpd32 |
| BogoMIPS | 1545.76 |
| ⚠️ hotplug landmine | `/sys/.../cpu*/online` takes trigger-style writes; repeated writes knock cores offline and only a reboot recovers them, so do not write by hand |

## 3. Memory (RAM)

| Item | Value |
|---|---|
| Total capacity | **938,404 kB ≈ 916MB** (cmdline mem_cs0_sz=0x40000000 = 1GB specification) |
| Usage at sampling time | 43.5MB used / 130MB free / 764MB buff+cache (including 647MB Cached) |
| Swap | none |

## 4. Storage (eMMC)

| Item | Value |
|---|---|
| eMMC model | **FNX2MB** (CID `150100464e58324d42...`, vendor 0x15 Samsung) |
| Total capacity | 7,634,944 blocks ≈ **7.3GB** (mmcblk0, including boot0/boot1/rpmb) |
| Root partition | `mmcblk0p23` 6.2G (ext4), 81% used after cleanup, 1.2G available |
| Android system partition | `mmcblk0p17` 610M → mounted at `/mnt/android_sys` (78% used) |
| Partition table | 23 primary partitions in total (p1~p6 1~5MB small partitions, p7 19M, p15 10M, p16 20M, p17 800M(819200KB), p20 200M, p21 18M, p23 6.2G root) |
| RAM disks | /run 183M tmpfs, /dev/shm 458M, /dev 10M tmpfs |

## 5. Display

| Item | Value |
|---|---|
| Screen panel | **ILI9881** (MIPI DSI, cmdline `lcd_id=ID9881`, driver `lcd_ili9881_mipi`) |
| Framebuffer | `/dev/fb0` driver **sprdfb**, 720×1280 portrait, **32bpp**, virtual size 720×3840 (3-page flip buffer) |
| Physical byte order | fb actually lands as `[R,G,B,X]` (opposite of what the driver reports; LVGL needs an R/B swap) |
| Backlight | `/sys/class/backlight/sprd_backlight`, 0~255 |
| GPU | **Mali-400 MP** (3D GPU; unusable in this system's musl user space: the bionic DDK cannot be loaded, no /dev/dri) |
| Hardware acceleration | **VSP/GSP/VPP built-in**: `/dev/sprd_vsp` (hardware decoding), `/dev/sprd_gsp` (scaling/rotation), `/dev/sprd_vpp` (post-processing), `/dev/ion` (zero-copy buffers), all usable |

## 6. Input devices

| event | Name | Description |
|---|---|---|
| event0 | sprd-gpio-keys | onboard physical keys (LEFT=114 服务=102 ENTER=115 BACK=116 耳机=30) |
| event1 | sprd-eic-keys | EIC keys |
| event2 | headset-keyboard | headset wire control |
| event3/4 | **2.4G Composite Device** (Vendor 4037:2804) | USB 2.4G wireless keyboard/mouse receiver (currently plugged in and enumerated) |

- USB host controller: dwc_otg (20200000.usb), host mode supports hotplug; the `mode`/`hprt0` sysfs entries are read-only debug ports
- USB peripheral port: rndis (PC network); SSH goes through this channel

## 7. Network

| Interface | IP | Description |
|---|---|---|
| lo | 127.0.0.1 | loopback |
| **rndis0** | 192.168.137.100/24 | USB virtual NIC (connected to the PC) |
| **wlan0** | 192.168.1.52/24 + global IPv6 | WiFi (MAC `8a:b3:92:1f:09:94`, driver module `sprdwl` 84.5KB) |

- Only 2 kernel modules: `sprdwl` (WiFi), `marlin_fm` (FM radio, 17554 bytes)
- FM status: the AP audio subsystem does not work (sipc only exposes the LTE channel, with no audio DSP channel); field strength/station search is not possible

## 8. Battery and temperature

| Item | Sampled value |
|---|---|
| Battery | Li-ion, **charge 100% (Full)**, voltage 4.185V, health Good |
| Battery temperature | **35.3°C** (353, unit 0.1°C) |
| ARM temperature | **55.8°C** (thermal_zone sensor_arm) |
| Power supply | usb ONLINE=1 (USB powered), ac ONLINE=0 |
| Fuel gauge | sprdfgu (Spreadtrum FGU) |

## 9. Audio

| Sound card | Name | Description |
|---|---|---|
| card0 | all-i2s | I2S interface |
| card1 | **sprdphone** | onboard codec (main output) |
| card2 | saudiolte | LTE voice channel |
| card3 | saudiovoip | VoIP channel |

- The ALSA pcm devices are complete (4 pcm each on C0~C3), but the AP-side audio subsystem's historical conclusion is: card0 EIO, DMA does not move → user-space sound output is not feasible
- Bluetooth: WCN module (@wcnd daemon); the link's truth is the `/tmp/bt_audio.fifo` reader; an invalid link key is a first-level troubleshooting item

## 10. Other peripherals

| Item | Value |
|---|---|
| LED | `blue` `green` `red` three colors (/sys/class/leds) |
| GPIO | gpiochip0 / 288 / 304 |
| Serial ports | /dev/ttyS0~S3 (console=ttyS1) |
| LTE modem | built into the SC9832A (sipc shared memory channel) |

## 11. Software stack (on-device apps)

| Component | Description |
|---|---|
| Main program | `/usr/local/bin/lvgl_demo` (LVGL **9.6** self-compiled, `/root/lvgl_install` install tree: liblvgl.a includes self-enabled montserrat_48) |
| Page framework | self-developed lv_page_manager (activity stack + onCreate/onResume/onPause/onDestroy) |
| Emulators | miniretro (FC, git original) + miniretro_gba (mgba core) + miniretro_psp (PPSSPP core, JIT+480x272), writing /dev/fb0 directly |
| Video playback | ffmpeg port (VSP hardware decoding / rotate instead of scale) |
| Daemons | `/root/lvgl_watchdog.sh` (starts in 5s), `log_rotate.sh` + busybox crond |
| Boot | `/etc/local.d/00_lvgl_demo.start` (via setsid) |
| App count | 18 apps built into the launcher + at most 16 external-process apps |

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
