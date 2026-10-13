---
title: "FM audio output: the vendor's official audio path and practical steps"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-02-fm-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM audio output: the vendor's official audio path (2026-09-23)

> Background: this device's FM is "connected at the application layer" (TUNE / RDS / volume are all there), but there is **no sound**.
> The previous conclusion was "FM audio is not feasible in user space", on the grounds that: the card1 DAPM route is incomplete, all 8 captures return EIO,
> and `codec_reg` is an empty file.
> This round **overturns half of that conclusion**: FM audio does not have to rely on the few audio ioctls in `marlin_fm.ko` —
> **the vendor actually wrote the FM audio path into the Android partition's configuration files**, and
> **all these kcontrols exist on this device's card1**.
> The reason it did not come out before is that nobody ever configured it according to that configuration.
>
> Status: **pending your manual verification on the device** (I will not run the verification again). This document gives the control names, order, commands, and troubleshooting points.

---

## 1. Conclusions first

| Item | Conclusion |
|---|---|
| `OVER_BT_ENABLE(0x1d)` / `I2S_SETTING(0x21)` / `ANA_SWITCH(0x1e)` / `GET_AUDIO_INFO(0x30)` | these are **empty shells** in this device's `marlin_fm.ko`: `fm_ioctl` enters the case, printks one line with the name, and returns, sending no SDIO commands at all (confirmed by disassembly). **Stop hoping to switch the audio path with FM ioctls**. |
| Upstream open-source driver (the same `marlin2_fm`) | likewise writes these cases as `ret = 0; break;` — **the vendor never implemented them on this chain**. This is the authoritative evidence that the `OVER_BT_ENABLE` path is dead. |
| **Where the real path is** | on the **AP codec side**; the vendor gave the full definition in the Android system partition's `/etc/tiny_hw.xml`. The audio coming out of the FM chip (digital DIGFM or analog AIL/AIR line-in) → codec → SPK/headphones, **the AP does not need to move the audio data**. |
| Whether this device has it | **It does**. In card1 (`sprdphone`), controls like `Digital FM Function`, `AD IISMUX` (enum includes `DIGFM`), `Line Function`, `ADCL/ADCR Mixer AILADCL/AIRADCR`, `SPKL Mixer ADCLSPKL`, `HPL Mixer ADCRHPL` **all exist**. |
| Why it did not come out before | previously only `Speaker Function` was set (connecting DACL→EAR), **without setting any control on the FM side**, and **without opening `hw:1,4`(`Dfm`) PCM to trigger DAPM power-up**. Neither was done, so naturally there was no sound. |

---

## 2. The vendor's official path definition (verbatim)

Source: the device's Android system partition `/etc/tiny_hw.xml` (read-only mounted at `/mnt/android_sys`).

### 2.1 Digital FM — `<device name="digital-fm">`

```xml
<device name="digital-fm">
  <path name="on">
     <ctl name="Digital FM Function" val="1" />
     <ctl name="DA0 ADDST MUX" val="0" />
     <ctl name="DA1 ADDST MUX" val="0" />
     <ctl name="AD IISMUX" val="2" />        <!-- 2 = DIGFM -->
  </path>
  <path name="off">
     <ctl name="Digital FM Function" val="0" />
     <ctl name="DA0 ADDST MUX" val="0" />
     <ctl name="DA1 ADDST MUX" val="0" />
     <ctl name="DA0 ADDFM MUX" val="0" />
     <ctl name="DA1 ADDFM MUX" val="0" />
     <ctl name="AD IISMUX" val="0" />
  </path>
</device>
```

`AD IISMUX`'s enum options (measured on this device's card1):
`[0]=AUDIIS0  [1]=DIGFM  [2]=EXTDIGFM  [3]=EXTIIS6  [4]=AUDIIS1`

⚠️ **Note**: the enum order dumped on this device is `(AUDIIS0/DIGFM/EXTDIGFM/EXTIIS6/AUDIIS1)`,
in which `val="2"` falls on **EXTDIGFM** rather than DIGFM. The XML was written for another kernel/codec version,
**so both values must be tried** (recommended: 2 first, then 1). This is the value in this plan most likely to need on-site tuning.

### 2.2 Analog FM (line-in → codec loop)

```xml
<device name="line">                      <!-- 模拟输入侧 -->
  <path name="on">
     <ctl name="HeadPhone Mute" val="1" />      <!-- 先 mute，防 pop -->
     <ctl name="ADCL Mixer AILADCL Switch" val="1" />
     <ctl name="ADCR Mixer AIRADCR Switch" val="1" />
     <ctl name="Line Function" val="1" />
     <ctl name="HeadPhone Mute" val="0" />      <!-- 再放开 -->
  </path>
  <path name="off">
     <ctl name="Line Function" val="0" />
     <ctl name="ADCL Mixer AILADCL Switch" val="0" />
     <ctl name="ADCR Mixer AIRADCR Switch" val="0" />
  </path>
</device>

<device name="line-speaker">              <!-- 模拟 → 扬声器 -->
  <path name="on">
     <ctl name="SPKL Mixer ADCLSPKL Switch" val="1" />
     <ctl name="SPKL Mixer ADCRSPKL Switch" val="1" />
  </path>
</device>

<device name="line-headphone">            <!-- 模拟 → 耳机 -->
  <path name="on">
     <ctl name="HPL Mixer ADCRHPL Switch" val="1" />
     <ctl name="HPR Mixer ADCLHPR Switch" val="1" />
  </path>
</device>
```

### 2.3 Output side (digital FM needs one configured too)

```xml
<device name="speaker">
  <path name="on">
     <ctl name="SPKL Mixer DACLSPKL Switch" val="1" />
     <ctl name="SPKL Mixer DACRSPKL Switch" val="1" />
     <ctl name="Speaker Function" val="1" />
  </path>
</device>

<device name="headphone">
  <path name="on">
     <ctl name="HPL Mixer DACLHPL Switch" val="1" />
     <ctl name="HPR Mixer DACRHPR Switch" val="1" />
     <ctl name="HeadPhone Function" val="1" />
  </path>
</device>
```

Reference: public analysis of the same SoC on the SC9832A platform confirms that FM audio enters the
codec from **AIL/AIR** (a MIC-like line-in), then either outputs directly via the "FM playback patch" or goes through VBC for the main control to record — fully consistent with the configuration file above.

---

## 3. How you run it (manual verification steps)

### 3.0 Preparation

1. Bring up the FM power-up chain first: WiFi firmware download → `bt_bringup.start` (including wcn BT-OPEN) → send `wcn FM-OPEN` to `@wcnd`
   and **keep the connection long-term**.
2. `fm_user_daemon` keeps `/dev/fm` open (socket `/tmp/fm_ctl.sock`); TUNE to a local strong-signal station.
3. Execute `mute 0` via `/tmp/fm_ctl.sock` to confirm FM is not muted (for the socket command syntax, see
   `AI工作流/*/docs/` and `lv_pages/radio_page.c`).
4. Without `amixer`/`tinymix`, use the existing `/root/fm_ctl`: `fm_ctl <op> <card> ...`

### 3.1 First confirm the controls' real names (very important)

The names dumped earlier **do not necessarily equal the full ALSA names** (for example, the dump has `ADCL Mixer AILADCL`,
while the XML has `ADCL Mixer AILADCL Switch`). Grep once to get the real names:

```sh
/root/fm_ctl grep card1 AIL
/root/fm_ctl grep card1 IISMUX
/root/fm_ctl grep card1 "Digital FM"
/root/fm_ctl grep card1 SPKL
/root/fm_ctl grep card1 Function
```

### 3.2 Plan A: digital FM → speaker (recommended to try first)

```sh
# 1) 输出侧 speaker（先铺好输出）
/root/fm_ctl set card1 "Speaker Function" 1
/root/fm_ctl set card1 "SPKL Mixer DACLSPKL Switch" 1
/root/fm_ctl set card1 "SPKL Mixer DACRSPKL Switch" 1

# 2) 数字 FM 通路
/root/fm_ctl set card1 "Digital FM Function" 1
/root/fm_ctl set card1 "DA0 ADDST MUX" 0
/root/fm_ctl set card1 "DA1 ADDST MUX" 0
/root/fm_ctl set card1 "AD IISMUX" 2        # 无声再试 1 / 3

# 3) 打开 FM PCM 触发 DAPM 上电（关键！本机 card1 的 01-04 就是 Dfm）
#    编译：gcc -O2 -o /root/fm_pcm fm_pcm.c -lasound
/root/fm_pcm "hw:1,4" 60 &                  # 保持写 60 秒
```

> **Step 3 is the easiest one to miss**: the reason the `Dfm` PCM device exists is to "open the stream and pull DAPM up";
> setting only the kcontrols without the stream coming up leaves `bias_level` stuck at `Off` (exactly the previously observed phenomenon).

### 3.3 Plan B: analog line-in → speaker / headphones

```sh
/root/fm_ctl set card1 "Line Function" 1
/root/fm_ctl set card1 "ADCL Mixer AILADCL Switch" 1
/root/fm_ctl set card1 "ADCR Mixer AIRADCR Switch" 1

# 出到扬声器
/root/fm_ctl set card1 "SPKL Mixer ADCLSPKL Switch" 1
/root/fm_ctl set card1 "SPKL Mixer ADCRSPKL Switch" 1

# 或出到耳机
/root/fm_ctl set card1 "HPL Mixer ADCRHPL Switch" 1
/root/fm_ctl set card1 "HPR Mixer ADCLHPR Switch" 1
/root/fm_ctl set card1 "HeadPhone Function" 1
```

### 3.4 Off / reset

```sh
/root/fm_ctl set card1 "Digital FM Function" 0
/root/fm_ctl set card1 "AD IISMUX" 0
/root/fm_ctl set card1 "Line Function" 0
/root/fm_ctl set card1 "Speaker Function" 0
```

---

## 4. Troubleshooting points

| Phenomenon | Possible cause | Handling |
|---|---|---|
| Completely silent, `bias_level` still Off | `hw:1,4` not opened/written | confirm the `fm_pcm` process is running and `writei` has not returned an error |
| Audible but very quiet / distorted | going through the line-in analog path, with gain unconfigured | keep only one route (two open at once interfere with each other), and try another `AD IISMUX` value |
| `AD IISMUX` cannot be set | different enum value range | first `fm_ctl get card1 "AD IISMUX"` to see the allowed value range |
| Headphones required | the FM antenna may be on the headphone line | try TUNE to the strongest station without headphones; if they must be plugged in, the UI needs a prompt |
| Digital FM never works | this device's firmware may not have connected the FM digital port to VBC | fall back to plan B (analog line-in), which has the most complete route |

Following the "end-to-end evidence" principle: **the criterion is the human ear hearing the station audio**, not the ioctl returning 0.

---

## 5. Pending confirmation checklist (to be backfilled after verification)

- [ ] The correct value of `AD IISMUX` (which of 1 / 2 / 3 is `DIGFM`)
- [ ] Which of digital FM and analog line-in actually works on this device
- [ ] Whether headphones are needed as an antenna
- [ ] Whether volume is controlled by `SETVOL`(0x04) or by the codec's pga (the `digital-fm` profile in `codec_pga.xml` uses `VBC STL DG Set` / `VBC STR DG Set`)
- [ ] The crosstalk situation when FM and A2DP are on at the same time (determines how channel arbitration should be written)

---

## 6. Appendix: evidence sources

| File | Content |
|---|---|
| `/mnt/android_sys/etc/tiny_hw.xml` | the vendor's full mixer path definitions (the verbatim source of §2 in this article) |
| `/mnt/android_sys/etc/codec_pga.xml` | `digital-fm` profile → `VBC STL DG Set`(bit 0) / `VBC STR DG Set`(bit 16) |
| `radio_docs/mixer_card1.txt` | the full kcontrol dump of this device's card1 (confirming the controls exist) |
| LKML `[PATCH 2/2] misc: added Spreadtrum's radio driver` (Chunyan Zhang, 2017) | the driver's upstream source: the full `FM_IOCTL_*` table, the chip-side `FM_*_CMD` numbering, and the empty implementations of the I2S/AudioInfo cases |
| Public analysis《Sprd 9832A Android6.0 FM 模式下的几种 Audio 路径》 | AIL/AIR input, the signal flow of the three modes (Line_in-Codec / Line_in-VBC-Codec / Digital FM-VBC-Codec) |

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
