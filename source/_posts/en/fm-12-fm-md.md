---
title: "FM Radio Chip Bring-Up_Operation Manual"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-12-fm-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# Unisoc SC9832A FM Radio Bring-Up — Manual Operation Guide

> **Audience**: Engineers operating the device hands-on
> **How to use**: Execute Step 0 → Step 6 in order; each step has an "expected output" — if the result does not match, stop and consult `FM收音芯片打通_故障排查手册.md`
> **Core value**: Turns the judgments in the AI guide into commands that can be typed one by one, ensuring that different people get consistent results

---

## 0. Prerequisite Concepts (Build Intuition in 30 Seconds)

**FM radio on this device is not "adding a new piece of hardware", but "bringing out the third function on a chip that already works".**

- Marlin2 is a **WiFi + Bluetooth + FM three-in-one** chip, and the three **share the SDIO bus**.
- When WiFi was brought up, `download` had already burned the **entire combo firmware, including the FM part**, into the chip → **no separate firmware flashing is needed for FM**.
- The `marlin_fm.ko` driver is **already loaded**, and the `/dev/fm` node **already exists**.
- Therefore we **do not need to touch the firmware or the driver**; we only need to write a user-space daemon layer to operate `/dev/fm`, and then draw a UI.

```
已就绪（不要重复做）            本手册要做的（Step 3 起）
─────────────────────          ─────────────────────────
✓ SDIO 枚举 0x2331              ✓ 探明 ioctl 命令号（47 条，见《FM收音ioctl命令表_逆向还原》）
✓ combo 固件已烧入              □ 写 FM daemon（socket 封装）
✓ marlin_fm.ko 已加载           □ 确认音频通路并出声
✓ /dev/fm 已注册                □ LVGL 收音机页
✓ RDS 解析能力已具备            □ 声道仲裁 + 后台播放
```

---

## 1. Environment Preparation

### 1.1 Device State Confirmation

```sh
# SSH 登录（IP 与密码见环境记录，勿写进交付物）
ssh root@<设备IP>

# 确认内核与主机名
uname -a                 # 期望：Linux 3.10.65  armv7l
hostname                 # 期望：spd-box
```

### 1.2 One-Command State Checkup

```sh
echo '--- 1. SDIO 是否枚举 ---'
cat /sys/bus/sdio/devices/*/device          # 期望：0x2331

echo '--- 2. FM 驱动是否加载 ---'
lsmod | grep marlin_fm                      # 期望：marlin_fm ... Used by sprdwl

echo '--- 3. FM 设备节点 ---'
ls -l /dev/fm                               # 期望：crw-rw---- ... 10, 23
grep -w fm /proc/misc                       # 期望： 23 fm

echo '--- 4. Android 分区（对照样本）---'
ls /mnt/android_sys/lib/libengfm.so         # 期望：文件存在

echo '--- 5. WiFi（FM 的前置）---'
ps | grep '[d]ownload' | head -2            # 期望：至少 1 行常驻
ip link show wlan0 | grep -o 'state [A-Z]*' # 期望：UP 或 DORMANT

echo '--- 6. 音频环境 ---'
cat /proc/asound/pcm | grep -i fm           # 期望：01-04: Dfm sprd-codec-fm-4
ls /usr/lib/libasound.so.2                  # 期望：文件存在
command -v amixer                           # 期望：无输出（本机没有 amixer）
```

> ⚠️ If any of items 1–3 are missing, it means **the underlying layers are not ready yet**; first bring up WiFi according to `01_WiFi打通/docs/WiFi芯片打通操作手册.md`,
> and do not force FM here — because FM depends on the same combo firmware.

---

## 2. Step 1: Extract the Driver Capability List (Already Frozen; Can Be Skipped)

```sh
# 命令名清单（AI 指导手册 §2.2 的来源）
strings /lib/modules/marlin_fm.ko | grep -- '----' | sed 's/.*----//;s/----//' | sort

# RDS 函数清单（AI 指导手册 §2.3 的来源）
nm /lib/modules/marlin_fm.ko | grep ' T ' | grep rds_

# 核心控制函数
nm /lib/modules/marlin_fm.ko | grep -E ' T fm_'

# 确认与 WiFi/BT 共享 SDIO 的官方描述
strings /lib/modules/marlin_fm.ko | grep description=
```

Expected: obtain command names such as TUNE / SEEK / SCAN / GETRSSI / MUTE / SETVOL / ANA_SWITCH / I2S_SETTING / OVER_BT_ENABLE / RDS_*,
as well as RDS functions such as `rds_get_ps` / `rds_get_rt` / `rds_get_pty` / `rds_get_af`.

> **Note**: this step only obtains the **command names**. For the command numbers, see Step 2, which is **already completed in this project**;
> consult the results directly in [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md).

---

## 3. Step 2: Obtain the ioctl Command Numbers — **Completed** (Formerly the Top Blocker)

> See the results in [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md): unified encoding `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`,
> with 45 of the 47 commands confirmed by measurement. **The content below is retained as a methodology record** (reusable when working on other peripherals).

Three approaches, in order of recommendation:

### Route A (first choice): Request the header file from the original manufacturer/solution provider

Request target: the FM user-space header file (`fm.h` / `sprd_fm.h`) and accompanying lib for the Marlin2 platform. Once obtained, skip to Step 3.

### Route B: Infer from the Android-side binaries

```sh
# 看 engfm 导出了什么（已知只有 fm_runcommand）
nm -D --defined-only /mnt/android_sys/lib/libengfm.so

# 看 FM HAL 用了哪些 pcm / 线程结构（推断音频架构）
nm -D --defined-only /mnt/android_sys/lib/libFMHalSource.so | grep -i 'read\|start\|stop\|pcm'

# 进阶：在 Android chroot 内对原生 FM APK 做一次 strace（如环境具备）
# 目标：抓出 open("/dev/fm") 之后紧跟的一组 ioctl(fd, CMD, ...) 的第一个参数值
```

> ⚠️ What this route yields are **inferred values**; they must be verified on real hardware using the Step 3 probe: only when sent correctly will the corresponding `----<命令名>----` print appear in `dmesg`.

### Route C: Controlled Probing

```sh
# 建议做法：写一个小 C 程序，按候选编号逐个 ioctl，观察返回值与内核打印
dmesg -c > /dev/null                 # 先清空，便于观察新日志
./fm_probe                           # 你的试探程序
dmesg | tail -40                     # 看是否出现 ----TUNE---- 之类打印
```

> 🔒 **Iron rules**:
> 1. Before probing, make sure WiFi/Bluetooth are **not carrying business traffic** (sending ioctls at random may cause abnormal firmware state);
> 2. Probe only one number at a time; do not spam in a loop;
> 3. On any abnormality, immediately reset `marlin_fm` with `rmmod`/`insmod` (note that it is depended on by `sprdwl`, so that dependency must be handled as well).

**Deliverable**: `fm_ioctl.h`, containing all command numbers and data structures. This is the input for all subsequent work.

---

## 4. Step 3: Compile and Deploy the FM Daemon

```sh
# 上传源码（从本机到设备）
scp fm_radio_daemon.c root@<设备IP>:/tmp/
scp fm_ioctl.h        root@<设备IP>:/tmp/

# 设备端编译
cd /tmp
gcc -O2 -Wall -o fm_radio_daemon fm_radio_daemon.c -lpthread

# 单实例启动（先手动验证，不自启）
pkill -x fm_radio_daemon 2>/dev/null; sleep 0.3
./fm_radio_daemon > /tmp/fm_daemon.log 2>&1 &
sleep 1
ls -l /tmp/fm_ctl.sock        # 期望：srwxrwxrwx socket
```

### 4.1 Socket Self-Test (python3 on the device; socat is not available on this device)

```python
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)                       # ★ 必须设超时
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c + "\n").encode()); time.sleep(0.2)
    return s.recv(4096).decode().strip()
for c in ["state", "open", "tune 97400", "rssi", "vol 8"]:
    print("%-12s -> %s" % (c, cmd(c)))
```

Expected: `OK OFF` → `OK ON` → `OK 97400` → `OK <rssi value>` → `OK 8`.

---

## 5. Step 4: Confirm the Audio Path (Must Be Confirmed by Ear)

```sh
# 先查当前音频状态（若 daemon 已封装）
python3 -c "
import socket,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(5)
s.connect('/tmp/fm_ctl.sock')
s.sendall(b'audioinfo\n'); time.sleep(0.3); print(s.recv(4096).decode())
"
```

Try the three paths in order, and **confirm by ear whether each one produces sound**:

| # | Path | Corresponding ioctl | Applicable |
|---|---|---|---|
| 1 | Analog/internal codec passthrough | `ANA_SWITCH` | Direct speaker output (default candidate) |
| 2 | I2S | `I2S_SETTING` / `GET_I2S_INFO` | Use when an external codec is needed |
| 3 | Over BT | `OVER_BT_ENABLE` | FM sound output from a Bluetooth device |

```sh
# ALSA 侧参照（本机没有 amixer，只能看节点）
cat /proc/asound/pcm | grep -i fm       # 01-04: Dfm sprd-codec-fm-4（仅 playback）
cat /proc/asound/pcm | grep i2s         # card0 四路 i2s.x 双向
```

> ⚠️ **Success must not be judged from logs in this area**:
> - TUNE returning OK **does not mean** there is sound;
> - You must actually listen. It is recommended to first lock onto the strongest local station as a baseline test.
> - Also confirm **whether headphones must be plugged in to serve as the antenna**: tune to a strong signal without headphones; if sound is produced, headphones are not required.

---

## 6. Step 5: Deploy the LVGL Radio Page

```sh
cd /home/lvgl_demo/lvgl_demo

# 1) 新增文件
#    lv_pages/radio_page.c
#    lv_pages/radio_page.h

# 2) 修改 launcher_page.c 三处（详见《FM收音机_LVGL界面设计与交互规格.md》§3.2）
#    a) include          : #include "lv_pages/radio_page.h"
#    b) s_apps[] 数组     : 在蓝牙条目之后插入收音机项
#    c) open_app switch  : case LAUNCHER_APP_RADIO: lv_start_activity(&g_radio_page, ...)

# 3) 编译部署
make -j2 > /tmp/mk.log 2>&1; echo "MAKE_RC=$?"
grep -E 'error:' /tmp/mk.log | head -20

cp -f build/lvgl_demo /usr/local/bin/lvgl_demo && sync
killall -9 lvgl_demo; sleep 0.5
cd /home/lvgl_demo/lvgl_demo && nohup /usr/local/bin/lvgl_demo > /tmp/lvgl_run.log 2>&1 &
```

> ⚠️ **Do not rely on the `$?` of `make | tail` for build success/failure** (that is tail's exit code); you must use `make > log 2>&1; echo MAKE_RC=$?`.
> Note: `extern/miniretro/` has no Makefile; use `sh build.sh` (unrelated to this task; do not touch it by accident).

---

## 7. Step 6: Boot Autostart (openrc)

```sh
cat > /etc/init.d/fm-radio <<'EOF'
#!/sbin/openrc-run
# FM 收音 daemon —— 必须晚于 WiFi 上电链
depend() {
    need localmount
    after bootmisc
    # ★ 关键：必须在 download/wcnd 之后，否则芯片未上电
}
start() {
    ebegin "Starting FM radio daemon"
    start-stop-daemon --start --background \
        --exec /usr/local/bin/fm_radio_daemon \
        --make-pidfile --pidfile /run/fm_radio.pid
    eend $?
}
stop() {
    ebegin "Stopping FM radio daemon"
    start-stop-daemon --stop --pidfile /run/fm_radio.pid
    eend $?
}
EOF

chmod +x /etc/init.d/fm-radio
rc-update add fm-radio default
rc-service fm-radio start
```

> ⚠️ The autostart order is the most accident-prone part of this integration: `download → wcnd → bt_once → bt_wake → bt_user_daemon → fm_radio_daemon`.
> If FM stops working after a reboot, first check whether it started too early (before the chip was powered).

---

## 8. Quick Reference for Common Nodes and Parameters

| Item | Value |
|---|---|
| SDIO modalias | `sdio:c00v0000d2331` |
| SDIO path | `/sys/bus/sdio/devices/mmc2:8800:1` |
| Driver module | `/lib/modules/marlin_fm.ko` (`Used by sprdwl`) |
| Control node | `/dev/fm` (misc 23) |
| Log node | `/dev/log_radio` (misc 35) |
| FM PCM | `hw:1,4` = `01-04 Dfm sprd-codec-fm-4` (playback) |
| I2S PCM | card0 `i2s.0`~`i2s.3` (playback + capture) |
| daemon socket | `/tmp/fm_ctl.sock` (`chmod 0666`) |
| daemon log | `/tmp/fm_daemon.log` |
| Android reference libraries | `/mnt/android_sys/lib/{libengfm,libFMHalSource,libfmjni}.so` |
| Main RDS fields | PS (8-character station name) / RT (64-character text) / PTY / AF / CT / EWS |

---

## 9. One-Sentence Summary

> The underlying layers (① firmware ② power-up ③ driver) are **all already in place**, and the command numbers have been fully reverse-engineered (§3 / see also "FM收音ioctl命令表_逆向还原").
> **This project has no remaining blockers**; simply proceed step by step from Step 3.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
