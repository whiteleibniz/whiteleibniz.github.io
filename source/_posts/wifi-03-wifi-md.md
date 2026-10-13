---
title: "WiFi芯片打通_故障排查手册"
date: 2026-09-13 15:58:12
lang: zh-CN
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# 展讯 SC9832A WiFi 故障排查手册 —— HT0 / spd-box

> **用途**：WiFi 起不来、扫不到、连不上、IP 获取不到时，按本手册定位根因。每一行命令均取自设备实测。
> **使用方式**：先看 §1 分层速查总表定位到层 → 跳到对应章节 → 用「定位命令」确认 → 按「修复」处理。
> **配套**：人工操作手册（第 5 章速查表）、AI 指导手册（§7 决策表）为精简版；本文是全量版。

---

## 0. 排障纪律（先读）

1. **四层模型，分层定位**：①固件/物理（download→SDIO 0x2331）→ ②驱动（marlin_fm→sprdwl→wlan0）→ ③协议（up→wpa_supplicant→扫描/连接）→ ④网络（DHCP→IPv4→路由）。哪层不过只查该层及其上游。
   - 例：连不上 WiFi 先查 `wpa_cli status`（③），而不是重烧固件（①）。
2. **先看日志**：`/var/log/wifi_boot.log`（wifi.start 输出，排障首选）→ `/tmp/logdw.log` → `dmesg | tail`。
3. **download 常驻勿杀**：全杀破坏芯片固件状态，只能整机重启恢复。
4. **想重来就幂等重跑**：`sh /etc/local.d/wifi.start`（脚本会先杀净残留再拉起），不要手动零散操作。
5. **驱动顺序硬约束**：`marlin_fm.ko` 必须先于 `sprdwl.ko`。
6. **先修时间再排网络**：设备日期曾退回 2016，证书/握手受系统时间影响。
7. 杀进程用 `pkill -9 -x <名字>`，禁止 `ps | grep` 内嵌模式。

---

## 1. 分层故障速查总表（一页定位）

| 现象（症状） | 大概率根因 | 定位命令 | 章节 |
|---|---|---|---|
| 日志 `ERROR: SDIO not enumerated, download may have failed` | 固件下载未完成 / 环境/时序问题 | `tail -20 /tmp/logdw.log` | §2 |
| `bind logdw failed: No such file or directory` | logdw 未就位 | `ls -la /tmp/logdw` | §2 |
| `download started pid=`（pid 空） | download 进程没起来 | `ps -eo pid,comm \| grep download` | §2 |
| `dmesg` 一直 `SDIO dev not ready` / GPIO94=0 | 芯片未上电/固件未下载 | `cat /dev/power_ctl` 可写性 | §2 |
| download 报 open 设备失败 | chroot 缺设备节点 | `mountpoint -q /tmp/aand/dev` | §2 |
| download 报找不到 wcnfdl/wcnmodem | 缺 by-name 软链 | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | §2 |
| download 跑完但 SDIO 无枚举 | DTB 不对（boot 分区） | `dmesg \| grep -i -E "sdio\|mmc2\|2331"` | §2 |
| `insmod sprdwl.ko` 报 Unknown symbol | 模块顺序错 | `lsmod \| grep marlin_fm` | §3 |
| wlan0 不出现 | 固件未完成就加载驱动 | `ls /sys/class/net/wlan0` | §3 |
| `insmod` 报 invalid module format | 模块与内核版本不匹配 | `uname -r; modinfo sprdwl.ko` | §3 |
| `wpa_cli scan` 失败 / 扫描为空 | supplicant 未跑 / 接口未 up | `pgrep -x wpa_supplicant` | §4 |
| `wpa_cli` 找不到命令 | PATH 缺 /sbin | `which wpa_cli` | §4 |
| 连上但 IP 一直"获取中" | DHCP 未跑 / wpa 未 COMPLETED | `wpa_cli -i wlan0 status` | §5 |
| 有 IPv6 无 IPv4 | DHCP 时序/接口状态 | `ip addr show wlan0` | §5 |
| 重启后 WiFi 丢失 | 未固化自启 | `ls /etc/local.d/`、`rc-update show` | §6 |
| 重启后 SSH 不通 | USB 口复用切换 | 轮询 `<设备IP>` / `<WiFi-IP>` | §6 |
| 日期 2016 年 | RTC 未同步 | `date` | §6 |

---

## 2. 物理 / 固件层（① DTB → download → SDIO）

### 2.1 `ERROR: SDIO not enumerated, download may have failed`

- **定位**：
  ```sh
  tail -20 /tmp/logdw.log            # 固件下载守护日志
  cat /sys/bus/sdio/devices/mmc2:8800:1/device   # 空 = 未枚举
  dmesg | tail -30                    # 看 mmc2 / sprd_download 消息
  ```
- **根因与修复**：

| 根因 | 确认 | 修复 |
|---|---|---|
| chroot 环境不全 | `ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/` | 重建 chroot 或重跑 `sh /etc/local.d/wifi.start` |
| `/dev/power_ctl` 不可写 | `[ -w /dev/power_ctl ] && echo OK` | 检查节点权限（download 写上电序列依赖它） |
| by-name 软链缺失 | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl; ln -sf /dev/block/mmcblk0p15 .../wcnmodem` |
| 挂载缺失 | `mountpoint -q /tmp/aand/dev || echo NOT_MOUNTED` | `mount --bind /dev /tmp/aand/dev; mount -t proc proc /tmp/aand/proc` |
| DTB 不对 | `dmesg \| grep -i sdio`（boot 分区 dtb 不含正确电源描述） | 写回 Android 原版 dtb（见 WiFi 操作手册 4.3，seek=20008） |
| 固件版本不匹配 | 驱动与固件来自不同 Android 版本 | 统一从同一 Android system 提取 |

### 2.2 `bind logdw failed: No such file or directory`

- **根因**：`/tmp/logdw` 不存在或不可执行（download 的日志守护）。
- **修复**：`ls -la /tmp/logdw`；缺失则从 Android system 拷：`cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw; chmod +x /tmp/logdw`。

### 2.3 `download started pid=`（pid 为空）

- **根因**：download 进程没起来（chroot 缺库 / 参数错 / 直接退出）。
- **定位**：`ps -eo pid,comm | grep download`；`tail -30 /tmp/dl.log`
- **修复**：
  ```sh
  pkill -9 -f logdw; pkill -9 -f 'wcnd'; sleep 1
  setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
  sleep 1
  setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
  sleep 2
  ps -eo pid,comm | grep download   # 应看到进程
  ```
- 仍失败用 strace 定位缺什么：`chroot /tmp/aand strace /bin/download 2>&1 | grep -E "open|ENOENT" | head -30`。

### 2.4 GPIO94 READY 恒 0 / dmesg 反复 SDIO dev not ready

- **根因**：芯片上电序列没执行（download 没跑成功）。
- **定位**：`strace` 跟踪 download 的 ioctl/write 是否报错（open power_ctl、write SLEEP/POWER_ON/POWER_RST）。
- **修复**：按 2.1 表格逐项核对环境；确认后重跑 wifi.start。

---

## 3. 驱动层（② marlin_fm → sprdwl → wlan0）

### 3.1 `insmod sprdwl.ko` 报 Unknown symbol

- **根因**：模块加载顺序反了——sprdwl.ko 依赖 marlin_fm.ko 导出的 `fm_read` 符号。
- **修复**：
  ```sh
  lsmod | grep -q marlin_fm || insmod /lib/modules/marlin_fm.ko
  sleep 1
  lsmod | grep -q sprdwl || insmod /lib/modules/sprdwl.ko
  ```

### 3.2 wlan0 不出现

- **根因**：固件下载未完成就加载驱动，或芯片未枚举。
- **定位**：`cat /sys/bus/sdio/devices/mmc2:8800:1/device`（必须先为 0x2331）；`dmesg | tail`
- **修复**：确认 SDIO 枚举后再重载驱动：
  ```sh
  rmmod sprdwl 2>/dev/null; rmmod marlin_fm 2>/dev/null; sleep 1
  insmod /lib/modules/marlin_fm.ko; sleep 1; insmod /lib/modules/sprdwl.ko; sleep 4
  ls /sys/class/net/wlan0
  ```

### 3.3 `insmod` 报 invalid module format

- **根因**：模块与内核 3.10.65 不匹配（不同内核版本/编译器）。
- **定位**：`uname -r`；`modinfo /lib/modules/sprdwl.ko | grep vermagic`
- **修复**：使用设备 `/lib/modules/` 中预编译的同源模块；不要用 Alpine 新 gcc 编老内核模块。

---

## 4. 协议层（③ up → wpa_supplicant → 扫描/连接）

### 4.1 `wpa_cli scan` 失败 / 扫描结果为空

- **定位**：`pgrep -x wpa_supplicant`；`ip -br link show wlan0`（需 UP）；`wpa_cli -i wlan0 status`
- **修复**：
  ```sh
  ip link set wlan0 up; sleep 2
  pgrep -x wpa_supplicant || wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
  wpa_cli -i wlan0 scan; sleep 5; wpa_cli -i wlan0 scan_results
  ```

### 4.2 `wpa_cli` 找不到命令

- **根因**：PATH 缺 `/sbin`（wpa_cli 在 /sbin）。
- **修复**：`export PATH=$PATH:/sbin`；或 `which wpa_cli` 确认路径。

### 4.3 扫描能看到但连接不上（wpa_state 卡 INACTIVE / SCANNING）

- **定位**：`wpa_cli -i wlan0 status | grep -E 'wpa_state|ssid'`
- **修复**：确认网络配置正确（ssid 引号、psk 类型）；`wpa_cli -i wlan0 remove_network 0` 后重加；检查 `wpa_cli -i wlan0 list_networks`。
- **常见**：开放网络 `key_mgmt NONE`；加密网络 `psk` 需带引号字符串。

---

## 5. 网络层（④ DHCP → IPv4）

### 5.1 连上但 IP 一直"获取中"

- **定位**：`wpa_cli -i wlan0 status | grep wpa_state`（必须 COMPLETED）；`udhcpc -i wlan0 -q -n 2>&1 | tail -5`
- **修复**：
  ```sh
  # wpa 未 COMPLETED → 回 §4；已 COMPLETED → 手动跑 DHCP
  udhcpc -i wlan0 -q -n
  ip addr show wlan0 | grep inet
  ```

### 5.2 有 IPv6 无 IPv4 / 无默认路由

- **根因**：DHCP 时序（接口刚关联就触发）、或 DHCP 应答慢。
- **修复**：`wpa_cli status` 确认 COMPLETED 后**立即** `udhcpc -i wlan0 -q -n`；加 `-n` 失败退出便于观察；确认 `ip route` 出现 default via 网关。
- **注意**：部分场景 IPv6 先取到而 IPv4 未取到，重跑 udhcpc 即可。

---

## 6. 自启 / 系统层

### 6.1 重启后 WiFi 丢失

- **定位**：`ls /etc/local.d/`（应有 wifi.start）；`rc-update show | grep local`；`cat /var/log/wifi_boot.log | tail`
- **修复**：确认 `/etc/local.d/wifi.start` 存在且可执行、`local` 在 default runlevel：
  ```sh
  rc-update add local default
  sh /etc/local.d/wifi.start 2>&1 | tail -20   # 幂等，可立即重跑
  ```

### 6.2 重启后 SSH 不通

- **根因**：设备 USB 口复用（RNDIS 网口/键盘/鼠标），重启后网口未恢复或 IP 变化。
- **修复**：轮询 `<设备IP>` 与 `<WiFi-IP>` 两个地址（本机可用 skill 的 `ssh_wait.py`）；等开机脚本跑完（download 固件下载需 60~90s）。

### 6.3 日期退回 2016 年

- **根因**：RTC 未同步（无电池供电时每次重启复位）。
- **修复**：`hwclock -s`（从 RTC 读）或 `ntpd -q`（网络校时）；已固化 `/etc/local.d/time_sync.start`，勿重复创建。

---

## 7. 诊断工具箱（关键节点速查）

| 项目 | 路径/命令 | 期望 |
|---|---|---|
| 开机脚本日志 | `/var/log/wifi_boot.log` | 无 ERROR、SDIO ready |
| SDIO 枚举 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 驱动 | `lsmod \| grep -E 'sprdwl\|marlin_fm'` | 两者都在 |
| 接口 | `ip -br link show wlan0` | `UP` |
| wpa 进程 | `pgrep -x wpa_supplicant` | 有 PID |
| wpa 状态 | `wpa_cli -i wlan0 status` | `wpa_state=COMPLETED` |
| IPv4 | `ip addr show wlan0 \| grep 'inet '` | 有地址 |
| 路由 | `ip route` | default via 网关 |
| 下载日志 | `/tmp/logdw.log`、`/tmp/dl.log` | download 完成 |
| chroot 环境 | `ls /tmp/aand/bin/download /tmp/aand/etc/marlinba/` | 文件齐全 |

**进程链**：`logdw → download(常驻) → (SDIO 0x2331) → marlin_fm.ko + sprdwl.ko → wlan0 UP → wpa_supplicant → udhcpc → IPv4`

---

## 8. 已验证死路（不要重试）

| 路线 | 结果 |
|---|---|
| 杀 download/logdw "干净重来" | 破坏固件状态，WiFi/蓝牙一起失效，只能整机重启 |
| 手写自研 download 替代安卓原版 | 固件下载时序是芯片保密协议，原版最可靠 |
| 换主线 Linux 内核 | 安卓内核含展讯专属定制（SDIO/电源/固件时序），主线无支持 |
| 改 USB OTG / 网络模式 | 用户明确禁止，破坏 RNDIS/网络拓扑 |
| 先 insmod sprdwl 再 marlin_fm | Unknown symbol |
| 重启后反复重连同一 IP | USB 口切换导致，需轮询双 IP |

---

## 9. 红线（任何情况下）

1. **download 常驻勿杀**。
2. **驱动顺序**：`marlin_fm.ko` 先、`sprdwl.ko` 后。
3. **幂等重跑**：`sh /etc/local.d/wifi.start`，勿手动零散操作。
4. 不修改 USB OTG / 网络模式配置。
5. 不换主线内核。
6. 时间必须先正确（影响证书/握手）。

---

*配套：WiFi芯片打通操作手册（人用）、WiFi打通_AI指导手册（AI 用）、WiFi芯片打通_部署交付文档（部署用）*
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
