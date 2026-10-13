---
title: "FM audio output: field-verified conclusions for the Bluetooth (A2DP) route"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-04-fm-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM audio output: field-verified conclusions for the Bluetooth (A2DP) route

- **Date**: 2026-09-23
- **Goal**: this device has no headphone jack, so digitize the FM audio and write it into `/tmp/bt_audio.fifo`, then deliver it to the Xiaoai speaker over Bluetooth A2DP
- **Conclusion**: **not feasible in user space**. All three sub-routes are proven dead by field tests, and **the root cause lies not in FM but in the fact that the entire AP audio subsystem never powers up**
- **Verification method**: everything was run by me on the device (the user asked me to "just verify it for me directly"); the evidence is in §3

---

## 1. Route breakdown

To get FM audio out of the Xiaoai speaker, two conditions must be met:

```
Condition A: obtain the FM PCM data (digitized)
Condition B: write the PCM into /tmp/bt_audio.fifo, and have bt_user_daemon send it out over A2DP
```

**Condition B is already working** (verified on the morning of 09-23: pushing 8.6MB of silent PCM kept the link up for 49s with the HCI credit continuously changing).
**Condition A is the dead end**; this article verifies it, along with its three candidate implementations.

| Route | Approach | Result |
|------|------|------|
| A1 | codec analog input (AIL/AIR) → read out the capture PCM | ❌ `readi` always returns `-5 (EIO)` |
| A2 | digital FM (`AD IISMUX=DIGFM`) → read out the capture PCM | ❌ same as above, and the results are identical whether it is configured or not |
| A3 | internal FM→BT passthrough in the combo chip (the "route b" chosen by the user) | ❌ see §3.4: neither the driver nor the protocol stack has this capability |

---

## 2. Tools newly written/rebuilt in this round

| Tool | Purpose |
|------|------|
| `ssh_tools/fm_cap_scan.c` → `/root/fm_cap_scan` | scans all capture devices × sample rates × channels in one pass and reports `nonzero / rms / peak` |
| `ssh_tools/fm_play_probe.c` → `/root/fm_play_probe` | scans playback the same way to determine whether the DMA actually moves at all |
| `ssh_tools/fm_hold.c` → `/root/fm_hold` | keeps a playback PCM in the running state, used to trigger DAPM power-up |

**★ Build pitfall (must remember)**: this device has **no ALSA headers** (`/usr/include/alsa` does not exist),
so `#include <alsa/asoundlib.h>` does not compile at all. You must follow the pattern of `fm_ctl.c` and use `dlopen("libasound.so.2")`
to fetch the symbols; the command is `gcc -O2 -o xxx xxx.c -ldl -lm` (**not** `-lasound`).
I hit this once when writing `fm_pcm.c`; all three tools this time use the dlopen approach.

**★ Second pitfall**: playback must be opened in **non-blocking** mode. The first time I ran the matrix in blocking mode, `writei`
on `hw:1,4` hung forever, the whole matrix was dragged into a timeout by the very first combination, and no data was obtained at all.

---

## 3. Field evidence

### 3.1 All capture PCMs return EIO (identical before and after configuring the controls)

Without any control configured, with the digital FM path configured, and with the line-in path configured, `fm_cap_scan` gives **exactly the same** results in all three cases:

```
hw:1,0  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,1  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,2  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,3  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
plughw:1,0 ...   same as above
(44100 / 16000 / 8000, 1ch / 2ch all behave the same way)
```

**Key control**: `card0` is `i2s.X null-codec-dai` (an empty codec with nothing to do with FM),
and its capture **likewise returns `-5 EIO`**.

> This refutes the claim that "FM audio cannot enter the host" —
> the problem is not FM; **the entire AP audio capture path is not working**.

### 3.2 Playback side: the DMA starts once and then stops, and the hardware pointer does not advance

`fm_play_probe` (non-blocking) results:

```
hw:1,4  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
hw:1,0  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
hw:1,1  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
```

Reading these results matters: **`frames=9600` shows that `writei` succeeded at first** (9600 frames = a 200ms buffer,
which exactly fills the whole ring buffer); only afterwards does it return `-11 (EAGAIN)`.

That is: the PCM started and the data entered the ring buffer, but **the DMA never transfers anything and the hardware pointer does not advance**.
This and the EIO on the capture side are two faces of the same root cause.

### 3.3 DAPM never powers up (the decisive evidence)

Use `fm_hold` to keep `hw:1,4` running, and at the same time configure the full path according to the vendor's `tiny_hw.xml`:

```
Digital FM Function=1  DA0 ADDST MUX=0  DA1 ADDST MUX=0
AD IISMUX=2            AD23 IISMUX=1
Speaker Function=1     SPKL Mixer DACLSPKL=1  SPKR Mixer DACRSPKR=1
```

Then check DAPM:

```
$ cat /sys/kernel/debug/asoc/sprdphone/sprd-codec.34/dapm/bias_level
Off

$ dapm_dump.sh | sed -n '/汇总/,$p'
----- 汇总 -----          ← empty, not a single widget is On

DFM-OUT                 Off  in=1  out=0     ← the link is "connected"
DFM-Output               Off  in=1  out=0
ADie Digital DACL Switch Off  in=1  out=0
Analog Power             Off  in=0  out=0    ← the analog power is not on
DA Clk                   Off  in=0  out=0    ← the clock is not on
AD Clk                   Off  in=0  out=0
```

**This is the hardest piece of evidence**: `in=1` shows that DAPM's **connection relationships** are established
(consistent with the earlier observation that "the route is connected"),
but `bias_level=Off` and every widget is Off — **the codec was never powered up from beginning to end**.
Without power-up, the DAC makes no sound, the ADC does not sample, and capture naturally returns EIO.

### 3.4 The Bluetooth passthrough (route b) is dead as well

- **Driver side**: in `marlin_fm.ko`, `OVER_BT_ENABLE(0x1d)` / `ANA_SWITCH(0x1e)` /
  `I2S_SETTING(0x21)` / `GET_AUDIO_INFO(0x30)` are all empty shells (entering the case only printks the name).
  The harder evidence is the upstream same-origin driver (the 2017 Spreadtrum `marlin2_fm` patch on LKML), where these cases are written as
  `ret = 0; break;` — **Spreadtrum never implemented them**; it is not that our version was trimmed down.
- **Protocol stack side**: `strings /usr/local/bin/bt_user_daemon | grep -i 'fm'` finds **not a single FM-related string**,
  only `[TX] opcode=0x%04x ...`. The in-house protocol stack does not know about FM and has no FM passthrough entry point.
- **There is no way to bypass the driver either**: in dmesg you can see the kernel itself issuing `mdbg_proc->write_buf:at+loopcheck`,
  but `/dev/mdbg*` **does not exist**; that is an internal kernel channel unreachable from user space.
  `write(/dev/fm, "at+fm=...")` always returns `EINVAL`.

### 3.5 Assumptions ruled out along the way

| Assumption | Investigation result |
|------|----------|
| Missing `audio_para` leads to incomplete codec initialization | The Android partition contains `/etc/audio_para` (485KB), but all codec kcontrols registered normally (120 of them), which shows the probe succeeded and the parameters are not missing |
| AGDSP firmware is not loaded | **sipc exposes only `spipe_lte0~14` (LTE modem channels)** and no audio DSP channel at all; sysfs contains only `saudio_lte.0` / `saudio_voip.1` (both shared-memory audio for LTE/voip), **with no saudio channel for the AGDSP**. Even if the firmware exists, there is no way to load it |
| The firmware contains hidden FM audio routing AT commands | The wcnmodem partition dump contains only a few strings such as `marlin_fm_ctrl.c`, `Handle_FM_RX_CMD_ENABLE`, `fm_cfg 0x%x,%x,%x`, and `marlin_fm_seek_*`; there is no `at+fm` command family and no `over_bt`-related strings |

---

## 4. Root cause analysis

```
sipc on the kernel side has no audio DSP channel (LTE only)
   → the AGDSP cannot be loaded / cannot communicate
   → the power and clocks that the codec driver's set_bias_level depends on never come up
   → DAPM bias_level stays Off, and Analog Power / DA Clk / AD Clk are all Off
   → the DAC makes no sound, the ADC does not sample, the DMA never transfers
   → playback returns EAGAIN, capture returns EIO, and FM cannot obtain PCM
```

**So: this is not "FM audio was not wired in", but "this machine's entire audio subsystem is dead under Alpine".**
This also explains all the earlier observations of "the route is connected but there is still no sound".

## 5. Conclusions and remaining options

**User space (current kernel)**: getting FM audio out over Bluetooth — **not feasible**; all three sub-routes have been proven dead by field tests.

The only remaining path to make it work is **modifying the kernel** (the original plan a), and it involves more than expected:

1. Add the AGDSP audio channel to the device tree / sipc configuration (currently only LTE channels exist);
2. Get the AGDSP firmware loaded (first confirm which partition holds the firmware; currently `/proc/partitions` has no explicitly named dsp partition);
3. Determine exactly where the codec's `set_bias_level` gets stuck (you can use `dynamic_debug` to enable the sprd-codec
   `dapm` / `bias` prints to locate it).

All three require the **kernel source** (this machine's `/tmp/linux-3.10.65` is a vanilla tree that does not contain vendor code),
and after rebuilding the kernel you must be able to flash the device. **Please confirm whether you have the vendor kernel source tree**; without it, this path cannot proceed either.

**A fallback that can be done immediately and needs no kernel**: keep the FM feature demonstrable in the UI (tuning, RDS, and a replacement interaction for station seeking),
and honestly mark the audio output part as "this device's audio subsystem is unavailable".

## 6. On-device state (left on the device after verification)

- The controls are currently configured for the "digital FM + speaker output" state (`Digital FM Function=1`, `AD IISMUX=2`,
  `Speaker Function=1`, `SPKL Mixer DACLSPKL=1`, `SPKR Mixer DACRSPKR=1`)
- The FM daemon is powered up, TUNE is at 97.4MHz, and `mute=0`
- `/root/fm_hold` may still be holding `hw:1,4` in the background (it exits on its own after at most 170s).
  To run `fm_cap_scan` / `fm_play_probe` again, first `kill` it, otherwise you will get `Resource busy`
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
