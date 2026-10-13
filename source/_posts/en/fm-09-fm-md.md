---
title: "FM radio bring-up: work process summary"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-09-fm-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# Spreadtrum SC9832A FM radio bring-up — work process summary

> **Audience**: anyone who needs to understand "how this solution was arrived at" (including AI that takes over later)
> **Stage note**: this article records the **exploration and design stage of 2026-09-22**; it has not yet entered the implementation and **sound/ear verification** stage
> **Core value**: it records the basis for key judgments, which detours were taken, and **what was deliberately not done** — this has more reuse value than the "conclusions" themselves

---

## 1. Task background and initial goals

WiFi and Bluetooth have both been brought up (on the same combo chip), and now we need to **add an FM radio feature** to the same LVGL demo,
with a "classic radio app layout" covering three blocks: **entry and icon, page layout, and feature list**,
and produce a full set of Chinese documents following the document types of `AI工作流/02_蓝牙打通/docs`, placed under `03_收音机/docs`.

The initial understanding had only one input: **"this device's WiFi, Bluetooth, and FM are integrated on the same chip (SDIO enumeration 0x2331)"**.

---

## 2. Analysis framework: first split "can FM be done" into five layers

Instead of rushing to draw the interface, we first established a layered model for judging feasibility:

```
① 硬件：芯片是真的吗？        SDIO 0x2331 能枚举吗？
② 固件：FM 部分烧进去了吗？   要不要单独烧？
③ 驱动：有驱动吗？设备节点在吗？
④ daemon：有人管这个节点吗？  有没有现成工具？
⑤ UI：界面怎么画？
```

**The value of this layering**: it lets us judge before starting work whether "this is building a wheel from scratch or wiring out something that already exists" —
and the answer determines the nature of the whole project and the amount of work.

---

## 3. The assault process (by timeline)

### Phase A: confirming the hardware exists — only one SDIO device

```sh
cat /sys/bus/sdio/devices/*/modalias   # → sdio:c00v0000d2331
cat /sys/bus/sdio/devices/*/device     # → 0x2331
```

There is only **one** SDIO device on the bus, confirming the "three-in-one, sharing SDIO" claim.

### Phase B: a surprise discovery — the FM driver was loaded long ago

```sh
lsmod | grep marlin_fm
# → marlin_fm  17554  1 sprdwl
```

**This was the most important turning point of this round**: FM was originally thought to be a brand-new feature never touched before,
but it turned out the driver not only exists but is **depended on by the WiFi driver `sprdwl`** (meaning its loading is normal and automatic).

Immediately after:

```sh
ls -l /dev/fm            # → crw-rw---- 10, 23
grep -w fm /proc/misc    # → 23 fm
```

**The device node is already registered.**

> 💡 **By this point the conclusion had clearly changed**: this job is not "bringing up the FM chip", but "wiring out a feature that is already running".

### Phase C: fully mapping the driver's capabilities — inferring with strings + nm

Because the device has **no vendor source** (`/tmp/linux-3.10.65` is a vanilla tree), only symbol-level forensics could be used:

```sh
strings /lib/modules/marlin_fm.ko | grep -- '----'     # reconstruct the ioctl command name table
nm /lib/modules/marlin_fm.ko | grep ' T '              # reconstruct the function symbol table
strings /lib/modules/marlin_fm.ko | grep description=  # get the official description
```

Three commands obtained all the key facts:

1. **40+ command names** (TUNE/SEEK/SCAN/GETRSSI/MUTE/SETVOL/ANA_SWITCH/I2S_SETTING/OVER_BT_ENABLE/RDS_*)
2. **Complete RDS parsing functions** (`rds_get_ps` station name, `rds_get_rt` text, `rds_get_pty`, `rds_get_af` alternative frequency, `rds_get_ct`, `rds_get_ews` emergency broadcast…)
3. **Official description**: `SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI`

The last line is **decisive**: it turned "shares SDIO with WiFi/Bluetooth" from a speculation into the chip vendor's official statement,
directly supporting the later series of designs such as "firmware depends on WiFi, power-up depends on the existing chain, and auto-start must queue".

### Phase D: an additional clue — the AT command style

`parse_at_fm_cmd` / `parse_at_fm_num` were found in the driver; on the Android side, `libengfm.so` **exports only one symbol, `fm_runcommand`**.

The two echo each other, suggesting FM control may follow the **AT command style** (writing command strings to the node).
This clue later became the breakthrough: **the same set of constants exists as literals in `libfmjni.so`**,
providing independent cross-validation of the command number encoding (see §2.4 of "FM收音ioctl命令表_逆向还原" for details).

### Phase E: audio routing — finding the FM-dedicated PCM, and also finding there are no command-line tools

```sh
cat /proc/asound/pcm | grep -i fm
# → 01-04: Dfm sprd-codec-fm-4 : : playback 1
```

Confirmed the existence of an FM-dedicated PCM device (card 1 device 4, playback only).

But the same round discovered: **no `amixer` / `tinymix` / `aplay`**, only `libasound.so.2`.
→ **Conclusion: the audio path can only be operated by writing C code; it cannot be debugged from the command line. This significantly changed how the audio layer had to be worked on.**

At the same time, the symbols of `libFMHalSource.so` on the Android side (`pcmHandle` + `FMHalThread::threadLoop` + `RingBuffer`)
revealed Android's audio architecture: **start a thread to read from PCM → ring buffer → output**. Our own daemon must replicate the isomorphic logic.

### Phase F: confirming "there is no ready-made user space" (to avoid reinventing the wheel)

```sh
ls /usr/bin /usr/sbin /bin /sbin | grep -i 'fm\|radio'   # no output
find / -maxdepth 4 -name '*fm*' -type f                  # only .ko files and Android libraries
```

→ **We must write the daemon ourselves**. At the same time, confirmed that Android's FM libraries **cannot be used directly** (they depend on the Android runtime).

### Phase G: UI integration points — following the Bluetooth pattern

Read `launcher_page.c` / `bluetooth_page.c` / `lv_page_manager.h` and confirmed three things:

1. The desktop grid **order is determined by the `s_apps[]` array** (not by enum values), so inserting after the Bluetooth item automatically places it right after Bluetooth;
2. The page registration pattern is `lv_page_t g_xxx_page = { .onCreate, .onPause, .onDestroy, ... }`;
3. The page manager explicitly stipulates: **in `onDestroy` you must clear your own timers/callbacks, but do not delete `page->root`**.
   This directly determined the "background playback" design: neither `onPause` nor `onDestroy` **may** stop the station.

### Phase H: font constraints — an easy place to crash

The real metrics of `lv_font_cn_16` were found: **`line_height = 31px，base_line = 9px`** (nominally 16px).
The project history already includes rework caused by "hardcoding the line height at 16px, which clipped Chinese text".
→ **All y coordinates in this round were recomputed on the 31px grid**, and a red line was made explicit in the documentation (no "visual fine-tuning" back to a 16px grid).

---

## 4. Review of key decisions (why done this way)

| Decision | Reason |
|---|---|
| **Not rewriting the protocol stack, only a thin daemon** | the RF/demodulation/RDS are all done in the chip and the driver; user space only needs to send commands |
| **The daemon exposes a unix socket text protocol** | it mirrors the already-verified `bt_user_daemon` exactly, with zero extra cognitive cost for the team; and the socket timeout pitfall has already been hit |
| **Systematically mirror the Bluetooth daemon's socket path naming** (`/tmp/fm_ctl.sock`) | consistency first |
| **Channel arbitration listed as P0** | all three share the audio output; without it, cross-talk is inevitable and users will certainly hit it |
| **The UI uses RDS data** (PS station name / RT scrolling) | the driver capability already exists and is this solution's differentiator; not using it degrades the UI to "just numbers" |
| **All coordinates on the 31px line-height grid** | avoids this project's existing Chinese-clipping rework |
| **An extra interface specification document was added** | the reference directory has no UI-class document, but the core of this round's requirement is the UI, so a nonexistent template cannot be forced |
| **Explicitly listing the "unknowns"** | when key information is missing, writing "to be confirmed" has more engineering value than pretending to know; but **anything you can work out yourself should not be listed as unknown** |

---

## 5. Final outcomes and consolidation

### 5.1 Deliverables

7 documents under `AI工作流/03_收音机/docs/`:

| Document | Purpose |
|---|---|
| `FM收音机_LVGL界面设计与交互规格.md` | **Core**: entry icon / page layout / feature list (corresponding to requirements ①②③) |
| `FM收音打通_AI指导手册.md` | hard facts + execution flow + decision table, preventing repeated investigation |
| `FM收音芯片打通_操作手册.md` | step-by-step executable commands |
| `FM收音芯片打通_故障排查手册.md` | layered quick-reference table |
| `HT0FM收音原理与移植学习Wiki.md` | principles and migration methodology |
| `FM收音启动流程_安卓vsAlpine对比.md` | how Android does it vs how we do it |
| `FM收音拉起_部署交付文档.md` | artifact inventory and deployment steps |
| `FM收音打通_工作过程总结.md` | this article |

### 5.2 Consolidated hard facts (directly reusable)

- Marlin2 combo chip, `0x2331`, **WiFi/Bluetooth/FM share SDIO** (as evidenced by the vendor description);
- `marlin_fm.ko` is loaded and depended on by `sprdwl`, and `/dev/fm` = misc 23 is registered;
- complete ioctl command name inventory + complete RDS function inventory;
- FM-dedicated PCM: `01-04 Dfm sprd-codec-fm-4` (playback only);
- no ALSA command-line tools, only `libasound.so.2`;
- no ready-made FM user space, and the Android libraries cannot be reused directly;
- `lv_font_cn_16` line height 31px; the page's `onDestroy` must not delete root.

---

## 6. Lessons learned (reusable for other modules)

1. **Before starting work, first judge clearly whether "this is new construction or wiring out".**
   The single sentence "FM shares a chip with WiFi" actually hides the information that "FM may already be ready"; starting from scratch without investigation wastes a lot of work. This round, a single `lsmod` command reversed the nature of the whole project.

2. **No source does not mean no information.**
   Two cuts with `strings` + `nm` on the `.ko` reconstruct the command name table and function table. Compared with hunting for driver source everywhere (we confirmed the kernel tree on the device is vanilla, a wasted search), this trick is much faster and more reliable.

3. **The vendor's `description=` is the best evidence.**
   The single line `share SDIO with BT/WIFI` settled the entire design of resource mutual exclusion and dependencies. When looking for evidence, prioritize this kind of "words written by the author".

4. **Look for "ready-made tools" first, then decide whether to build.**
   We confirmed there was no FM user-space tool on the whole disk before deciding to write a daemon — avoiding reinventing the wheel; at the same time, we confirmed the Android libraries could not be used directly, avoiding a detour.

5. **Unavailable tools must be discovered early.**
   The absence of `amixer` was found during the planning stage; if it had only been discovered while debugging audio, the entire troubleshooting approach of "assuming the mixer can be driven from the command line" would have been void.

6. **List the unknowns explicitly — but distinguish "truly unknown" from "too lazy to check".**
   Six items were initially listed as "to be measured", of which the **ioctl command numbers** later proved to be **completely self-solvable**:
   the `.ko` is not stripped, and disassembly + measurement settles all of them.
   Lesson: **"ask the vendor for it" often just means the forensics path was not found**; it should not be written into the blockers so early.
   The remaining 5 items (headphone antenna, `OVER_BT_ENABLE` semantics, RSSI thresholds, etc.) are the ones that truly require on-device work.

7. **Respect existing patterns.**
   UI navigation uses `lv_start_activity`, the daemon uses a socket text protocol, pages use `lv_page_t` — all copied from existing successful solutions. The less "innovation" in a new module, the smaller the error surface.

---

## 7. Current status and next steps

**Completed**: the hardware/driver/audio/UI integration points are all mapped, and the design proposal and document family are produced.

**The original number one hard blocker has been removed**: **the ioctl command numbers have all been reverse-engineered and confirmed by measurement** (completed in an added phase).
The command names were known but the numbers were not. Recommended by priority:

1. ~~Ask the vendor for header files~~ → **no longer needed**: all 47 command numbers have been obtained by self-disassembling the `.ko` + measurement;
2. reverse-engineer from the Android-side `libengfm.so` / `libFMHalSource.so` (together with strace inside the chroot);
3. controlled single-step probing (locate by the `----<命令名>----` prints in `dmesg`).

With the command numbers in hand, proceed in the order of Step 3→6 of `FM收音芯片打通_操作手册.md`; **all other stages are unobstructed**.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
