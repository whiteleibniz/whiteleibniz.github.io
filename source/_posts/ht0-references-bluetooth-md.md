---
title: "bluetooth"
date: 2026-09-13 15:27:33
search: true
categories:
- AI工作流
- 可复用资产
tag:
- HT0
- WCN
- 技能
---


# 展讯 SC9832A 设备（HT0）蓝牙打通 —— AI 执行指导手册

> **读者对象**：AI 助手（豆包 / 其他大模型），需在同类设备（展讯 SC9832A，安卓内核 + Alpine 用户态）上快速解决蓝牙不可用问题
> **使用方式**：先读 §1–§3 建立上下文 → 按 §5 标准流程执行 → 按 §6 验证 → 遇故障查 §7 决策表
> **核心价值**：本文所有事实均已实测验证；照着做最快 5 分钟确认底层是否通，避免重复数天踩坑

---

## 1. 设备与环境速览

| 项目 | 值 |
|---|---|
| 设备型号 | HT0（对照机：H709，跑安卓 6.0，可作信息源） |
| 主机名 / 内核 | `spd-box` / `Linux 3.10.65 #13 SMP PREEMPT armv7l` |
| 系统组合 | **保留安卓 6.0 内核 + switchroot 到 Alpine Linux**（关键！） |
| SSH | `root@<设备IP>`（RNDIS 调试口，密码见环境记录）/ WiFi: `<WiFi-IP>` |
| 无线芯片 | 展讯 **Marlin combo WCN**（WiFi + 蓝牙同一颗芯片） |
| 蓝牙 HCI | `/dev/ttyS0`，3M 波特率 + CRTSCTS，H4 协议 |
| 蓝牙唤醒 | `/proc/bluetooth/sleep/btwrite`（写 1） |
| 当前状态 | 底层已打通，用户态 daemon + LVGL 蓝牙设置页已部署，开机自启 |

> ⚠️ 重启后 SSH 可能短暂不可达（USB 口切换），需轮询重试；`/tmp` 目录重启后保留（chroot 环境、工具都在）。

---

## 2. 已确认的硬事实（无需重新探查，直接信任）

1. **蓝牙固件随 WiFi 一起下载**：执行 `chroot /tmp/aand /bin/download -i wlan0` 时，combo 固件（含蓝牙部分）已整体烧入芯片 → **WiFi 拉起 = 蓝牙固件已就绪**，不需要单独烧蓝牙固件。
2. **pskey 已生效**：download 读 `/tmp/aand/etc/marlinba/connectivity_configure.ini` 的 [SETCTION 6] 下发蓝牙 pskey；实测 Read Features 返回 `ff ff 8d fe` 与 `pskey_bt.txt` 的 feature_set 完全一致 → **不要纠结"缺 pskey"，不需要单独发**。
3. **BT-OPEN 失败头号根因**：chroot 内 `/tmp/aand/proc/mdbg/*` 权限 600 → `chmod 666 /tmp/aand/proc/mdbg/*` 后返回 `WCNBTWIFI-CMD OK`。重启后必做。
4. **btwrite 是 HCI 有响应的前提**：蓝牙引擎省电休眠，必须周期性（1.5~2s）写 1 唤醒；缺它 → HCI 无响应或只回一次 SPRD3 身份帧。
5. **SPRD3 身份帧 = 引擎启动信号**：`55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e`（"SPRD3"=展讯标识），收到它说明 HCI 通道活了。
6. **扫描前置**：必须**先发 Write Scan Enable（0x0c1a, 0x03）再发 Inquiry**（GIAC `0x33 0x8b 0x9e`），否则 Inquiry 被接受（CMD_STATUS 0x00）但永远无 Inquiry Result。
7. **固件真实 MAC**：`11:22:14:31:93:27`（探针响应值，不是伪造）。
8. **波特率**：固件 BT 初始化后 115200→3M；daemon 直接以 3M 打开 ttyS0。
9. **已扫到设备样例**：`48:f1:ae:25:7e:48 class=5a420c`（手机，BR/EDR）。
10. **进程链**：`logdw → download(常驻) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)`。

---

## 3. 已验证死路（不要重试，浪费轮次）

| 路线 | 结果 | 原因 |
|---|---|---|
| 内核 `hci_uart.ko` 驱动 | hci0 能注册（DOWN INIT RUNNING）但 `hciconfig up` 超时、TX=0 | 3.10 安卓定制内核，tty_struct 偏移与驱动不匹配；Alpine gcc14.2 编老内核模块报 invalid module format |
| vhci 虚拟方案 | 用户明令否决 | — |
| 反复黑盒试引导命令序列 | 不完整、状态不稳定 | 引导协议需对照机抓包，且**不影响扫描功能达成**，不值得死磕 |
| `ps \| grep` 内嵌模式杀 daemon | 误杀执行命令的 shell 自身 | 用 `pkill -9 -x bt_user_daemon` |
| `/tmp/reset_tty` 恢复 ldisc | 段错误 | 用 python `fcntl.ioctl(fd, 0x5421, b'\x00\x00\x00\x00')`（TIOCSETD=0x5421, N_TTY=0） |
| 杀掉 download "重启干净环境" | 破坏 WiFi/蓝牙固件状态，需整机重启恢复 | **download 常驻勿杀** |

---

## 4. 系统模型：四层 + 每层验证标准

```
① 固件/物理层    download 烧固件 → SDIO 枚举 0x2331
                 验证: cat /sys/bus/sdio/devices/mmc2:8800:1/device  → 0x2331
② 上电层         wcnd + BT-OPEN → WCNBTWIFI-CMD OK
                 验证: cat /tmp/bt_once.log 含 "WCNBTWIFI-CMD OK"
③ 引擎层         btwrite 唤醒 → HCI 响应 + SPRD3 帧
                 验证: bt_probe_full 收到 Reset 响应 04 0e 04 01 03 0c 00
④ 应用层         daemon socket → LVGL 页面
                 验证: printf 'scan 15\n' 客户端 → OK N + 设备行
```

**排查纪律**：哪一层验证不过，就只在这一层及其上游找原因，不要跨层瞎试。

---

## 5. 标准执行流程（可直接复制）

### 5.1 确认环境

```sh
uname -a; hostname
ls /tmp/aand/bin/download /tmp/aand/bin/wcnd /tmp/bt_once /tmp/bt_wake.sh
ls /usr/local/bin/bt_user_daemon /tmp/bt_probe_full
```

### 5.2 拉起 WiFi（蓝牙前提）

```sh
pkill -9 -f logdw 2>/dev/null; pkill -9 -f 'wcnd' 2>/dev/null; pkill -9 -x bt_once 2>/dev/null
setsid /tmp/logdw >/dev/null 2>&1 </dev/null &
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl_run.log 2>&1 </dev/null &
sleep 15
cat /sys/bus/sdio/devices/mmc2:8800:1/device     # 期望 0x2331
insmod /lib/modules/marlin_fm.ko; insmod /lib/modules/sprdwl.ko
ip link set wlan0 up
```

### 5.3 蓝牙上电 + 唤醒 + daemon

```sh
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null

ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_once' || setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 3
grep -q 'CMD OK' /tmp/bt_once.log || echo "BT-OPEN FAIL, 检查 chmod 是否生效"

ps -ef | grep -q '[b]t_wake' || setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &

pgrep -x bt_user_daemon >/dev/null || setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
```

### 5.4 验证（设备端 python3，无 socat）

```sh
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"                    # 期望 OK ON

printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"                                # 期望 OK N + 设备行
```

---

## 6. 验证标准清单（逐项确认）

| # | 检查 | 期望 |
|---|---|---|
| 1 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 2 | `grep 'CMD OK' /tmp/bt_once.log` | `push(17): WCNBTWIFI-CMD OK` |
| 3 | `/tmp/bt_probe_full 20` | 六步全通（Reset/Ver/BD_ADDR/Buffer/Features/Scan Enable） |
| 4 | `cat /proc/bluetooth/sleep/btwrite` 可写 | `echo 1 > ...` 返回 WRITE_OK |
| 5 | socket `state` | `OK ON` |
| 6 | socket `scan 15` | `OK N` + 设备行（无设备则 N=0，不算失败） |
| 7 | `pgrep -x bt_user_daemon` | 单实例 |
| 8 | LVGL 桌面"蓝牙"图标 → 开关/搜索/列表 | 页面正常 |

---

## 7. 故障 → 根因 → 修复 决策表

| 症状 | 大概率根因 | 修复 |
|---|---|---|
| BT-OPEN FAIL | mdbg 权限 600 | `chmod 666 /tmp/aand/proc/mdbg/*` 重试 |
| HCI 无响应 / 只回一次 SPRD3 | 缺 btwrite 唤醒 | 启动 bt_wake.sh；确认 btwrite 可写 |
| 扫描无结果 | 未先 Write Scan Enable | 用 daemon scan 命令（内部已处理） |
| socket connect 失败 | daemon 多实例抢 socket | `pkill -9 -x bt_user_daemon` → 单实例重启 |
| daemon 日志 "Not a tty" | tty ldisc 被占 | python ioctl TIOCSETD=0x5421 恢复 N_TTY |
| WiFi/蓝牙一起没了 | download 被杀 | 整机重启，按 §5.2 重拉 |
| 屏幕程序反复"变回旧版" | watchdog/开机脚本指向 build 路径 | 统一改为 `/usr/local/bin/lvgl_demo`（已做） |
| 重启后 22 端口不通 | USB 口切换 | 轮询重连（本机可复用 bt_auto_resume.py） |

---

## 8. 用户态 daemon 架构（改动/维护必读）

```
┌─────────────┐   unix socket    ┌──────────────────────────┐
│ LVGL 蓝牙页 │  /tmp/bt_ctl.sock │  bt_user_daemon           │
│ (C, LVGL9)  │ ────────────────► │  ┌────────────────────┐  │
└─────────────┘   state/on/off/   │  │ H4 HCI 引擎         │  │
                  scan/list/      │  │ ttyS0 3M+CRTSCTS    │  │
                  connect         │  └─────────┬──────────┘  │
                                  │            │ HCI 帧       │
                                  │     ┌──────▼──────┐      │
                                  │     │ Marlin 芯片  │      │
                                  │     └─────────────┘      │
                                  └──────────────────────────┘
```

**协议**（文本行，客户端 shutdown(SHUT_WR) 后读到 EOF）：
- `state` → `OK ON` / `OK OFF`
- `on` / `off` → 开关蓝牙（HCI Reset + Scan Enable 使能/关闭）
- `scan N` → 扫描 N 秒，返回 `OK <count>` + 每行 `bd_addr class rssi`
- `list` → 列出最近扫描结果
- `connect <bd>` → 尝试连接（BR/EDR 对方未接受时返回 RC -2，属预期）

**实现要点**（重构时勿破坏）：
- `B3000000` + `CRTSCTS`，`VMIN=1` 阻塞读
- 帧读取按 H4 帧头：`buf[1]=evt`、`buf[2]=len`，select 超时保护
- 扫描流程固定为：`Write Scan Enable(0x0c1a,0x03)` → `Inquiry(0x0401, 33 8b 9e)` → 收 Inquiry Result
- socket 0666，单实例（openrc command_background 管理）
- 日志：`/tmp/btud.log`（stdout）、`/tmp/btud_dbg.log`（TX/RX hex）

---

## 9. 红线与运维纪律

1. **download 常驻勿杀** —— 全杀破坏固件状态，只能整机重启恢复。
2. **驱动加载顺序**：`marlin_fm.ko` 先、`sprdwl.ko` 后（符号依赖）。
3. **杀进程**：一律 `pkill -9 -x <名字>`，禁止 `ps | grep` 内嵌模式。
4. **重启后必做**：mdbg chmod 666（开机脚本已自动做，手动调试时别忘）。
5. **蓝牙扫描时保持 btwrite 唤醒**（bt_wake.sh 别停）。
6. **不要动 USB OTG / 网络模式配置**（用户明确约束）。
7. 多实例打架 = 先 `pkill` 清干净再起，别在残留上叠加。

---

## 10. 设备上已有工具清单（复用，勿重造）

| 工具 | 位置 | 用途 |
|---|---|---|
| bt_user_daemon | `/usr/local/bin/bt_user_daemon` | 生产 daemon（已部署） |
| bt_probe_full | `/tmp/bt_probe_full` | HCI 六步探针诊断 |
| hci_3m | `/tmp/hci_3m` | 3M 原始 HCI 测试 |
| bt_once | `/tmp/bt_once` | BT-OPEN 触发 |
| bt_wake.sh | `/tmp/bt_wake.sh` | btwrite 周期唤醒 |
| bt_daemon | `/etc/init.d/bt_daemon` | openrc 自启（rc-update add default） |
| wifi.start | `/etc/local.d/wifi.start` | 开机 WiFi + download 链 |
| lvgl_demo | `/usr/local/bin/lvgl_demo` | LVGL 桌面（含蓝牙页，git 已提交） |
| pskey_bt.txt | `/mnt/android_sys/lib/modules/pskey_bt.txt` | 蓝牙参数权威值 |
| btud_dbg.log | `/tmp/btud_dbg.log` | daemon TX/RX hex 日志 |

---

## 11. 后续增强方向（当前未完成）

| 项 | 说明 | 建议路径 |
|---|---|---|
| 真实配对/连接 | daemon `connect` 只在 BR/EDR 层测试过（RC -2 属预期） | 抓对照机 H709 蓝牙开启时 ttyS0 完整流量，重放初始化序列（含引导命令） |
| BLE 支持 | 当前只验证 BR/EDR 扫描 | 扩展 HCI LE 命令（LE Set Scan Parameters/Enable） |
| 音频 A2DP | 无协议栈，暂不可用 | 需引入 BlueZ 或轻量 A2DP 栈 |
| daemon 连接状态持久化 | 当前连接尝试不保存 | 页面可加"已连接设备"状态展示 |

---

## 12. 5 分钟快速验收路径

```sh
# 1) 三层状态一条命令
grep 'CMD OK' /tmp/bt_once.log && cat /sys/bus/sdio/devices/mmc2:8800:1/device && pgrep -x bt_user_daemon
# 2) 应用层一次 socket 调用
printf 'scan 8\n' | timeout 15 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"
```

以上两条通过 → 蓝牙底层 + 应用链路全部 OK，直接进入"增强方向"工作；不通过 → 按 §7 决策表逐项定位。

---

*文档版本：v1.0（蓝牙打通后沉淀）*
*关联文档：操作手册（人用）、启动流程对比、工作过程总结*
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
