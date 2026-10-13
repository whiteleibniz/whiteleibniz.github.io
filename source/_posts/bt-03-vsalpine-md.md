---
title: "蓝牙启动流程_安卓vsAlpine对比"
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


# 展讯 SC9832A 蓝牙启动流程 —— 安卓 vs Alpine（本设备）对比

> 硬件：展讯 Marlin combo WCN 芯片（WiFi + 蓝牙同芯片）
> 本设备：保留安卓 6.0 内核（3.10.65）+ switchroot 到 Alpine Linux
> 目的：说清蓝牙从开机到可用的完整流程，对比安卓原生与当前 Alpine 方案的原理差异

---

## 1. 芯片物理架构（两种系统共用）

```
                    ┌─────────────────────────────┐
                    │      Marlin combo WCN       │
                    │  ┌──────────┐  ┌──────────┐ │
                    │  │ WiFi     │  │ Bluetooth│ │
                    │  │ (wlan0)  │  │ (HCI)    │ │
                    │  └──────────┘  └──────────┘ │
                    └──────┬──────────────┬───────┘
                           │ SDIO         │ UART
                           │              │ ttyS0 (3M + CRTSCTS)
        ┌──────────────────┴──┐      ┌────┴─────────────┐
        │ mmc2:8800:1 (0x2331)│      │ /proc/bluetooth/ │
        │                     │      │ sleep/btwrite    │  ← 唤醒节点
        └─────────────────────┘      └──────────────────┘
```

- **SDIO**：数据通道（WiFi 数据、蓝牙固件大块下载都走这里）
- **UART ttyS0**：蓝牙 HCI 控制通道（3M 波特率 + 硬件流控 CRTSCTS，H4 协议）
- **btwrite 节点**：`/proc/bluetooth/sleep/btwrite` —— 写 1 唤醒蓝牙引擎（省电模式管理）

---

## 2. 安卓 6.0 原生蓝牙启动流程

安卓侧关键信息来自原机 `init.board.rc` / `init.rc` / `ueventd.rc`：

### 2.1 启动链

```
开机
 └─ init 执行 init.board.rc
     ├─ chmod 660 /proc/bluetooth/sleep/btwrite    ← 唤醒节点权限
     ├─ chmod 660 /sys/devices/70000000.uart/uart_conf ← UART 配置节点
     ├─ chown bluetooth system ...（属主）
     ├─ service download  /system/bin/download     ← 固件下载（class core, oneshot）
     │     user system / group system shell wifi bluetooth
     ├─ service btld /system/bin/btld -lpm 0 -hb 3000000  ← 蓝牙低功耗管理（3M 波特率）
     │     user root / group bluetooth net_bt_admin
     ├─ service bt_rm /system/bin/bt_rm             ← 蓝牙射频管理
     ├─ #service hciattach /system/bin/hciattach -n /dev/sttybt0 sprd_shark（被注释掉）
     └─ Bluedroid 协议栈（bluetooth.default.so + libbt-vendor）
           ├─ libbt-vendor: btwrite 唤醒（H709 日志可见每 30s 周期写 1→1.5s→写 2）
           ├─ libbt-vendor: 读 uart_conf、发 pskey（BT_PSKEY_CONFIG_INFO_T）
           ├─ 固件回 SPRD3 身份帧 → HCI 标准命令就绪
           └─ BluetoothCtrl 管理（扫描/配对/连接）
```

### 2.2 安卓关键点

| 环节 | 安卓做法 |
|---|---|
| 固件下载 | `download` 开机 oneshot 执行，读 `connectivity_configure.ini`（含蓝牙 pskey [SETCTION 6]）+ calibration，SDIO 大块写入 |
| 上电控制 | `wcnd`（BT-OPEN 命令触发蓝牙子系统上电） |
| 唤醒管理 | libbt-vendor 周期性 `btwrite` 唤醒（H709 日志：每 30s 写 1 → 1.5s → 写 2） |
| HCI 通道 | 传统上 hciattach 走 /dev/sttybt0 sprd_shark；本机实际靠 libbt-vendor 直接管理 UART（uart_conf 控制波特率） |
| 协议栈 | Bluedroid（bluetooth.default.so + libbt-vendor.so） |
| 用户工具 | BluetoothCtrl（展讯定制蓝牙控制） |
| 节点/权限 | init.board.rc 开机统一 chmod/chown |

---

## 3. Alpine（本设备）蓝牙启动流程

### 3.1 启动链（当前已固化）

```
开机
 ├─ /etc/local.d/wifi.start        （local 脚本）
 │     ├─ setsid /tmp/logdw                       ← 固件下载日志通道
 │     ├─ setsid chroot /tmp/aand /bin/download -i wlan0   ← 固件下载（常驻）
 │     ├─ SDIO 枚举验证 mmc2:8800:1 = 0x2331
 │     ├─ insmod marlin_fm.ko → sprdwl.ko         ← WiFi 驱动
 │     └─ ip link set wlan0 up
 ├─ /etc/local.d/lvgl_demo.start
 │     └─ setsid /usr/local/bin/lvgl_demo         ← LVGL 桌面（含蓝牙设置页）
 ├─ /etc/init.d/bt_daemon          （openrc）
 │     ├─ chmod 666 /tmp/aand/proc/mdbg/*         ← 修复 BT-OPEN 权限（重启后必做）
 │     ├─ setsid chroot /tmp/aand /bin/wcnd       ← 上电守护
 │     ├─ setsid /tmp/bt_once 900                 ← BT-OPEN（期望 WCNBTWIFI-CMD OK）
 │     ├─ setsid /tmp/bt_wake.sh                  ← btwrite 周期唤醒
 │     └─ setsid /usr/local/bin/bt_user_daemon    ← 用户态 HCI 守护（unix socket 服务）
 └─ LVGL 蓝牙设置页
       ├─ 开关 → socket `on`/`off`
       ├─ 搜索 → socket `scan N`
       └─ 设备列表 ← socket 返回 bd_addr class rssi
```

### 3.2 Alpine 关键点

| 环节 | Alpine 做法 |
|---|---|
| 固件下载 | **复用安卓原版 download**，在 chroot `/tmp/aand` 内运行（依赖安卓库/节点/分区软链），参数 `-i wlan0`（WiFi 模式，蓝牙固件随 combo 一起下载） |
| 上电控制 | 复用安卓原版 wcnd（chroot 内）+ bt_once 触发 BT-OPEN |
| 唤醒管理 | 自写 `/tmp/bt_wake.sh` 每 1.5~2s 写 btwrite=1（比安卓 30s 更勤，保证 HCI 稳定响应） |
| HCI 通道 | **自写用户态 daemon** 直接打开 /dev/ttyS0（3M+CRTSCTS，H4），不依赖内核 hci_uart 驱动 |
| 协议栈 | 无 Bluedroid；daemon 实现最小 HCI 命令集（Reset/Version/BD_ADDR/Features/Scan） |
| 用户工具 | LVGL 蓝牙设置页（unix socket 与 daemon 通信） |
| 节点/权限 | 开机脚本 chmod 666 mdbg + bt_daemon openrc 管理 |

---

## 4. 逐环节对比表

| 对比项 | 安卓 6.0 原生 | Alpine（本设备） | 差异原因 |
|---|---|---|---|
| 固件下载 | download（oneshot，system 用户） | download（chroot，常驻） | Alpine 无安卓 init，需保持进程防芯片掉固件 |
| 固件来源 | 分区 wcnfdl/wcnmodem | 同分区（by-name 软链到 chroot） | 内核相同，分区布局不变 |
| pskey 下发 | libbt-vendor 初始化时发 VSC | download 下载时经 connectivity_configure.ini 下发 | 固件已在下载阶段拿到 pskey（实测 feature_set 生效） |
| BT 上电 | wcnd + BT-OPEN（init 触发） | wcnd（chroot）+ bt_once | 复用原版，仅执行者不同 |
| 唤醒 | libbt-vendor 每 30s btwrite | bt_wake.sh 每 1.5~2s btwrite | 用户态无 libbt-vendor，自写更勤的唤醒保证不丢响应 |
| HCI 通道 | libbt-vendor 直接管 UART | 自写 daemon 直接读 /dev/ttyS0 | 同样绕过内核协议栈，直接操作串口 |
| 内核驱动 | 无 hci_uart（vendor 直管） | 尝试过 hci_uart.ko → 放弃（TX=0） | 3.10 内核 tty_struct 偏移与新版驱动不匹配 |
| 协议栈 | Bluedroid（完整 stack） | 无协议栈，daemon 仅 HCI 层 | Alpine 无 Bluedroid；LVGL 应用层直接消费 HCI 扫描结果 |
| 扫描实现 | Bluedroid Inquiry | daemon Inquiry + Write Scan Enable 前置 | 展讯固件特性：不先开扫描使能就不回 Inquiry Result |
| 管理工具 | BluetoothCtrl | LVGL 蓝牙设置页（socket） | 面向桌面应用的定制 UI |
| 波特率 | 115200 → 3M（uart_conf 切换） | 直接 3M 打开 ttyS0 | 固件 BT 初始化后切到 3M，daemon 固定用 3M |

---

## 5. 原理要点（为什么能通）

1. **同一颗 combo 芯片，固件是 WiFi+BT 一体的** —— download 以 `-i wlan0` 下载时，蓝牙固件部分已随 combo 镜像进入芯片，因此"WiFi 拉起后蓝牙固件已就绪"，后续只需上电 + 唤醒 + HCI 通信，不需要单独再烧蓝牙固件。

2. **SPRD3 身份帧是引擎启动信号** —— 唤醒后固件回 `55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e`（"SPRD3" = 展讯芯片标识），说明蓝牙引擎在跑、HCI 通道活着；此后才能发标准 HCI 命令。

3. **btwrite 是省电开关** —— 蓝牙引擎空闲进入低功耗，必须周期性写 1 唤醒；缺这一步，HCI 命令发出去没有响应（这是早期所有测试失败的共同根因之一）。

4. **Write Scan Enable 是扫描前提** —— 展讯固件要求先发 `0x0c1a (0x03)` 开启扫描使能，Inquiry 才会返回 Inquiry Result 事件；裸发 Inquiry 会被接受（CMD_STATUS 0x00）但永远等不到结果。

5. **用户态方案 vs 内核驱动** —— 该设备内核为安卓定制 3.10.65，hci_uart.ko 依赖的 tty_struct 内部布局与主线不一致，硬编码偏移导致 TX=0、up 超时。直接用户态读写 /dev/ttyS0 绕开内核协议栈，反而最可靠（安卓 vendor 本来就是这么干的）。

---

## 6. 一句话总结

> **安卓**：init → download → wcnd/BT-OPEN → libbt-vendor（btwrite 唤醒 + pskey + HCI）→ Bluedroid → BluetoothCtrl
> **Alpine（本设备）**：开机脚本 → chroot download（WiFi 模式，combo 固件一起下）→ wcnd/bt_once → bt_wake.sh（btwrite）→ 自写用户态 daemon（H4 HCI）→ LVGL 蓝牙设置页

底层硬件链路完全一致，差异只在"由谁来执行"：安卓靠 init + 完整协议栈，本设备靠开机脚本 + 自写用户态守护进程，用最小实现换掉安卓那一整套依赖。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
