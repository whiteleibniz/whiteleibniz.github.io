---
title: "FM radio bring-up: deployment and delivery document"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-10-fm-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM radio bring-up — deployment and delivery document

> **Audience**: engineers taking over deployment/maintenance
> **Note**: this document describes the **target delivery state**. Currently (2026-09-22) we are at the **design and planning complete, not yet implemented** stage;
>   items marked "已存在" in the text are measured and confirmed, while items marked "待产出" are the deliverables to be created in this round
> **Core value**: it states in one go "exactly what is to be delivered, where it goes, and how to verify it"

---

## 1. Full chain picture (who brings up whom)

```
开机 openrc
 │
 ├─ logdw
 ├─ download（常驻）          ← 【已存在】烧入 Marlin2 combo 固件（含 FM）
 ├─ wcnd（上电管理）          ← 【已存在】
 ├─ bt_once(BT-OPEN)          ← 【已存在】使芯片整体带电
 ├─ bt_wake.sh                ← 【已存在】周期唤醒
 ├─ bt_user_daemon            ← 【已存在】/tmp/bt_ctl.sock
 │
 ├─ fm_radio_daemon           ← 【待产出】独占 /dev/fm → /tmp/fm_ctl.sock
 │                                        ★ 唯一新增后台组件
 └─ lvgl_demo                 ← 【已存在】新增收音机页 g_radio_page → socket
```

**Key dependency**: `fm_radio_daemon` must be ordered **after** the WiFi/power-up chain.
Because FM shares SDIO with WiFi/Bluetooth (the driver states `share SDIO with BT/WIFI`), every command fails when the chip is not powered.

---

## 2. Artifact inventory

### 2.1 Device side (already exists, verified by measurement → do not implement again)

| Item | Current state | Verification command |
|---|---|---|
| SDIO enumeration | ✅ `0x2331` | `cat /sys/bus/sdio/devices/*/device` |
| FM driver `marlin_fm` | ✅ loaded | `lsmod \| grep marlin_fm` |
| `/dev/fm` node | ✅ misc 23 | `grep -w fm /proc/misc` |
| `/dev/log_radio` | ✅ misc 35 | `grep log_radio /proc/misc` |
| RDS parsing capability | ✅ built into the driver | `nm /lib/modules/marlin_fm.ko \| grep rds_` |
| FM PCM | ✅ `01-04 Dfm sprd-codec-fm-4` | `cat /proc/asound/pcm \| grep -i fm` |
| Android reference libraries | ✅ `/mnt/android_sys/lib/*.so` | `ls /mnt/android_sys/lib/libfm*` |
| FM user-space tools | ❌ **do not exist** | `ls /usr/bin \| grep fm` (no output) |

### 2.2 To be produced (this round's deliverables)

| Type | File | Placement |
|---|---|---|
| **Header file** | `fm_ioctl.h` (the command numbers have been reconstructed and it can be generated directly) | device `/home/lvgl_demo/lvgl_demo/libs/fm/` |
| **daemon source** | `fm_radio_daemon.c` | same as above + archive to `AI工作流/03_收音机/src/` |
| **LVGL page** | `radio_page.c` / `radio_page.h` | device `lv_pages/` + archive to `src/` |
| **Auto-start script** | `fm_radio.start` or openrc service | archive to `AI工作流/03_收音机/deploy/` |
| **Configuration** | `/etc/fm_radio.conf` (last frequency/volume/favorites) | device runtime; the source includes a default template |
| **Documentation** | 8 documents in this document family | `AI工作流/03_收音机/docs/` |

> ⚠️ Project convention: **only final artifacts that can be deployed and run directly are collected**; temporary probe scripts are not archived.
> Therefore the `deploy/` and `src/` directories are **populated only after the implementation produces output**; no empty directories are created now just to fill space.

### 2.3 Three changes to existing code

Per `FM收音机_LVGL界面设计与交互规格.md` §3.2:

1. `lv_pages/launcher_page.c`: new include
2. `lv_pages/launcher_page.c`: insert the radio into the `s_apps[]` array after the Bluetooth item
3. `lv_pages/launcher_page.c`: add `case LAUNCHER_APP_RADIO:` to the `open_app` switch

Files not to be changed: `main.c` (**note it is this repo's only CRLF file; it is unaffected this round**),
`lv_pm/lv_page_manager.h`, and the already-brought-up WiFi/Bluetooth chain.

---

## 3. New device deployment steps (from scratch)

### Step 0 Low-level health check (everything must be green)

```sh
cat /sys/bus/sdio/devices/*/device        # expect 0x2331
lsmod | grep marlin_fm                    # expect loaded
ls -l /dev/fm                             # expect the node to exist
ps | grep '[d]ownload'                    # expect resident
ip link show wlan0 | grep -o 'state [A-Z]*'   # expect UP/DORMANT
```

If any item does not match → go back to `01_WiFi打通/docs/WiFi芯片打通操作手册.md` and **do not continue**.

### Step 1 Obtain the ioctl command numbers (**completed**)

> For the results, see [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md); you can write `fm_ioctl.h` directly from them.

Following the three routes in §8 of `FM收音打通_AI指导手册.md` (vendor header files / Android library reverse-engineering / controlled probing),
produce `fm_ioctl.h`. **Without this step, nothing after it can begin.**

### Step 2 Compile and deploy the FM daemon

```sh
scp fm_radio_daemon.c fm_ioctl.h root@<设备IP>:/tmp/
ssh root@<设备IP> 'cd /tmp && gcc -O2 -Wall -o fm_radio_daemon fm_radio_daemon.c -lpthread'
ssh root@<设备IP> 'install -m 755 /tmp/fm_radio_daemon /usr/local/bin/fm_radio_daemon'
ssh root@<设备IP> '/usr/local/bin/fm_radio_daemon > /tmp/fm_daemon.log 2>&1 &'
ssh root@<设备IP> 'ls -l /tmp/fm_ctl.sock'      # expect a socket with permissions 0666
```

### Step 3 Socket smoke test

```python
# 设备端 python3（本机没有 socat）
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c+"\n").encode()); time.sleep(0.2)
    return s.recv(4096).decode().strip()
for c in ["state","open","tune 97400","rssi","vol 8"]:
    print("%-12s -> %s" % (c, cmd(c)))
```

Expected: `OK OFF` → `OK ON` → `OK 97400` → `OK <value>` → `OK 8`.

### Step 4 Audio output (**confirmed by human ear; logs are not an acceptable substitute**)

```sh
# 依次三条路径，每条都要实际听
#   1) ANA_SWITCH（默认候选）
#   2) I2S_SETTING
#   3) OVER_BT_ENABLE
```

At the same time, confirm: **whether headphones must be plugged in as the antenna** (tune to the strongest station without headphones and listen).

### Step 5 Compile and deploy the LVGL radio page

```sh
cd /home/lvgl_demo/lvgl_demo
cp /tmp/radio_page.c /tmp/radio_page.h lv_pages/
# 改 launcher_page.c 三处（见 §2.3）
make -j2 > /tmp/mk.log 2>&1; echo "MAKE_RC=$?"
grep -E 'error:' /tmp/mk.log | head -20
cp -f build/lvgl_demo /usr/local/bin/lvgl_demo && sync
killall -9 lvgl_demo; sleep 0.5
nohup /usr/local/bin/lvgl_demo > /tmp/lvgl_run.log 2>&1 &
```

> ⚠️ To judge whether make succeeded, **do not** use `make | tail`'s `$?` (that is tail's exit code); you must use `make > log 2>&1; echo MAKE_RC=$?`.

### Step 6 Boot-time auto-start

See the openrc service in §7 of `FM收音芯片打通_操作手册.md`; be sure to declare in `depend()` that it is ordered after the WiFi/power-up chain.

---

## 4. Verification criteria (all met = deployment successful)

| # | Item | Criterion | Basis |
|---|---|---|---|
| 1 | Low level | SDIO/driver/node all three OK | §Step 0 commands |
| 2 | daemon | the four basic socket commands work | Step 3 expected output |
| 3 | Tuning | can TUNE to a locally known strong-signal station | `OK <freq>` |
| 4 | **Sound output** | **the broadcast is heard by human ear** | logs are not an acceptable substitute |
| 5 | Station seeking | seek can find the next station; scanning shows progress and can be interrupted | UI behavior |
| 6 | Signal strength | RSSI varies with frequency and is discriminating | thresholds must be calibrated first |
| 7 | Channel arbitration | switching between any two of FM/A2DP/local has **no cross-talk** | human ear |
| 8 | Background playback | returning to the desktop does not stop the station | human ear |
| 9 | UI | the desktop icon is after Bluetooth; the frequency/dial/favorites display correctly | human eye (including the icon glyph, not a tofu block) |
| 10 | Auto-start | automatically available after reboot | reboot verification |

> Among them, **items 4, 7, and 9 must be confirmed by human eye/ear** — this project's troubleshooting discipline explicitly does not accept "log OK" as a pass criterion.

---

## 5. This round's "known unknowns" (an honest list)

When taking over the deployment, read this table first; these are items that are **not yet confirmed** and must not be treated as established facts:

| # | Unknown item | Why it matters |
|---|---|---|
| 1 | ~~ioctl command numbers~~ | **resolved** (see "FM收音ioctl命令表_逆向还原") |
| 2 | Whether it depends on the headphone antenna | determines whether a "please insert headphones" UI state is needed |
| 3 | `OVER_BT_ENABLE` semantics | determines the arbitration logic |
| 4 | Whether `SETVOL` is module gain or master volume | determines the volume chain |
| 5 | The dimension and thresholds of the raw RSSI values | determines how the signal bar is drawn |
| 6 | FM behavior on system suspend | determines the feasibility of "keep listening with the screen off" |
| 7 | Whether a 48px large-font bitmap is needed | determines the main frequency display effect |

---

## 6. One-line summary

> **Three layers are ready, two layers remain to be built**. The firmware/driver/device nodes are all already present;
> what this round actually needs to deliver is these three: **`fm_radio_daemon` (including `fm_ioctl.h`) + the LVGL radio page + openrc auto-start**;
> the precondition for starting, the **ioctl command numbers**, has been obtained by self-reverse-engineering,
> and **this project currently has no blockers**, so implementation can begin directly.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
