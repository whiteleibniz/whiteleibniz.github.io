---
title: "FM radio ioctl command table: reverse-engineered reconstruction"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-06-fm-ioctl-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# Spreadtrum SC9832A FM radio — reverse-engineered reconstruction of the ioctl command table (with field-test confirmation)

> **Audience**: engineers responsible for the FM daemon / UI; engineers who want to reuse this technique when connecting other peripherals later.
> **How to use**: when writing `/dev/fm`-related code, **look up the command numbers directly in the tables in this article**; do not guess again, and do not wait for the vendor's header files again.
> **Core value**: it turns the former "number one blocker" into a **constant table you can code directly**, and provides a reusable forensics method.

---

## 0. One-line summary

> `marlin_fm.ko` is **not stripped**, and the command numbers are written right in the machine code of `fm_ioctl()`.
> All commands are uniformly encoded as **`_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`**;
> of the 47 commands, **45 have been confirmed by on-device tests (the kernel log printed the command names)**, and the other 2 were inferred by static disassembly.
> **The only hard blocker has been removed; you can start writing the daemon.**

---

## 0.1 ⚠️ Important corrections (added 2026-09-22, read before use)

The command number table itself is **still accurate**, but the following three **capability-level conclusions have been overturned by later field tests**; do not design according to the old conclusions:

| Old conclusion (original draft of this article) | Field-test correction |
|---|---|
| `SCAN 0x08` + `SCAN_GETRSSI 0x24` are usable and can draw a spectrum/signal strength | ❌ **Both are empty shells**: the calls return 0 but with **zero SDIO traffic**; `GETRSSI 0x07` is the only signal-class command that really sends SDIO, but it always returns `ETIMEDOUT` after 4.2s with a barely changing return value → **this device cannot obtain a trustworthy signal strength** |
| `SEEK 0x03` can "search up/down for the next station" | ❌ **The driver truncates the start frequency to 1 byte** (`freq & 0xFF` goes into the AT frame), so in-band frequencies cannot be passed in; field tests show only **two fixed return values, 92.5MHz / 103.1MHz**, independent of the current frequency → **station seeking cannot be implemented** |
| `write(/dev/fm)` can be used to write AT text and bypass the ioctl | ❌ Always `-1 / EINVAL(22)`, with no SDIO traffic at all |

In addition, **audio-class commands such as `OVER_BT_ENABLE 0x1d` / `ANA_SWITCH 0x1e` / `I2S_SETTING 0x21` are all empty shells**
(disassembly of `fm_ioctl` shows `R_ARM_CALL` calling only 7 functions, with no audio path functions).

→ **For detailed field-test data, see `FM收音_SEEK与场强_实测结论.md`.**

---

## 1. Conclusion table (usable directly as `fm_ioctl.h`)

Encoding: `cmd = 0xC004F500 | nr`, i.e. `_IOWR(magic=0xF5, nr, size=4)`.

| nr | Command number | Command name | Confirmation method | Return value measured on this device | Purpose |
|---|---|---|---|---|---|
| 0x00 | `0xC004F500` | `power up` | **measured** | 0 | Power-up (**note: not `TUNE`**) |
| 0x01 | `0xC004F501` | `power down` | **measured** | 0 | Power-down |
| 0x02 | `0xC004F502` | `TUNE` | **measured** | -1 (`ETIMEDOUT`) | Tune to a specified frequency (parameter = frequency) |
| 0x03 | `0xC004F503` | `SEEK` | **measured** | 0 | Search up/down for the next station |
| 0x04 | `0xC004F504` | `SETVOL` | **measured** | 0 | Set the volume |
| 0x05 | `0xC004F505` | `GETVOL` | **measured** | 0 | Read the volume |
| 0x06 | `0xC004F506` | `MUTE` | **measured** | 0 | Mute switch |
| 0x07 | `0xC004F507` | `GETRSSI` | **measured** | 0 | **Signal strength** (UI signal bar) |
| 0x08 | `0xC004F508` | `SCAN` | **measured** | 0 | Full-band scan |
| 0x09 | `0xC004F509` | `STOP_SCAN` | static inference | -1 (no log printed) | Interrupt the scan |
| 0x0a | `0xC004F50A` | `GETCHIPID` | **measured** | 0 | Chip ID (this device returns `0x2341`) |
| 0x0b | `0xC004F50B` | `EM_TEST` | **measured** | 0 | Engineering mode |
| 0x0c | `0xC004F50C` | `RW_REG` | **measured** | 0 | Register read/write (debugging) |
| 0x0d | `0xC004F50D` | `GETMONOSTERO` | **measured** | 0 | Mono/stereo status |
| 0x0e | `0xC004F50E` | `GETCURPAMD` | **measured** | 0 | Current PAMD value |
| 0x0f | `0xC004F50F` | `GETGOODBCNT` | **measured** | 0 | Good block count (audio quality statistics) |
| 0x10 | `0xC004F510` | `GETBADBNT` | **measured** | 0 | Bad block count |
| 0x11 | `0xC004F511` | `GETBLERRATIO` | **measured** | 0 | Block error rate |
| 0x12 | `0xC004F512` | `RDS_ONOFF` | **measured** | -1 | RDS switch |
| 0x13 | `0xC004F513` | `RDS_SUPPORT` | **measured** | 0 | Whether RDS is supported |
| 0x17 | `0xC004F517` | `SIM_DATA` | **measured** | 0 | Simulation data (production testing) |
| 0x18 | `0xC004F518` | `IS_FM_POWERED_UP` | **measured** | 0 | **Whether it is already powered up** (for daemon startup self-check) |
| 0x1d | `0xC004F51D` | `OVER_BT_ENABLE` | **measured** | 0 | **FM audio over Bluetooth** (key to channel arbitration) |
| 0x1e | `0xC004F51E` | `ANA_SWITCH` | **measured** | 0 | **Analog audio path switching** |
| 0x1f | `0xC004F51F` | `GETCAPARRAY` | **measured** | 0 | Capacitance array (hardware calibration) |
| 0x21 | `0xC004F521` | `I2S_SETTING` | **measured** | 0 | **I2S audio path settings** |
| 0x22 | `0xC004F522` | `RDS_GROUPCNT` | **measured** | 0 | RDS group count |
| 0x23 | `0xC004F523` | `GET_LOG` | **measured** | 0 | Fetch the driver log |
| 0x24 | `0xC004F524` | `SCAN_GETRSSI` | **measured** | 0 | **Fetch the signal strength point by point during scanning** (for drawing a spectrum) |
| 0x25 | `0xC004F525` | `SETMONOSTERO` | **measured** | 0 | Force mono/stereo |
| 0x26 | `0xC004F526` | `RDS_BC_RST` | **measured** | 0 | RDS broadcast reset |
| 0x27 | `0xC004F527` | `CQI_GET` | **measured** | 0 | Channel quality |
| 0x28 | `0xC004F528` | `GET_HW_INFO` | **measured** | 0 | Hardware information |
| 0x29 | `0xC004F529` | `GET_I2S_INFO` | **measured** | 0 | Current I2S state |
| 0x2a | `0xC004F52A` | `IS_DESE_CHAN` | **measured** | 0 | Whether it is on a desense channel |
| 0x2b | `0xC004F52B` | `TOP_RDWR` | **measured** | 0 | Top-level register read/write |
| 0x2c | `0xC004F52C` | `HOST_RDWR` | **measured** | 0 | Host-side read/write |
| 0x2d | `0xC004F52D` | `PRE_SEARCH` | **measured** | 0 | Pre-search |
| 0x2e | `0xC004F52E` | `RESTORE_SEARCH` | **measured** | 0 | Restore search |
| 0x30 | `0xC004F530` | `GET_AUDIO_INFO` | **measured** | 0 | **Current audio path state** |
| 0x3c | `0xC004F53C` | `SCAN_NEW` | **measured** | 0 | New version of scan |
| 0x3d | `0xC004F53D` | `SEEK_NEW` | **measured** | 0 | New version of seek |
| 0x3e | `0xC004F53E` | `TUNE_NEW` | **measured** | 0 | New version of tuning |
| 0x3f | `0xC004F53F` | `SOFT_MUTE_TUNE` | **measured** | 0 | **Soft-mute tuning** (no popping when changing stations) |
| 0x40 | `0xC004F540` | `DESENSE_CHECK` | **measured** | 0 | Desense detection |
| 0x46 | `0xC004F546` | `FULL_CQI_LOG` | **measured** | 0 | Full CQI log |
| 0xff | `0xC004F5FF` | `DUMP_REG` | static inference | -1 (no log printed) | Dump registers |

**Statistics**: of the 47 commands, 45 are **confirmed by measurement** (the kernel log printed the command name); 2 (`STOP_SCAN` / `DUMP_REG`) were inferred by static disassembly, return -1 when called, and print no log, so **verify them once more before use**.

### Undefined ranges (calls return -1 with no log)

`nr = 0x14~0x16`, `0x19~0x1c`, `0x20`, `0x2f`, `0x31~0x3b`, `0x41~0x45`, and `0x47~0xfe` have no corresponding branch in the driver;
the `ioctl` takes the "Unknown FM IOCTL!" branch and returns `-EINVAL`.

---

## 2. How the command numbers were derived

### 2.1 Encoding rules

Take any command number and decode it with the `_IOC` macros to verify:

```python
dir_ = (cmd >> 30) & 3        # 3 = READ|WRITE  => _IOWR
size = (cmd >> 16) & 0x3FFF   # 4
type = (cmd >>  8) & 0xFF     # 0xF5
nr   =  cmd        & 0xFF     # command number
# example: 0xC004F509 -> _IOWR(0xF5, 9, 4)
```

**`type` is always `0xF5` and `size` is always `4`**, so the whole command set can be indexed by `nr` alone,
i.e. `#define FM_IOCTL(nr) (0xC004F500 | (nr))`.

### 2.2 Static route: reading the constants from the machine code of `fm_ioctl()`

```sh
file /lib/modules/marlin_fm.ko          # -> not stripped  ← prerequisite
objdump -d --disassemble=fm_ioctl /lib/modules/marlin_fm.ko
```

`fm_ioctl()` was compiled by the compiler into a **binary search**, and each case looks like:

```asm
     d48: ldr  r3, [pc, #1756] @ 142c    ; fetch the 32-bit constant from the literal pool
     d50: cmp  r1, r3                    ; r1 = the cmd passed in by the user
     d64: beq  12e8                      ; jump to the handler on a hit
     d6c: sub  r3, r3, #19               ; the compiler derives the next comparison point nearby with add/sub
     d70: cmp  r1, r3
```

**Two pitfalls you will certainly hit (both actually hit)**:

| Pitfall | Symptom | Correct approach |
|---|---|---|
| **`movw` only modifies the low 16 bits** | taking the value of `movw r3, #62729` alone yields a "half number" like `0xf509` | you must include the high 16 bits (the `movt`, or the result of the preceding `sub` chain); the true value is `0xc004f509` |
| **The print strings are not in `.rodata`** | fetching strings by `.rodata` offset fails | use `objdump -r` to read the relocation table: the format strings for the command names are in **`.rodata.str1.1`** |

**How to extract the command names**: the fixed shape of each handler block is

```asm
     11ac: movw r2, #112           @ __LINE__
     11b0: ldr  r0, [pc, #792] @ 14d0   ; ← the format string, always within the first 6 instructions
     11b4: ldr  r1, [pc, #632] @ 1434   ; ← __func__ "fm_ioctl"
     11b8: bl   printk
```

and the format string template is always `"FM_DRV: %s-%d -- ----<command name>----"`, so a full-string regex extracts the name precisely.

### 2.3 Dynamic route: using dmesg as the "arbiter of truth" (the final criterion)

In the driver, **the first thing every case does is print its own name**, and this `printk` line comes **before the actual handler**,
so even if the handler fails due to invalid parameters, the name is still printed — this is a zero-cost, truth-arbitrable verification:

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_ioctl-112 -- ----GETCHIPID----
```

The probe is minimal (`ssh_tools/fmprobe.c`):

```c
int fd = open("/dev/fm", O_RDWR);
unsigned char arg[64] = {0};          /* all-zero parameters: most handlers return early due to invalid parameters */
int r = ioctl(fd, 0xC004F502 /*TUNE*/, arg);
```

**The correct way to capture kernel logs**: comparing `dmesg | wc -l` before and after is **unreliable** — on this device the `SDIOTRAN` subsystem floods the log at high frequency, and the ring buffer wraps around, causing missed reads (the first version of the scan therefore identified only 12/47).
**You must first clear it with `dmesg -c`, then call, then read**:

```python
subprocess.run(["dmesg", "-c"])            # clear
subprocess.run(["/root/fmprobe", hex(cmd)])# call once
time.sleep(0.25)
body = subprocess.run(["dmesg"], capture_output=True, text=True).stdout
```

After switching to this method, **one scan named 45/47 successfully**.

### 2.4 Cross-validation: search for the same constant in the Android libraries

The vendor Android partition's `libfmjni.so` **contains the same batch of `0xC004F5xx` literals** (18 occurrences found by raw byte search),
which independently confirms from a third party that the encoding is not something we miscalculated:

```python
raw = open("/mnt/android_sys/lib/libfmjni.so", "rb").read()
b = (0xC004F500 | 0x0a).to_bytes(4, "little")   # 0a f5 04 c0
print(b in raw)                                  # True
```

> ⚠️ **Directly grepping `0xc004f5xx` in the objdump text finds nothing** — `movw`/`movt` split it into two instructions.
> Either search the raw bytes, or search for `movt ... @ 0xc004`.

### 2.5 Cross-conclusion of the static and dynamic routes

Static disassembly first produced 47 candidate constants, 31 of which resolved their names directly;
the remaining 16 (`0x02/0x05/0x08/0x0c/0x0f/0x12/0x18/0x1d/0x1f/0x23/0x26/0x29/0x2c/0x30/0x3e/0x46`)
were first inferred based on "the order of the command names in `.rodata` = ascending `nr` order", and then **all were confirmed one by one by measurement, with no errors**.

---

## 3. Incidental finding: the driver actually provides a dual "AT command + ioctl" interface

The complete kernel log captured during a measured TUNE:

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_write-348 -- fm_write_completion done=0X0
FM_DRV: fm_write_buf-310 -- fm start wake marlin
FM_DRV: fm_write_buf-337 -- * fmdev->write_buf: at+fm=1,0 *
fm_sdio_write size: 11
FM_DRV: fm_write-356 -- fm_write_after_completion done=0X0
```

Three confirmable facts:

1. **What the driver sends to the chip over SDIO is AT text**, in the format **`at+fm=<opcode>,<param>`**
   (`at+fm=1,0` is 10 characters + NUL = 11 bytes, matching `fm_sdio_write size: 11`).
2. **The AT opcode is not the ioctl nr**: `TUNE`'s ioctl nr is `0x02`, but its AT opcode is `1`.
   They are two separate numbering schemes; **do not mix them up**.
3. The driver contains `parse_at_fm_cmd` / `parse_at_fm_num`, indicating that `/dev/fm` **also accepts direct `write()` of AT text**
   — this is another way to bypass the ioctl (the fact that `libengfm.so` exports only `fm_runcommand` corroborates this).

> ⚠️ **The full AT opcode table has not been calibrated yet**: only `power up -> at+fm=0` and `TUNE -> at+fm=1,<freq>` are confirmed so far.
> Many commands in the scan print `at+fm=12`, whose semantics are unconfirmed (suspected to be a generic query frame).
> **Until the AT frame of every command has been captured once, the daemon must always use the ioctl, not AT text.**

### 3.1 An important behavior: `TUNE` blocks for about 4 seconds

`TUNE` (with arg=0 at the time, i.e. an invalid frequency) returned `-1 / ETIMEDOUT`, and the log timestamps spanned

```
[11448.618865] ----TUNE----      →  [11452.613128] fm_write_after_completion
```

That is **about 3.99 s**, corresponding to the driver line `seek Timeout(%d sec), fm seek end !`.

**Design implications**:
- TUNE/SEEK in the daemon **must be placed in a separate thread**; the UI thread must not wait synchronously;
- the socket interface must have a timeout set (a pitfall hit on this project's Bluetooth page: `SO_RCVTIMEO`);
- the UI needs a "tuning in progress" state and a timeout fallback.

---

## 4. Direct impact on downstream design

| Previous state | Now |
|---|---|
| `操作手册` Step 2 = "obtain the ioctl command numbers (the number one blocker)" | **This step is complete**; work can start from Step 3 |
| daemon could not be coded | you can directly `#define FM_IOCTL(nr) (0xC004F500 | (nr))` |
| `OVER_BT_ENABLE` / `ANA_SWITCH` semantics unknown | the command numbers are now determined (`0x1D` / `0x1E`), so you can start A/B listening tests to confirm the path |
| no interface for scanning/fetching signal strength | `SCAN 0x08` + `SCAN_GETRSSI 0x24` are usable, and the UI spectrum can be drawn |
| changing stations pops | `SOFT_MUTE_TUNE 0x3F` is usable |

**The daemon's minimal closed loop (P0) needs only 8 commands**:
`IS_FM_POWERED_UP(0x18)` → `power up(0x00)` → `TUNE(0x02)` / `TUNE_NEW(0x3E)` →
`GETRSSI(0x07)` → `SETVOL(0x04)` → `MUTE(0x06)` → `ANA_SWITCH(0x1E)` → `power down(0x01)`.

---

## 5. Confirmed hard facts (no need to re-investigate)

| Item | Value |
|---|---|
| Command encoding | `_IOWR(0xF5, nr, 4)` = `0xC004F500 \| nr` |
| Total number of commands | 47 with branches (45 measured + 2 inferred) |
| Command name print format | `FM_DRV: <func>-<line> -- ----<NAME>----` |
| Command name print timing | **before the actual handler** (hence usable as the arbiter of truth) |
| Device node | `/dev/fm` (misc 10:23) |
| Chip communication | SDIO, AT text `at+fm=<opcode>,<param>` |
| `TUNE` blocking duration | ≈ 3.99 s (failure path, returns `ETIMEDOUT` on timeout) |
| `GETCHIPID` return value | `0x2341` |
| Static tool availability | the device ships with `objdump` / `readelf` / `nm` / `strings` / `gcc` / `python3` |
| Android side | `libfmjni.so` contains the same batch of constants; `libFMHalSource.so` handles PCM (`/dev/snd/controlC%i`) |

## 6. Verified dead ends (do not retry)

| Approach | Result |
|---|---|
| Looking for the FM driver source on the device | ❌ None; `/tmp/linux-3.10.65` is a **vanilla kernel tree** with no Spreadtrum private FM source |
| Looking for `fm.h` / `sprd_fm.h` header files | ❌ None on the whole disk (`find / -name '*.h' \| grep -i fm` only hits unrelated files) |
| Directly grepping the objdump text for `0xc004f5xx` | ❌ the `movw`/`movt` split makes it unfindable; **you must search the raw bytes or search `movt @ 0xc004`** |
| Fetching the command name format strings from `.rodata` | ❌ they are actually in **`.rodata.str1.1`**; you must read the relocation table |
| Comparing `dmesg \| wc -l` before and after to capture logs | ❌ the `SDIOTRAN` flood causes ring buffer wrap-around and silent missed reads; **you must clear first with `dmesg -c`** |
| Reusing the Android FM user-space libraries | ❌ they depend on the Android runtime (`libcutils`/`libutils`/`binder`) and cannot be ported directly |

## 7. Still unconfirmed (do not treat as fact)

| Item | Why it must wait for measurement |
|---|---|
| The full AT opcode table | only 2 confirmed; the semantics of `at+fm=12` are unknown |
| The exact command numbers of `STOP_SCAN` / `DUMP_REG` | static inference, not confirmed by measured prints |
| The structure/dimension of each ioctl's parameters | this round used all-zero parameters and did not calibrate them (e.g. TUNE's frequency unit and step) |
| The value semantics of `ANA_SWITCH` / `I2S_SETTING` / `OVER_BT_ENABLE` | requires **human-ear** A/B listening confirmation |
| Whether it depends on headphones as the antenna | requires a field test tuning to a strong-signal station without headphones plugged in |
| The valid range and thresholds of RSSI | must be calibrated by measurement; **do not copy generic thresholds from the internet** |

---

## 8. Reproduction scripts (engineering scripts outside `AI工作流`)

| Script | Purpose |
|---|---|
| `ssh_tools/fm_ioctl_extract.py` | reverse-engineers command numbers↔names by static disassembly (including fixes for the two pitfalls: the `movw` high bits and `.rodata.str1.1`) |
| `ssh_tools/fm_re_full.py` | command name completeness check + Android library raw-byte cross-validation |
| `ssh_tools/pull_disasm.py` | pulls the `fm_ioctl` disassembly down locally for manual reading |
| `ssh_tools/fmprobe.c` | minimal ioctl probe on the device |
| `ssh_tools/fmprobe_sweep.py` | full measured scan (using the `dmesg -c` clearing method) |
| `ssh_tools/fm_any.c` | generic `/dev/fm` ioctl probe (`fm_any --seq 30:0 29:0`) |
| `ssh_tools/fm_tune_probe.c` + `_run.py` | dumps the 32-byte arg structure written back by the ioctl (to determine what the driver wrote) |
| `ssh_tools/fm_seek_probe{,2}.c` + `_run.py` | SEEK parameter matrix / start point and direction semantics calibration (**see 0.1 and the dedicated article for details**) |
| `ssh_tools/fm_at_probe.c` + `_run.py` | verifies `write(/dev/fm)` writing AT text (conclusion: EINVAL) |
| `ssh_tools/fm_sigcmd_trace.py` | tests signal-class commands under a clean dmesg to see whether there is SDIO traffic |
| `ssh_tools/fm_rssi_sweep.py` / `fm_rssi_trace.py` | multi-frequency RSSI scan / complete driver log of a single tune+RSSI |

> The same technique can be reused directly on peripherals that "have a driver but no source", such as GPS / NFC / sensors.

---

> **One-line summary**: the command numbers were not lost, just hidden in the machine code of the `.ko`;
> **static disassembly to locate candidates + single-step measured calls with all-zero parameters + `dmesg -c` clearing to capture logs** —
> three steps settle all 47 commands. The only hard blocker is removed, and you can start writing the daemon.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
