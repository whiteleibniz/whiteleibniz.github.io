---
title: "FM radio startup flow: Android vs Alpine comparison"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-07-fm-vsalpine-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# Spreadtrum SC9832A FM radio startup flow — Android vs Alpine (this device) comparison

> **Audience**: anyone who needs to understand "why we do it this way on Alpine"
> **Core value**: Android natively has a whole framework, and on Alpine we replace it with as little code as possible — this article aligns every stage of the two sides, so you know clearly **which segment we replaced and what the basis for the replacement is**

---

## 1. Chip physical architecture (shared by both systems)

Whether Android or Alpine, **the bottom three layers are exactly the same**, which is the prerequisite for being able to compare them:

```
┌─ Hardware layer   Marlin2 combo chip, SDIO vendor 0x0000 / device 0x2331
│            WiFi + BT + FM three-in-one, sharing the SDIO bus
├─ Firmware layer   download burns the combo firmware (including the FM part) once
├─ Driver layer   marlin_fm.ko → registers the misc device /dev/fm (minor 23)
│
│  ← the two systems diverge below this point →
```

**Measured values** (`spd-box`, this device):

| Item | Value |
|---|---|
| SDIO modalias | `sdio:c00v0000d2331` |
| FM driver | `marlin_fm` (`Used by sprdwl`) |
| FM device nodes | `/dev/fm` (misc 23), `/dev/log_radio` (misc 35) |
| FM PCM | `01-04: Dfm sprd-codec-fm-4` (playback) |
| Kernel | Linux 3.10.65 |

> The driver states: `SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI`
> — this statement holds under both systems and is the starting point for analyzing shared-resource issues.

---

## 2. Android 6.0 native FM startup flow

### 2.1 Startup chain

```
Boot
 └─ init / ueventd
     ├─ insmod sprdwl.ko → along with marlin_fm.ko
     ├─ download (shared with WiFi, burns the combo firmware)
     ├─ wcnd (unified power-up management for WiFi/Bluetooth/FM)
     └─ SystemServer
         └─ BroadcastRadioService
             └─ loads the FM HAL
                 ├─ libradio.so / libradioservice.so (HAL interface)
                 ├─ libFMHalSource.so (audio source, starts a thread to read from PCM)
                 ├─ libfmjni.so (JNI bridge)
                 └─ libengfm.so (engineering mode, exports only fm_runcommand)
                     └─ opens /dev/fm, sends commands
         └─ FM App (radio_interactor_service.apk etc.)
             └─ AudioFlinger ← FMHalSource → TinyALSA → PCM
```

### 2.2 Android key points

| Stage | What Android does |
|---|---|
| **Permissions/access control** | SELinux + device node permissions; `/dev/fm` only allows access by the radio group |
| **Audio routing** | `FMHalSource` holds the `pcmHandle`; `FMHalThread::threadLoop()` reads PCM → `RingBuffer` → AudioFlinger mixing |
| **State management** | `BroadcastRadioService` manages radios uniformly and provides the `RadioManager` API to apps |
| **RDS handling** | parsed inside the HAL (`rds_parser` lives on the driver or HAL side) and reported to apps via `RadioMetadata` |
| **Multi-app contention** | the service layer arbitrates uniformly; apps use it as API clients |
| **Middleware thickness** | very thick: App → RadioManager → BroadcastRadioService → JNI → HAL → /dev/fm |

**Evidence sources** (readable directly from the Android partition on this device):

```sh
ls /mnt/android_sys/lib/{libFMHalSource,libengfm,libfmjni,libradio,libradioservice}.so
ls /mnt/android_sys/priv-app/radio_interactor_service/radio_interactor_service.apk
nm -D /mnt/android_sys/lib/libengfm.so                 # only fm_runcommand
nm -D /mnt/android_sys/lib/libFMHalSource.so | grep -i 'pcm\|thread\|RingBuffer'
```

---

## 3. The Alpine (this device) FM solution

### 3.1 Goal: replace a whole framework with minimal code

On Alpine we have **no** binder / SystemServer / AudioFlinger / SELinux radio policy.
So what must be replaced is layers ④ and ⑤; **layers ①–③ are kept as they are**.

### 3.2 Proposed startup chain

```
Boot
 └─ openrc
     ├─ sprdwl.ko → marlin_fm.ko (inherits the existing WiFi chain)
     ├─ logdw
     ├─ download (burns the combo firmware, including FM)        ← reuses the existing
     ├─ wcnd (power-up)                            ← reuses the existing
     ├─ bt_once(BT-OPEN) → bt_wake.sh           ← reuses the existing
     ├─ bt_user_daemon  /tmp/bt_ctl.sock        ← reuses the existing
     ├─ fm_radio_daemon /tmp/fm_ctl.sock        ← 【新增】replaces the whole Android middleware
     └─ lvgl_demo → radio page g_radio_page        ← 【新增】replaces the Android FM App
```

### 3.3 Correspondences on the Alpine side

| Android component | Alpine replacement | Notes |
|---|---|---|
| insmod + node permissions | inherits the existing WiFi chain; no extra action needed | `/dev/fm` is already available |
| BroadcastRadioService | **None** | replaces service-layer arbitration with single-instance mutual exclusion in the daemon |
| FM HAL (`libFMHalSource.so`) | **the audio thread inside `fm_radio_daemon`** | isomorphic logic: read PCM → buffer → output |
| JNI / `libfmjni.so` | **None** | a unix socket text protocol is used between the UI and the daemon |
| `libengfm.so`(`fm_runcommand`) | **implement the command encapsulation yourself** | the hint is to adopt the AT command style |
| RadioManager API | **socket text commands** | few commands, easy to debug, consistent with the Bluetooth daemon |
| AudioFlinger mixing/focus | **write the audio focus arbitration yourself** | must be done, otherwise FM/A2DP/local playback will cross-talk |
| FM App (APK) | **LVGL `radio_page`** | 720×1280 portrait screen, 31px line-height grid |

---

## 4. Stage-by-stage comparison table

| Stage | Android | Alpine (this device) | Key differences |
|---|---|---|---|
| **Firmware download** | download in init | download via openrc | basically the same; Alpine relies on the WiFi auto-start chain |
| **Power-up management** | wcnd manages uniformly | wcnd likewise | the same |
| **Driver loading** | insmod sprdwl → marlin_fm | the same (auto-loaded) | note that `marlin_fm` is depended on by `sprdwl` |
| **Device node** | `/dev/fm` (restricted access) | `/dev/fm` (misc 23) | under Alpine root connects directly, with no SELinux constraints |
| **Command interface** | HAL wraps ioctl/AT | the daemon sends directly | **the command numbers have been reverse-engineered** (`0xC004F500 \| nr`, 47 of them) |
| **Audio source** | `FMHalSource` + `FMHalThread` + RingBuffer | the daemon builds its own read thread | isomorphic architecture, simplified implementation |
| **Audio mixing** | AudioFlinger | **a focus arbitration must be built** | Android is backed by the framework; Alpine must write it itself |
| **RDS reporting** | `RadioMetadata` → App | socket text fields | the RDS parsing capability already exists in the driver; take it directly |
| **UI** | APK + full FM app | LVGL radio page | limited by MCU-class resources, designed lean for 720×1280 |
| **Multi-app contention** | service-layer arbitration | **single-daemon exclusive access + upper-layer arbitration** | simple but sufficient |
| **Command-line tools** | `amixer`/`tinymix`/`tinyplay` (bundled with Android) | **none of them** | you can only write C against libasound.so.2 |

---

## 5. Key principles (why this works)

1. **The combo chip sharing SDIO is the key constraint**:
   the firmware is burned once and power-up is managed uniformly, so **it is impossible to burn firmware for FM alone or power it up alone**.
   This is also the root cause of "if WiFi does not work, FM certainly does not work".

2. **The driver has already done all the complex RF/demodulation/RDS work**:
   user space does not need to implement any FM protocol; it only needs to operate according to the command set.
   Therefore, on the Alpine side it is feasible to replace Android's "whole HAL + service + JNI stack" with "a thin daemon".

3. **Audio is the only framework capability that must be added yourself**:
   Android has AudioFlinger for mixing and focus management; on the Alpine side nothing handles this,
   **three-way arbitration among FM / A2DP / local playback must be explicitly implemented**, otherwise users will certainly encounter cross-talk.

4. **The socket text protocol is a deliberate choice**:
   it stays consistent with the existing Bluetooth daemon (`/tmp/bt_ctl.sock`, `state`/`on`/`off`),
   and the team already has the mental model and the pitfall experience (especially "you must set a socket timeout, or the UI freezes").

---

## 6. One-line summary

> Android holds FM up with **a whole framework** (Service + HAL + JNI + AudioFlinger);
> on Alpine we keep the same **bottom three layers** (hardware/firmware/driver),
> use a single **`fm_radio_daemon`** to replace the middleware, use an **LVGL radio page** to replace the app,
> and **add ourselves the piece that Android's framework backs up — audio focus arbitration**.
> The only former uncertainty, the **ioctl command numbers**, has been removed (see "FM收音ioctl命令表_逆向还原"), and the whole chain can now run end to end.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
