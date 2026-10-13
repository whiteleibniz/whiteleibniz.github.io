---
title: "FM Radio_Progress Snapshot_20260922"
date: 2026-09-22 23:28:06
lang: en
permalink: en/2026/09/22/fm-progress/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM Radio — Progress Snapshot (2026-09-22)

> Scope: Unisoc SC9832A / Alpine Linux / armv7l / 720×1280 portrait screen / LVGL 9.6.0
> This article only covers **exactly how far the implementation has gone**: what can run, what has been accepted, what has been disproved by measurement, and what remains.

---

## I. Conclusion in One Sentence

**The FM application layer is complete and working: daemon + radio page + desktop entry + boot autostart, with the entire chain reproducible and acceptable via screenshots.**
**The only thing that cannot be solved in user space is "making sound"** — FM audio flows in hardware only to the FM chip's own analog output,
entering neither the system codec nor the host capture, so it **can neither be played through the speaker nor digitized and fed to Bluetooth**.

---

## II. Completed and Accepted (All Measured on the Device)

### 2.1 FM Daemon — 100% Complete (Commands Available on This Device)

`/usr/local/bin/fm_user_daemon` (19784 B) on the device, with boot autostart, single instance, and resident operation.

| Capability | Implementation | Measured result |
|---|---|---|
| Open the FM channel | Connect to abstract unix socket `@wcnd` → send `wcn FM-OPEN` → **keep the connection long-term** | `wcn FM-OPEN -> WCNBTWIFI-CMD OK` |
| `/dev/fm` handle | **Kept open, never closed** (close triggers `fm_release` → sends `at+fm=12`, blocking for ~4 s) | Held at all times |
| Channel self-healing | A 5 s watchdog period; the channel is automatically reopened when it drops | Implemented |
| Control protocol | unix socket `/tmp/fm_ctl.sock`, plain-text single-line commands | See the table below |
| Command timeout protection | `SO_SNDTIMEO/SO_RCVTIMEO`, with replies written using `MSG_NOSIGNAL` + ignoring `SIGPIPE` | Fixed (see §3.3) |

**Protocol and measured receipts**:

```
state          -> OK off freq=97400 vol=5 mute=0 chipid=0x2341 rds=1
chipid         -> OK chipid 0x2341
rds            -> OK rds 1
on / off       -> OK on / OK off
tune 97400     -> OK tune 97400
vol 12         -> OK vol 12
mute 0         -> OK mute 0
ana 1          -> OK ana 1
rssi           -> OK rssi 123 rc=-1        ← 见 §4.2，此值不可用
```

`chipid=0x2341` and `rds=1` are values genuinely read back from the chip, proving that the entire SDIO channel is alive.

### 2.2 LVGL Radio Page — 100% Complete (All 8 Zones Render Correctly)

`lv_pages/radio_page.c` (34287 B) on the device. **It has passed manual zone-by-zone proofreading using screenshots.**

```
┌─ A 标题栏   返回 | 收音机 | 开/关 | 状态文字（收听中 / 已关闭）
├─ B 信息条   FM 87.5-108.0 MHz  100 kHz  RDS 可用  芯片 2341
├─ C 当前频点 97.4 MHz（montserrat_48）+ 台名行（无台名/RDS 未解析）
├─ D 刻度尺   88 92 96 100 104 108 六个标签 + 5 个收藏红方块 + 当前频点指针
├─ E 信号     条形图 + 「原始 N」 + 「正在收听 当前 97.4 MHz」
├─ F 控制区   -0.1 | ◀◀ | 静音 | ▶▶ | +0.1
├─ G 收藏列表 收藏频道 (5/16) + 收藏当前 + 每项「删除」
└─ H 音量     音量 12/15 滑块 + 音频通路状态 + 切换音频通路
```

**Key engineering points (all pitfalls encountered and already fixed)**:

1. **The UI thread must never do socket I/O** — a dedicated IO thread `rp_io_worker()` runs blocking commands,
   while the LVGL timer `rp_poll_cb()` (700 ms) only does a locked memcpy + control refresh.
   Reason: a single `rssi` call takes 4 s, and calling it directly on the UI thread would freeze the interface.
2. **The ruler width must not be queried from LVGL** — `lv_obj_get_width()` returns the cached `coords` (= 0) during the `onCreate` stage,
   and after being defaulted to 10, all ticks are squeezed to the far left. This was changed to a self-cached width `rp_ruler_width()` + a fallback value.
3. **The ruler pointer must not be attached under a parent object that will be cleaned** — it was originally attached under `marks`,
   and the `lv_obj_clean(marks)` in `rebuild()` would delete the pointer along with it. It was reattached under `card`.
4. **Inset the two ends of the scale** — full-width mapping pushes the `108` label and the `87.5` red square out of the visible area.
5. **Lifecycle**: `onPause` **only stops UI polling and never stops FM** (returning to the desktop must continue playback);
   `onDestroy` only clears its own handles and **does not delete root** (it is deleted uniformly by the page manager).

### 2.3 Page Entry / Return — Closed-Loop Acceptance Achieved This Round

```
桌面（焦点在「收音机」）── ENTER ──▶ 收音机页 ✅
收音机页 ── 返回键(ESC) ──▶ 桌面，焦点框自动回到「收音机」✅
（期间 daemon 状态不变，FM 未被打断）✅
```

Screenshots: `shots/re_0.png` (desktop, focus box on the radio), `shots/re_1.png` (radio page),
`shots/re_on.png` (radio page after FM power-up), `shots/re_after_back.png` (desktop after returning).

> ⚠️ **The earlier "cannot enter the page" was my own operational mistake**, not a program defect:
> `LAUNCHER_APP_RADIO` is inserted at **index 8** in the app table (settings/network/Bluetooth/radio/gallery),
> and **the initial focus at startup is index 8 = the radio**. My earlier key sequence `Down→Right→Right→Right→Confirm` instead moved the focus away.
> **Correct operation: press "Confirm" directly on the desktop to enter the radio page.**

### 2.4 Desktop Entry — 100% Complete

- Added `{ LAUNCHER_APP_RADIO, "收音机", LV_SYMBOL_VOLUME_MAX, 0xe6614f }` to `s_apps[]` (row 2, column 4, after Bluetooth).
- The icon uses **`LV_SYMBOL_VOLUME_MAX` (speaker)**.
  Measurement showed that among the 60 FontAwesome icons in this device's `lv_font_cn_16`, **there is no "station/antenna/radio wave" glyph at all**
  (`F519/F2CE/F7C0/F8CE/F09E/F130` all render as tofu boxes), so the speaker was used as a fallback.
- Added `case LAUNCHER_APP_RADIO:` → `lv_start_activity(&g_radio_page, ...)` to `launcher_open_app()`.

### 2.5 Boot Autostart — 100% Complete, Verified by Measurement

`/etc/local.d/zz_fm.start` (1172 B): wait for `bt_user_daemon` for up to 180 s (indicating the WCN chain is ready) →
kill old instances → clear the socket → start with `setsid` → after 6 s, report the instance count/socket/log.
Measured after a device cold start: `fm_user_daemon` comes up automatically, with `chipid=0x2341 rds=1`.

---

## III. Old Conclusions Corrected This Round (Important; Do Not Follow the Old Ones)

### 3.1 ~~"Audio-type ioctls Can Configure an Audio Path"~~ → **They Are All Hollow Shells**

`OVER_BT_ENABLE 0x1D` / `ANA_SWITCH 0x1E` / `I2S_SETTING 0x21` / `GET_I2S_INFO 0x29` / `GET_AUDIO_INFO 0x30`
**only printk and return** inside `marlin_fm.ko`, producing no SDIO traffic whatsoever.

**Criterion (the hardest evidence on this device)**: after clearing `dmesg` and calling them, the driver only prints the command names,
**with no `fm_write_buf ... at+fm=xx` SDIO send/receive appearing at all**;
by contrast, `POWER_UP / TUNE / GETRSSI` print the complete send/receive pairs `at+fm=1,9740` / `at+fm=13`.

> **General experience: to judge whether an ioctl is a hollow shell, look at whether it produces real lower-layer traffic, not at rc.**

### 3.2 ~~"Enabling Speaker per the Vendor's tiny_hw.xml Will Produce Sound"~~ → **No Such Route Exists in the Kernel**

The DAPM graph (137 widgets) has an incomplete topology by measurement:

- The out of `DACL Switch` is only `EAR Mixer`; `DACR Switch` has **no out**;
- **`HPL/HPR/SPKL/SPKR Mixer` has zero inputs (completely isolated)** → going through the speaker is physically impossible;
- **The only reachable output endpoint on the whole device is `EAR` (the earpiece)**.

Even if kcontrols such as `Earpiece Function` are turned on according to the real path (the DAC→EAR in count measured 0→2, **the chain is connected**),
**the whole-device codec is still all Off, with `bias_level=Off`** — connected, but not powered.

### 3.3 ~~"The daemon is stable"~~ → **It Once Exited Silently Due to SIGPIPE; Fixed**

When the client (radio page) disconnects first, a bare `write()` in the daemon triggers SIGPIPE,
whose default action is to **terminate the process** → the daemon dies silently. This has been changed to `MSG_NOSIGNAL` + `signal(SIGPIPE, SIG_IGN)`.

### 3.4 ~~"`SEEK`/`SCAN` Are Usable and Can Search for Stations"~~ → **SEEK Parameters Are Truncated and SCAN Is a Hollow Shell** (new this round)

- `SEEK (0x03)` really does send SDIO, but the driver takes **only the low byte** of the u16 starting frequency when assembling the AT frame
  (974 → `at+fm=4,0,206`) → in-band frequencies cannot be passed in; measurement showed only **two fixed return values, 92.5 / 103.1**,
  and they are **unrelated** to the current frequency → it cannot serve as "next station".
- `SCAN(0x08)` / `SCAN_NEW(0x3c)`: they return 0 but with **zero SDIO traffic**.
- `write(/dev/fm, "at+fm=...")`, intended to bypass the driver bug → always **`EINVAL(22)`**, with no SDIO traffic.

> For detailed data, see `radio_docs/FM收音_SEEK与场强_实测结论.md`.

### 3.5 ~~"Signal Strength Can Be Read"~~ → **No Credible Field Strength Can Be Obtained** (new this round)

`GETRSSI(0x07)` is the only signal-class command that really sends SDIO, but it **always times out with `ETIMEDOUT` after 4.2 s**,
and its return values barely change across 10 frequency points (123~125); the rest (`SCAN_GETRSSI/CQI_GET/GETMONOSTERO/…`) are all hollow shells;
the second field of the `TUNE` response (164/139) is not a stable indicator either, and **the driver does not write it back to user space**.
→ The radio page has **removed the fake signal bars** and now says "this device does not provide a field strength query".

---

## IV. Blockers and Infeasible Items (No Solution in User Space)

### 4.1 FM Making Sound — ❌ No Solution in User Space (Conclusion Final)

All three possible exits for FM audio **have been excluded by measurement**:

| Exit | Measured result |
|---|---|
| ① FM chip analog output → system codec → speaker/headphone | The DAPM routing table lacks HPL/SPKL, and the only reachable endpoint is EAR; moreover, the system codec's `bias_level` is permanently `Off`, and `Analog/Digital Power` are all Off |
| ② `OVER_BT_ENABLE` / `ANA_SWITCH` / `I2S_SETTING` to switch paths | **Hollow-shell ioctl**, with no SDIO traffic (§3.1) |
| ③ Host capture recording + digitization then feeding Bluetooth A2DP | All 8 capture devices **fail with `readi -5 EIO`** (the 4 on card0 even return -524 ENODEV for `set_params`); `read(/dev/fm)` only returns 688 B RDS blocks, **with no PCM** |

**Root cause**: FM audio flows in hardware only to the FM chip's own analog output → speaker/headphone,
**with no FM audio channel entering the AGDSP**. Therefore it can neither make sound nor be taken over by digitization.

**Additional confirmation**: after FM power-up + opening `Dfm` (hw:1,4), recording capture again (the last combination) still yields EIO, and DAPM is still all Off.

**Reaching this point requires** (choose one of three, all beyond user space):
- (a) Modify the kernel: add the sprd-codec DAPM route / fix the stream trigger events so the system codec powers up;
- (b) Obtain the BT firmware's "FM passthrough" entry (HCI vendor command);
- (c) Request the new version of the `bt_user_daemon` source code (the version currently on the device is **not** the old copy in the local `ref_src/`).

### 4.2 Signal Strength Table — ❌ The Hardware Provides No Usable Query

This round scanned **10 frequency points** + used a probe to dump the ioctl write-back structure, with the following conclusions:

- `GETRSSI (0x07)`: the **only** signal-class command that really asks the chip. The chip replies to `at+fm=13` with a small integer (123~125),
  and the driver writes it into the **first byte** of the arg buffer;
  **but the ioctl always takes a fixed 4.2 s and then returns `-1 / ETIMEDOUT(110)`**,
  and the value **barely changes across 10 frequency points** → **it cannot be used as a signal table**.
- `SCAN_GETRSSI 0x24`, `CQI_GET 0x27`, `GETMONOSTERO 0x0D`, `GETGOODBCNT 0x0F`,
  `GETBADBNT 0x10`, `GETBLERRATIO 0x11`, `IS_DESE_CHAN 0x2A`: **all are hollow shells** (printk only, no SDIO traffic).
- In the chip's `TUNE` response `0,<X>,0,9740`, the second field appears to correlate with the frequency (97.4→164, 87.5→139),
  but **tuning the same frequency twice in a row yields 164 and 139** → it is not a stable field-strength indicator, and the driver **does not write this response back** to user space.
- `RDS`: the data path is alive (688 B blocks can be read back), but measurement shows `blk2=blk4=180` is constant and `The PS is` (empty)
  → **no valid RDS station name can be received in the current environment**.

> So the line "Raw N (query timeout)" on the UI now **truthfully reflects the hardware state**,
> but as a "signal table" it is meaningless. The rework has been completed in §5 (changed to fixed text + removed polling).

### 4.3 Station Search (SEEK) — ❌ Parameters Are Truncated by the Driver; Cannot Serve as "Next Station"

`SEEK (0x03)` **really does send SDIO** (`at+fm=4,<p2>,<p3>`, about 1.43 s each time, and it can obtain
`fm seek event have come freq=...`), but **the parameters are broken**:

| Starting freq we pass | What the driver actually sends | Chip response frame | "Found frequency" written back by the driver |
|---|---|---|---|
| 974 (97.4MHz) | `at+fm=4,0,206` | `3,139,0,9250` | **925 = 92.5MHz** |
| 875 / 1080 / 900 / 1000 | `,0,107` / `,0,56` / `,0,132` / `,0,232` | `3,139,0,9250` | **925** |
| **0** | `at+fm=4,0,0` | `3,139,0,10310` | **1031 = 103.1MHz** |

- The driver takes **only the low byte** of the u16 freq when assembling the AT frame → in-band frequencies (875~1080) **can never be passed in**;
- The second parameter of the AT frame is **always 0** (changing `zero/band/one/pad` to 1/2 makes no difference);
- The result is **unrelated to the current frequency**: first TUNE to 87.5 / 97.4 / 100.0 / 103.1, then `SEEK(0)`, and all four return 103.1.

→ **SEEK degenerates into "either 92.5 or 103.1"; it is not station search. The UI should not provide a "station search" button.**

Two additional paths excluded:
- `SCAN(0x08)` / `SCAN_NEW(0x3c)`: they return 0 but with **zero SDIO traffic** (hollow shell); `STOP_SCAN(0x09)` always returns `EINVAL(22)`.
- `write(/dev/fm, "at+fm=4,0,9740")`, intended to write AT text directly to bypass the driver bug → always **`-1 / EINVAL(22)`**,
  with no `fm_write_buf` in dmesg → **the driver does not accept user-space AT text; this path does not work**.

> Forensics scripts: `ssh_tools/fm_seek_probe.c` / `fm_seek_probe2.c` / `fm_at_probe.c` (including `_run.py`).
> For complete data, see `AI工作流/05_收音机/docs/FM收音_SEEK与场强_实测结论.md`.

---

## V. Incomplete / To-Do (★ Latest status after the late-night continuation on 2026-09-22)

### 5.1 Completed This Round ✅

| # | Item | Result |
|---|---|---|
| 5 | Added rotation to `/tmp/btud_dbg.log` | ✅ **129.9 MB → 65 KB**, root partition 77% → 75%; installed busybox `crond` (runs `/root/log_rotate.sh` on the hour) + boot autostart `/etc/local.d/zz_crond.start`; measurement confirmed the log continues to grow normally and is not a sparse file |
| 1 | Changed the UI signal-strength area to honest text | ✅ Removed the 5 fake signal bars and changed it to "Field strength: this device does not provide a field strength query"; screenshot `shots/dep_1E.png` accepted |
| 2 | Removed the pointless `rssi` polling | ✅ Removed the `want_rssi` logic (which used to waste 4.2 s after every tuning); the `rssi` command is retained on the daemon side for experimentation |
| — | The "audio path" text at the bottom | ✅ Changed to "Audio output: temporarily unavailable on this device (no usable path)", and **removed** the ineffective "switch audio path" button (ANA_SWITCH is a hollow shell; keeping it would only mislead) |
| 4 | System-wide volume control | ✅ Graceful degradation: on first probe, if `tinymix` does not exist, it is set to "unavailable", and **the warning appears only once** (previously, every slider drag forked a shell that would inevitably return 127); the measured log `grep -c 'Volume System'` = **1** |
| 7 | Outdated comments in `launcher_page.c` | ✅ Corrected (index 8 is now the **radio**, not task management; behavior unchanged) |
| 8 | `radio_docs/` documentation | ✅ Added `FM收音_SEEK与场强_实测结论.md`; added **§0.1 Important Corrections** at the top of `FM收音ioctl命令表_逆向还原.md` (overturning the three old conclusions that "SCAN/SCAN_GETRSSI can draw a spectrum", "SEEK can search for stations", and "AT text can be written") |

**Screenshots accepted this round**
| Screenshot | Content |
|---|---|
| `shots/fin_0.png` | Desktop: all 12 app icons are present, the "Radio" speaker icon renders normally, and **the focus box (pink outline) lands right on "Radio"** → directly confirming that `s_apps[]` index 8 = the radio |
| `shots/dep_1E.png` / `shots/fin_1.png` | The radio page's 8 zones are all correct; "Field strength: this device does not provide a field strength query" and "Audio output: temporarily unavailable on this device (no usable path)" are shown, with no fake signal bars and no ANA button |

**Final process state (measured on the device)**
`lvgl_demo 15468` + `lvgl_watchdog 15681`；`fm_user_daemon 2491` + `fm_watchdog 20199`；
`bt_user_daemon 1222`、`wcnd 1155`、`crond 20905`（整点轮转）

### 5.2 Still Incomplete / Pending User Decision ⏳

| # | Item | Priority | Description |
|---|---|---|---|
| A | **FM making sound** | Blocking (decision needed) | No solution in user space; choose one of three paths: (a) modify the kernel to add the sprd-codec DAPM route / fix the stream trigger; (b) obtain the BT firmware's "FM passthrough" entry (HCI vendor command); (c) accept that "FM is demonstrable in UI/control only, with no sound" |
| B | Request the new version of the `bt_user_daemon` source code | Medium | Needed if path (b) is taken |
| C | Commit the source code into the repository | Medium | Per AGENTS.md: first provide the file list + a commit message in Chinese and **obtain the user's consent**; **automatic commits are forbidden**. See the list below |
| D | RDS station name | Low | `read(/dev/fm)` can read 688B blocks, but measurement shows `The PS is` is empty → no valid station name can be received in the current environment |
| E | Other system-wide `tinymix` dependencies | Low | Already gracefully degraded; to truly fix it, a codec playback volume control is needed first (among card1's 120 kcontrols, **there is no playback volume control at all**) |

### 5.3 List of Files to Be Committed (commit only after the user's consent)

**Device-side repository `/home/lvgl_demo/lvgl_demo` (already tracked by git)**
| File | Change |
|---|---|
| `lv_pages/radio_page.c` | The page itself (this session: honest signal-strength area, removal of fake signal bars and rssi polling, bottom audio-output text, removal of the ANA button) |
| `lv_pages/radio_page.h` | Added |
| `lv_pages/launcher_page.c` | Three radio entry points + correction of outdated comments |
| `lv_status_bar/volume_control.c` | Graceful degradation when tinymix is missing (warning appears only once) |
| `AI工作流/05_收音机/docs/FM收音_SEEK与场强_实测结论.md` | Added |
| `AI工作流/05_收音机/docs/FM收音ioctl命令表_逆向还原.md` | Added §0.1 Important Corrections + script table supplements |

**Runtime artifacts outside the device-side repository (whether to commit them is to be decided)**
`/usr/local/bin/fm_user_daemon`、`/etc/local.d/zz_fm.start`、`/root/fm_watchdog.sh`、
`/root/log_rotate.sh`、`/etc/local.d/zz_crond.start`、`/etc/crontabs/root`

**Local engineering scripts `ssh_tools/` (whether to commit them together with the repository is to be decided)**
`fm_user_daemon.c`、`radio_deploy.py`、`build_deploy.py`、`pull_file.py`、`log_rotate_install.py`、
`fm_seek_probe.c`/`fm_seek_probe2.c`/`fm_at_probe.c`（含 `_run.py`）、`fm_tune_probe.c`（含 `_run.py`）、
`fm_live_check.py`、`fm_rssi_sweep.py`、`fm_rssi_trace.py`、`fm_sigcmd_trace.py`、`fm_any.c`、`pcm_rec.c`、`dapm_graph2.py`

---

## VI. Quick Reference for Acceptance Commands

```sh
# 设备: <设备IP>   (root / <密码>，真实凭据只在运行参数里给，勿写入公开文档)

# FM 状态
python3 /root/fm_cli.py state

# 上电 / 调台 / 音量 / 静音
python3 /root/fm_cli.py on
python3 /root/fm_cli.py 'tune 97400'
python3 /root/fm_cli.py 'vol 12'
python3 /root/fm_cli.py 'mute 0'

# 看驱动真实收发（判断命令是不是空壳）
dmesg | grep -E 'FM_DRV|fm_sdio' | tail -40
```

**Windows-side tool scripts** (`ssh_tools/`):

| Script | Purpose |
|---|---|
| `radio_enter_test.py [键序列]` | Stop the watchdog → cleanly restart the app → screenshot → press keys → screenshot, and tail the app log |
| `fm_live_check.py` | Daemon command chain → radio page screenshot → return key → desktop screenshot |
| `fm_rssi_sweep.py` | Multi-frequency-point RSSI scan |
| `fm_rssi_trace.py` | Capture the complete FM driver log of a single tune+RSSI |
| `fm_tune_probe.c` / `fm_tune_probe_run.py` | Directly dump the 32-byte structure written back by ioctl (to judge what the driver wrote) |
| `fm_sigcmd_trace.py` | Test signal-class commands under a clean dmesg and see whether there is SDIO traffic |

---

## VII. Next-Step Recommendations (Updated per This Round's Results)

1. ~~Save the disk first~~ ✅ **Completed** (129.9 MB → 65 KB, and hourly rotation installed).
2. ~~Change the signal area to honest text~~ ✅ **Completed**.
3. ~~Add `seek`/`scan`/`stopscan`~~ ❌ **Disproved; will not be done**: the `SEEK` parameters are truncated by the driver and `SCAN` is a hollow shell,
   so doing it would be "fake station search". **Do not turn unreliable capabilities into buttons**.
4. **Making sound requires a user decision** (the only real blocker): modify the kernel to add DAPM routes, request the new version of the Bluetooth protocol stack source code,
   or accept "demonstrable in UI/control only".
5. Committing the source code goes through approval (AGENTS.md: provide the list + a commit message in Chinese first; **automatic commits are forbidden**) —
   see §5.3 for the list.
6. Optional minor optimization: make the threshold of `/root/log_rotate.sh` (currently 20 MB) and the list of logs to monitor configurable,
   to make it easy to add logs for new daemons in the future.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
