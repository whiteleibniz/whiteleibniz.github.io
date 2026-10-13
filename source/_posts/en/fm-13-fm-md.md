---
title: "FM Radio Chip Bring-Up_Troubleshooting Manual"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-13-fm-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# Unisoc SC9832A FM Radio Troubleshooting Manual — spd-box

> **Audience**: Engineers / AI who encounter problems while bringing up FM
> **Iron rule of troubleshooting**: **Locate the layer top-down**; skipping layers is not allowed. If any layer is not working and you guess upward from it, you will inevitably waste time
> **Core value**: Chains "symptom → most likely root cause → verification command → fix" into a single decision table, locating the layer within 5 minutes

---

## 0. Troubleshooting Discipline (Read First; Violating It Wastes Time)

1. **Layer first, act second**. Five layers: ① firmware ② power-up ③ driver ④ daemon ⑤ UI. Use the quick-reference table in §1 to locate the layer.
2. **Display/audio conclusions must be confirmed by human eyes and ears**; "logs return OK" must not be substituted for "there really is a picture/sound".
3. **For every path, first write a minimal, no-frills reproduction** before discussing a fix.
4. **Do not repeat already-confirmed hard facts** (see `FM收音打通_AI指导手册.md` §2), and do not retread already-verified dead ends (§10).

---

## 1. Layered Troubleshooting Quick-Reference Master Table (One-Page Location)

| Symptom | Layer | Preferred verification command | Jump |
|---|---|---|---|
| `/dev/fm` cannot be opened (ENOENT) | ③ Driver | `ls /dev/fm && grep -w fm /proc/misc` | §3.1 |
| `0x2331` cannot be read on SDIO | ①② Firmware/power-up | `cat /sys/bus/sdio/devices/*/device` | §2.1 |
| WiFi is fine, but FM does not respond | ② Power-up | `ps \| grep wcnd` | §2.2 |
| ioctl returns `-EINVAL` | ③ Wrong command number | `dmesg \| tail` (check for `----<命令名>----`) | §3.2 |
| ioctl returns OK but there is **no sound** | ③/④ Audio path | `cat /proc/asound/pcm \| grep -i fm` | §4 |
| There is sound but it is **noisy / extremely quiet** | ④ Volume chain | Compare `GETVOL` with the actual listening impression | §4.3 |
| RSSI is constantly 0 or an extreme value | ③/⑤ Tuning failure | Perform a single-point TUNE on a known strong-signal station | §5.1 |
| seek does not return / gets stuck | ③ Driver timeout | `dmesg \| grep 'seek Timeout'` | §5.2 |
| **LVGL page freezes** | ⑤ socket blocking | Check whether `SO_RCVTIMEO` is set | §6.1 |
| FM and Bluetooth **make sound at the same time** | ⑤ Missing arbitration | Check the audio focus module | §6.3 |
| FM stops working after a reboot | Autostart order | `rc-service fm-radio status` | §7.1 |
| **Station drops** on screen-off/background | ③ PM suspension | `dmesg \| grep -i suspend` | §7.3 |

---

## 2. Firmware / Power-Up Layer (①②)

### 2.1 SDIO Cannot Be Read / `device` Is Not Equal to `0x2331`

```sh
cat /sys/bus/sdio/devices/*/modalias   # 期望 sdio:c00v0000d2331
cat /sys/bus/sdio/devices/*/device     # 期望 0x2331
```

- **Root cause**: `download` did not start or the firmware was not burned → the combo chip as a whole is not online, so **FM of course does not exist either**.
- **Fix**: first bring up WiFi according to the `01_WiFi打通` documentation. `download` must **stay resident**; do not kill it.
- **Note**: there is only this one device on SDIO, and WiFi/Bluetooth/FM all share it; **there is no independent "FM enumeration"**.

### 2.2 WiFi Is Normal but FM Does Not Respond to Commands

```sh
ps | grep '[w]cnd'      # 期望有进程
ps | grep '[d]ownload'  # 期望常驻
```

- **Root cause**: the wcnd power-up step is missing, so the chip's powered state is incomplete (especially evident for the FM part).
- **Fix**: add the `wcnd` + `bt_once(BT-OPEN)` steps, referring to §3 of `02_蓝牙打通/docs/蓝牙芯片打通_操作手册.md`.

---

## 3. Driver Layer (③)

### 3.1 `/dev/fm` Does Not Exist

```sh
lsmod | grep marlin_fm            # 期望：marlin_fm ... Used by sprdwl
insmod /lib/modules/marlin_fm.ko
ls -l /dev/fm ; grep -w fm /proc/misc
```

- **Note**: `marlin_fm` is depended on by `sprdwl` (`Used by sprdwl` in `lsmod`),
  so when unloading it you must handle the dependent party as well; **do not rashly rmmod WiFi that is carrying business traffic**.
- Under normal circumstances this should not happen: the module is already loaded automatically when WiFi is brought up.

### 3.2 ioctl Returns `-EINVAL` / `-ENOTTY` (**This Project's Number One Fault**)

```sh
dmesg -c >/dev/null
# 再发一次你的 ioctl 命令
dmesg | tail -30
```

- **Judgment**: the driver prints `----<命令名>----` for each command.
  - If you sent command A but `dmesg` prints `/----B----/` → **the command number mapping is wrong**;
  - If `dmesg` has no new prints at all → **the command number did not land in any known branch**.

- **Fix**: check the conclusion table of "FM收音ioctl命令表_逆向还原" and verify `nr`. All command numbers have been reverse-engineered, so only two possibilities remain here: "copied incorrectly" or "used an undefined range"; **this is no longer a blocker**.
- 🔒 **Do not use brute-force full traversal**: sending ioctls at random may put the firmware into an abnormal state. Only perform controlled single-step probing, and prepare a reset method.

### 3.3 `dmesg` Shows `seek Timeout(%d sec), fm seek end !`

- **This is the driver's built-in seek timeout mechanism**, not a bug (the string comes from the driver source code).
- **The upper layer must be equipped accordingly**: the daemon/UI must also have its own timeout fallback, and after a timeout it must show a "no station found" prompt, so the UI does not spin forever.

---

## 4. Audio Layer (Whether There Is Sound) — The Layer Most Prone to "Thinking It Works"

### 4.1 ioctl Succeeds but There Is No Sound

```sh
cat /proc/asound/pcm | grep -i fm
# 期望看到：01-04: Dfm sprd-codec-fm-4 : : playback 1
```

| Possible cause | Investigation |
|---|---|
| The correct audio path is not selected | Try in order `ANA_SWITCH` (default) → `I2S_SETTING` → `OVER_BT_ENABLE`, **confirming each one by ear** |
| The main output volume is not turned on | This device has no `amixer`; you can only write code using `libasound.so.2` to query the mixer; `SETVOL` may only be the FM module's internal gain |
| **Headphones are not plugged in but the design depends on the headphone antenna** | Tune to the strongest station and listen without headphones; if headphones are mandatory, the UI must give a clear prompt |
| The channel is occupied by someone else (A2DP/local playback) | See §6.3 |

> ⚠️ **Logs must not be used to determine whether there is sound**. There is no necessary connection between TUNE returning OK and "hearing the broadcast".

### 4.2 Sound Is Intermittent / Feels Choppy

- Check `fm_suspend` / `fm_resume`: the driver implements dev_pm_ops, so **FM is very likely to be suspended along with the system** (see §7.3).
- Check SDIO bandwidth: FM shares SDIO with WiFi/Bluetooth, so high WiFi throughput may have an impact — this is an inherent characteristic of the shared chip and needs evaluation by measurement.

### 4.3 Volume Is Wrong / `SETVOL` Has No Effect

- First confirm whether the `GETVOL` return value changes with the value you write:
  - If it changes → the FM internal gain is in effect, but the main output (codec/speaker) volume is a separate chain that must go through ALSA;
  - If it does not change → the command did not succeed or the value range is wrong (the value range needs calibration by measurement).

---

## 5. Tuning / Scan Layer

### 5.1 RSSI Is Constantly 0 or a Fixed Extreme Value

```sh
# 用本地已知最强电台做单点基准
python3 - <<'EOF'
import socket,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(5)
s.connect('/tmp/fm_ctl.sock')
def cmd(c):
    s.sendall((c+"\n").encode()); time.sleep(0.3); return s.recv(4096).decode().strip()
print(cmd("tune 97400"))   # 换成你手边最强的那个频点（单位 kHz）
print(cmd("rssi"))
EOF
```

- If even a single point cannot yield a reasonable value → go back to §3.2 (command numbers) or §4 (antenna/path).
- If a single point is OK but scanning is wrong → check the usage of `SCAN` / `SCAN_GETRSSI`.

### 5.2 Scanning Is Very Slow / Cannot Be Stopped Midway

- The full band is 87.5–108.0 MHz with a 100 kHz step ≈ 205 frequency points, and each point requires a dwell measurement → being slow is **normal**.
- The UI must: ① show percentage progress; ② show the number of stations found; ③ provide a clickable **Stop** button (`STOP_SCAN`).
- The daemon side must also set an overall timeout; it cannot wait indefinitely.

---

## 6. Application Layer (④⑤ daemon → socket → LVGL)

### 6.1 LVGL Page Freezes / Page Switching Does Not Respond

- **Root cause**: socket I/O is performed inside an LVGL timer callback, and the daemon does not respond → the UI thread is blocked.
- **Fix (mandatory)**:
  ```c
  struct timeval tv = { .tv_sec = 0, .tv_usec = 200*1000 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
  ```
- This is exactly the same pitfall already encountered on the Bluetooth page.

### 6.2 `connect /tmp/fm_ctl.sock` Fails

```sh
ls -l /tmp/fm_ctl.sock          # 期望 socket 且权限 0666
ps | grep '[f]m_radio_daemon'   # 期望进程在
tail -30 /tmp/fm_daemon.log     # 看 daemon 启动有没有报错
```

- The daemon did not start → run it manually once and look at the output (`./fm_radio_daemon` in the foreground).
- The socket exists but cannot be connected to → check for leftover old socket files (the daemon should `unlink` the old socket at startup).

### 6.3 FM and Bluetooth A2DP / Local Playback **Make Sound at the Same Time**

- **Root cause**: the three share one audio output, with no arbitration.
- **Fix**: implement an audio focus module (see §5.4 of `FM收音机_LVGL界面设计与交互规格.md`):
  - FM encounters A2DP → automatically **mute (not close)**, and after A2DP ends ask whether to resume;
  - A2DP encounters FM → pop up a confirmation dialog; after the user agrees, pause/disconnect A2DP and then FM takes over;
  - Local playback and FM are mutually exclusive.
- ⚠️ Note that the semantics of `OVER_BT_ENABLE` are not yet confirmed (whether it means "send FM sound to Bluetooth" or "allow coexistence"); **measure first, then write the arbitration**.

### 6.4 Station Stops After Returning to the Desktop / Station Drops on Screen-Off

- In `onPause`, calling close or mute is **forbidden**; only stop UI timers/callbacks.
- The playback state is **held by the daemon**, decoupled from the page lifecycle.
- If the station drops on screen-off: check whether `fm_suspend` is triggered by the system PM (see §7.3).

---

## 7. System / Autostart Layer

### 7.1 FM Is Not Automatically Available After a Reboot

```sh
rc-service fm-radio status
rc-status | grep -E 'fm-radio|download|wcnd'
```

- **Number one root cause**: the autostart order precedes the WiFi power-up chain, so the chip is not yet powered when FM starts.
- **Fix**: declare `after` for WiFi/power-up-related services in the openrc service's `depend()`.
  The correct chain: **`logdw → download → wcnd → bt_once → bt_wake → bt_user_daemon → fm_radio_daemon`**.

### 7.2 The Daemon Restarts Repeatedly

- Check whether it is a misjudgment by `<the on-device watchdog>`; during debugging, be sure to kill processes by PID,
  **do not use `pkill -f <pattern>`** — it will match the shell itself carrying the command and kill your own SSH session.

### 7.3 FM Drops the Station After Screen-Off / System Suspension

```sh
dmesg | grep -i 'suspend\|resume'
```

- The driver symbols contain `fm_suspend` / `fm_resume` (static functions, shown as `t` by `nm`), indicating that dev_pm_ops is implemented.
- If the product requires "continued listening with the screen off", extra handling is needed (holding a lock or preventing suspend) — **this must be confirmed by measurement and cannot be assumed**.

---

## 8. Diagnostic Toolbox (Quick Reference for Key Nodes)

| Purpose | Command |
|---|---|
| One-shot checkup | See the six-part script in §1.2 of `操作手册.md` |
| Driver command name list | `strings /lib/modules/marlin_fm.ko \| grep -- '----' \| sed 's/.*----//;s/----//' \| sort` |
| RDS function list | `nm /lib/modules/marlin_fm.ko \| grep ' T ' \| grep rds_` |
| Evidence of shared SDIO | `strings /lib/modules/marlin_fm.ko \| grep description=` |
| Whether ioctl lands in the correct branch | `dmesg -c >/dev/null` → send the command → `dmesg \| tail`, look for `----<命令名>----` |
| Whether the FM PCM exists | `cat /proc/asound/pcm \| grep -i fm` |
| socket connectivity | See the python3 snippet in §6.1 |
| seek timeout logs | `dmesg \| grep 'seek Timeout'` |

---

## 9. Items Still Requiring Measurement and Calibration (Currently **Not** Established Facts)

| Item | Why it matters |
|---|---|
| ioctl **command numbers** | Block the entire workflow |
| Whether it depends on **headphones as the antenna** | Determines whether the UI needs a "please insert headphones" prompt |
| The exact semantics of `OVER_BT_ENABLE` | Determines how to write the channel arbitration |
| The relationship between `SETVOL` and the main output volume | Determines which chain volume control goes through |
| The **RSSI threshold** boundaries | Determines how many bars the signal bar draws (do not copy dBm values from the internet; this device returns raw driver values) |
| FM behavior during system suspend | Determines the feasibility of "continued listening with the screen off" |

---

## 10. Verified Dead Ends (Do Not Retry)

| Route | Conclusion |
|---|---|
| Looking for Unisoc FM source code in `/tmp/linux-3.10.65` | ❌ That is a vanilla tree; it has no private FM source code |
| Looking for an off-the-shelf FM command-line tool | ❌ There is none anywhere on the disk; you must write your own daemon |
| Using `amixer`/`tinymix` to switch paths | ❌ These tools are not installed on this device; you can only write code calling the ALSA lib |
| Directly dynamically loading Android's `libFMHalSource.so` | ❌ It depends on the Android runtime and cannot run under Alpine |

---

## 11. Red Lines (Under Any Circumstances)

1. Writing SSH passwords/accounts/real IPs in documentation is **forbidden**.
2. Audio/display conclusions **must be confirmed by ear and eye**; "logs OK" is not accepted as a pass criterion.
3. Socket I/O inside LVGL **must** have timeouts set.
4. Kill processes **by PID**; `pkill -f` matching strings that could hit your own command line is forbidden.
5. Before committing, check `git diff --stat` and `git diff --ignore-cr-at-eol --stat` (`main.c` is the only CRLF file in the whole repository).
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
