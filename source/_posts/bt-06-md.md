---
title: "蓝牙芯片打通_操作手册"
date: 2026-09-13 15:27:33
lang: zh-CN
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# 展讯 SC9832A 蓝牙芯片打通 —— 人工操作手册

> 适用范围：保留安卓内核 + switchroot 到 Alpine Linux 的展讯 SC9832A 设备（hostname `spd-box`，内核 `Linux 3.10.65`）
> 目的：在不依赖 AI 助手的情况下，人工手动完成蓝牙底层拉起、HCI 通道验证、用户态守护进程部署与开机自启
> 本文所有命令均已在设备上实测通过

---

## 0. 前置概念（30 秒建立直觉）

这台设备的 WiFi 和蓝牙是**同一颗展讯 Marlin combo 芯片**（WCN），SDIO 承载数据通道，UART（ttyS0）承载蓝牙 HCI 控制通道。芯片固件不在系统里"常驻"，每次开机都必须由安卓原版 `download` 引导器把固件烧进芯片，之后芯片才能工作。

```
开机 → download 烧固件 → SDIO 枚举 → 蓝牙固件由 wcnd 触发 BT-OPEN → btwrite 周期性唤醒 → HCI 通道可用
```

| 角色 | 文件/进程 | 干什么 |
|---|---|---|
| 固件烧录 | `/tmp/aand/bin/download`（chroot 安卓环境） | 把 wcnfdl/wcnmodem 分区固件经 SDIO 烧进芯片，芯片上电启动 |
| 上电序列 | `/tmp/aand/bin/wcnd` | 收到 BT-OPEN 命令后驱动蓝牙子系统上电 |
| 上电确认 | `/tmp/bt_once 900` | 发送 BT-OPEN，返回 `WCNBTWIFI-CMD OK` 即成功 |
| 周期性唤醒 | `/tmp/bt_wake.sh` | 每 1.5~2 秒向 `/proc/bluetooth/sleep/btwrite` 写 1，防止蓝牙引擎休眠 |
| HCI 服务 | `/usr/local/bin/bt_user_daemon` | 打开 /dev/ttyS0（3M+CRTSCTS）走 H4 协议，提供 unix socket 供应用查询 |

---

## 1. 环境准备

### 1.1 设备状态确认

```sh
# SSH 登录
ssh root@<设备IP>        # 
# 或
ssh root@<WiFi-IP>           # WiFi 网络地址

# 确认内核与主机名
uname -a                        # 期望: Linux 3.10.65 ... armv7l
hostname                        # 期望: spd-box

# 确认 chroot 安卓环境存在（download 依赖它）
ls /tmp/aand/bin/download /tmp/aand/bin/wcnd
ls /tmp/aand/etc/marlinba/     # 期望有 connectivity_configure.ini 等
```

> ⚠️ 若 `/tmp/aand` 不存在：需重新搭建 Android 用户态 chroot 环境（建目录、铺 Android system 库、mount --bind /dev、建 wcnfdl/wcnmodem 分区软链）。详见 WiFi 操作手册第 4 章。

### 1.2 工具清单

| 工具 | 用途 | 位置 |
|---|---|---|
| `download` | 固件下载引导器 | `/tmp/aand/bin/download`（chroot 内执行） |
| `wcnd` | 蓝牙/WiFi 上电守护 | `/tmp/aand/bin/wcnd`（chroot 内执行） |
| `bt_once` | BT-OPEN 一次性上电触发 | `/tmp/bt_once` |
| `bt_wake.sh` | btwrite 周期唤醒脚本 | `/tmp/bt_wake.sh` |
| `bt_probe_full` | HCI 全序列探针（诊断） | `/tmp/bt_probe_full` |
| `hci_3m` | 3M 波特率 HCI 原始测试 | `/tmp/hci_3m`（早期诊断用） |
| `bt_user_daemon` | 用户态 HCI 守护（生产） | `/usr/local/bin/bt_user_daemon` |
| python3 | unix socket 客户端 | 设备自带 |

---

## 2. 第一步：拉起 WiFi（蓝牙前提，不能跳过）

蓝牙芯片与 WiFi 共用同一固件与电源域，**必须先把 WiFi 芯片拉起来**，蓝牙才有物理基础。

```sh
# 1) 清理残留（不要杀 download！）
pkill -9 -f logdw 2>/dev/null
pkill -9 -f 'wcnd' 2>/dev/null
pkill -9 -x bt_once 2>/dev/null

# 2) 启动固件下载通道守护
setsid /tmp/logdw >/dev/null 2>&1 </dev/null &

# 3) 固件下载（WiFi 模式，常驻勿杀）
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl_run.log 2>&1 </dev/null &

# 4) 等待 SDIO 枚举（10~30 秒）
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # 期望: 0x2331
ls /sys/bus/sdio/devices/                        # 期望出现 mmc2:8800:1

# 5) 加载 WiFi 驱动（顺序不能反）
insmod /lib/modules/marlin_fm.ko
insmod /lib/modules/sprdwl.ko
ip link set wlan0 up
ip link show wlan0                              # 出现 wlan0 即成功
```

> 验证标准：`mmc2:8800:1` 设备号 `0x2331`，`wlan0` 接口存在。

---

## 3. 第二步：蓝牙上电序列（BT-OPEN）

### 3.1 修复 mdbg 权限（关键！重启后必做）

BT-OPEN 失败的头号原因：chroot 内 `/tmp/aand/proc/mdbg/*` 权限为 600，导致上电命令无响应。

```sh
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null
```

### 3.2 启动 wcnd + 触发 BT-OPEN

```sh
# wcnd（蓝牙/WiFi 上电守护）
ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2

# BT-OPEN 一次性触发，期望输出 push(17): WCNBTWIFI-CMD OK
setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 3
cat /tmp/bt_once.log          # 看到 "WCNBTWIFI-CMD OK" 即上电成功
```

> 若输出 `FAIL`：重新执行 3.1 的 chmod（多半是权限问题），再重跑本步。

---

## 4. 第三步：btwrite 周期性唤醒（缺了它 HCI 无响应）

蓝牙固件上电后默认进入省电模式，**必须周期性唤醒**才有 HCI 响应。

```sh
# 启动周期唤醒脚本（每 1.5~2 秒写 1）
setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &

# 手动验证唤醒节点存在且可写
cat /proc/bluetooth/sleep/btwrite          # 应返回 0 或 1
echo 1 > /proc/bluetooth/sleep/btwrite && echo WRITE_OK
```

> 缺这一步的典型症状：`bt_probe_full` 发 HCI Reset 后收不到任何响应（或只收到一次 `55 7e ... 53 50 52 44 33`（SPRD3）身份帧后无后续）。

---

## 5. 第四步：HCI 通道诊断（可选，验证底层）

```sh
# 完整 HCI 探针：六步全通 = 底层 OK
/tmp/bt_probe_full 20 2>&1 | tail -30

# 期望看到：
#   Reset            → 04 0e 04 01 03 0c 00
#   Read Local Ver   → HCI 6.0, 制造商标识 0x1380（展讯）
#   Read BD_ADDR     → 11:22:14:31:93:27
#   Read Buffer Size / Features → ff ff 8d fe（与 pskey feature_set 一致）
#   Write Scan Enable → 成功
```

| 探针步骤 | 意义 |
|---|---|
| HCI Reset | 芯片 HCI 引擎启动 |
| Read Local Version | 固件版本 / 厂商识别 |
| Read BD_ADDR | 芯片蓝牙 MAC |
| Read Buffer Size | HCI 缓冲能力 |
| Read Features | 特性集（验证 pskey 是否生效） |
| Set Event Mask + Write Scan Enable | 为扫描做准备 |

---

## 6. 第五步：部署用户态 HCI 守护进程（生产方案）

> 说明：为什么不用内核 hci_uart 驱动？该设备内核是 3.10.65 安卓定制内核，用户编译的 hci_uart.ko 硬编码 tty_struct 偏移不匹配，hci0 能注册但 `TX=0`、`hciconfig up` 超时，驱动路线不通。用户态方案直接读写 /dev/ttyS0，不依赖内核协议栈，最可靠。

### 6.1 编译 daemon

源码 `bt_user_daemon.c`（本地保存），在设备上编译：

```sh
gcc -O2 -o /usr/local/bin/bt_user_daemon /tmp/bt_user_daemon.c -lpthread
```

关键实现要点（维护时参考）：
- 打开 `/dev/ttyS0`：`B3000000`（3M）+ `CRTSCTS`，`VMIN=1`（阻塞读）
- H4 协议：按帧头 `buf[1]=evt / buf[2]=len` 读取完整帧
- 扫描前必须先发 `Write Scan Enable (0x0c1a, 0x03)` 再发 Inquiry（GIAC `0x33 0x8b 0x9e`），否则固件不回 Inquiry Result
- unix socket `/tmp/bt_ctl.sock`（0666），文本命令：`state` / `on` / `off` / `scan <N>` / `list` / `connect <bd>`

### 6.2 部署 + 自启（openrc）

```sh
# 单实例启动
pkill -9 -x bt_user_daemon 2>/dev/null
setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &

# openrc 自启
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

### 6.3 验证（unix socket 客户端）

设备端 python3（无 socat）：

```sh
# 查状态
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"
# 期望: OK ON

# 扫描 15 秒（读到 EOF）
printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"
# 期望: OK <N>  + 每行一个设备:  bd_addr class rssi
# 实测:  OK 1 / 48:f1:ae:25:7e:48 5a420c 0
```

---

## 7. 开机自启链路（重启后全自动）

设备重启后由 `/etc/local.d/` 脚本链自动拉起：

```
/etc/local.d/wifi.start    → logdw + download（常驻）+ WiFi 驱动 + wlan0
/etc/local.d/lvgl_demo.start → 启动 LVGL 桌面（/usr/local/bin/lvgl_demo）
/etc/init.d/bt_daemon      → bt_user_daemon（openrc）
```

> 关键红线：
> - **download 常驻勿杀** —— 全杀会破坏 WiFi/蓝牙固件状态，需要重启设备才能恢复
> - 重启后必须重新执行 3.1 的 `chmod 666 /tmp/aand/proc/mdbg/*`（脚本里已自动做）
> - 进程清理一律用 `pkill -9 -x bt_user_daemon`，不要用 `ps | grep` 内嵌模式（会误杀执行命令的 shell 自身）

---

## 8. 常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| BT-OPEN 返回 FAIL | `/tmp/aand/proc/mdbg/*` 权限 600 | `chmod 666 /tmp/aand/proc/mdbg/*` 后重试 |
| HCI 无响应 / 只回一次 SPRD3 帧 | 缺 btwrite 唤醒 | 启动 `/tmp/bt_wake.sh`，确认 `/proc/bluetooth/sleep/btwrite` 可写 |
| 扫描不出设备 | 未先发 Write Scan Enable | 走 daemon 的 `scan` 命令（内部已处理），勿裸发 Inquiry |
| socket connect 失败 | daemon 多实例抢 socket | `pkill -9 -x bt_user_daemon` 后单实例重启 |
| daemon 日志报 "Not a tty" | tty ldisc 被占 | python `fcntl.ioctl(fd, 0x5421, b'\x00\x00\x00\x00')` 恢复 N_TTY |
| 内核 hci0 注册但 TX=0 | 3.10 内核 hci_uart 偏移不匹配 | 放弃内核驱动，使用用户态 daemon |
| WiFi 起不来 | download 被误杀 | 重启设备，按第 2 章重新拉起 |

---

## 9. 涉及的关键节点 / 参数速查

| 项目 | 值 |
|---|---|
| SDIO 设备 | `/sys/bus/sdio/devices/mmc2:8800:1`，device=0x2331 |
| HCI 串口 | `/dev/ttyS0`，波特率 3M（B3000000）+ CRTSCTS，H4 协议 |
| 唤醒节点 | `/proc/bluetooth/sleep/btwrite`（写 1，每 1.5~2s） |
| UART 配置节点 | `/sys/devices/70000000.uart/uart_conf`（0x1a1=115200，0x341=57600） |
| socket | `/tmp/bt_ctl.sock`（0666） |
| 调试日志 | `/tmp/btud_dbg.log`（TX/RX hex）、`/tmp/btud.log`（stdout） |
| 固件真实 MAC | `11:22:14:31:93:27`（固件响应，非伪造） |
| pskey | `/mnt/android_sys/lib/modules/pskey_bt.txt`（feature_set/device_addr），download 经 `connectivity_configure.ini` [SETCTION 6] 下发 |
| 已知可扫设备 | `48:f1:ae:25:7e:48`（class=5a420c 手机） |
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
