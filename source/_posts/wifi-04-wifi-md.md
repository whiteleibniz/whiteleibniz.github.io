---
title: "WiFi芯片打通_部署交付文档"
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


# HT0 设备 WiFi 拉起 —— 部署交付文档

> 目的：回答"整个 WiFi 流程到底涉及哪些脚本/程序？在新设备上怎么部署才能拉起 WiFi？"
> 内容：① 链路全景 → ② 产物清单（设备端/本机/Git）→ ③ 新设备部署步骤 → ④ 验证 → ⑤ 常见问题
> 适用：同型号设备（HT0 / 展讯 SC9832A，安卓内核 + Alpine 用户态）

---

## 1. WiFi 链路全景（谁拉起谁）

```
开机
 ├─ /etc/local.d/wifi.start        ① 挂载安卓 system + 搭 chroot + download 烧固件 + 驱动 + wlan0 + wpa
 ├─ /etc/local.d/bt_bringup.start   ② （蓝牙链，见蓝牙部署交付文档——WiFi 是蓝牙物理前提）
 ├─ /etc/init.d/bt_daemon          ③ （蓝牙 daemon）
 └─ LVGL 桌面                     ④ 网络设置页（wpa_cli 与 supplicant 交互）
```

**依赖关系**：download 烧的 combo 固件含 WiFi+蓝牙两部分 → **WiFi 拉起 = 蓝牙固件也已就绪**；① 是 ②③④ 的前提。

### wifi.start 内部步骤（幂等，可反复重跑）

```
① 挂载 /mnt/android_sys（mmcblk0p17, Android system 只读）
② 搭建 chroot /tmp/aand（bin/lib/etc/marlinba + bind /dev /proc /sys + by-name 软链）
③ 杀净残留 download/logdw → setsid /tmp/logdw → setsid chroot /tmp/aand /bin/download -i wlan0（常驻）
④ 等 SDIO 枚举 mmc2:8800:1 = 0x2331（≤90s）
⑤ insmod marlin_fm.ko → sprdwl.ko（顺序硬约束）→ ip link set wlan0 up
⑥ wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
```

---

## 2. 产物清单

### 2.1 设备端已部署（HT0 现状，实测核对）

| 类别 | 路径 | 说明 |
|---|---|---|
| 开机脚本 | `/etc/local.d/wifi.start` | **WiFi 全链路自启（幂等）**，日志 `/var/log/wifi_boot.log` |
| chroot 环境 | `/tmp/aand/bin/download` | 固件下载引导器（安卓原版） |
| | `/tmp/aand/bin/wcnd` | WiFi/蓝牙上电守护 |
| | `/tmp/aand/etc/marlinba/*.ini` | 固件配置（含蓝牙 pskey） |
| | `/tmp/aand/lib/libiwnpi.so` | download 依赖库 |
| 日志守护 | `/tmp/logdw` | download 日志守护 |
| 驱动 | `/lib/modules/marlin_fm.ko`、`/lib/modules/sprdwl.ko` | WiFi 驱动（顺序：fm 先、wl 后） |
| 协议 | `/etc/wpa_supplicant/wpa_supplicant.conf` | wpa_supplicant 配置（含已保存网络） |
| DHCP | `udhcpc`（Alpine 自带） | 获取 IP |
| 分区软链 | `/dev/block/platform/sdio_emmc/by-name/{wcnfdl→p14, wcnmodem→p15, boot→p16}` | download 按名找分区 |
| 系统时间 | `/etc/local.d/time_sync.start` | RTC 校时（防退回 2016） |
| LVGL 桌面 | `/usr/local/bin/lvgl_demo` | 桌面（含网络设置页 network_page.c） |

### 2.2 本机（Windows 工作目录）源码与部署脚本

| 文件 | 用途 |
|---|---|
| `shell/wifi.start` | **开机脚本副本（git 已归档）** |
| `lv_pages/network_page.c` | **LVGL 网络设置页源码（1677 行，WiFi UI）** |
| 四份文档 | 操作手册 / 启动流程对比 / 工作过程总结 / AI 指导手册 |

### 2.3 Git 提交（设备项目 /home/lvgl_demo/lvgl_demo）

WiFi 底层打通相关提交见 git log（`git log --oneline | head -10`），涉及：
- `shell/wifi.start`（开机脚本）
- `lv_pages/network_page.c`（网络设置页 + launcher 注册）
- AI工作流/01_WiFi打通/（docs + deploy/wifi.start）

### 2.4 Skill 封装（可移植）

`workspace\.user_skills\ht0-wcn-radio\` —— SKILL.md + references/wifi.md + scripts（wifi_bringup.py / ssh_wait.py），任何 AI 加载后可直接操作同型设备。

---

## 3. 新设备部署步骤（从零拉起 WiFi）

> 前提：同型号设备（HT0/SC9832A）、已 switchroot Alpine、SSH root 可用。

### Step 0 确认基础环境

```sh
ssh root@<设备IP>
uname -a                              # Linux 3.10.65 ... armv7l
ls /dev/block/platform/sdio_emmc/by-name/   # wcnfdl=p14 wcnmodem=p15 boot=p16 system=p17
```

### Step 1 准备固件与 Android 用户态（chroot）

```sh
# 1) 挂载安卓 system（只读）
mkdir -p /mnt/android_sys
mount -r /dev/block/mmcblk0p17 /mnt/android_sys

# 2) 提取 download 及依赖（本机 adb 从对照机拉取后 scp 上传，或直接从 system 拷）
mkdir -p /tmp/aand/{bin,lib,etc,dev}
cp /tmp/download            /tmp/aand/bin/download
cp /tmp/libiwnpi.so         /tmp/aand/lib/
cp -r /mnt/android_sys/lib/*.so /tmp/aand/lib/
cp -r /mnt/android_sys/etc/marlinba /tmp/aand/etc/
chmod +x /tmp/aand/bin/download

# 3) 设备节点 + 分区软链
mount --bind /dev /tmp/aand/dev
mkdir -p /tmp/aand/dev/block/platform/sdio_emmc/by-name
ln -sf /dev/block/mmcblk0p14 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnfdl
ln -sf /dev/block/mmcblk0p15 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnmodem
ln -sf /dev/block/mmcblk0p16 /tmp/aand/dev/block/platform/sdio_emmc/by-name/boot

# 4) 验证 chroot 可运行
chroot /tmp/aand /bin/download --help 2>&1 | head -5
```

> 若 dtb 不是 Android 原版（换过 boot），先按 WiFi 操作手册 4.3 写回原版 dtb 并重启。

### Step 2 固件下载（download 上电序列）

```sh
# logdw 日志守护（常驻）
setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
sleep 1
# download（常驻勿杀）
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
# 等 SDIO 枚举（≤90s）
for i in $(seq 1 18); do [ -e /sys/bus/sdio/devices/mmc2:8800:1 ] && break; sleep 5; done
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # 期望 0x2331
```

### Step 3 加载驱动（顺序不能反）

```sh
insmod /lib/modules/marlin_fm.ko    # 先
sleep 1
insmod /lib/modules/sprdwl.ko       # 后（依赖 fm_read 符号）
sleep 2
ip link set wlan0 up
ip link show wlan0                  # 出现 wlan0 即成功
```

### Step 4 配置 wpa_supplicant

```sh
cat > /etc/wpa_supplicant/wpa_supplicant.conf <<'EOF'
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
EOF
wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
wpa_cli -i wlan0 status              # wpa_state=INACTIVE 属正常
```

### Step 5 开机自启固化

```sh
# 驱动开机加载
cat > /etc/modules-load.d/wifi.conf <<'EOF'
marlin_fm
sprdwl
EOF
# 开机脚本（完整链，内容以 AI工作流 deploy/wifi.start 为准）
cp /home/lvgl_demo/lvgl_demo/AI工作流/01_WiFi打通/deploy/wifi.start /etc/local.d/wifi.start
chmod +x /etc/local.d/wifi.start
rc-update add local default
```

> 完整 `wifi.start` 含 chroot 搭建、logdw/download 拉起、SDIO 等待、驱动、wlan0、wpa_supplicant——新设备可直接部署该脚本一票到底，不必手动分步。

### Step 6 验证

```sh
# 分层验证
cat /sys/bus/sdio/devices/mmc2:8800:1/device        # 0x2331
lsmod | grep -E 'sprdwl|marlin_fm'
ip -br link show wlan0                              # UP
pgrep -x wpa_supplicant                             # 有 PID
wpa_cli -i wlan0 scan && sleep 5 && wpa_cli -i wlan0 scan_results   # 出现热点
udhcpc -i wlan0 -q -n                               # 取 IP
ip addr show wlan0 | grep inet
```

---

## 4. 验证标准（全部满足 = 部署成功）

| # | 检查 | 期望 |
|---|---|---|
| 1 | SDIO device | `0x2331` |
| 2 | lsmod | sprdwl + marlin_fm 都在 |
| 3 | `ip -br link show wlan0` | `UP` |
| 4 | wpa_supplicant 进程 | 存在 |
| 5 | `wpa_cli status` | `wpa_state=COMPLETED`（已连）或 `INACTIVE`（未连，正常） |
| 6 | 扫描 | `scan_results` 出现热点 |
| 7 | IPv4 | `ip addr show wlan0` 有 inet 地址 + 默认路由 |
| 8 | LVGL 网络页 | 开关/扫描/已保存/附近列表/连接均正常 |
| 9 | 重启后 | ①②③ 全自动拉起（不用手动） |
| 10 | 蓝牙（同芯片） | `grep 'CMD OK' /tmp/bt_once.log` 有值（固件含蓝牙） |

---

## 5. 常见问题（新设备部署时最可能踩的坑）

| 现象 | 原因 | 处理 |
|---|---|---|
| `SDIO not enumerated` | chroot 环境不全 / 时序 / 权限 | 看 `/tmp/logdw.log`；确认 power_ctl 可写、by-name 软链存在；重跑 wifi.start |
| `bind logdw failed` | /tmp/logdw 缺失 | `cp /mnt/android_sys/bin/logdw /tmp/logdw; chmod +x` |
| `download started pid=` 空 | 进程没起来 | chroot 缺库；`strace` 定位；确认 /tmp/aand 完整 |
| wlan0 不出现 | 固件未完成就加载驱动 | 等 SDIO 0x2331 再 insmod；rmmod 后按序重载 |
| `Unknown symbol` | 驱动顺序反 | 先 marlin_fm 再 sprdwl |
| `invalid module format` | 模块与内核不匹配 | 用设备 /lib/modules/ 同源模块 |
| 扫描为空 | supplicant 未起 / 接口未 up | `ip link set wlan0 up` + 确认进程 |
| IP 一直获取中 | DHCP 未跑 / wpa 未 COMPLETED | `wpa_cli status`；`udhcpc -i wlan0 -q -n` 手动跑 |
| 重启后 WiFi 丢失 | 未固化自启 | 部署 wifi.start + `rc-update add local default` |
| 日期 2016 | RTC 未同步 | 校时并固化 time_sync.start |
| SSH 重启后不通 | USB 口复用切换 | 轮询 `<设备IP>` / `<WiFi-IP>` |
| WiFi 正常但蓝牙起不来 | 蓝牙链未跑 | 见蓝牙部署交付文档（mdbg/wcnd/bt_once/bt_wake/daemon） |

---

## 6. 一句话总结部署路径

```
环境确认 → 建 chroot(/tmp/aand + 软链) → download 烧固件 → 等 SDIO 0x2331
→ insmod marlin_fm → sprdwl → wlan0 up → wpa_supplicant
→ udhcpc 取 IP → 固化 wifi.start 自启 → 验证(0x2331+UP+scan+IPv4)
```

所有产物都有本机副本与 Skill 封装（`ht0-wcn-radio`），新设备部署全程可复用。

---

*配套：WiFi芯片打通操作手册（人用）、WiFi芯片打通_故障排查手册、WiFi打通_AI指导手册（AI 用）*
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
