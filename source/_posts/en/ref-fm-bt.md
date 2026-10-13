---
title: "ref_FM_Bluetooth_Hardware Acceleration"
date: 2026-09-23 20:16:57
lang: en
permalink: en/2026/09/23/ref-fm-bt/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 蓝牙
---


# Reference (Details) — FM Radio / Bluetooth A2DP / Hardware Acceleration

> Split out from `MEMORY.md §8~10` to avoid exceeding the main note's size limit. The conclusion-level summary remains in MEMORY.md.
> Original articles: `radio_docs/` (SEEK and field strength, ioctl command table, Bluetooth audio routing, power-up scripts, DMA survey),
> `outputs/FM收音机_进度快照_20260922.md`, `outputs/Mali400与硬件加速_勘察结论.md`

## A. FM Radio (application layer complete; **no solution for audio output**)

- **★★ Conclusion: the entire AP audio subsystem is dead**
  - `card0` capture `-5 EIO`; on the playback side, DMA never transfers after PCM start; DAPM `bias_level` is always Off (the codec has never been powered on)
  - Root cause: **sipc only exposes the LTE channel and has no audio DSP channel → AGDSP has no way to load**
  - FM audio ioctls (`OVER_BT_ENABLE`/`I2S_SETTING`/`ANA_SWITCH`/`GET_AUDIO_INFO`) are empty implementations in both this machine's `.ko` and the upstream `marlin2_fm`;
    the Bluetooth protocol stack has no FM
  - → **FM audio output over Bluetooth is not feasible in user space**; only kernel modifications remain (vendor source code required)
- **Power-up chain (key to FM usability)**: `01_wifi.start` → `bt_bringup.start` (wait 18s) → send `"wcn FM-OPEN"` to @wcnd
  and **keep the connection long-term** (abstract unix socket `sun_path[0]=0+"wcnd"`), otherwise `set_marlin_wakeup ack timeout`
- **Artifacts**:
  - `/usr/local/bin/fm_user_daemon` (holds the fd open permanently, because `close(/dev/fm)` blocks for ~4s)
  - At boot `/etc/local.d/zz_fm.start` → calls `/root/fm_powerup.sh` (pulls up the daemon + tops up power + pulls up `fm_watchdog`)
  - Control socket `/tmp/fm_ctl.sock`: `state|on|off|tune <kHz>|vol|mute|ana|rssi|chipid|rds`
- **★ `daemon running ≠ FM working`**: you must also send `on`(POWER_UP) for the RF to come up; **socket writes must use `MSG_NOSIGNAL` + ignore `SIGPIPE`**
  (otherwise a client disconnect triggers SIGPIPE and terminates the process); scripts disable `rssi` (it always times out at a fixed 4.2s)
- **★ Field strength and station scanning are both impossible (do not try again)**: `GETRSSI` always times out at a fixed 4.2s with `-ETIMEDOUT` and the returned value never changes; the `SEEK` driver only takes the low byte of the frequency →
  after TUNE to any frequency point, SEEK always returns 103.1 → **the UI must not have a "station scan" button**

## B. Bluetooth A2DP — "Connected" Must Be Judged by End-Point Evidence (fixed on 2026-09-23)

- **★ `conn` only indicates the ACL link, not that the connection is usable**; the UI must never treat `conn` as "connected"
- **★ The only user-space-visible A2DP truth = whether `/tmp/bt_audio.fifo` has a reader** (open the write end non-blocking: `ENXIO`=no reader=empty link) →
  landed as `bp_a2dp_ready()` in `lv_pages/bluetooth_page.c` (three states: link+audio=green / link only=orange / paired only=gray)
- **★ link key failure is a first-level investigation item for speaker-class devices**: delete the entry from `/tmp/bt_linkkey.conf` → truly restart the daemon → reconnect (via full SSP)
- **★ `openrc restart` does not replace the process**: to apply a state change you must do a true restart (kill -9 + sleep + setsid relaunch + sleep, and verify that the pid has changed)
- In-house `bt_user_daemon` (74KB, including A2DP Sink/Source); audio source `/tmp/bt_audio.fifo` (44100/2ch/S16_LE);
  paired device "Xiaoai Speaker-1303"

## C. Hardware Acceleration (details in `outputs/Mali400与硬件加速_勘察结论.md`)

- **Mali-400 is a 3D GPU, not a display controller**; display belongs to `sprdfb`→`/dev/fb0`; video hardware decoding is in the AP's **VSP**
- **Mali cannot be used on this machine**: `mali.ko` can be insmod'ed but the only DDK is bionic libraries, which musl cannot load; mesa has no `lima_dri.so`,
  `/dev/dri` does not exist → **the GPU cannot cure stuttering** (the stutter is CPU software decoding, `nproc=2`)
- **What should really be dug into**: VSP hardware decoding `/dev/sprd_vsp`, GSP 2D acceleration `/dev/sprd_gsp`+ION (hardware scaling + YUV→RGB, saving swscale)
- Video pre-transcoding parameters: 720x1280 + H.264 baseline + no B frames + ≤1Mbps + 24fps;
  mplayer is at `/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer` (not in PATH)

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
