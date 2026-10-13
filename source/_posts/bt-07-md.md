---
title: "蓝牙芯片打通_故障排查手册"
date: 2026-09-13 15:58:12
lang: zh-CN
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# 展讯 SC9832A 蓝牙故障排查手册 —— HT0 / spd-box

> **用途**：蓝牙起不来、扫不到、没响应时，按本手册定位根因。每一行命令均取自设备实测。
> **使用方式**：先看 §1 分层速查总表定位到层 → 跳到对应章节 → 用「定位命令」确认 → 按「修复」处理。
> **配套**：人工操作手册（第 8 章速查表）、AI 指导手册（§7 决策表）为精简版；本文是全量版。

---

## 0. 排障纪律（先读，违反会浪费时间）

1. **分层定位，不跨层瞎试**：四层模型——①固件/物理（download→SDIO 0x2331）→ ②上电（wcnd+BT-OPEN→CMD OK）→ ③引擎（btwrite 唤醒→HCI 响应）→ ④应用（daemon→socket→LVGL）。哪层不过只查该层及其上游。
2. **先看日志再看进程**：日志顺序 `/var/log/wifi_boot.log`（wifi 链）→ `/tmp/bt_once.log`（BT-OPEN）→ `/tmp/btud.log` + `/tmp/btud_dbg.log`（daemon）→ `dmesg | tail`。
3. **download 常驻勿杀**：全杀会破坏 WiFi/蓝牙固件状态，只能整机重启恢复。
4. **杀进程一律 `pkill -9 -x <名字>`**，禁止 `ps | grep` 内嵌模式（会误杀执行命令的 shell 自身）。
5. **重启后必做 mdbg chmod**（开机脚本已自动做，手动调试时别忘）：
   `chmod 666 /tmp/aand/proc/mdbg/*; chmod 666 /proc/mdbg/*; echo 0 > /proc/mdbg/wdtirq`
6. **先确认 WiFi 层**：蓝牙与 WiFi 同芯片，WiFi 没拉起来蓝牙必挂。`cat /sys/bus/sdio/devices/mmc2:8800:1/device` 必须为 `0x2331`。

---

## 1. 分层故障速查总表（一页定位）

| 现象（症状） | 大概率根因 | 定位命令 | 章节 |
|---|---|---|---|
| `SDIO not enumerated, download may have failed` | 固件下载未完成 / chroot 环境不全 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | §2 |
| `bind logdw failed: No such file or directory` | logdw 未就位 | `ls -la /tmp/logdw` | §2 |
| download 卡住 / pid 为空 | chroot 缺库/节点/软链 | `ps -eo pid,comm \| grep download` | §2 |
| BT-OPEN 返回 FAIL | mdbg 权限 600 | `cat /tmp/bt_once.log` | §3 |
| wcnd 没起 / bt_once 无输出 | 进程没起来 / 时序 | `ps -ef \| grep '[w]cnd'` | §3 |
| HCI 无响应 / 只回一次 SPRD3 帧 | 缺 btwrite 唤醒 | `[ -w /proc/bluetooth/sleep/btwrite ]` | §4 |
| daemon 日志 "Not a tty" | tty ldisc 被占 | `cat /tmp/btud.log` | §4 |
| 扫描无结果（scan 返回 OK 0） | 未先 Write Scan Enable | 用 daemon `scan` 命令 | §5 |
| socket connect 失败 / state 无响应 | daemon 多实例 / 瞬时窗口 | `ps -eo comm \| grep '[b]t_user_daemon'` | §5 |
| 重启后蓝牙不自动拉起 | 自启链缺失 / 顺序错 | `rc-update show` | §6 |
| LVGL 蓝牙页反复变回旧版 | watchdog 指向 build 路径 | `cat /root/lvgl_watchdog.sh` | §6 |
| WiFi/蓝牙一起没了 | download 被杀 | `dmesg \| tail` | §7 |
| SSH 重启后不通 | USB 口切换 | 轮询 `<设备IP>` / `<WiFi-IP>` | §7 |

---

## 2. 物理 / 固件层（① download → SDIO）

### 2.1 `SDIO not enumerated, download may have failed`

- **定位**：`cat /sys/bus/sdio/devices/mmc2:8800:1/device`（空 = 未枚举）；`tail -20 /tmp/logdw.log`；`dmesg | tail -30`
- **可能根因与修复**：

| 根因 | 确认 | 修复 |
|---|---|---|
| chroot 环境不全 | `ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/connectivity_configure.ini` | 重建 chroot（见 WiFi 操作手册 4.4）或重跑 `sh /etc/local.d/wifi.start` |
| `/dev/power_ctl` 不可写 | `[ -w /dev/power_ctl ] && echo OK` | 检查节点权限；download 靠它写 SLEEP→POWER_ON→POWER_RST 上电序列 |
| by-name 软链缺失 | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl; ln -sf /dev/block/mmcblk0p15 .../wcnmodem` |
| 挂载缺失 | `mountpoint -q /tmp/aand/dev || echo NOT` | `mount --bind /dev /tmp/aand/dev; mount -t proc proc /tmp/aand/proc` |
| DTB 不对（boot 分区） | `dmesg \| grep -i sdio` | 确认 p16 已写 Android 原版 dtb（WiFi 操作手册 4.3） |
| download 没起来 | `ps -eo pid,comm \| grep download` | `setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &` |

### 2.2 `bind logdw failed: No such file or directory`

- **根因**：`/tmp/logdw` 不存在或不可执行（logdw 是 download 的日志守护）。
- **修复**：`ls -la /tmp/logdw`；缺失则 `cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw; chmod +x /tmp/logdw`。

### 2.3 download 进程反复退出 / pid 为空

- **定位**：`ps -eo pid,comm | grep download`；`tail -30 /tmp/dl_run.log`
- **修复**：先 `pkill -9 -f logdw; pkill -9 -f 'wcnd'` 清残留，再 `setsid /tmp/logdw &`、`setsid chroot /tmp/aand /bin/download -i wlan0 &`；若仍退，用 `strace chroot /tmp/aand /bin/download -i wlan0 2>&1 | grep -E "open|ENOENT"` 看缺什么。

---

## 3. 蓝牙上电层（② wcnd + BT-OPEN）

### 3.1 BT-OPEN 返回 FAIL（头号问题）

- **定位**：`cat /tmp/bt_once.log`（期望 `push(17): WCNBTWIFI-CMD OK`；FAIL 则 600 权限问题）
- **根因**：chroot 内 `/tmp/aand/proc/mdbg/*` 权限 600，wcnd 无权限操作调制解调器调试节点。
- **修复**：
  ```sh
  chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
  chmod 666 /proc/mdbg/* 2>/dev/null
  echo 0 > /proc/mdbg/wdtirq 2>/dev/null
  # 重启 wcnd + 重发 BT-OPEN
  pkill -9 -f 'wcnd'; sleep 1
  setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
  sleep 2
  setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
  sleep 3; cat /tmp/bt_once.log
  ```
- **提示**：此权限**重启后必丢**，开机脚本 `bt_bringup.start` 已自动执行；手动调试时勿忘。

### 3.2 wcnd 没起来 / bt_once 无任何输出

- **定位**：`ps -ef | grep '[w]cnd'`（wcnd 是 chroot 内进程，`comm` 可能显示为别的名字，用 `-ef` 看完整命令行）
- **修复**：确保 WiFi 已拉起（SDIO 0x2331）后按 3.1 的启动序列重跑；注意 wcnd 依赖 `/tmp/aand` 环境和 download 常驻。

---

## 4. 引擎 / 唤醒层（③ btwrite → HCI）

### 4.1 HCI 无响应 / 只回一次 SPRD3 帧（关键！）

- **现象**：`bt_probe_full` 发 HCI Reset 收不到响应；或只收到一次 `55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e`（SPRD3 身份帧）后无后续。
- **根因**：蓝牙引擎上电后默认省电休眠，**必须周期性 btwrite 唤醒**才有 HCI 响应。
- **定位**：`[ -w /proc/bluetooth/sleep/btwrite ] && echo WRITABLE || echo NO`；`ps -eo args | grep '[b]t_wake.sh'`
- **修复**：启动唤醒脚本（每 1.5~2s 写 1）：
  ```sh
  setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &
  echo 1 > /proc/bluetooth/sleep/btwrite && echo WRITE_OK
  ```
- **注意**：`bt_wake.sh` 必须在蓝牙工作期间一直跑；扫描时尤其不能停。

### 4.2 SPRD3 帧的含义

- `55 7e 00 81 ... 53 50 52 44 33 ...` 中的 `SPRD3` 是展讯启动标识——**收到它说明 HCI 通道活了、固件在跑**。此时若标准 HCI 命令无响应，优先查唤醒（4.1）与 daemon 波特率（4.3）。

### 4.3 daemon 日志 "Not a tty" / HCI 全无响应

- **根因**：ttyS0 的 line discipline（ldisc）被占/被破坏（早期测试残留），打开失败或收发异常。
- **定位**：`tail -10 /tmp/btud.log`
- **修复**：用 python 恢复 N_TTY（TIOCSETD=0x5421，N_TTY=0）：
  ```sh
  python3 -c "import fcntl; f=open('/dev/ttyS0',2); fcntl.ioctl(f,0x5421,b'\x00\x00\x00\x00')"
  pkill -9 -x bt_user_daemon; sleep 1
  setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
  ```
- **死路**：`/tmp/reset_tty` 恢复 ldisc 会段错误，勿用。

### 4.4 波特率 / UART 配置问题

- **节点**：`/sys/devices/70000000.uart/uart_conf`（`0x1a1`=115200、`0x341`=57600、daemon 用 3M）
- **规则**：daemon 直接以 `B3000000 + CRTSCTS` 打开 ttyS0；**不要**在固件初始化后擅自改 uart_conf，否则固件与 daemon 波特率失配 → HCI 无响应。
- **定位**：`cat /tmp/btud_dbg.log | tail -20`（看 TX/RX hex 是否乱码）。

### 4.5 内核 hci0 注册但 TX=0

- **根因**：3.10.65 安卓定制内核与自编 `hci_uart.ko` 的 tty_struct 偏移不匹配；Alpine gcc14.2 编老内核模块报 `invalid module format`。
- **结论（死路）**：**放弃内核驱动路线**，使用用户态 daemon（读写 /dev/ttyS0，不依赖内核蓝牙协议栈）。

---

## 5. 应用层（④ daemon → socket → LVGL）

### 5.1 socket connect 失败

- **定位**：`[ -S /tmp/bt_ctl.sock ] && echo YES || echo NO`；`ps -eo comm | grep '[b]t_user_daemon'`
- **根因**：daemon 多实例抢 socket / socket 文件残留。
- **修复**：
  ```sh
  pkill -9 -x bt_user_daemon; sleep 1
  rm -f /tmp/bt_ctl.sock
  setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
  ```

### 5.2 state 查询无响应（Terminated）/ 重启后瞬时无响应

- **现象**：重启后 socket 存在但 `state` 查询 6s 超时被杀（返回 Terminated）；稍等几秒后又正常。
- **根因**：daemon 启动与蓝牙上电链（bt_bringup.start）无先后保证，daemon 在引擎未就绪时先打开 ttyS0 进入初始化，瞬时阻塞。
- **修复（已固化）**：`/etc/init.d/bt_daemon` 的 `depend()` 应含 `after local`（确保上电链先完成）；验证：
  ```sh
  cat /etc/init.d/bt_daemon | grep -A4 depend
  rc-service bt_daemon restart
  # 若仍无响应，等 10~15s 重试 state；仍不行按 5.1 单实例重启
  ```
- **快速重试命令**：
  ```sh
  printf 'state\n' | timeout 5 python3 -c "import socket,sys
  s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
  s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
  print(s.recv(4096).decode())"
  ```

### 5.3 扫描无结果（OK 0）

- **根因**：未先发 `Write Scan Enable` 就发 Inquiry——固件接受 Inquiry（CMD_STATUS 0x00）但永不回 Inquiry Result。
- **修复**：**走 daemon 的 `scan` 命令**（内部已处理顺序），勿裸发 Inquiry：
  ```sh
  printf 'scan 15\n' | timeout 25 python3 -c "import socket,sys
  s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
  s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
  d=b''
  while True:
      x=s.recv(4096)
      if not x: break
      d+=x
  print(d.decode())"
  # 期望 OK <N> + 每行 bd_addr class rssi
  ```
- 若环境确实无蓝牙设备，N=0 不算故障。

### 5.4 蓝牙页开关无反应

- **定位**：确认 daemon 单实例 + state 返回 `OK ON`（先过 5.1/5.2）；再看 LVGL 日志 `/tmp/lvgl_demo.log` 是否有 socket 报错。
- **修复**：多为 daemon 侧问题，按 5.1 重置；页面本身只做 socket 文本交互，不持有 HCI 状态。

---

## 6. 系统 / 自启层

### 6.1 重启后蓝牙不自动拉起

- **定位**：`rc-update show | grep -E 'bt_daemon|local'`；`ls /etc/local.d/`（应有 wifi.start、bt_bringup.start、lvgl_demo.start）
- **修复**：
  ```sh
  # 缺上电链脚本则创建（内容见 AI工作流 deploy/bt_bringup.start）
  # 缺 daemon 自启则：
  rc-update add bt_daemon default
  rc-service bt_daemon start
  ```
- **完整自启链**：`wifi.start`（WiFi 前提）→ `bt_bringup.start`（sleep 8 + mdbg + wcnd + bt_once + bt_wake）→ `bt_daemon`（openrc，`after local`）。

### 6.2 daemon 与上电链顺序错乱

- **症状**：重启后 daemon 进程在但 state 长期无响应。
- **修复**：确认 `/etc/init.d/bt_daemon` 的 `depend()` 含 `after local`；改后 `rc-update del bt_daemon default; rc-update add bt_daemon default; reboot` 验证。

### 6.3 LVGL 蓝牙页反复变回旧版 / 页面缺失

- **根因**：watchdog / 开机脚本指向 `build/` 旧路径。
- **修复**：统一指向 `/usr/local/bin/lvgl_demo`；确认 `bluetooth_page.c/h` 已编译进镜像并注册（launcher 图标）。

---

## 7. 通用系统问题

| 症状 | 根因 | 修复 |
|---|---|---|
| WiFi/蓝牙一起没了 | download 被杀 / 固件状态破坏 | **整机重启**，别手动"干净重来"；重启后自动链恢复 |
| 重启后 SSH 不通 | USB 口复用切换 | 轮询 `<设备IP>` 与 `<WiFi-IP>`（本机可用 skill 的 ssh_wait.py） |
| 日期退回 2016 | RTC 未同步 | `hwclock -s` / ntpd；确认 `/etc/local.d/time_sync.start` 存在 |
| 蓝牙扫描时 WiFi 掉 | 罕见共存问题 | 确认 download 常驻 + 重启后优先拉起 WiFi 链 |

---

## 8. 诊断工具箱（关键节点速查）

| 项目 | 路径/命令 | 期望 |
|---|---|---|
| SDIO 枚举 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 固件下载日志 | `/var/log/wifi_boot.log`、`/tmp/logdw.log`、`/tmp/dl_run.log` | download 完成、无 ERROR |
| BT-OPEN 结果 | `grep 'CMD OK' /tmp/bt_once.log` | `WCNBTWIFI-CMD OK` |
| 唤醒节点 | `[ -w /proc/bluetooth/sleep/btwrite ]` | WRITABLE |
| UART 配置 | `cat /sys/devices/70000000.uart/uart_conf` | daemon 用 3M 打开 |
| HCI 探针 | `/tmp/bt_probe_full 20` | 六步全通 |
| daemon 进程 | `ps -eo comm \| grep '[b]t_user_daemon'` | 单实例 |
| daemon 日志 | `/tmp/btud.log`（stdout）、`/tmp/btud_dbg.log`（TX/RX hex） | 无 Not a tty、有 RX |
| socket | `[ -S /tmp/bt_ctl.sock ]` | YES |
| 开机脚本 | `ls /etc/local.d/`、`rc-update show` | wifi.start / bt_bringup.start / bt_daemon 均在 default |

**进程链**：`logdw → download(常驻) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)`

---

## 9. 已验证死路（不要重试）

| 路线 | 结果 |
|---|---|
| 内核 `hci_uart.ko` | hci0 能注册但 TX=0 / up 超时，驱动偏移不匹配 |
| vhci 虚拟方案 | 用户否决 |
| 反复黑盒试引导命令序列 | 不完整、状态不稳定，且不影响扫描功能 |
| `/tmp/reset_tty` 恢复 ldisc | 段错误，用 python ioctl |
| 杀 download "重启干净环境" | 破坏固件状态，整机重启才恢复 |
| `ps \| grep` 内嵌杀进程 | 误杀 shell 自身 |

---

## 10. 红线（任何情况下）

1. **download 常驻勿杀**。
2. **驱动顺序**：`marlin_fm.ko` 先、`sprdwl.ko` 后。
3. 杀进程：`pkill -9 -x <名字>`。
4. 重启后 mdbg chmod 666（脚本自动做）。
5. 蓝牙工作期间 `bt_wake.sh` 不停。
6. 不修改 USB OTG / 网络模式配置。

---

*配套：蓝牙芯片打通_操作手册（人用）、蓝牙打通_AI指导手册（AI 用）、HT0蓝牙拉起_部署交付文档（部署用）*
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
