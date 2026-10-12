---
title: "WiFi打通_AI指导手册"
date: 2026-09-13 15:27:33
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# 展讯 SC9832A 设备（HT0）WiFi 打通 —— AI 执行指导手册

> **读者对象**：AI 助手（豆包 / 其他大模型），需在同类设备（展讯 SC9832A，安卓内核 + Alpine 用户态）上快速解决 WiFi 不可用 / 无法连接问题
> **使用方式**：先读 §1–§3 建立上下文 → 按 §5 标准流程执行 → 按 §6 验证 → 遇故障查 §7 决策表
> **核心价值**：本文所有命令均取自设备上实测通过的 `wifi.start` 开机脚本；照着做可在同类设备上直接拉起 WiFi，避免重复踩坑
> **关联**：WiFi 与蓝牙共用同一颗 Marlin combo 芯片，WiFi 是蓝牙的物理前提（见蓝牙 AI 指导手册）

---

## 1. 设备与环境速览

| 项目 | 值 |
|---|---|
| 设备型号 | HT0（对照机：H709，跑安卓 6.0，可作信息源） |
| 主机名 / 内核 | `spd-box` / `Linux 3.10.65 #13 SMP PREEMPT armv7l` |
| 系统组合 | **保留安卓 6.0 内核 + switchroot 到 Alpine Linux**（关键！） |
| SSH | `root@<设备IP>`（RNDIS 调试口）/ WiFi 联网后 `<WiFi-IP>` |
| WiFi 芯片 | 展讯 **Marlin combo WCN**（SC2331，WiFi+蓝牙同芯片，SDIO 接口） |
| WiFi 接口 | `wlan0`（驱动 sprdwl.ko + marlin_fm.ko） |
| 固件下载 | 安卓原版 `download` 二进制，在 chroot `/tmp/aand` 内运行 |
| 当前状态 | WiFi 已打通：download → 驱动 → wpa_supplicant → DHCP，开机脚本已固化 |

> ⚠️ 重启后 SSH 可能短暂不可达（USB 口切换），需轮询重试；`/tmp` 重启后保留（chroot 环境、工具都在）。

---

## 2. 已确认的硬事实（无需重新探查，直接信任）

1. **WiFi 固件必须由安卓原版 download 烧录**：`chroot /tmp/aand /bin/download -i wlan0`，芯片才有固件可跑；WiFi 与蓝牙固件是一体的，**WiFi 拉起 = 蓝牙固件也已就绪**。
2. **download 依赖完整的 chroot 安卓用户态**：`/tmp/aand` 内需有 Android 的 lib（含 libiwnpi.so）、`/etc/marlinba/*.ini` 配置、设备节点、分区软链（by-name: wcnfdl→mmcblk0p14、wcnmodem→mmcblk0p15、boot→mmcblk0p16）。这些 `wifi.start` 已自动搭建。
3. **SDIO 枚举是固件下载成功的标志**：`/sys/bus/sdio/devices/mmc2:8800:1` 出现且 device=**0x2331**。
4. **驱动加载顺序硬约束**：`marlin_fm.ko` **必须先于** `sprdwl.ko`（sprdwl 依赖 marlin_fm 导出的 fm_read 符号），反了报 Unknown symbol。
5. **download 必须常驻**：全杀 download/logdw 会破坏芯片固件状态，只能整机重启恢复。
6. **wpa_supplicant 配置**：`/etc/wpa_supplicant/wpa_supplicant.conf`，`ctrl_interface=/run/wpa_supplicant`，`update_config=1`；LVGL 网络页通过 `wpa_cli` 与该配置交互。
7. **LVGL 网络设置页**（`lv_pages/network_page.c`）：开关=ip link up/down，扫描=`wpa_cli -i wlan0 scan` + `scan_results`，连接=`add_network`→`set_network`→`select_network`→`save_config`→`reconnect`。
8. **开机脚本已固化**：`/etc/local.d/wifi.start`（幂等设计，已就绪步骤自动跳过），git 副本在 `shell/wifi.start`。
9. **DHCP**：用 `udhcpc -i wlan0`（Alpine 默认）；若持续"获取中"，优先查 wpa 连接状态与驱动。
10. **时间问题**：设备 RTC 曾退回 2016 年，已用 hwclock/ntpd 修复并固化（`/etc/local.d/time_sync.start` 之类脚本），若日期错乱先修时间再排网络（证书/握手会受日期影响）。

---

## 3. 已验证死路（不要重试，浪费轮次）

| 路线 | 结果 | 原因 |
|---|---|---|
| 杀掉 download/logdw "干净重来" | 芯片固件状态被破坏，WiFi/蓝牙一起失效 | 必须整机重启才能恢复；正确做法是让 wifi.start 幂等重跑 |
| 用主线 Linux 内核替换安卓内核 | 未采用 | 安卓内核含展讯专属定制（SDIO/电源/固件时序），主线内核无对应支持，风险极高 |
| 改 USB OTG / 网络模式 | 用户明确禁止 | 会破坏 RNDIS 调试口 / 网络拓扑 |
| 直接 insmod sprdwl.ko 不加载 marlin_fm | Unknown symbol 加载失败 | 模块符号依赖，顺序不能反 |
| 重启后 22 端口不通时反复重连同一 IP | 无效 | USB 口切换导致，需轮询双 IP 重试 |
| 手写自研 download 替代安卓原版 | 高风险不采用 | 固件下载时序（power_ctl 上电序列 + UART 握手 + SDIO 大块写入）是芯片保密协议，原版二进制最可靠 |

---

## 4. 系统模型：分层 + 每层验证标准

```
① 固件/物理层    logdw + download → 芯片上电 + 固件烧录
                 验证: cat /sys/bus/sdio/devices/mmc2:8800:1/device → 0x2331
② 驱动层         insmod marlin_fm.ko → insmod sprdwl.ko → wlan0 出现
                 验证: lsmod | grep sprdwl; ls /sys/class/net/wlan0
③ 协议层         ip link up → wpa_supplicant → 扫描/连接
                 验证: iwconfig wlan0（ESSID 关联）; wpa_cli status
④ 网络层         DHCP → IPv4 地址
                 验证: ip addr show wlan0 有 inet 地址 + 默认路由
```

**排查纪律**：哪一层验证不过，只在这一层及其上游找原因。例：连不上 WiFi 先查 wpa_supplicant 状态（③），而不是去重烧固件（①）。

---

## 5. 标准执行流程（可直接复制）

### 5.1 完整链路（对应 wifi.start，建议直接依赖开机脚本幂等重跑）

```sh
# 直接重跑开机脚本（幂等，安全）
sh /etc/local.d/wifi.start 2>&1 | tail -20
# 日志: /var/log/wifi_boot.log
```

### 5.2 手动分步（调试时用）

```sh
# 1) 环境（若 /tmp/aand 不存在，wifi.start 会自动搭建；手动确认）
ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/connectivity_configure.ini
mountpoint -q /tmp/aand/dev || mount --bind /dev /tmp/aand/dev
mountpoint -q /tmp/aand/proc || mount -t proc proc /tmp/aand/proc

# 2) 杀净残留 + 启动 logdw + download（常驻）
for p in $(ps -eo pid,comm | awk '$2=="download"||$2=="logdw"{print $1}'); do kill -9 "$p"; done
setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
sleep 1
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
sleep 2
ps -eo pid,comm | grep download    # 确认 download 在跑

# 3) 等 SDIO 枚举（最多 90s）
for i in $(seq 1 18); do
  [ -e /sys/bus/sdio/devices/mmc2:8800:1 ] && break
  sleep 5
done
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # 期望 0x2331

# 4) 驱动（顺序不能反）
lsmod | grep -q marlin_fm || insmod /lib/modules/marlin_fm.ko
sleep 1
lsmod | grep -q sprdwl || insmod /lib/modules/sprdwl.ko
sleep 2
ls /sys/class/net/wlan0 || { rmmod sprdwl 2>/dev/null; rmmod marlin_fm 2>/dev/null; sleep 1;
                             insmod /lib/modules/marlin_fm.ko; sleep 1; insmod /lib/modules/sprdwl.ko; sleep 4; }

# 5) 接口 up + wpa_supplicant
ip link set wlan0 up
sleep 2
pgrep -x wpa_supplicant || wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf

# 6) DHCP
udhcpc -i wlan0 -q -n 2>&1 | tail -5
ip addr show wlan0 | grep inet
```

### 5.3 连接 WiFi（wpa_cli 交互，LVGL 网络页同款逻辑）

```sh
wpa_cli -i wlan0 scan                              # 触发扫描
sleep 3
wpa_cli -i wlan0 scan_results                      # 查看热点
# 添加/配置网络
ID=$(wpa_cli -i wlan0 add_network | tail -1)
wpa_cli -i wlan0 set_network $ID ssid '"MySSID"'
wpa_cli -i wlan0 set_network $ID psk '"<WiFi密码>"'
wpa_cli -i wlan0 set_network $ID scan_ssid 1
wpa_cli -i wlan0 set_network $ID priority 10
wpa_cli -i wlan0 enable_network $ID
wpa_cli -i wlan0 select_network $ID
wpa_cli -i wlan0 save_config
udhcpc -i wlan0 -q
```

---

## 6. 验证标准清单（逐项确认）

| # | 检查 | 期望 |
|---|---|---|
| 1 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 2 | `lsmod \| grep sprdwl` | sprdwl + marlin_fm（依赖关系 1 sprdwl） |
| 3 | `ip -br link show wlan0` | `UP` |
| 4 | `iwconfig wlan0` | ESSID 已关联 / 无 ESSID 则未连 |
| 5 | `pgrep -x wpa_supplicant` | 进程存在 |
| 6 | `wpa_cli -i wlan0 status` | `wpa_state=COMPLETED` |
| 7 | `ip addr show wlan0 \| grep 'inet '` | 有 IPv4 地址 |
| 8 | `ip route` | 有 default via 网关 |
| 9 | LVGL 网络页 | 开关/扫描/已保存/附近列表/连接均正常 |

---

## 7. 故障 → 根因 → 修复 决策表

| 症状 | 大概率根因 | 修复 |
|---|---|---|
| 日志 `ERROR: SDIO not enumerated, download may have failed` | 固件下载未完成（时序/权限/节点问题） | 看 `/tmp/logdw.log` 尾部；确认 /dev/power_ctl 可写、by-name 软链存在；重跑 wifi.start |
| 日志 `bind logdw failed: No such file or directory` | logdw 未就位（/tmp/logdw 不存在或非可执行） | `ls -la /tmp/logdw`；从 /mnt/android_sys/bin/ 重新拷贝 |
| `download started pid=`（pid 空） | download 进程没起来 | `ps -eo pid,comm \| grep download`；chroot 环境是否完整 |
| wlan0 不出现在驱动加载后 | 驱动加载失败 / 芯片未枚举 | `dmesg \| tail`；先确认 SDIO 0x2331；rmmod 重载 |
| 扫描为空 | wpa_supplicant 未起 / 接口未 up | `pgrep wpa_supplicant`；`ip link set wlan0 up`；`wpa_cli scan` 后再 `scan_results` |
| 连上但 IP 一直"获取中" | DHCP 未跑 / wpa 未 COMPLETED | `wpa_cli status` 看 wpa_state；`udhcpc -i wlan0 -q -n` 手动跑 |
| 重启后 SSH 不通 | RNDIS 口未恢复 / IP 变化 | 轮询 <设备IP> 与 <WiFi-IP>；等开机脚本跑完 |
| 日期 2016 年 | RTC 未同步 | hwclock -s / ntpd 同步，写入 /etc/local.d 开机脚本（已固化，勿重复） |
| WiFi 正常但蓝牙起不来 | 蓝牙链未跑 | 见蓝牙 AI 指导手册 §5（mdbg 权限 / wcnd / bt_once / btwrite） |

---

## 8. 组件架构（改动/维护必读）

```
开机
 └─ /etc/local.d/wifi.start（幂等）
      ├─ 挂载 /mnt/android_sys（mmcblk0p17, Android system 只读）
      ├─ 搭建 chroot /tmp/aand（bin/lib/etc/marlinba + bind /dev /proc /sys + 分区 mknod + by-name 软链）
      ├─ 杀净残留 download/logdw
      ├─ setsid /tmp/logdw
      ├─ setsid chroot /tmp/aand /bin/download -i wlan0   ← 常驻
      ├─ 等 SDIO 枚举 mmc2:8800:1 = 0x2331（≤90s）
      ├─ insmod marlin_fm.ko → sprdwl.ko（顺序硬约束）
      ├─ ip link set wlan0 up
      └─ wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
之后
 ├─ LVGL 网络页（network_page.c）通过 wpa_cli 扫描/连接
 └─ udhcpc 取 IP（Alpine 网络栈）
```

**chroot 关键节点**（download 依赖，缺失即 SDIO 枚举失败）：
- `/tmp/aand/bin/download`（安卓原版）
- `/tmp/aand/lib/libiwnpi.so` + 全套 Android lib
- `/tmp/aand/etc/marlinba/connectivity_configure.ini`（固件路径/校准配置，也含蓝牙 pskey）
- `/tmp/aand/dev/block/platform/sdio_emmc/by-name/{wcnfdl→mmcblk0p14, wcnmodem→mmcblk0p15, boot→mmcblk0p16}`
- `/dev/power_ctl`（download 写入 SLEEP→POWER_ON→POWER_RST 上电序列）

**LVGL 网络页**（`lv_pages/network_page.c`，1677 行，WiFi 设置 UI 模板）：
- 开关：`ip link set wlan0 up/down` + `wpa_cli disconnect/reconnect`
- 扫描：`wpa_cli scan` → 定时 3s → `wpa_cli scan_results` → 解析 bssid/signal/flags/ssid
- 连接：add_network / set_network（ssid/psk/key_mgmt/scan_ssid/priority）/ select_network / save_config
- 已保存列表：`wpa_cli list_networks`

---

## 9. 红线与运维纪律

1. **download 常驻勿杀** —— 全杀破坏芯片固件状态，只能整机重启。
2. **驱动顺序**：`marlin_fm.ko` 先、`sprdwl.ko` 后。
3. **wifi.start 幂等** —— 想重来直接 `sh /etc/local.d/wifi.start`，它会先杀净再拉起，不要手动零散操作。
4. **不要改 USB OTG / 网络模式配置**（用户明确约束）。
5. **不要换主线内核** —— 展讯专属定制（SDIO/电源/固件）依赖安卓内核。
6. **日期必须正确** —— WiFi 握手/证书受系统时间影响，先修时间再排网络。
7. **进程清理用 pkill -9 -x <名>**，勿用 `ps | grep` 内嵌模式（误杀自身 shell）。

---

## 10. 设备上已有工具/文件清单（复用，勿重造）

| 工具/文件 | 位置 | 用途 |
|---|---|---|
| wifi.start | `/etc/local.d/wifi.start`（git: `shell/wifi.start`） | WiFi 开机自启 + 全链路（幂等） |
| 启动日志 | `/var/log/wifi_boot.log` | wifi.start 输出（排障首选） |
| download | `/tmp/aand/bin/download` | 固件下载（chroot 内） |
| logdw | `/tmp/logdw` | 固件下载日志守护 |
| 安卓用户态 | `/mnt/android_sys`（mmcblk0p17） | Android system 只读挂载（库/配置源） |
| 驱动 | `/lib/modules/marlin_fm.ko`、`/lib/modules/sprdwl.ko` | WiFi 驱动（设备预编译） |
| wpa 配置 | `/etc/wpa_supplicant/wpa_supplicant.conf` | wpa_supplicant 配置（含已保存网络） |
| 网络页 | `lv_pages/network_page.c`（LVGL 项目） | WiFi 设置 UI（wpa_cli 交互模板） |
| DHCP | `udhcpc`（Alpine 自带） | 获取 IP |

---

## 11. 后续增强方向（当前未完成）

| 项 | 说明 | 建议路径 |
|---|---|---|
| IPv4 稳定性 | 部分场景 IPv6 有地址而 IPv4 未取到 | 检查 wpa_state=COMPLETED 后立即 udhcpc，加 `-n` 重试与日志 |
| 自动重连策略 | 掉线后仅靠 wpa_supplicant 自动重连 | 可加网络页"断开重连"按钮与信号强度展示（scan_results signal 已有） |
| 多网络优先级 | 当前单 network 配置 | 扩展 wpa_cli list_networks 管理 + 排序 UI |
| 与蓝牙共存 | WiFi 常驻 + 蓝牙扫描并行 | 共用 download/wcnd，实测无冲突，但可加互斥电源管理 |

---

## 12. 5 分钟快速验收路径

```sh
# 1) 三层状态一条命令
cat /sys/bus/sdio/devices/mmc2:8800:1/device && ip -br link show wlan0 && pgrep -x wpa_supplicant
# 2) 连接状态
wpa_cli -i wlan0 status | grep -E 'wpa_state|ip_address'
# 3) IPv4
ip addr show wlan0 | grep 'inet '
```

以上通过 → WiFi 底层 + 协议 + 网络全链路 OK；不通过 → 按 §7 决策表逐项定位。

---

*文档版本：v1.0（WiFi 打通后沉淀）*
*关联文档：WiFi 操作手册（人用）、WiFi 启动流程对比、WiFi 工作过程总结、蓝牙打通 AI 指导手册*
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
