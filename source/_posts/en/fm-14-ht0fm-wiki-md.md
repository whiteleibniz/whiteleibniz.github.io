---
title: "HT0FM Radio Principles and Porting Study Wiki"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-14-ht0fm-wiki-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# HT0 FM Radio Principles and Porting Study Wiki

> **Audience**: Engineers who want to understand "what is really going on with this chip's FM", as well as those who will port to other platforms in the future
> **How to read**: §0–§2 build intuition → §3 understand the software/hardware layering → §4 see how Android does it → §5 see how we do it → §8 troubleshooting methodology → §9 migration checklist
> **Core value**: Facts scattered across `.ko` symbols, the ALSA topology, and the Android vendor libraries, organized into a readable chain of knowledge

---

## 0. Build Intuition in One Sentence

**On this chip, the FM radio is not a standalone piece of hardware, but the third functional module inside the Marlin2 "three-in-one" chip.**

Its RF, demodulation, and RDS decoding are all completed inside the chip; externally it exposes only one control channel over SDIO and one `/dev/fm` character device.
What you can do in Linux user space is essentially only three things: **give it commands, ask it for field strength, and connect the audio it produces to the codec**.

---

## 1. What the Hardware Looks Like

### 1.1 One Chip, Three Functions

```
                        ┌─────────────────────────┐
   SDIO 总线  ──────────▶  Unisoc(展讯) Marlin2   │
   (共享！)              │  ┌───────────────────┐ │
                         │  │ WiFi  (sprdwl)    │ │
                         │  ├───────────────────┤ │
                         │  │ Bluetooth (BT/UART)│ │
                         │  ├───────────────────┤ │
                         │  │ FM Radio (marlin_fm)│ │
                         │  └───────────────────┘ │
                         └───────────┬───────────┘
                                     │ 音频输出
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              内部 codec 直通      I2S 总线      Over BT（走蓝牙）
```

**Measured evidence**:

| Fact | Value | How to obtain |
|---|---|---|
| SDIO modalias | `sdio:c00v0000d2331` | `cat /sys/bus/sdio/devices/*/modalias` |
| SDIO device path | `mmc2:8800:1` | `ls /sys/bus/sdio/devices/` |
| vendor / device | `0x0000` / `0x2331` | `cat .../vendor`, `.../device` |
| **Official statement on shared SDIO** | `SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI` | `strings /lib/modules/marlin_fm.ko \| grep description=` |

The last row is **the most critical one**: the driver author states in writing that FM and BT/WiFi **share SDIO**.
This determines that all of FM's availability dependencies (firmware, power-up) are bound together with WiFi/Bluetooth.

### 1.2 What "Shared SDIO" Means

| Impact area | Description |
|---|---|
| **Firmware** | `download` burns the combo firmware as a whole in one go, **including the FM part**. There is no independent FM firmware process |
| **Power-up** | There is no independent FM power-up switch; the chip simply needs to be powered as a whole (it depends on the `wcnd` / BT-OPEN chain) |
| **Bandwidth** | SDIO is a shared bus, so high WiFi throughput may theoretically affect the FM data stream; **this needs evaluation by measurement** |
| **Fault coupling** | If WiFi dies ⇒ SDIO does not enumerate ⇒ FM is necessarily unavailable. **Troubleshooting must confirm WiFi first** |

---

## 2. Software Layering (Five-Layer Model)

```
⑤ UI 层      LVGL 收音机页         ← 本项目新增主体
      │ unix socket /tmp/fm_ctl.sock
④ daemon 层  fm_radio_daemon       ← 本项目新增，独占 /dev/fm
      │ ioctl / AT 命令
③ 驱动层      marlin_fm.ko → /dev/fm (misc 23)   ← 已存在
      │ SDIO 事务
② 固件层      Marlin2 combo 固件（含 FM）        ← 随 WiFi 一起烧好
      │ SDIO 物理链路
① 硬件层      Marlin2 芯片 FM 部件               ← 已存在
```

**The "pass criteria" corresponding to each layer** (this is the basis for layered troubleshooting):

| Layer | Pass criterion |
|---|---|
| ① Hardware | `cat /sys/bus/sdio/devices/*/device` yields `0x2331` |
| ② Firmware | WiFi can come up (`download` stays resident) |
| ③ Driver | `lsmod \| grep marlin_fm`, `ls /dev/fm`, and `grep -w fm /proc/misc` yields `23 fm` |
| ④ daemon | `connect /tmp/fm_ctl.sock` succeeds and `state` returns `OK *` |
| ⑤ UI | Can tune stations, hear sound, and return to the desktop without stopping playback |

---

## 3. The Boundary of Capabilities Provided by the Driver: Command List and RDS

### 3.1 Control Commands (from the Debug Prints of `strings marlin_fm.ko`)

The driver prints `----<命令名>----` for each ioctl branch; the commands are recovered accordingly:

| Category | Commands |
|---|---|
| Basic | `TUNE`、`TUNE_NEW`、`SEEK`、`SEEK_NEW`、`MUTE`、`SETVOL`、`GETVOL`、`IS_FM_POWERED_UP` |
| Scan | `SCAN`、`SCAN_NEW`、`STOP_SCAN`、`SCAN_GETRSSI`、`PRE_SEARCH`、`RESTORE_SEARCH` |
| Signal | `GETRSSI`、`GETMONOSTERO`、`SETMONOSTERO`、`SOFT_MUTE_TUNE`、`DESENSE_CHECK`、`IS_DESE_CHAN`、`CQI_GET`、`FULL_CQI_LOG` |
| Audio | `ANA_SWITCH`、`I2S_SETTING`、`GET_I2S_INFO`、`GET_AUDIO_INFO`、`OVER_BT_ENABLE` |
| RDS | `RDS_SUPPORT`、`RDS_ONOFF`、`RDS_GROUPCNT`、`RDS_BC_RST` |
| Information | `GETCHIPID`、`GET_HW_INFO`、`GETCAPARRAY`、`GETCURPAMD`、`GETGOODBCNT`、`GETBADBNT`、`GETBLERRATIO` |
| Mass-production debugging | `RW_REG`、`TOP_RDWR`、`HOST_RDWR`、`DUMP_REG`、`EM_TEST`、`SIM_DATA`、`GET_LOG` |

> ✅ **Update (2026-09-22)**: the command numbers have been **fully reverse-engineered and confirmed by measurement**; see
> [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md).
> The encoding is unified as `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`, with 45 of the 47 commands passing measurement.
> This section is retained as a **functional-perspective** classification; for the actual numbers, consult that document.

### 3.2 AT Command Style — Confirmed by Measurement, and It Is Real

The driver contains two functions, `parse_at_fm_cmd` / `parse_at_fm_num`; on the Android side, `libengfm.so` exports only one symbol, `fm_runcommand`
(literally translated, "run an FM command").

**This is not speculation; AT frames have actually been captured**. The complete kernel log when calling `TUNE`:

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_write-348 -- fm_write_completion done=0X0
FM_DRV: fm_write_buf-337 -- * fmdev->write_buf: at+fm=1,0 *
fm_sdio_write size: 11
```

Conclusions:

1. What the driver sends over SDIO is indeed **AT text**, in the format **`at+fm=<opcode>,<param>`**
   (`at+fm=1,0` is 10 characters + NUL = 11 bytes, which matches `fm_sdio_write size: 11`).
2. **The AT opcode and the ioctl nr are two separate numbering schemes**: the ioctl nr of `TUNE` is `0x02`, but its AT opcode is `1`.
   So far only `power up -> at+fm=0` and `TUNE -> at+fm=1,<freq>` have been confirmed. **The full AT table is not yet calibrated; do not mix the two schemes**.
3. Another byproduct: **`TUNE` is a blocking call**, and the failure path takes about **3.99 s** (the log timestamp span
   `11448.618` → `11452.613`). Therefore the daemon must run TUNE/SEEK on a dedicated thread, and the socket must have timeouts set.

### 3.3 RDS — The Differentiating Value of This Project

`nm marlin_fm.ko` reveals a complete RDS parser:

| Field | Function | Length/meaning |
|---|---|---|
| **PS** | `rds_get_ps` | Station name, **8 characters** |
| **RT** | `rds_get_rt` | Radio text, **64 characters** (scrolling subtitles) |
| PTY | `rds_get_pty` | Program type (news/classical/rock…) |
| PI | `rds_get_pi_code` | Program identification code |
| **AF** | `rds_get_af` / `rds_get_af_method` | **Alternative frequencies** — automatically switch to another frequency of the same program when the signal degrades |
| TP/TA | `rds_get_tp_ta` | Traffic program / traffic announcement |
| CT | `rds_get_ct` | Station clock |
| DI/MS | `rds_get_di_ms` | Decoder identification / music-speech |
| **EWS** | `rds_get_ews` | **Emergency broadcast** (has compliance significance) |
| PTYN / PIN / SLC | `rds_get_ptyn` / `rds_get_pin` / `rds_get_slc` | Program type name / item number / SLC |
| ODA / TDC | `rds_get_oda` / `rds_get_oda_aid` / `rds_get_tdc` | Open data application / transparent data channel |
| EON | `rds_get_eon` / `rds_get_eon_ta` | Enhanced other network information |

**This means the radio app is not merely "able to make sound", but can display station names, scrolling text, and program types, and can even track frequencies automatically**.
When designing the UI, be sure to make use of these capabilities; do not degenerate it into an interface with only frequency digits.

---

## 4. How Native Android Does It (Reference Sample)

The vendor Android partition is mounted at `/mnt/android_sys` on the device and can be browsed directly:

| Component | Path | Description |
|---|---|---|
| FM HAL audio source | `/mnt/android_sys/lib/libFMHalSource.so` | The `android::FMHalSource` class |
| Engineering mode library | `/mnt/android_sys/lib/libengfm.so` | **Exports only `fm_runcommand`** |
| JNI bridge | `/mnt/android_sys/lib/libfmjni.so` | Java ↔ native |
| Broadcast services | `libradio.so` / `libradioservice.so` / `libradio_metadata.so` | The standard broadcast radio HAL stack |
| Service APK | `/mnt/android_sys/priv-app/radio_interactor_service/` | Upper-layer service |
| Driver | `/mnt/android_sys/lib/modules/marlin_fm.ko` | The same copy loaded on this device |

### 4.1 The Audio Architecture Read from `libFMHalSource.so`

`nm -D` shows that the class holds:

- **`pcmHandle`** (tinyalsa PCM handle)
- `mSamplerate` / `mPeriodSize` / `mPeriodCount` / `mChannel`
- A background thread `FMHalThread::threadLoop()`
- A `RingBuffer` (`GetData/PutData/GetBuf/PutBuf/BufCount`)

**Conclusion**: the Android side is a typical audio pipeline that **starts a thread to read data from PCM, passes it through a ring buffer, and then hands it to the audio output**.
The daemon we write ourselves on Alpine essentially has to replicate this same chain (though a simpler implementation can be used).

### 4.2 Why These Libraries **Cannot Be Directly Reused**

They depend on the Android runtime (Android infrastructure such as binder, `sp<>` smart pointers, `ALooper`, and `RingBuffer`),
and **cannot run when dynamically loaded** on Alpine. They can only serve as a **reference sample / source of facts**, not as reusable components.

---

## 5. Our Approach: Replacing an Entire Stack with Minimal Code on Alpine

### 5.1 Design Trade-offs

| Decision | Choice | Reason |
|---|---|---|
| Whether to rewrite the FM protocol stack | **No** | It is already implemented inside the chip; we only send commands |
| Control channel | Write an FM daemon that exclusively owns `/dev/fm` | Avoids multi-process contention; consistent with the approach of the Bluetooth daemon |
| External interface | unix socket + plain-text commands | Fully mirrors the existing `bt_user_daemon` (`/tmp/bt_ctl.sock`), minimizing the team's learning cost |
| Audio output | Try the internal codec passthrough first (`ANA_SWITCH`) | I2S and Over-BT serve as alternatives, **pending measurement** |
| UI carrier | LVGL radio page | Homogeneous with the desktop's other apps |

### 5.2 Why "Mirroring bt_user_daemon" Is the Right Choice

The Bluetooth daemon is already a pattern validated by the team:

```
unix socket /tmp/bt_ctl.sock，文本命令，chmod 0666
    发 "state"  → 回 "OK ON" / "OK OFF"
    发 "on"     → 回 "OK ON"
    发 "off"    → 回 "OK OFF"
```

FM copies this set exactly: **it likewise reduces the cognitive burden of some inexplicable new protocol, and the pitfalls of socket timeouts and reconnection have already been encountered once**.

### 5.3 The Pitfall You Must Remember: Socket Timeout

> 🔒 When performing socket I/O inside an LVGL timer callback, you **must** set `SO_RCVTIMEO` / `SO_SNDTIMEO` (200ms recommended).
> Otherwise, once the daemon stops responding, **the entire UI thread freezes**. This is a hard lesson already learned on this project's Bluetooth page; FM must not step into it again.

---

## 6. Audio Path: Three Possibilities, One Must Be Chosen by Measurement

Measured ALSA topology of this device:

```
0 [alli2s]       00-00~00-03: i2s.0~i2s.3 null-codec-dai-N   playback + capture
1 [sprdphone]    01-00 HiFi sprd-codec-i2s-0                  playback + capture
                 01-01 Voice sprd-codec-vaudio-1              playback + capture
                 01-02 AuxRecord                              capture
                 01-03 AuxDSPCaptrue                          capture
                 01-04 Dfm sprd-codec-fm-4                    playback  ← FM 专用！
2 [saudiovoip]   ...
3 [saudiolte]    ...
```

The three corresponding driver ioctls:

| Path | ioctl | Status |
|---|---|---|
| Analog/internal codec passthrough | `ANA_SWITCH` | Default candidate |
| I2S | `I2S_SETTING` / `GET_I2S_INFO` | Alternative |
| FM audio over Bluetooth | `OVER_BT_ENABLE` | Semantics to be confirmed |

**Current tooling**: this device has `libasound.so.2`, but **does not have** `amixer` / `tinymix` / `aplay`
→ **mixer adjustments cannot be done from the command line; C code must be written**.

**Not yet confirmed** (must not be treated as fact):
1. Whether FM requires headphones to be plugged in as the antenna (the existence of `01-04` suggests it may not, but this needs measurement);
2. The exact semantics of `OVER_BT_ENABLE`;
3. Whether `SETVOL` is the FM module's internal gain or the main output volume.

---

## 7. Three Words: Uncertainty

The key items in this Wiki that have **not yet been measured** must be confirmed one by one before formal work begins (listed together here for easy comparison):

| # | Item to confirm | Impact |
|---|---|---|
| 1 | ioctl **command numbers** | Block the entire workflow; without them, no commands can be sent |
| 2 | Whether it depends on the headphone antenna | Determines whether the UI needs a "please insert headphones" state |
| 3 | `OVER_BT_ENABLE` semantics | Determines the channel arbitration logic |
| 4 | `SETVOL` scope | Determines the volume control chain |
| 5 | RSSI raw value units and thresholds | Determines how the signal bar is drawn |
| 6 | FM behavior during system suspend | Determines whether "continued listening with the screen off" is possible |

> This list is itself a deliverable: **stating clearly "what is known and what is not" has more engineering value than pretending to know everything.**

---

## 8. Troubleshooting Methodology (Follow This When Migrating)

1. **Layer first**: ①② firmware/power-up → ③ driver → ④ daemon → ⑤ UI. If any layer is not working, do not guess at the layers above.
2. **Let the nodes speak**: `lsmod` / `ls /dev/fm` / `/proc/misc` / `sdio device` — these four commands determine life or death.
3. **Whether ioctls are correct is seen in dmesg**: the driver prints `----<命令名>----`, which is the only direct evidence for judging whether the command number mapping is correct.
4. **Audio must not be judged from logs**: it must be listened to by human ear.
5. **When the UI freezes, first suspect socket blocking**: check whether timeouts are set.

---

## 9. General Checklist for Migrating to Similar Devices

To migrate this FM solution to another similar device (Unisoc Marlin series), do the following in order:

1. **Confirm SDIO enumeration**: `cat /sys/bus/sdio/devices/*/device`, and check whether the device id matches.
2. **Confirm the driver**: `lsmod | grep <fm driver name>`, `ls /dev/<fm node>`.
3. **Confirm the sharing relationship**: `strings <fm driver>.ko | grep description=`, and find out whether it shares SDIO with WiFi/BT.
4. **Pull the command list**: `strings <driver>.ko | grep -- '----'`, plus `nm <driver>.ko | grep ' T '`.
   **Going one step further — reverse-engineer the command numbers as well**: use `file <driver>.ko` to see whether it is `not stripped`,
   then `objdump -d --disassemble=<ioctl function>` and read the constants in the binary search tree.
   If the driver prints `----<命令名>----`, confirm each one by measurement using "single-step calls with all-zero parameters + clearing the log with `dmesg -c`".
   **If you can figure it out yourself, do not list it as something "to be requested from the original manufacturer".**
5. **Confirm the audio topology**: `cat /proc/asound/pcm | grep -i fm`.
6. **Find the userspace gap**: is there an off-the-shelf FM tool? (This device has none; you need to write your own daemon)
7. **Mirror the existing daemon pattern**: copy the usage of the socket daemon whose success has already been validated on this device.
8. **Run through the six pending confirmation items in §7 again** — the answers may differ on different devices, so **do not copy this device's conclusions verbatim**.

---

## 10. What This Wiki Wants You to Remember

> **FM is "already there", not "something to be built".**
>
> FM is in the chip, FM is in the firmware, FM is lying in the driver, and even the RDS parser is already written —
> there are only three engineering tasks we really have to do: **wrap the operations on `/dev/fm` into a daemon, connect the audio to the codec, and draw a UI that can use RDS**.
>
> **And the matter of "information gaps" is much easier to solve than imagined.**
> Initially we listed "cannot obtain the ioctl command numbers" as the number one hard blocker, and were even prepared to beg the original manufacturer for the header file.
> In the end we discovered: the `.ko` is **not stripped**, and the command numbers lie in plain sight in the machine code;
> plus the driver prints each command's name into the kernel log, so **locating candidates via disassembly + single-step measurement with all-zero parameters** nailed down all 47 commands.
>
> So the first priority is not "go ask for the header file", but rather — **first check whether it is needed at all**.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
