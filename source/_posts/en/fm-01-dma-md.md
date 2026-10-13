---
title: "DMA support and feasibility survey of porting from Android"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-01-dma-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# DMA support status & feasibility survey of porting from Android

- **Date**: 2026-09-23
- **Question**: does this device's DMA actually support it? Can the Android audio stack be ported over?
- **Conclusion**: **the DMA hardware and driver are both present, but there is nothing portable at the kernel layer (Alpine runs the factory Android kernel)**; everything portable in user space has been tried, all ineffective. The blockage has been localized to **all 12 audio power domains being disabled and the codec's digital registers reading back as all 0**.

---

## 1. First correct a premise: Alpine runs the factory Android kernel

```
$ uname -a
Linux spd-box 3.10.65 #13 SMP PREEMPT Fri Apr 27 13:23:49 CST 2018 armv7l Linux

$ cat /proc/cmdline
... androidboot.hardware=sc9832 lcd_id=ID9881 ... androidboot.mode=charger
```

The kernel version, build time, and `androidboot.hardware=sc9832` all point to the **vendor's factory kernel**,
and the boot partition `mmcblk0p16` starts with the standard `ANDROID!` boot.img magic number.

> So the direction of "porting drivers from Android" **does not hold** — the drivers are already in this kernel, and they are all **builtin**
> (on the Android side, `/mnt/android_sys/lib/modules/` contains only `sprdwl.ko / marlin_fm.ko / mali.ko /
> `gator.ko / autotst.ko / mmc_test.ko`, with **no audio modules at all**).

## 2. DMA support status: both hardware and driver are present

| Item | Status |
|----|------|
| `/sys/class/dma` | **does not exist** — but this is normal: sprd uses its own DMA driver and **does not go through the kernel dmaengine framework** |
| `0.dma-controller` / `0.dmac` | present (platform device) |
| `sprd_dma_copy.27` | present |
| `i2s.38 / .39 / .40 / .41` | present |
| `sprd-pcm-audio.42`, `sprd-codec.34` | present |
| `vbc-r2p0.36`, `vaudio.37`, `saudio_lte.0`, `saudio_voip.1` | present |
| `sprd-audio-power.1 ~ .12` | 12 audio power domains, each with a `regulator` subdirectory |
| regulator framework / `sc2723-regulator` | normal, 38 regulators in total |

**Conclusion: DMA is neither missing a driver nor missing hardware.**

## 3. What was ported from Android, and the results

| Portable item | Source | Result |
|--------|------|------|
| **`audio_para`** | `/mnt/android_sys/etc/audio_para` (485KB), with `/etc/audio_para` and `/data/local/media/audio_para` explicitly in the HAL strings | ❌ **ineffective**. Already placed in `/etc/audio_para` + `/lib/firmware/audio_para` and **rebooted**, yet the codec's digital registers **still read all 0** |
| **Audio HAL** | `/mnt/android_sys/lib/hw/audio.primary.sc8830.so` | ❌ it is a **bionic** dynamic library, while this device is musl, **so it cannot run**. However, the control sequences inside it were reconstructed and measured earlier (see §5) |
| **tinyplay / tinycap / tinymix** | `/mnt/android_sys/bin/` | ❌ also bionic binaries. Equivalent functionality has been covered by self-written tools (`fm_cap_scan` / `fm_play_probe`) |
| **VBC path** | the HAL uses `/dev/vbpipe6` and `/dev/pipe/mmi.audio.ctrl` | ❌ **neither `/dev/vbpipe*` nor `/dev/pipe` exists on this device** |
| **AGDSP / audio DSP** | — | ❌ **sipc only has `sipc-lte`(dst 0x5) and `sipc-pmsys`(dst 0x6)**, **with no audio DSP channel at all**; under `/sys/kernel/debug/sipc/` there are sblock/sbuf/seblock/sipx/smem/smsg, but the smsg channel list contains only lte/pmsys |

## 4. Blockage localization (the most important discovery this round)

### 4.1 The codec's digital registers read back as all 0

`/proc/asound/sprdphone/sprd-codec` can dump the registers directly:

```
sprd-codec.34 digital part
0x0000 | 0x0000 0x0000 0x0000 0x0000      ← 全 0
0x0010 | 0x0000 0x0000 0x0000 0x0000
0x0020 | 0x0000 0x0000 0x0000 0x0000
0x0030 | 0x0000 0x0000 0x0000 0x0000
sprd-codec.34 analog part
0x0000 | 0x0010 0x0081 0xb400 0x6d3c      ← 模拟部分有正常值
0x0010 | 0x1070 0xa000 0x0000 0x0000
```

The analog part (via the SC2723's ADI bus) is normal, while **the digital part is empty**.
After placing `audio_para` + rebooting it is **still all 0**.

### 4.2 All 12 audio power domains are unused

```
sprd-audio-power.1 → regulator.26 = SRG_VREG      num_users=0
regulator.27 SRG_VB        regulator.28 SRG_BG
regulator.29 SRG_BG_IBIAS  regulator.30 SRG_VCOM
regulator.31 SRG_VCOM_BUF  regulator.32 SRG_VBO
regulator.33 SRG_VMICBIAS  regulator.34 SRG_MICBIAS
regulator.35 SRG_AUXMICBIAS regulator.36 SRG_HEADMICBIAS ...
```

All are **disabled, users=0**. The Off widgets in DAPM like `Analog Power / DA Clk / AD Clk`
correspond to these power domains.

**Under `/sys/class/regulator/regulator.X/` there are only `device name num_users power subsystem
suspend_* type uevent`, with no writable `state`** → **user space cannot force enable**, and it must be done by the kernel's DAPM.

### 4.3 Complete causal chain

```
sipc 无 audio DSP 通道 → VBC/AGDSP 类通路不可用（/dev/vbpipe 也不存在）
                       ↓
DAPM 需要 enable 的 12 个 SRG_* 电源域全部 disabled (users=0)
                       ↓
codec 数字部分上不了电 → 数字寄存器读写不到（全 0）
                       ↓
bias_level 永远 Off，DAPM 不 power up
                       ↓
i2s / DMA 不搬运 → 播放 writei 写一个 buffer 就 EAGAIN、采集 readi 直接 EIO
```

## 5. Actions already tried; do not repeat them

- Configured the complete `digital-fm` + `speaker` path per the vendor's `tiny_hw.xml`, and used `fm_hold` to keep `hw:1,4` running
  → `bias_level` still Off, ON widget count 0
- Placed `audio_para` in `/etc` and `/lib/firmware` and rebooted → ineffective
- `unbind/bind` to re-probe `sprd-codec.34` → **bind failed, the codec became `(null)`**,
  recoverable only by reboot. **Do not unbind `sprd-codec.34` again**; it breaks the audio subsystem

## 6. What can still be done

1. **The vendor's kernel source is needed to continue**: investigate why `sprd-codec`'s probe / `set_bias_level` did not pull bias to
   STANDBY, and why the digital registers are inaccessible. The local `/tmp/linux-3.10.65` is a vanilla tree without vendor code.
2. Second best: use `dynamic_debug` to enable `sprd-codec` / `snd_soc`'s dapm and bias related prints,
   which shows the DAPM decision process (some information can be obtained without the source).
3. **Not recommended** direction: continuing to tune kcontrols in user space — with the power domains unable to enable, no control setting helps.

## 7. On-site state (after the survey)

- The device has rebooted once and everything is normal: `lvgl_demo` / `bt_user_daemon`(1177) / `fm_user_daemon`(1228) / `lvgl_watchdog` are all running
- `/etc/audio_para` and `/lib/firmware/audio_para` are deployed (measured ineffective; harmless to keep)
- After the reboot the kcontrols have returned to their default values (the previously configured digital-fm / speaker combination has been cleared)
- New tools: `/root/fm_cap_scan` (capture matrix scan), `/root/fm_play_probe` (playback matrix, non-blocking),
  `/root/fm_hold` (keeps PCM running)

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
