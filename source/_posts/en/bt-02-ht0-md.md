---
title: "HT0 Bluetooth Bring-up: Deployment Delivery Document"
date: 2026-09-21 11:47:29
lang: en
permalink: en/2026/09/21/bt-02-ht0-md/
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# HT0 Device Bluetooth Bring-up — Deployment Delivery Document

> Purpose: answer "which scripts/programs are involved in the entire Bluetooth flow? How do you deploy on a new device to bring up Bluetooth?"
> Contents: ① full chain overview → ② artifact list (device/local machine/Git) → ③ new device deployment steps → ④ verification → ⑤ FAQ
> Applicable to: same-model devices (HT0 / Spreadtrum SC9832A, Android kernel + Alpine userland)

---

## 1. Full Bluetooth Chain Overview (who starts whom)

```
开机
 ├─ /etc/local.d/wifi.start       ① 挂载安卓 system + 搭 chroot + download 烧固件 + 驱动 + wlan0
 ├─ /etc/local.d/bt_bringup.start  ② mdbg 权限 + wcnd + bt_once(BT-OPEN) + bt_wake.sh(btwrite 唤醒)
 ├─ /etc/init.d/bt_daemon          ③ 用户态 HCI daemon（openrc 自启）
 └─ LVGL 桌面                     ④ 蓝牙设置页（socket 与 daemon 通信）
```

**Dependency relationships**: ① is the prerequisite for ②③④ (the combo firmware burned by download includes the Bluetooth part); ② is the prerequisite for ③ (HCI responds only after power-on + wake-up).

---

## 2. Artifact List

### 2.1 Already deployed on the device (HT0 current state, verified by live testing)

| Category | Path | Description |
|---|---|---|
| Firmware download chain | `/tmp/logdw` | download log daemon (copy of the original Android version) |
| | `/tmp/aand/bin/download` | firmware download bootloader (inside chroot) |
| | `/tmp/aand/bin/wcnd` | WiFi/Bluetooth power-on daemon (inside chroot) |
| | `/tmp/aand/etc/marlinba/*.ini` | firmware configuration (includes Bluetooth pskey) |
| Bluetooth power-on/wake-up | `/tmp/bt_once` | BT-OPEN trigger (source /tmp/bt_once.c) |
| | `/tmp/bt_wake.sh` | periodic btwrite wake-up (writes 1 every 2s) |
| HCI diagnostics | `/tmp/bt_probe_full` | HCI six-step probe (source /tmp/bt_probe_full.c) |
| | `/tmp/hci_3m` | 3M baud rate raw HCI test (early diagnostics) |
| **Core service** | `/usr/local/bin/bt_user_daemon` | **userland HCI daemon (production)**, source `/tmp/bt_user_daemon.c` |
| Auto-start configuration | `/etc/local.d/wifi.start` | boot WiFi chain (4991B, includes chroot setup) |
| | `/etc/local.d/bt_bringup.start` | boot Bluetooth power-on chain (mdbg+wcnd+bt_once+bt_wake) |
| | `/etc/init.d/bt_daemon` | daemon openrc auto-start (already `rc-update add default`) |
| | `/etc/local.d/lvgl_demo.start` | LVGL desktop auto-start (points to /usr/local/bin/lvgl_demo) |
| | `/root/lvgl_watchdog.sh` | desktop watchdog (auto-restarts if it dies) |

### 2.2 Local machine (Windows working directory `new-chat\`) source code and deployment scripts

| File | Purpose |
|---|---|
| `bt_user_daemon.c` | **daemon source code (core deliverable)** — the device's /tmp has an identical copy |
| `bt_probe_full.c` / `bt_probe_inquiry.c` | HCI probe source code |
| `bt_deploy_v4.py` / `bt_deploy_all.py` / `bt_full_sequence_test.py` | paramiko one-click deployment/test scripts |
| `bt_verify_scan.py` / `bt_sock_test.py` | scan/socket verification scripts |
| `bt_ssh_wait_8h.py` / `bt_auto_resume.py` | SSH polling and reconnection |
| `bluetooth_page.c` / `bluetooth_page.h` | **LVGL Bluetooth settings page (already registered in the launcher)** |
| Four documents | operation manual / process comparison / work summary / AI guidance manual |

### 2.3 Git commits (device project /home/lvgl_demo/lvgl_demo)

```
973e3b5 新增蓝牙设置应用：launcher 注册蓝牙图标，蓝牙页含开关/搜索/设备列表，
        通过 unix socket 与 bt_user_daemon 通信；开机脚本与看门狗统一使用 /usr/local/bin/lvgl_demo
```
Files involved: `lv_pages/bluetooth_page.c`, `lv_pages/bluetooth_page.h`, `lv_pages/launcher_page.c` (3 registration points), `shell/wifi.start`

### 2.4 Skill packaging (portable)

`workspace\.user_skills\ht0-wcn-radio\` — contains SKILL.md + references (WiFi/Bluetooth manuals) + scripts (wifi_bringup/bt_status/ssh_wait); any AI can operate same-model devices directly after loading it.

---

## 3. New Device Deployment Steps (bringing up Bluetooth from scratch)

> Prerequisites: same-model device (HT0/SC9832A), already switchrooted to Alpine, SSH root available, WiFi chain can start (the `/tmp/aand` environment exists or wifi.start can set it up automatically).

### Step 0 Confirm the basic environment (WiFi prerequisite)

```sh
ssh root@<设备IP>
# 确认安卓 system 可挂载、chroot 可搭（wifi.start 自动做）
sh /etc/local.d/wifi.start 2>&1 | tail -5    # 期望: SDIO ready 0x2331 + wlan0 UP
cat /sys/bus/sdio/devices/mmc2:8800:1/device  # 0x2331
```
> If wifi.start does not exist: first mount `/mnt/android_sys` (mmcblk0p17), then rebuild the chroot from the contents of `wifi.start` (see references/wifi.md).

### Step 1 Upload and deploy the basic tools

```sh
# 从本机 scp 到设备 /tmp/
scp bt_once bt_wake.sh bt_probe_full logdw root@<设备IP>:/tmp/
chmod +x /tmp/bt_once /tmp/bt_wake.sh /tmp/bt_probe_full /tmp/logdw

# logdw 也可从安卓 system 拷：
# cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw
```

### Step 2 Compile and deploy the HCI daemon (core)

```sh
# 上传源码
scp bt_user_daemon.c root@<设备IP>:/tmp/
# 设备端编译
gcc -O2 -o /usr/local/bin/bt_user_daemon /tmp/bt_user_daemon.c -lpthread
# 单实例启动
pkill -9 -x bt_user_daemon 2>/dev/null; sleep 1
setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
```
> If the device has no gcc: cross-compile on the local machine (armv7 static) or copy the binary from an already-deployed device (`/usr/local/bin/bt_user_daemon`, 24KB, identical architecture, directly usable).

### Step 3 Configure boot auto-start

```sh
# 3a. 蓝牙上电链脚本
cat > /etc/local.d/bt_bringup.start << 'EOF'
#!/bin/sh
# 蓝牙上电链：mdbg 权限 -> wcnd -> bt_once(BT-OPEN) -> bt_wake(btwrite)
sleep 8
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null
ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_once' || setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_wake' || setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &
EOF
chmod +x /etc/local.d/bt_bringup.start

# 3b. daemon openrc 自启
cat > /etc/init.d/bt_daemon << 'EOF'
#!/sbin/openrc-run
command="/usr/local/bin/bt_user_daemon"
command_background=yes
pidfile="/run/bt_daemon.pid"
EOF
chmod +x /etc/init.d/bt_daemon
rc-update add bt_daemon default
rc-service bt_daemon start
```

### Step 4 (optional) LVGL Bluetooth settings page

```sh
# 上传页面文件到项目
scp bluetooth_page.c bluetooth_page.h root@<设备IP>:/home/lvgl_demo/lvgl_demo/lv_pages/
# 修改 launcher_page.c 三处：include / 枚举 LAUNCHER_APP_BLUETOOTH / s_apps 数组 / open_app switch
# 编译部署（4 线程）
cd /home/lvgl_demo/lvgl_demo && make -j4
install -m 755 build/lvgl_demo /usr/local/bin/lvgl_demo
pkill -9 -x lvgl_demo; setsid /usr/local/bin/lvgl_demo >/tmp/lvgl_demo.log 2>&1 </dev/null &
```
> If the new device has no LVGL project: deploy the WiFi/Bluetooth lower layers first (Step 0–3); the page is the final application layer.

### Step 5 Verify

```sh
# 分层状态
cat /sys/bus/sdio/devices/mmc2:8800:1/device          # 0x2331
grep 'CMD OK' /tmp/bt_once.log                        # WCNBTWIFI-CMD OK
ps -eo comm | grep -c '[b]t_user_daemon'              # ≥1
# socket 查询（设备端 python3）
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"                          # OK ON
# 扫描
printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"                                     # OK N + 设备行
```
> You can also use the Skill's script directly: `python scripts/bt_status.py --host <IP> --password <pwd> --scan 8` (runs on the local machine, requires paramiko).

---

## 4. Verification Criteria (all satisfied = deployment successful)

| # | Check | Expected |
|---|---|---|
| 1 | SDIO device | `0x2331` |
| 2 | /tmp/bt_once.log | contains `WCNBTWIFI-CMD OK` |
| 3 | btwrite | writable (bt_wake.sh is running) |
| 4 | daemon process | ≥1 (single instance) |
| 5 | socket state | `OK ON` |
| 6 | socket scan | `OK N` + device lines (N=0 is not a failure; no devices in the environment) |
| 7 | LVGL Bluetooth page (if present) | on/off/search/list work normally |
| 8 | After reboot | ①②③ all come up automatically (no manual action) |

---

## 5. FAQ (the pitfalls most likely to be hit when deploying on new devices)

| Symptom | Cause | Fix |
|---|---|---|
| `BT-OPEN FAIL` | mdbg permissions 600 | `chmod 666 /tmp/aand/proc/mdbg/*` (already included in bt_bringup.start) |
| `SDIO not enumerated` | incomplete download environment | confirm /tmp/aand is complete (bin/lib/marlinba/nodes/symlinks), rerun wifi.start |
| `bind logdw failed` | /tmp/logdw missing | copy it from /mnt/android_sys/bin/ |
| daemon fails to start (Not a tty) | tty ldisc occupied | `python3 -c "import fcntl; f=open('/dev/ttyS0',2); fcntl.ioctl(f,0x5421,b'\0'*4)"` |
| No scan results | Write Scan Enable not sent first | use the daemon scan (handled internally); do not send bare Inquiry |
| socket connect failure | daemon multiple instances | `pkill -9 -x bt_user_daemon` then single instance |
| gcc not found | Alpine minimal install | `apk add build-base`, or copy the binary directly from a deployed device |

---

## 6. One-Sentence Summary of the Deployment Path

```
环境就绪(wifi.start) → 传 4 个工具(bt_once/bt_wake.sh/bt_probe_full/logdw)
→ 编译部署 daemon(bt_user_daemon.c) → 两条自启(bt_bringup.start + bt_daemon)
→ 验证(0x2331 + CMD OK + socket OK ON + scan)
→ 可选: LVGL 蓝牙页(bluetooth_page.c/h + launcher 注册 + make -j4)
```

All artifacts have local copies (`new-chat\` directory) and Skill packaging (`ht0-wcn-radio`), so the entire new-device deployment is fully reusable.


---

## 6. A2DP Real Audio Playback (new in the v1.0.3 Bluetooth speaker support release)

> Purpose: after connecting to a Bluetooth speaker, clicking a song in the desktop music/video app plays sound directly from the Bluetooth speaker (no longer the demo beep).

### 6.1 Audio Chain

```
桌面点歌(music/video_page)
  → 判断蓝牙已连(AF_UNIX socket /tmp/bt_ctl.sock 发 "conn")
  → mplayer -ao pcm:nowaveheader:fast:file=/tmp/bt_audio.fifo -srate 44100 -channels 2 -format s16le
  → /tmp/bt_audio.fifo (命名管道, 512字节/帧)
  → bt_user_daemon 媒体循环读 PCM → SBC 编码(bp35/7帧/20ms)
  → A2DP → 蓝牙音箱出声
```

### 6.2 Key Deployment Points

| Item | Value | Description |
|---|---|---|
| fifo pipe | `/tmp/bt_audio.fifo` | created with `mkfifo` in the boot script `bt_bringup.start`; it exists automatically after reboot |
| mplayer audio parameters | `-ao pcm:nowaveheader:fast:file=/tmp/bt_audio.fifo -srate 44100 -channels 2 -format s16le` | **`-format s16le` is mandatory**; otherwise big-endian causes static noise |
| Bluetooth check | `bt_audio_connected()` | **must be called before the fork child process (in the parent process)**; calling it in the child after fork, where dup2 has redirected stdio, fails to connect and falls back to `-ao null` |
| Bluetooth not connected | keep `-ao null` | does not affect progress/pause/track-change control |

### 6.3 Troubleshooting Points

- **No sound when clicking a song**: run `ps | grep mplayer` to see whether the parameters used are `-ao null` or fifo. If null → `bt_audio_connected()` failed in the parent process; confirm the daemon is running and the socket `/tmp/bt_ctl.sock` exists.
- **Melody audible but all static noise**: mplayer is missing `-format s16le` (default big-endian PCM, daemon reads little-endian int16).
- **Track-change/pause/exit sound anomalies**: confirm the old mplayer has been killed (pkill mplayer first when starting a new one) and the fifo is not occupied.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
