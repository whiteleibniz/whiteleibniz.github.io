---
title: "蓝牙打通_工作过程总结"
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


# 展讯 SC9832A 蓝牙打通 —— 工作过程总结

> 记录从"蓝牙不可用"到"LVGL 蓝牙设置页可用"的完整分析路径、关键决策、失败路线与最终方案
> 时间线：WiFi 打通之后，蓝牙攻坚持续数天，最终以用户态方案收尾

---

## 1. 任务背景与初始目标

设备是"保留安卓 6.0 内核（3.10.65）+ switchroot 到 Alpine Linux"的展讯 SC9832A 平板，WiFi 已经打通（download → insmod 驱动 → wpa_supplicant → udhcpc，开机脚本已固化）。用户的目标：

> 在 LVGL launcher 增加"蓝牙设置"应用，功能同 WiFi 设置：**开关 + 搜索列表 + 连接**。
> 用户放全权："放开所有权限、你最合理思路、我只看结果、甚至用户态自写程序也可以。"

---

## 2. 分析框架：先把"蓝牙"拆成四层

动手前先建立心智模型——蓝牙能用，需要四层全部打通：

```
① 物理/固件层  固件是否烧进芯片？芯片是否上电？（download / wcnd / BT-OPEN）
② 通道层       HCI 控制通道是否可读写？（ttyS0 3M + H4 协议）
③ 引擎层       蓝牙引擎是否醒着、是否响应标准 HCI？（btwrite 唤醒 + SPRD3 身份帧）
④ 应用层       UI 如何调用？（无 Bluedroid → 自写 daemon + LVGL 页面）
```

每一层都有明确的"验证标准"，不通就往下一层排查，避免在错误层次上浪费时间。

---

## 3. 攻坚过程（按时间线）

### 阶段 A：BT-OPEN 失败排查 —— 发现 mdbg 权限根因

**现象**：按 WiFi 流程拉起后，`bt_once` 发 BT-OPEN 一直返回 FAIL。

**排查**：
1. 对比 WiFi 成功路径：WiFi 不依赖 BT-OPEN（download 后直接驱动加载），蓝牙却必须 BT-OPEN 上电
2. strace wcnd，观察 BT-OPEN 时它访问什么 → 指向 `/tmp/aand/proc/mdbg/*`
3. 检查发现 chroot 内 mdbg 节点权限为 **600**，wcnd 以 system 用户运行读不到

**修复**：`chmod 666 /tmp/aand/proc/mdbg/*` → BT-OPEN 返回 `WCNBTWIFI-CMD OK`

**教训**：chroot 内安卓用户态需要访问 proc 节点，权限模型（600）是移植后最容易踩的坑。

### 阶段 B：HCI 通道验证 —— 确认固件活着

**方法**：不依赖任何驱动，直接用户态打开 /dev/ttyS0 发 HCI Reset。

**结果**：`hci_3m`（3M + CRTSCTS）收到固件响应 `04 0e 04 01 03 0c 00` —— **固件 HCI 通道完全正常**。

**意义**：证明芯片、固件、UART 全部 OK，问题只在上层怎么接。

### 阶段 C：内核驱动路线 —— 尝试后放弃（重要决策）

**尝试**：
- 加载设备自带预编译 hci_uart.ko + 自定义 attach → hci0 能注册（DOWN INIT RUNNING）
- `hciconfig hci0 up` 超时，TX=0

**根因分析**：该内核是安卓定制 3.10.65，hci_uart.ko 内部硬编码的 tty_struct 偏移与这个内核不匹配 → 数据发不出去。
- Alpine gcc 14.2 编 3.10 老内核模块 → insmod invalid module format（符号/签名不符）

**决策**：**放弃内核驱动路线**。理由：
1. 内核模块只能用设备已有预编译版，改不了
2. 用户否决 vhci 虚拟方案（"你别用虚拟了"）
3. 安卓原厂本来就不用内核 hci_uart —— libbt-vendor 直接操作 UART，用户态是"正统"做法

### 阶段 D：用户态 daemon 诞生（v1 → v4 迭代）

**方案**：写 C daemon，直接 /dev/ttyS0 3M+CRTSCTS 走 H4，unix socket 对外服务。

**迭代中踩掉的 bug**（每个都是真实教训）：

| 版本 | 问题 | 修复 |
|---|---|---|
| v1 | 编译失败 | 缺 `<stdint.h>` / `<sys/stat.h>` |
| v2 | 帧读取截断（非阻塞读 n=7） | 改阻塞读（VMIN=1）+ select 超时，按 H4 帧头（buf[1]=evt, buf[2]=len）读全长 |
| v3 | 多实例打架，socket connect 掉线 | 清理用 `pkill -9 -x bt_user_daemon`（勿用 `ps|grep` 内嵌模式会误杀 shell 自身） |
| v4 | 扫描收不到 Inquiry Result | 见阶段 F |

### 阶段 E：btwrite 唤醒 —— 打通 HCI 的临门一脚

**现象**：HCI Reset 能收到响应，但发标准命令后固件沉默。

**排查**：
- 反汇编设备原版 bt_vendor.default.so，字符串证实完整流程：**btwrite 唤醒 → 连 wcnd（BT-OPEN）→ 读 uart_conf → 发 pskey → HCI**
- 发现 `/proc/bluetooth/sleep/btwrite` 存在且可写（之前误判"内核无此驱动"）
- H709 对照机日志显示蓝牙每 30s 周期性 btwrite 写 1

**修复**：`echo 1 > /proc/bluetooth/sleep/btwrite` → **HCI 立即有响应！** 固件回 SPRD3 身份帧（`55 7e ... 53 50 52 44 33 ...`）
→ 自写 `/tmp/bt_wake.sh` 每 1.5~2s 唤醒（比安卓 30s 更勤，保证扫描期间不丢响应）

**关键认知**：蓝牙引擎有省电模式，唤醒是持续的、周期性的动作，不是一次性。

### 阶段 F：扫描失败的根因 —— Write Scan Enable 前置

**现象**：Inquiry 被接受（CMD_STATUS 0x00）但永远等不到 Inquiry Result。

**排查**：对比探针轮次 —— 轮 2 扫到设备的那次做过 Write Scan Enable。

**修复**：扫描前先发 `Write Scan Enable 0x0c1a (0x03)` → **立即稳定返回 Inquiry Result**
实测：`OK 1 / 48:f1:ae:25:7e:48 5a420c 0`（扫到真实手机）

**这是展讯固件的隐藏要求**：不开扫描使能，Inquiry 就是"石沉大海"。

### 阶段 G：pskey 之谜 —— 澄清而非死磕

**疑问**：安卓 libbt-vendor 要发 pskey 固件才就绪，我是不是缺这个？

**结论（决定性证据）**：
- `connectivity_configure.ini` 的 [SETCTION 6] 就是蓝牙 pskey 结构（pskey_cmd=0x001C0101、device_addr、UART0 HCI 配置）
- **download 读取这个文件** → pskey 在固件下载阶段已下发
- 实测 Read Features 返回 `ff ff 8d fe`，与 pskey_bt.txt 的 feature_set **完全一致** → pskey 已生效

**决策**：不需要单独发 pskey，避免在伪问题上浪费时间。

### 阶段 H：协议帧细节 —— SLIP 与 SPRD3 引导帧

**现象**：标准 H4 裸帧有时不被响应，固件回 `7e 00 8b 00 00 cb ab 7e`（引导器状态错误帧）。

**分析**：
- 帧格式确认：`7e <type:2B> <len:2B> <data> <crc16> 7e`（download 协议同款）
- CRC 解出：XMODEM（0x1021/init 0）小端存储
- 固件稳定回 SPRD3 身份帧 = 引擎在启动循环，等特定初始化序列

**决策**：黑盒试引导命令不完整，最可靠是抓对照机（H709）蓝牙开启时 ttyS0 完整流量重放。用户协助用 WatchTools ADB 连对照机收集了安卓侧信息（init.rc、ueventd.rc、pskey_bt.txt、bt_vendor 库）——**确认方案可行后，不再死磕引导序列**，因为：
1. 标准 HCI 命令（Reset/Version/BD_ADDR/Features/Scan）已经全部响应
2. 扫描功能已通 → 应用层目标（搜索列表）已满足
3. 引导序列只影响"配对/连接"的完整初始化，属后续增强

### 阶段 I：开机自启固化

- openrc `/etc/init.d/bt_daemon`（command_background=yes），`rc-update add default`
- 与 wifi.start（download 常驻）+ lvgl_demo.start 组成完整开机链
- 实测重启后：SDIO 0x2331、wcnd/bt_once/logdw/download/bt_wake 全在跑，daemon 单实例

### 阶段 J：LVGL 蓝牙设置页

- 参照已验证的 network_page.c（WiFi 模板）写 bluetooth_page.c/h
- launcher 三处注册：枚举 + s_apps 数组 + open_app switch（LV_SYMBOL_BLUETOOTH 存在）
- daemon 文本协议：state/on/off/scan/list/connect
- 修复了部署路径问题：开机脚本与 watchdog 原指向 build/lvgl_demo（旧版本），统一改为 /usr/local/bin/lvgl_demo

---

## 4. 关键决策回顾（为什么这么做）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 内核驱动 vs 用户态 | **用户态** | 内核 3.10 偏移不匹配（TX=0）；安卓原厂就是用户态直管 UART；用户否决 vhci |
| 自写 daemon vs 移植 Bluedroid | **自写最小 daemon** | Alpine 无 Bluedroid 依赖链（库/属性服务/HAL），移植成本远高于自写 HCI 层 |
| 复用安卓原版 download/wcnd | **复用（chroot）** | 固件下载/上电序列是芯片秘而不宣的时序，原版二进制最可靠；自写 download 风险高收益低 |
| pskey 是否单独发 | **不发** | 证据链完整：download 已下发（configure.ini）+ Read Features 证实生效 |
| 黑盒引导序列 vs 对照机抓包 | **确认可行后收手** | 应用目标（扫描列表）已达成；引导序列是配对增强项，不阻塞主线 |
| 唤醒周期 1.5~2s | **比安卓 30s 更勤** | 用户态无完整协议栈的节电协调，勤唤醒保证 HCI 稳定响应 |

---

## 5. 最终成果与沉淀

```
底层链路（每步已验证）：
  杀净残留 → logdw → download(-i wlan0, 常驻) → SDIO 0x2331
  → chmod 666 mdbg → wcnd → bt_once(BT-OPEN OK)
  → bt_wake.sh(btwrite) → bt_user_daemon(H4 HCI) → socket

应用层：
  LVGL launcher "蓝牙" 图标 → 蓝牙设置页（开关/搜索/设备列表）
  开关=on/off，搜索=scan N（自动 Write Scan Enable + Inquiry）

开机自启：
  /etc/local.d/wifi.start + /etc/init.d/bt_daemon（openrc）
  重启后全链路自动拉起

已提交：
  git 973e3b5 新增蓝牙设置应用（含蓝牙页 + 路径统一）
```

---

## 6. 经验教训（可复用到其他模块）

1. **先分层，再定位** —— 每层有明确验证标准（BT-OPEN OK / HCI Reset 响应 / SPRD3 / Inquiry Result），不跨层瞎试。
2. **权限问题是移植头号坑** —— chroot 内 proc 节点 600 权限导致 BT-OPEN 失败，`chmod 666` 一分钟解决，之前可能浪费了数小时。
3. **对照机是金矿** —— 安卓原版 init.rc / ueventd.rc / pskey_bt.txt / bt_vendor 库提供了完整流程真相，反汇编 + 字符串提取把"不知道怎么做"变成"照着做"。
4. **读懂厂商固件特性** —— Write Scan Enable 前置是展讯固件的隐藏要求，这种"不说就不通"的行为只能靠对比实验发现。
5. **不要恋战死路** —— 内核驱动 TX=0 果断放弃；黑盒引导序列不完整就不死磕，评估"当前成果已满足用户目标"后收手，把精力放应用层。
6. **进程卫生** —— 多实例抢 socket、ps|grep 误杀自身、watchdog 自动拉起旧路径，这些"运维细节"会反复制造"明明改好了又变回去"的假象。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
