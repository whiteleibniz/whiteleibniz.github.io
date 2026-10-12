---
title: "WiFi芯片打通操作手册"
date: 2026-09-13 15:27:33
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# WiFi 芯片打通 —— 人工操作手册

> **适用设备**：spd-box（SC9832A 四核，armv7l，Android 6 内核 3.10.65 + switchroot Alpine Linux 3.21 armhf）
> **WiFi 芯片**：Marlin SC2331（SDIO 接口，`mmc2:8800:1`，device 0x2331）
> **文档目标**：不依赖任何 AI 辅助，人工按本手册从零把该设备的板载 WiFi 打通到"可扫描、可连接"状态。
> **文档版本**：v1.0　|　2026-09

---

## 目录

1. [背景与问题定义](#1-背景与问题定义)
2. [工具与物料清单](#2-工具与物料清单)
3. [总体思路](#3-总体思路)
4. [操作流程](#4-操作流程)
   - 4.1 设备与系统确认
   - 4.2 从 Android 对照机取证
   - 4.3 提取并替换 Android 原版设备树（DTB）
   - 4.4 搭建 Android 用户态 chroot 环境
   - 4.5 执行固件下载（download 上电序列）
   - 4.6 验证 SDIO 枚举
   - 4.7 加载 WiFi 驱动
   - 4.8 安装并配置 wpa_supplicant
   - 4.9 扫描验证
   - 4.10 开机自启动固化
5. [故障排查速查表](#5-故障排查速查表)
6. [注意事项与风险](#6-注意事项与风险)

---

## 1. 背景与问题定义

- 设备出厂为 Android 6.0，WiFi/蓝牙在 Android 下**完全可用**（硬件无故障）。
- 用户将该设备 **switchroot** 为 Alpine Linux（保留 Android 内核 3.10.65，仅替换根文件系统）。
- 换到 Alpine 后 **WiFi 完全不工作**，典型现象：
  - `dmesg` 反复出现 `SDIO dev not ready`；
  - GPIO94（芯片 READY 引脚）恒为 0；
  - 内核从未枚举出 SDIO WiFi 设备（`/sys/bus/sdio/devices/` 为空）。
- **根因**：SC2331 芯片的**上电时序 + 固件下载**由 Android 系统里的常驻 `download` 服务完成（写 `/dev/power_ctl`、`/dev/download`，并把 `wcnfdl`/`wcnmodem` 分区的固件刷进芯片）。Alpine 没有这套服务，芯片从未被"激活"。

---

## 2. 工具与物料清单

| 类别 | 工具/物料 | 用途 | 备注 |
|---|---|---|---|
| 远程操作 | SSH 客户端（paramiko / PuTTY / OpenSSH） | 连接 Alpine 设备 | `root@<设备IP>` |
| 对照取证 | WatchTools adb（`AndroidWatch_ADB_ToolBox\adb\adb.exe`） | 连接同型号 Android 机 H709 | 需 root（Magisk） |
| 分区读写 | `dd`、`cat`、`ls` | 提取/写入分区、设备节点 | 设备内自带（BusyBox/coreutils） |
| 系统跟踪 | `strace` | 定位 download 服务失败原因 | Alpine 用 `apk add strace` |
| 固件文件 | `download`（Android 二进制）、`libiwnpi.so`、`wcnfdl`/`wcnmodem` 分区镜像 | 上电 + 固件下载 | 从 Android 系统提取 |
| 设备树 | `android_orig.dtb`（约 53,967 字节） | 替换 p16 分区中的 dtb | 从 Android boot 镜像提取 |
| 内核模块 | `marlin_fm.ko`、`sprdwl.ko` | WiFi 驱动 | 放在 `/lib/modules/` |
| 用户态 | `wpa_supplicant` + `wpa_cli`（v2.10-r11） | 扫描/连接 | Alpine armhf 包 |
| 依赖库 | `libnl3`、`pcsc-lite-libs` | wpa_supplicant 依赖 | Alpine armhf 包 |
| 辅助 | `chroot`、`mount --bind` | 运行 Android 二进制 | 设备自带 |

---

## 3. 总体思路

> **一句话**：芯片的上电与固件下载逻辑在 Android 用户态（`download` 服务）里，Alpine 缺它 → 把 Android 原版 `download` 二进制 + 固件 + 设备节点搬进 chroot，在 Alpine 里"借壳"跑完上电序列，让内核枚举出 SDIO 芯片，再加载驱动、配 wpa_supplicant。

链路分四段，缺一不可：

```
[1] 正确的 DTB（Android 原版）
        ↓
[2] download 上电 + 固件下载（chroot 跑 Android 二进制）
        ↓
[3] 内核枚举 SDIO 设备 + insmod 驱动 → wlan0 出现
        ↓
[4] wpa_supplicant 配置 → 扫描 / 连接
```

---

## 4. 操作流程

### 4.1 设备与系统确认

```sh
# 连接设备
ssh root@<设备IP>          # 密码 <密码>

# 确认系统
uname -a                          # 应看到 3.10.65 Android 内核 + armv7l
cat /etc/os-release               # Alpine 3.21 armhf

# 确认分区映射（by-name）
ls -l /dev/block/platform/sdio_emmc/by-name/
# 关键分区：
#   boot    -> p16   （含内核 + 设备树）
#   wcnfdl  -> p14   （WiFi/蓝牙 固件 A）
#   wcnmodem-> p15   （WiFi/蓝牙 固件 B）
#   system  -> p17   （Android system，只读挂载可提取文件）
#   recovery-> p21

# 确认芯片当前状态（未打通的典型表现）
cat /sys/bus/sdio/devices/mmc2:*/device 2>/dev/null   # 空 = 未枚举
dmesg | grep -i -E "sdio|mmc2|wlan|2331"              # 可见 SDIO dev not ready
```

### 4.2 从 Android 对照机取证

> 需要一台**同型号、Android 系统正常**的设备（H709），WiFi/蓝牙都好的那台。

```sh
# 电脑端 adb 连接（WatchTools 的 adb）
D:\Program Files (x86)\watchTools\AndroidWatch_ADB_ToolBox\adb\adb.exe devices
adb shell id                          # 确认 root（Magisk）

# 查看分区表（拿到 by-name 到分区号的映射）
adb shell ls -l /dev/block/platform/sdio_emmc/by-name/
#   记录：boot=p16  wcnfdl=p14  wcnmodem=p15  system=p17  recovery=p21

# 提取 boot 镜像（内含 dtb）
adb shell dd if=/dev/block/mmcblk0p16 of=/sdcard/boot_p16_android.img bs=4096
adb pull /sdcard/boot_p16_android.img ./

# 提取 WiFi/蓝牙固件（两个分区）
adb shell dd if=/dev/block/mmcblk0p14 of=/sdcard/wcnfdl.img bs=4096
adb shell dd if=/dev/block/mmcblk0p15 of=/sdcard/wcnmodem.img bs=4096
adb pull /sdcard/wcnfdl.img ./
adb pull /sdcard/wcnmodem.img ./

# 提取 download 服务及其依赖（Android 用户态上电程序）
adb shell cp /system/bin/download /sdcard/download
adb shell cp /system/lib/libiwnpi.so /sdcard/libiwnpi.so
adb pull /sdcard/download ./
adb pull /sdcard/libiwnpi.so ./

# 提取 Android 内核模块（sprdwl 等，备选方案，通常 Alpine 里已有）
adb shell ls /system/lib/modules/ | grep -i -E "sprdwl|marlin|fm"
```

### 4.3 提取并替换 Android 原版设备树（DTB）

> Android 原版 DTB 里含 WiFi 电源/时钟的正确描述。这是后续 download 能正常工作的前提之一。

**4.3.1 电脑端：从 boot 镜像提取 DTB**

```sh
# boot 镜像头为 ANDROID!，内核之后、ramdisk 之前是 dtb 段
# 用 unpack_bootimg（或手动）：
# Android 6 内核镜像内嵌 dtb，偏移约 0xB71800（以实际解析为准）
# 工具：abootimg / unpack_bootimg / dtbTool

unpack_bootimg --boot_img boot_p16_android.img --out boot_extract/
# 得到 dtb 文件（约 53,967 字节）→ 命名 android_orig.dtb

# 校验
file android_orig.dtb        # Device Tree Blob version 17
```

**4.3.2 设备端：写入 p16 分区**

```sh
# 把 android_orig.dtb 上传到设备 /tmp/
# 写入 p16 的 dtb 偏移处：
#   dtb 在 boot 内的偏移 = 0x9C5000（字节）= 20008 个 512 字节块
dd if=/tmp/android_orig.dtb of=/dev/block/mmcblk0p16 bs=512 seek=20008 conv=notrunc

# 备份当前 boot 以防万一
dd if=/dev/block/mmcblk0p16 of=/root/p16_boot_backup.img bs=4096

# 重启后验证
reboot
dmesg | grep -i -E "sdio|mmc2|2331"   # 观察枚举情况
```

> ⚠️ 写入 boot 分区有风险，务必先做备份。若刷错可 `dd` 回备份。

### 4.4 搭建 Android 用户态 chroot 环境

> 目的：让 Android 原版 `download` 二进制能在 Alpine 里运行（它依赖 Android 的库、设备节点、分区链接）。

```sh
# 1) 建目录并铺 Android 用户态文件
mkdir -p /tmp/aand/{bin,lib,etc,dev}
cp /tmp/download          /tmp/aand/bin/download
cp /tmp/libiwnpi.so       /tmp/aand/lib/
cp -r /mnt/android_sys/lib/*.so  /tmp/aand/lib/   # 从 p17 挂载的 Android system 复制全套 so
chmod +x /tmp/aand/bin/download

# 2) 固件与配置
#    Android 的 download 会读 /etc/marlinba/*.ini（WiFi/蓝牙固件路径配置）
cp -r /mnt/android_sys/etc/marlinba /tmp/aand/etc/

# 3) 关键设备节点（download 需要 /dev/power_ctl 和 /dev/download）
mount --bind /dev /tmp/aand/dev

# 4) 固件分区链接（download 按 by-name 找分区）
mkdir -p /tmp/aand/dev/block/platform/sdio_emmc/by-name
ln -sf /dev/block/mmcblk0p14 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnfdl
ln -sf /dev/block/mmcblk0p15 /tmp/aand/dev/block/platform/sdio_emmc/by-name/wcnmodem

# 5) 验证 chroot 内可运行
chroot /tmp/aand /bin/download --help 2>&1 | head -20
# 若报缺库/找不到，用 strace 定位：
chroot /tmp/aand strace /bin/download 2>&1 | grep -E "open|ENOENT" | head -30
```

> 排错要点：`strace` 看到 `open("/dev/power_ctl")` 失败 → 确认 `mount --bind /dev`；看到 `open(...wcnfdl)` 失败 → 确认 by-name 链接。

### 4.5 执行固件下载（download 上电序列）

```sh
# 在 chroot 里运行 Android 原版 download（带参数，参考 Android 的调用方式）
chroot /tmp/aand /bin/download -i wlan0 2>&1 | tee /tmp/dl_run.log

# 预期动作（由 download 内部完成）：
#   1) 打开 /dev/power_ctl，写入 SLEEP → POWER_ON → POWER_RST 上电序列
#   2) 打开 ttyS0（115200）与芯片握手
#   3) 把 wcnfdl / wcnmodem 分区固件以 SDIO 大块写入芯片
#   4) 芯片完成启动，SDIO 从设备就绪

# 观察内核日志，应出现：
dmesg | tail -30
#   mmc2: new high speed SDIO card at address 8800
#   mmc2:8800:1  (device 0x2331)
#   sprd_download_sdio_write ... 131080 ...   （大块固件写入）
```

> 若固件下载失败（卡在握手/写入错误），检查：DTB 是否正确（回 4.3）、`/dev/power_ctl` 是否可写、固件分区是否为原版。

### 4.6 验证 SDIO 枚举

```sh
# 芯片已枚举（此时 GPIO94 READY 应为 1）
cat /sys/bus/sdio/devices/mmc2:8800:1/device
# 期望输出：0x2331

ls /sys/bus/sdio/devices/
# 期望出现 mmc2:8800:1
```

### 4.7 加载 WiFi 驱动

```sh
# 1) 先加载 FM 辅助模块（提供 fm_read 等符号）
insmod /lib/modules/marlin_fm.ko
# 2) 再加载主 WiFi 驱动
insmod /lib/modules/sprdwl.ko

# 3) 验证接口出现
ip link show wlan0
#   出现 wlan0，MAC a2:d2:f3:bf:8c:10 即为成功

# 4) 打开接口
ip link set wlan0 up
```

> ⚠️ 加载顺序不能反：`sprdwl.ko` 依赖 `marlin_fm.ko` 导出的符号（`fm_read`），反过来会报 `Unknown symbol`。

### 4.8 安装并配置 wpa_supplicant

> Alpine 官方源若不可用，直接下载 armhf 的 apk 手动安装。

```sh
# 1) 准备 apk 包（armhf）：
#    wpa_supplicant-2.10-r11.apk
#    libnl3.apk
#    pcsc-lite-libs-2.2.3-r1.apk
apk add --allow-untrusted /tmp/wpa_supplicant.apk /tmp/libnl3.apk /tmp/pcsc.apk

# 2) 写配置
cat > /etc/wpa_supplicant/wpa_supplicant.conf <<'EOF'
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
EOF

# 3) 启动
/sbin/wpa_supplicant -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf -B

# 4) 确认状态
wpa_cli -i wlan0 status
#   wpa_state=INACTIVE 属正常（未连接任何网络）
```

### 4.9 扫描验证

```sh
wpa_cli -i wlan0 scan
sleep 5
wpa_cli -i wlan0 scan_results
# 出现多个热点（CMCC-*、ChinaNet-* 等）即打通成功

# 连接示例（开放网络直连）
wpa_cli -i wlan0 add_network
wpa_cli -i wlan0 set_network 0 ssid '"CMCC-dtGM"'
wpa_cli -i wlan0 set_network 0 key_mgmt NONE
wpa_cli -i wlan0 enable_network 0
wpa_cli -i wlan0 save_config
```

### 4.10 开机自启动固化

> 设备重启后，内核枚举、固件、驱动、wpa_supplicant 都要自动恢复。

```sh
# 1) 驱动开机加载：写入 /etc/modules-load.d/wifi.conf
cat > /etc/modules-load.d/wifi.conf <<'EOF'
marlin_fm
sprdwl
EOF

# 2) 固件下载 + wpa_supplicant 开机脚本：/etc/local.d/wifi_setup.start
cat > /etc/local.d/wifi_setup.start <<'EOF'
#!/bin/sh
# 1. chroot 跑 download 完成上电+固件下载
mount --bind /dev /tmp/aand/dev
chroot /tmp/aand /bin/download -i wlan0 &
sleep 8
# 2. 确认接口并 up
ip link set wlan0 up
# 3. 启动 wpa_supplicant
/sbin/wpa_supplicant -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf -B
EOF
chmod +x /etc/local.d/wifi_setup.start

# 3) 启用 local 服务（Alpine openrc）
rc-update add local default
rc-service local start
```

---

## 5. 故障排查速查表

| 现象 | 可能原因 | 排查/修复 |
|---|---|---|
| `dmesg` 一直 `SDIO dev not ready` | 芯片未上电/固件未下载 | 确认跑过 download（4.5），看 `/dev/power_ctl` 是否可写 |
| GPIO94 READY 恒 0 | 上电序列没执行 | 用 `strace` 跟踪 download 的 ioctl/write 是否报错 |
| `download` 报 open 设备失败 | chroot 内缺设备节点 | `mount --bind /dev /tmp/aand/dev` |
| `download` 报找不到 wcnfdl/wcnmodem | 缺 by-name 链接 | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl` |
| `download` 跑完但 SDIO 无枚举 | DTB 不对 | 确认 p16 已是 Android 原版 dtb（4.3） |
| `insmod sprdwl.ko` 报 Unknown symbol | 模块加载顺序错 | 先 `insmod marlin_fm.ko` |
| wlan0 不出现 | 固件下载未完成就加载驱动 | 等 dmesg 出现 `mmc2:8800:1` 再 insmod |
| `wpa_cli scan` 失败 | wpa_supplicant 未跑 / 接口未 up | `ip link set wlan0 up` + 确认 supplicant 进程 |
| `wpa_cli` 找不到 | PATH 缺 /sbin | `export PATH=$PATH:/sbin` |
| 重启后 WiFi 丢失 | 未做自启动 | 按 4.10 固化 |
| 拔插 USB 外设后 SSH 断 | 设备 USB 口复用（网口/键盘） | 重插电脑 USB 并重启设备恢复 |

---

## 6. 注意事项与风险

1. **刷 p16（boot）分区有变砖风险**——必须先备份（`/root/p16_boot_backup.img`），刷错可回滚。
2. **USB 口复用**：设备的 USB 口既做 SSH 网口又插外设。插入键盘/鼠标会断 SSH，需要拔掉外设、插回电脑 USB 并重启设备。
3. **固件版本匹配**：download 上电成功后，驱动和固件要来自同一 Android 版本，否则可能出现 wlan0 有接口但扫描失败。
4. **模块路径**：确认 `marlin_fm.ko` / `sprdwl.ko` 在 `/lib/modules/` 且与内核 3.10.65 匹配（不匹配会 `invalid module format`）。
5. **wpa_supplicant 版本**：设备 armhf，务必用 armhf 包；x86_64 包会报 Exec format error。
6. **dtb 偏移**：写 p16 时 `seek=20008`（512 字节块）对应字节偏移 `0x9C5000`，不同固件可能不同，先解析 boot 镜像确认。

---

*本手册基于实际打通过程整理，操作顺序不可颠倒，关键步骤（DTB → 上电 → 驱动 → supplicant）缺一不可。*
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
