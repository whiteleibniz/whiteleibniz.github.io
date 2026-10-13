---
title: "FM radio: field-tested conclusions on SEEK and signal strength"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-05-fm-seek-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM radio: field-tested conclusions on SEEK / signal strength / AT text direct writes

> Device: Spreadtrum SC9832A (Alpine Linux / armv7l), FM chip Unisoc Marlin2 combo,
> driver `marlin_fm.ko`, node `/dev/fm`, ioctls uniformly encoded as `_IOWR(0xF5, nr, 4) = 0xC004F500 | nr`.
> Tested on: 2026-09-22. **All conclusions come from on-device tests; the arbiter of truth is the driver's own dmesg (`fm_write_buf` / `parse_at_fm_cmd`).**

---

## 0. Summary in one table

| What you want to do | Feasible? | Reason |
|---|---|---|
| Power-up / tuning / volume / mute | ✅ | `POWER_UP(0x00)` / `TUNE(0x02)` / `SETVOL(0x04)` / `MUTE(0x06)` really send SDIO |
| **Station seeking (next station)** | ❌ | the driver truncates `SEEK(0x03)`'s start frequency to 1 byte, so in-band frequencies cannot be passed in; field tests show only 2 fixed return values |
| **Reading the signal strength** | ❌ | `GETRSSI(0x07)`, the only signal-class command that really sends SDIO, always times out after 4.2s and its return value barely changes; all other signal-class commands are empty shells |
| **Writing AT text to bypass the ioctl** | ❌ | `write(/dev/fm)` always returns `-1 / EINVAL(22)`; the driver does not accept AT text from user space |

---

## 1. `SEEK (0x03)` — the parameter is truncated, so it cannot be used for station seeking

### 1.1 Parameter structure (same as TUNE)
```c
typedef struct {
    unsigned char  zero;   /* offset 0 */
    unsigned char  band;   /* offset 1 */
    unsigned char  one;    /* offset 2 */
    unsigned char  pad;    /* offset 3 */
    unsigned short freq;   /* offset 4-5  —— unit 0.1MHz (974 = 97.4MHz) */
    unsigned char  tail[26]; /* offset 6 onward */
} fm_arg_t;
```

### 1.2 The AT frames the driver actually sends

The driver takes **only the low byte** of `freq` (u16) when assembling the AT frame (this is a driver bug):

| freq we pass | What the driver actually sends | Chip response frame | The "found frequency" the driver writes back to `tail[0..1]` |
|---|---|---|---|
| 974 (97.4MHz) | `at+fm=4,0,206` | `3,139,0,9250` | **925 = 92.5MHz** |
| 875 (87.5MHz) | `at+fm=4,0,107` | `3,139,0,9250` | **925** |
| 1080 (108.0MHz) | `at+fm=4,0,56` | `3,139,0,9250` | **925** |
| 900、1000 | `at+fm=4,0,132` / `,232` | `3,139,0,9250` | **925** |
| **0** | `at+fm=4,0,0` | `3,139,0,10310` | **1031 = 103.1MHz** |

- In `at+fm=4,<p2>,<p3>`, **p2 is always 0**: changing `zero/band/one/pad` all to 1/2 makes no difference.
- **p3 = `freq & 0xFF`**, so in-band frequencies (875~1080) can never be passed in.
- The result is **independent of the "current frequency"**: first `TUNE` to 87.5 / 97.4 / 100.0 / 103.1, then `SEEK(0)`,
  and all four calls return **103.1**.

### 1.3 Behavioral model
- `p3 == 0`  → always returns **the opposite extreme of the 92.5MHz band** (103.1MHz)
- `p3 != 0`  → always returns **92.5MHz**

In other words, SEEK degenerates into "pick one of two fixed values"; it is **not "search up/down from the current frequency for the next station"**.
**Do not** turn it into a "seek stations" button in the UI.

- Timing: about **1.43 s** per call (`at+fm=4` sent → `parse_at_fm_cmd: fm seek event have come freq=...`).
- The value in the driver log line `FM seek freq =0` is **always 0**, regardless of the freq passed in → do not use it as a criterion.
- `SEEK_NEW(0x3d)` only prints a log and then sends `at+fm=12` (a generic query frame); `SCAN(0x08)` / `SCAN_NEW(0x3c)`
  return 0 with **zero SDIO traffic** → all are empty shells/placeholders.
- `STOP_SCAN(0x09)` always returns `-1 / EINVAL(22)`.

### 1.4 Probes
- `ssh_tools/fm_seek_probe.c` + `fm_seek_probe_run.py` — parameter variant matrix + write-back structure dump
- `ssh_tools/fm_seek_probe2.c` + `fm_seek_probe2_run.py` — start point/direction semantics verification (together with TUNE)

---

## 2. `write(/dev/fm)` writing AT text — rejected by the kernel

The driver contains `parse_at_fm_cmd` / `parse_at_fm_num`, and on the Android side `libengfm.so` exports only
one symbol, `fm_runcommand`, so it looks as though "you can write AT text directly to bypass the ioctl". **Field tests say no**:

```
write(fd, "at+fm=1,9250", 12)  -> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=4,0,9740", 15)-> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=4,1,9740", 15)-> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=12", 8)       -> rc=-1 errno=22 (EINVAL)
```
dmesg contains **no `fm_write_buf` record at all** → the request was rejected before entering the driver, with no SDIO traffic.
**Conclusion: this path does not work; do not spend time on it.** Probe: `ssh_tools/fm_at_probe.c` + `fm_at_probe_run.py`.

---

## 3. Signal strength / signal-class commands — none of them usable

| Command | Command number | Field-test verdict |
|---|---|---|
| `GETRSSI` | 0x07 | **the only one that really sends SDIO** (`at+fm=13`); the chip replies 123~125, but the ioctl **always returns `-1 / ETIMEDOUT(110)` and always takes 4.2s**; the return value barely changes across 10 frequencies → cannot serve as a signal strength table |
| `SCAN_GETRSSI` | 0x24 | empty shell (printk only) |
| `CQI_GET` | 0x27 | empty shell |
| `GETMONOSTERO` | 0x0d | empty shell |
| `GETGOODBCNT` / `GETBADBNT` | 0x0f / 0x10 | empty shell |
| `GETBLERRATIO` | 0x11 | empty shell |
| `IS_DESE_CHAN` | 0x2a | empty shell |
| `SOFT_MUTE_TUNE` | 0x3f | has an effect (suppresses pops when changing stations), but **does not write back a usable signal strength** |

**The second field in the `TUNE` response is not the signal strength**: `at+fm=1,9740` → `0,164,0,9740`;
tuning the same frequency repeatedly yields two different values, 164 and 139; different frequencies all land near 139~140;
**and the driver does not write this response back to user space at all** (after the ioctl returns, the arg structure is unchanged).
→ Verdict: it is not a stable signal strength indicator and cannot serve as a signal table.

**Downstream impact**: the radio page **should no longer** draw a "signal bar".
The current version has been changed to the fixed text "this device does not provide signal strength queries", and the `rssi` polling after every tune has been **removed** (it used to waste 4.2s each time).

---

## 4. Related: FM audio output is dead as well

See `FM收音ioctl命令表_逆向还原.md` and `outputs/FM收音机_进度快照_20260922.md`:
- FM audio-class ioctls (`OVER_BT_ENABLE 0x1d` / `ANA_SWITCH 0x1e` / `I2S_SETTING 0x21` …)
  in `marlin_fm.ko` **just printk and return** (disassembly of `fm_ioctl` shows `R_ARM_CALL` calling only 7 functions, with no audio path functions).
- The whole-device codec (`sprdphone` card1) DAPM **route table is missing HPL/HPR/SPKL/SPKR**,
  the only reachable endpoint is `EAR`, and it never powers up `Analog/Digital Power` (`bias_level=Off` stays Off).
- All 8 capture devices **return `readi -5 (EIO)`**; `read(/dev/fm)` only returns a 688B RDS data block.
→ **FM audio can neither make sound nor be digitized into the host**. There is no solution in user space.

---

## 5. Constraints for the app design (copy directly)

1. **Do not provide a "seek stations" button in the UI** — SEEK is uncontrollable and would make people think a station was found.
2. **Do not draw signal strength in the UI** — the hardware does not provide it; drawing it would be lying.
3. **Do not poll `rssi`** — each poll wastes 4.2s.
4. **Do not try writing AT text** — EINVAL.
5. The usable and verified feature set: `state / on / off / tune <kHz> / vol <0-15> / mute <0|1> / chipid / rds`.
6. For any decision on "should we modify the kernel for this", first read §4 of this article — the bottleneck for audio output lies in the codec's DAPM route, not in the FM driver.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
