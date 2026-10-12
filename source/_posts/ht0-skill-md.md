---
title: "ht0-wcn-radio Skill 说明"
date: 2026-09-13 16:05:17
search: true
categories:
- AI工作流
- 可复用资产
tag:
- HT0
- WCN
- 技能
---


---
name: ht0-wcn-radio
description: "展讯 SC9832A 设备（HT0，安卓内核 + Alpine 用户态）WiFi/蓝牙 combo 芯片（Marlin WCN）的运维排障与打通。当用户报告这类设备 WiFi 起不来、连不上网、蓝牙无响应、需要重新拉起 WiFi/蓝牙、需要诊断 download 固件下载/SDIO 枚举/驱动加载/HCI 通道问题时使用。包含一键拉起脚本、分层验证清单、故障决策表与完整参考手册。触发场景：WiFi 扫描为空、IP 一直获取中、蓝牙搜不到设备、BT-OPEN 失败、SDIO not enumerated、hci 无响应、开机后无线不生效、HT0/H709/SC9832A/Marlin/sprdwl 相关任务。"
---

# HT0 WCN Radio — 展讯 SC9832A WiFi/蓝牙 combo 芯片运维

## 何时使用

用户提到 HT0 / H709 / SC9832A / spd-box / Alpine + 安卓内核 / Marlin / sprdwl / download 固件 / WiFi 拉不起 / 蓝牙搜不到，或要求"拉起 WiFi / 蓝牙"、"开机自动启动 WiFi/蓝牙"、"无线不生效"时，使用本 Skill。

## 设备速览（30 秒上下文）

| 项 | 值 |
|---|---|
| 设备 | HT0（对照机 H709 跑安卓 6.0，可作信息源） |
| 内核/系统 | Linux 3.10.65（安卓定制内核）+ Alpine 用户态，**保留安卓内核 switchroot** |
| SSH | `root@<设备IP>`（RNDIS 调试口）/ WiFi 联网后 `<WiFi-IP>`，密码见环境记录 |
| 芯片 | 展讯 Marlin combo WCN（WiFi+蓝牙同芯片，SDIO 数据 + ttyS0 UART HCI） |
| WiFi | wlan0（sprdwl.ko + marlin_fm.ko），固件由 chroot 安卓 download 烧录 |
| 蓝牙 | /dev/ttyS0 3M+CRTSCTS H4，btwrite 唤醒，用户态 daemon 提供 unix socket `/tmp/bt_ctl.sock` |

## 红线（违反 = 需整机重启）

1. **download/logdw 常驻勿杀** —— 全杀破坏芯片固件状态，只能整机重启。
2. **驱动顺序**：`marlin_fm.ko` 先、`sprdwl.ko` 后（符号依赖 fm_read）。
3. **蓝牙 BT-OPEN 前置**：重启后必 `chmod 666 /tmp/aand/proc/mdbg/*`。
4. **蓝牙扫描前置**：必须先 `Write Scan Enable (0x0c1a,0x03)` 再 Inquiry，否则无 Inquiry Result。
5. 杀进程用 `pkill -9 -x <名>`，勿用 `ps | grep` 内嵌模式（误杀自身 shell）。
6. 勿改 USB OTG / 网络模式；勿换主线内核（展讯专属定制依赖安卓内核）。

## 工作流

### A. 一键拉起 WiFi

```bash
python scripts/wifi_bringup.py --host <设备IP> --password '<pwd>'
```

或手动（幂等，安全）：`sh /etc/local.d/wifi.start`，日志 `/var/log/wifi_boot.log`。

### B. 一键检查蓝牙全链路

```bash
python scripts/bt_status.py --host <设备IP> --password '<pwd>' [--scan 8]
```

### C. SSH 轮询恢复

设备重启后 USB 口切换导致 22 端口短暂不通：

```bash
python scripts/ssh_wait.py --hosts <设备IP>,<WiFi-IP> --password '<pwd>' --timeout 180
```

## 分层验证（哪层不过，查哪层）

```
① 固件/物理层   download 烧录 → SDIO 枚举 0x2331
                cat /sys/bus/sdio/devices/mmc2:8800:1/device  → 0x2331
② 上电层(蓝牙)  wcnd + bt_once → /tmp/bt_once.log 含 "WCNBTWIFI-CMD OK"
③ 驱动/接口层   lsmod | grep sprdwl; ip -br link show wlan0 → UP
④ 协议层        pgrep wpa_supplicant; wpa_cli -i wlan0 status → wpa_state=COMPLETED
⑤ 网络层        ip addr show wlan0 | grep 'inet ' → 有 IPv4
⑥ 引擎层(蓝牙)  /tmp/bt_probe_full 六步全通（Reset/Ver/BD_ADDR/Buffer/Features/Scan Enable）
⑦ 应用层(蓝牙)  socket state → OK ON; scan N → OK <count> + 设备行
```

## 故障决策（速查，详见 references）

| 症状 | 根因 | 修复 |
|---|---|---|
| BT-OPEN FAIL | mdbg 权限 600 | `chmod 666 /tmp/aand/proc/mdbg/*` |
| HCI 无响应 / 只回一次 SPRD3 | 缺 btwrite 唤醒 | 起 `/tmp/bt_wake.sh` |
| 蓝牙扫描无结果 | 未先 Write Scan Enable | 用 daemon scan（内部已处理） |
| WiFi SDIO not enumerated | 固件下载失败 | 看 /tmp/logdw.log；确认 by-name 软链；重跑 wifi.start |
| bind logdw failed | /tmp/logdw 缺失 | 从 /mnt/android_sys/bin/ 重拷 |
| WiFi 连上但 IP 获取中 | DHCP 未跑 / wpa 未 COMPLETED | `wpa_cli status` 检查；`udhcpc -i wlan0 -q` |
| socket connect 失败 | daemon 多实例 | `pkill -9 -x bt_user_daemon` 后单实例 |
| daemon "Not a tty" | ldisc 被占 | python `fcntl.ioctl(fd,0x5421,b'\0'*4)` 恢复 N_TTY |
| 重启后 SSH 不通 | USB 口切换 | ssh_wait.py 轮询双 IP |

## 参考文档（按需读取，勿全量加载）

- **WiFi 完整手册**：`references/wifi.md` —— WiFi 全流程、wifi.start 脚本结构、wpa_cli 交互、验证清单、故障表
- **蓝牙完整手册**：`references/bluetooth.md` —— 蓝牙全流程、daemon 架构/socket 协议、HCI 要点、验证清单、故障表
- **快速验收**：两手册第 12 节（5 分钟验收路径），各两条命令确认链路

## 脚本（本机运行，paramiko 直连设备）

| 脚本 | 用途 | 关键输出 |
|---|---|---|
| `scripts/wifi_bringup.py` | 一键拉起 WiFi 并验证 | SDIO 0x2331 / wlan0 UP / wpa 状态 |
| `scripts/bt_status.py` | 一键检查蓝牙全链路（可带扫描） | 各层状态 + socket 结果 |
| `scripts/ssh_wait.py` | 轮询等待 SSH 恢复 | 可用主机 + 连接成功标志 |

脚本依赖本机 `paramiko`；密码等凭据走 `--password` 参数或环境变量，勿硬编码。

## 文档同步规则（版本化，打 tag 时同步）

文档**不随每次迭代提交更新**（避免小改动消耗），按**版本定版（打 tag）**统一同步：

1. 日常迭代：只提交代码/脚本/配置改动，commit 备注写清改动内容；**不动文档**。
2. 打 tag 定版（用户确认功能完善/稳定）时，一次性完成：
   - 同步更新受影响文档族：docs 文档（操作手册/故障排查手册/AI指导手册/部署交付文档/流程对比/工作总结）+ references/*.md + 本 SKILL.md（工作流/红线/决策表，如涉及）
   - 新增/改名/删除文件时同步更新 AI工作流/README.md 目录规范
   - **校验**：文档中的命令、路径、产物与实际设备运行状态一致（改过的层必须实测过）
   - 打 tag：git tag <vX.Y.Z>，备注中文，写明「定版范围 + 同步更新的文档清单」
3. tag 提交应包含或紧随文档更新，保证「一个 tag = 一份完整文档快照」可回溯。

## 隐私红线（强制）

- 项目公开：**任何文档、git 备注、归档文件中禁止出现真实 SSH 密码、账号、真实 IP**。
- 一律用占位符：`<设备IP>` / `<WiFi-IP>` / `<密码>`；凭据只在运行参数或环境变量中提供。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
