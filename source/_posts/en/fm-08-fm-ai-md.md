---
title: "FM radio bring-up: AI execution guide"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-08-fm-ai-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# Spreadtrum SC9832A (spd-box) FM radio bring-up — AI execution guide

> **Audience**: AI assistants / engineers who need to build an FM radio on similar devices (Spreadtrum SC9832A + Marlin2 combo chip, Android kernel + Alpine user space)
> **How to use**: read §1–§3 first to build context → verify layer by layer per §5 → execute per §6 → on failure, consult the decision table in §7
> **Core value**: all hardware facts in this article have been obtained by on-device measurement; following it lets you **skip all low-level investigation** and go straight to the "write the daemon + draw the UI" stage; §3 explicitly marks the dead ends not to be walked again

---

## 1. Device and environment at a glance

| Item | Value |
|---|---|
| Hostname / kernel | `spd-box` / `Linux 3.10.65` armv7l |
| System combination | keeps the Android 6.0 kernel + switchroot to **Alpine Linux** user space |
| Wireless chip | **Spreadtrum Marlin2 combo WCN** — WiFi + Bluetooth + FM **one single chip, sharing SDIO** |
| SDIO enumeration | `sdio:c00v0000d2331`, `device=0x2331` at `/sys/bus/sdio/devices/mmc2:8800:1` |
| FM kernel driver | **`marlin_fm` (loaded)**, /lib/modules/marlin_fm.ko, 17554 bytes |
| FM device nodes | **`/dev/fm`** (misc, registered as `23 fm` in `/proc/misc`), `/dev/log_radio` (`35`) |
| Display | 720×1280 portrait framebuffer, LVGL 9.6.0 |
| SSH | `root@<设备IP>` (the password and IP are in the environment records; do not write them into documents) |
| Android vendor partition | mounted at `/mnt/android_sys` (usable as an information source and reference sample) |

> ⚠️ Privacy red line: in all deliverables it is **forbidden** to include the SSH password, account, or real IP; always use the `<设备IP>` / `<密码>` placeholders.

---

## 2. Confirmed hard facts (no need to re-investigate; trust directly)

> Each entry below notes how it was obtained; **entries marked ✅ are measured conclusions that can be used directly as design basis**.

### 2.1 Chip and resource sharing (the most critical item)

1. ✅ **FM shares SDIO with WiFi/Bluetooth and belongs to the same Marlin2 chip**.
   Evidence 1: there is only **one** device on the SDIO bus, with modalias `sdio:c00v0000d2331`.
   Evidence 2: the verbatim driver module description (from `strings /lib/modules/marlin_fm.ko`):
   ```
   description=SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI
   ```
   **This directly determines that FM's availability depends on the WiFi power-up chain** (see §4 for details).

2. ✅ **The FM driver is already loaded, and `marlin_fm` is depended on by `sprdwl`** (`lsmod` shows `marlin_fm 17554 1 sprdwl`).
   It is not an isolated module, so note WiFi's dependency when unloading/reloading it.

3. ✅ **`/dev/fm` already exists and is registered** (item 23 in `/proc/misc`); **no need to insmod or mknod again**.

### 2.2 Driver capability inventory (from the debug output of `strings marlin_fm.ko`)

The driver prints `----<命令名>----` for each ioctl command, from which the complete command set was reconstructed:

| Category | Commands |
|---|---|
| **Basic control** | `TUNE`、`TUNE_NEW`、`SEEK`、`SEEK_NEW`、`MUTE`、`SETVOL`、`GETVOL`、`IS_FM_POWERED_UP` |
| **Scan** | `SCAN`、`SCAN_NEW`、`STOP_SCAN`、`SCAN_GETRSSI`、`PRE_SEARCH`、`RESTORE_SEARCH` |
| **Signal** | `GETRSSI`、`GETMONOSTERO`、`SETMONOSTERO`、`SOFT_MUTE_TUNE`、`DESENSE_CHECK`、`IS_DESE_CHAN`、`CQI_GET`、`FULL_CQI_LOG` |
| **Audio path** | `ANA_SWITCH`、`I2S_SETTING`、`GET_I2S_INFO`、`GET_AUDIO_INFO`、`OVER_BT_ENABLE` |
| **RDS** | `RDS_SUPPORT`、`RDS_ONOFF`、`RDS_GROUPCNT`、`RDS_BC_RST` |
| **Chip info** | `GETCHIPID`、`GET_HW_INFO`、`GETCAPARRAY`、`GETCURPAMD`、`GETGOODBCNT`、`GETBADBNT`、`GETBLERRATIO` |
| **Debug/mass production** | `RW_REG`、`TOP_RDWR`、`HOST_RDWR`、`DUMP_REG`、`EM_TEST`、`SIM_DATA`、`GET_LOG` |

> ⚠️ **Honest labeling**: the command **names** in the table above come from debug print strings inside the driver, so you can be confident these command branches really exist;
> **the command numbers were fully reverse-engineered and confirmed by measurement on 2026-09-22**, see [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md):
> uniform encoding `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`, with 45 of the 47 confirmed by on-device measurement.
> The classification table in this section is kept as a functional view; **for the actual numbers, always consult that document** — do not guess.

### 2.3 RDS capability (from the function symbols of `nm marlin_fm.ko`)

The driver contains a complete RDS parser, **the biggest value point of this project's FM feature**:

| Function | Meaning | UI use |
|---|---|---|
| `rds_get_ps` | Program Service, **station name, 8 characters** | display the station name below the main frequency |
| `rds_get_rt` | Radio Text, **station text, 64 characters** | scrolling subtitle |
| `rds_get_pty` | Program Type | small label (news/music/traffic) |
| `rds_get_af` / `rds_get_af_method` | Alternative Frequency | automatically switch to the same station on a stronger-signal frequency |
| `rds_get_pi_code` | Programme Identification | station identifier |
| `rds_get_tp_ta` | Traffic Program / Announcement | traffic broadcast flag |
| `rds_get_ct` | Clock Time | optional source for the status bar time |
| `rds_get_di_ms` | Decoder ID / Music-Speech | stereo/speech flag |
| `rds_get_ews` | Emergency Warning System | emergency broadcast (has compliance significance) |
| `rds_get_ptyn` / `rds_get_pin` / `rds_get_slc` | program type name / item number / SLC | extended field |
| `rds_get_oda` / `rds_get_oda_aid` / `rds_get_tdc` | Open Data Application | extended field |
| `rds_get_eon` / `rds_get_eon_ta` | Enhanced Other Networks | cross-station information |
| `rds_parser` / `rds_parser_init` / `fm_read_rds_data` | parser body | — |

Other function symbols confirmed to exist: `fm_open`、`fm_ioctl`、`fm_read`、`fm_write`、`fm_tune`、`fm_seek`、`fm_getrssi`、`fm_mute`、`fm_powerup`、`fm_powerdown`、`fm_rds_onoff`、`fm_sdio_read`、`fm_sdio_write`、`receive_tasklet`、`fm_suspend`、`fm_resume`、`parse_at_fm_cmd`、`parse_at_fm_num`。

### 2.4 Current audio state (determines the channel arbitration design)

| Fact | Current state |
|---|---|
| ALSA sound cards | `0 [alli2s]` / `1 [sprdphone]` / `2 [saudiovoip]` / `3 [saudiolte]` |
| **FM-dedicated PCM** | **`01-04: Dfm sprd-codec-fm-4`, playback only** (no corresponding capture node) |
| Other PCMs | card 0 has four `i2s.x null-codec-dai-x`, **all supporting both playback + capture** |
| ALSA user-space library | ✅ `libasound.so.2` is present (you can write C to operate PCM and the mixer directly) |
| ALSA **command-line tools** | ❌ no `amixer` / `tinymix` / `aplay` / `alsamixer` — **you must write code; you cannot drive the mixer from the shell** |

> Inference: FM audio may go through the internal codec directly (corresponding to `01-04`), or it may enter the codec via some I2S path.
> **The choice between `ANA_SWITCH` and `I2S_SETTING` can only be settled after measurement** (see item 2 of the to-do list in §8).

### 2.5 The existing power-up chain (FM must attach to it)

The chain already established for Bluetooth/WiFi (recorded in the `01_WiFi打通` / `02_蓝牙打通` documents):

```
logdw → download(常驻) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)
```

Here `download` burns the combo firmware (including the FM part) into the chip in one go.

---

## 3. Verified dead ends (do not retry; it wastes rounds)

| Route | Result | Reason |
|---|---|---|
| Looking for the **driver source** of `marlin_fm` on the device | ❌ None | `/tmp/linux-3.10.65` is a **vanilla kernel tree** with only generic radio drivers such as `wl128x` and `sf16fmr2`, **and no** Spreadtrum private FM source; do not expect to read `fm.h` on the device |
| Looking for a ready-made FM user-space daemon/command-line tool | ❌ None | `ls /usr/bin /usr/sbin /bin /sbin \| grep fm` produces no output, and no FM executable was found on the whole disk. **You must write the daemon yourself** |
| Using `amixer`/`tinymix` to switch the audio path | ❌ Not even installed | see §2.4; you can only write code against the ALSA lib or issue ioctls directly |
| Hoping to reuse the Android-layer FM libraries directly | ❌ Cannot run directly | `/mnt/android_sys/lib/` has `libFMHalSource.so`, `libengfm.so`, `libfmjni.so`, `libradio*.so`, but they depend on the Android runtime (binder/ALooper/`sp<>` etc.) and **cannot be dynamically loaded directly on Alpine** |
| Mistakenly thinking RDS does not exist | ❌ The opposite is true | the RDS parsing functions in the driver are quite complete (§2.3) and are this project's FM differentiator; do not lose them |

> **`libengfm.so` deserves a separate mention**: it exports only one symbol, `fm_runcommand`. This hints that the vendor's engineering mode operates FM by "running commands"
> (echoing `parse_at_fm_cmd` / `parse_at_fm_num` in the driver) → suggesting FM control very likely follows the **AT command style**, which is the second viable route besides probing the ioctl numbers.

---

## 4. System model: five layers + per-layer verification criteria

```
┌─ ① 固件层    download 已把 combo 固件烧入 Marlin2
│      验证：WiFi 可用 ⇒ FM 固件就绪
├─ ② 上电层    wcnd / BT-OPEN 使芯片整体带电；FM 共享 SDIO，无独立上电步骤
│      验证：/sys/bus/sdio/devices/mmc2:8800:1 存在，device=0x2331
├─ ③ 驱动层    marlin_fm.ko 已加载并注册 misc 设备
│      验证：lsmod | grep marlin_fm   且   ls /dev/fm   且   grep fm /proc/misc
├─ ④ daemon 层 FM daemon 独占 /dev/fm，对外暴露 unix socket（★ 本任务要新建的唯一后台组件）
│      验证：socket 收发 command 返回 OK
└─ ⑤ UI 层     LVGL 收音机页，经 socket 与 daemon 通信（★ 本任务主体）
       验证：点击可调台、可出声、返回后台不停台
```

> **Iron rule of layered troubleshooting**: if any layer is not working, **do not guess at the layer above**. First confirm layer by layer top-down per §5, and only then start changing the UI.

---

## 5. Layer-by-layer verification commands (copy directly)

```sh
# ==== ①+②+③ 一次性确认 ====
ls /dev/fm && echo "设备节点 OK"
grep -w fm /proc/misc && echo "misc 注册 OK"
lsmod | grep marlin_fm && echo "驱动已加载 OK"
cat /sys/bus/sdio/devices/*/device && echo "SDIO 枚举 OK (应为 0x2331)"

# ==== ③ 驱动描述（确认共享 SDIO 的依据）====
modinfo marlin_fm 2>/dev/null || strings /lib/modules/marlin_fm.ko | grep description=

# ==== ② WiFi 作为 FM 的前置 ====
ip link show wlan0 | grep -o 'state [A-Z]*'     # 期望 UP / DORMANT，不是 DOWN
ps | grep -c '[d]ownload'                        # 期望 >=1，download 常驻

# ==== ③ 驱动能力清单复核（无需再看 .ko）====
# 见 §2.2 / §2.3 两张表，已固化在本文中
```

```python
# ==== ④/⑤ socket 层的设备端自测（Alpine 有 python3，无 socat）====
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)                 # ★ 必须设超时，否则 daemon 无响应会挂死
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c + "\n").encode())
    time.sleep(0.2)
    return s.recv(4096).decode()
print("state  ->", cmd("state"))
print("open   ->", cmd("open"))
print("tune   ->", cmd("tune 97400"))
print("rssi   ->", cmd("rssi"))
```

> ⚠️ The socket path `/tmp/fm_ctl.sock` above is **the design goal mandated by this manual**; it is not implemented yet.

---

## 6. Execution flow

| Step | Action | Output | Completion criterion |
|---|---|---|---|
| **Step 0** | run all commands in §5 and confirm the state of layers ①–③ | exploration record | `/dev/fm` exists, the driver is loaded, WiFi is up |
| **Step 1** | ~~Determine the ioctl command numbers~~ **Completed** | [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md) | can issue a successful `TUNE` against `/dev/fm` (command number: `0xC004F502`) |
| **Step 2** | write the **FM daemon**: exclusively own `/dev/fm`, wrap ioctl → socket | `fm_radio_daemon.c` | the four commands `state` / `open` / `tune` / `rssi` work |
| **Step 3** | write a **minimal probe** to verify `SCAN` and RSSI, and calibrate the signal strength thresholds | calibration record | can obtain ≥3 local station frequencies and their strength values |
| **Step 4** | **Confirm the audio path** (`ANA_SWITCH` vs `I2S_SETTING` vs `OVER_BT_ENABLE`) | path decision | the speaker really produces sound (**must be confirmed by human ear**) |
| **Step 5** | implement **channel arbitration** (mutual exclusion among FM / A2DP / local playback) | arbitration module | switching between any two of the three has no cross-talk |
| **Step 6** | draw the **LVGL radio page** | `radio_page.c` | see `FM收音机_LVGL界面设计与交互规格.md` |
| **Step 7** | RDS display + favorites + persistence + background playback | complete app | see the feature list in §5 of the same document |
| **Step 8** | openrc auto-start (`depends on WiFi`) | service file | automatically available after reboot |

---

## 7. Failure → root cause → fix decision table

| Symptom | Most likely root cause | Fix |
|---|---|---|
| `open /dev/fm` fails with ENOENT | `marlin_fm` is not loaded | `insmod /lib/modules/marlin_fm.ko`, then confirm with `lsmod` |
| `SDIO not enumerated` / `device` cannot be read | download did not run or the firmware download failed | fix WiFi first: restart the `logdw → download` chain |
| WiFi is fine but FM does not respond | missing `wcnd` power-up or the chip as a whole is not powered | check `ps \| grep wcnd` and rerun BT-OPEN |
| the ioctl returns `-EINVAL` | the command number is wrong, or it fell into an **undefined range** (`0x14~0x16`/`0x19~0x1c`/`0x31~0x3b` etc.) | check the `nr` against the conclusion table in [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md); then use `dmesg \| grep FM_DRV` to see whether a **different** command name was printed |
| the ioctl succeeds but there is **no sound** | the audio path is not open | Step 4: try each of the three paths, and use `GET_AUDIO_INFO` / `GET_I2S_INFO` to check the current state |
| there is noise / the sound is very quiet | the volume chain is wrong or `SETVOL` is not the master volume | check whether the main output volume still needs to be raised separately via the ALSA mixer |
| RSSI is always 0 / at an extreme | the TUNE did not really succeed, or the headphone antenna is not connected (if the design depends on headphones) | first verify that a single strong-signal station can be received normally; then investigate the antenna dependency |
| seek hangs without returning | the driver has a seek timeout (log `(fmdrv) seek Timeout(%d sec), fm seek end !`) | the upper layer must also set a timeout fallback and provide a "no station found" UI |
| the LVGL page freezes | socket I/O blocked the UI thread | **you must** set `SO_RCVTIMEO`/`SO_SNDTIMEO` (200ms) — a pitfall hit on this project's Bluetooth page |
| FM stops working after reboot | the auto-start order runs before the WiFi/power-up chain | declare the dependency in the service and start in order per Step 8 |
| FM and Bluetooth A2DP **make sound at the same time** | no channel arbitration was done | Step 5; refer to §5.4 of the UI specification document |

---

## 8. ioctl command numbers: solved (the former number one blocker)

**Completed on 2026-09-22.** For the specific results, see [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md).

Approach in brief: `marlin_fm.ko` is **not stripped** → disassemble the binary search tree of `fm_ioctl()` to read the constant candidates,
then use "single-step calls with all-zero parameters + `dmesg -c` clearing to capture logs" to confirm the command names one by one by measurement.
The three **historical routes** below are kept as a methodology memo:

| Route | Approach | Assessment |
|---|---|---|
| **A. Ask the vendor for header files** (least effort) | request the Marlin2 platform's FM user-space header files (usually called `fm.h` / `sprd_fm.h`) and the libfm library from the chip vendor/solution provider | ✅ **first choice**. With it, everything is clear |
| **B. Reverse-engineer from the Android-side binaries** | the Android partition has `libengfm.so` (exporting `fm_runcommand`) and `libFMHalSource.so`. Use `nm`/`readelf` to cross-examine how they call open/ioctl, or **strace** a native FM APK's operation sequence once inside the Android chroot | ⚠️ feasible but requires touching the chroot environment; note this route is **inference**, and after getting the numbers you still must verify on the device |
| **C. Brute-force the ioctls directly** | iterate over the candidate command numbers, observe `/dev/fm`'s return values and the `----<命令名>----` prints in `dmesg`, and see which number printed which command name | ⚠️ feasible but risky: sending ioctls indiscriminately may put the firmware in an abnormal state. **It must be done when WiFi/Bluetooth are not carrying business traffic, and with a reset method available** |

> 🔒 **Discipline**: whichever route you take, **confirm first on this machine/the Android side; do not write wrong command numbers into the daemon and then blindly tune on the emulator**.

Other to-do items:

1. **Confirm whether headphones are needed as the antenna**: this device's ALSA has a dedicated FM PCM (`01-04`), hinting that internal passthrough may be possible, but it has **not been measured**.
   Criterion: tune to a strong-signal station without headphones plugged in and see whether sound comes out.
2. **Confirm the exact semantics of `OVER_BT_ENABLE`**: does it mean "send FM audio to a connected Bluetooth device", or "allow FM and BT to coexist"?
3. **Confirm the relationship between `SETVOL` and the actual output volume**: it may only be the FM module's internal gain.
4. **Confirm whether FM drops the station when the system suspends** (the driver has `fm_suspend`/`fm_resume`) — this determines whether "keep listening with the screen off" can be implemented.

---

## 9. Red lines and operations discipline

1. **Forbidden**: writing `main.c` back over SFTP and committing without checking the line endings: `main.c` is this repository's **only** CRLF file, and writing it back converts it to LF,
   producing a fake change of 1618 "whole-file rewrite" lines in the commit. Before committing, always check that the two numbers from `git diff --stat` and `git diff --ignore-cr-at-eol --stat` agree.
2. **Forbidden**: writing the SSH password/account/real IP into documents.
3. **Forbidden**: "if it looks right, it passes": display/color/audio conclusions **must be confirmed by human eyes/ears on the real device**; they cannot be self-certified by "screenshots/decoding results being self-consistent".
4. **Forbidden**: doing socket I/O in an LVGL timer callback without a timeout.
5. **Forbidden**: `pkill -f` with a string that would match its own command line (it would kill your own SSH session); always kill by PID.
6. Before modifying `/dev/fm`-related logic, confirm the watchdog (`lvgl_watchdog.sh`) has been handled per procedure, to avoid interfering with experiments.

---

## 10. Inventory of tools already on the device (reuse; do not rebuild)

| Tool | Purpose |
|---|---|
| `python3` | socket self-tests, writing probe scripts |
| `nm` / `readelf` | analyzing `.ko` and `.so` symbols (all facts in §2 were obtained this way) |
| `strings` | extracting debug strings from `.ko` (the command names were obtained this way) |
| `libasound.so.2` | writing C to operate PCM / mixer (no amixer, so code is the only way) |
| `/mnt/android_sys` | Android vendor partition; FM-related libraries under `lib/` can serve as reference samples |
| `/tmp/linux-3.10.65` | vanilla kernel tree, **without** Spreadtrum private FM source (see the dead ends in §3) |

---

## 11. Future enhancement directions (currently incomplete)

| Direction | Description |
|---|---|
| Deep use of RDS | PTY labels, AF automatic frequency switching, CT station clock, EWS emergency broadcast (the driver capabilities are in §2.3) |
| Internet radio integration | FM + WiFi dual mode; when WiFi is online, enhanced station information can be fetched |
| Recording/playback | FM audio to disk via PCM capture (must first confirm a usable capture node exists) |
| Multi-region bands | China 87.5–108.0 / Japan 76–90 / European 50 kHz step |

---

## 12. One-line summary

> **This device's FM hardware, driver, and RDS parsing capability are all already in place and running** (`marlin_fm.ko` is loaded, `/dev/fm` is registered,
> and it shares the same Marlin2 chip with WiFi/Bluetooth); the only thing missing is "the middle layer":
> **an FM daemon that wraps `/dev/fm`'s ioctls into a unix socket**, plus **a radio page that can actually be drawn**.
> The **only thing** that used to block starting work (the ioctl command numbers) has been removed (§8);
> everything that remains is routine engineering work: write the daemon, settle the audio path, do the channel arbitration, draw the UI.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
