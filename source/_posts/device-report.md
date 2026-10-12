---
title: "SC9832A_设备软硬件信息报告"
date: 2026-09-24 21:36:03
search: true
categories:
- 设备档案
tag:
- SC9832A
---


# SC9832A 智能终端 · 设备软硬件信息报告

> 采集时间：2026-09-24 21:31 · 采集方式：SSH 只读探测（/proc、/sys、dmesg、命令行工具）
> 主机名 `spd-box` · IP `192.168.137.100`（rndis0）

---

## 1. 系统概览

| 项目 | 值 |
|---|---|
| 产品形态 | 手持智能终端（竖屏 720×1280，带 4 物理键） |
| SoC | Spreadtrum **SC9832A**（Hardware: sc9832） |
| 序列号 | `CB02317100000B83`（androidboot.serialno） |
| 操作系统 | **Alpine Linux 3.21.3**（musl + busybox 用户态） |
| 内核 | **Linux 3.10.65 #13 SMP PREEMPT**（armv7l，2018-04-27 由 gcc 4.8 编译，`renjie@admin007-Server`） |
| 启动参数 | `console=ttyS1,115200n8 init=/init root=/dev/ram0 androidboot.hardware=sc9832 lcd_id=ID9881 mem_cs0_sz=40000000(1GB)` |
| 运行环境 | BusyBox v1.37.0、gcc 14.2.0（Alpine）、Python 3.12.14（设备自带） |
| 采样时负载 | up 37min，load 1.90 / 2.69 / 2.29 |

## 2. 处理器（CPU）

| 项目 | 值 |
|---|---|
| 架构 | ARMv7 **Cortex-A7**（implementer 0x41, part 0xc07, rev 5, v7l） |
| 设计核数 | 4 核（SC9832A 规格） |
| 当前在线 | **2 核**（cpu0/cpu1；其余核 hotplug 下线，`/proc/cpuinfo` 仅枚举 2 个） |
| 频率策略 | cpufreq：**768MHz（当前）～1.3GHz（max）**，governor=`interactive` |
| 特性 | swp half thumb fastmult vfp edsp neon vfpv3 tls vfpv4 idiva idivt vfpd32 |
| BogoMIPS | 1545.76 |
| ⚠️ hotplug 雷 | `/sys/.../cpu*/online` 是触发式写，重复写会让核掉线且只能重启恢复，勿手写 |

## 3. 内存（RAM）

| 项目 | 值 |
|---|---|
| 总容量 | **938,404 kB ≈ 916MB**（cmdline mem_cs0_sz=0x40000000 = 1GB 规格） |
| 采样时使用 | 43.5MB used / 130MB free / 764MB buff+cache（含 647MB Cached） |
| Swap | 无 |

## 4. 存储（eMMC）

| 项目 | 值 |
|---|---|
| eMMC 型号 | **FNX2MB**（CID `150100464e58324d42...`，厂商 0x15 Samsung） |
| 总容量 | 7,634,944 blocks ≈ **7.3GB**（mmcblk0，含 boot0/boot1/rpmb） |
| 根分区 | `mmcblk0p23` 6.2G（ext4），清理后用 81%、可用 1.2G |
| Android 系统分区 | `mmcblk0p17` 610M → 挂载 `/mnt/android_sys`（用 78%） |
| 分区表 | 共 23 个主分区（p1~p6 1~5MB 小分区、p7 19M、p15 10M、p16 20M、p17 800M(819200KB)、p20 200M、p21 18M、p23 6.2G 根） |
| 内存盘 | /run 183M tmpfs、/dev/shm 458M、/dev 10M tmpfs |

## 5. 显示

| 项目 | 值 |
|---|---|
| 屏幕面板 | **ILI9881**（MIPI DSI，cmdline `lcd_id=ID9881`，驱动 `lcd_ili9881_mipi`） |
| 帧缓冲 | `/dev/fb0` 驱动 **sprdfb**，720×1280 竖屏、**32bpp**、虚拟尺寸 720×3840（3 页翻页缓冲） |
| 物理字节序 | fb 落盘实际为 `[R,G,B,X]`（与驱动报告相反，LVGL 需 R/B 交换） |
| 背光 | `/sys/class/backlight/sprd_backlight`，0~255 |
| GPU | **Mali-400 MP**（3D GPU；本系统 musl 用户态用不起来：bionic DDK 无法加载、无 /dev/dri） |
| 硬件加速 | **VSP/GSP/VPP built-in**：`/dev/sprd_vsp`（硬解）、`/dev/sprd_gsp`（缩放/旋转）、`/dev/sprd_vpp`（后处理）、`/dev/ion`（零拷贝缓冲），均可用 |

## 6. 输入设备

| event | 名称 | 说明 |
|---|---|---|
| event0 | sprd-gpio-keys | 板载物理键（LEFT=114 服务=102 ENTER=115 BACK=116 耳机=30） |
| event1 | sprd-eic-keys | EIC 按键 |
| event2 | headset-keyboard | 耳机线控 |
| event3/4 | **2.4G Composite Device**（Vendor 4037:2804） | USB 2.4G 无线键鼠接收器（当前已插入枚举） |

- USB 主控：dwc_otg（20200000.usb），host 模式支持热插拔；`mode`/`hprt0` sysfs 只读调试口
- USB 外设口：rndis（PC 网络），SSH 走此通道

## 7. 网络

| 接口 | IP | 说明 |
|---|---|---|
| lo | 127.0.0.1 | 回环 |
| **rndis0** | 192.168.137.100/24 | USB 虚拟网卡（连接 PC） |
| **wlan0** | 192.168.1.52/24 + 全局 IPv6 | WiFi（MAC `8a:b3:92:1f:09:94`，驱动模块 `sprdwl` 84.5KB） |

- 内核模块仅 2 个：`sprdwl`（WiFi）、`marlin_fm`（FM 收音机，17554 字节）
- FM 现状：AP 音频子系统不工作（sipc 仅暴露 LTE 通道，无音频 DSP 通道），场强/搜台不可做

## 8. 电池与温度

| 项目 | 采样值 |
|---|---|
| 电池 | Li-ion，**电量 100%（Full）**，电压 4.185V，健康 Good |
| 电池温度 | **35.3°C**（353，单位 0.1°C） |
| ARM 温度 | **55.8°C**（thermal_zone sensor_arm） |
| 供电 | usb ONLINE=1（USB 供电中）、ac ONLINE=0 |
| 电量计 | sprdfgu（Spreadtrum FGU） |

## 9. 音频

| 声卡 | 名称 | 说明 |
|---|---|---|
| card0 | all-i2s | I2S 接口 |
| card1 | **sprdphone** | 板载 codec（主输出） |
| card2 | saudiolte | LTE 语音通道 |
| card3 | saudiovoip | VoIP 通道 |

- ALSA pcm 设备齐全（C0~C3 各 4 路 pcm），但 AP 侧音频子系统历史结论：card0 EIO、DMA 不搬运 → 用户态出声不可行
- 蓝牙：WCN 模块（@wcnd 守护），链路真相 `/tmp/bt_audio.fifo` 读者；link key 失效为一级排查项

## 10. 其他外设

| 项目 | 值 |
|---|---|
| LED | `blue` `green` `red` 三色（/sys/class/leds） |
| GPIO | gpiochip0 / 288 / 304 |
| 串口 | /dev/ttyS0~S3（console=ttyS1） |
| LTE 调制解调器 | SC9832A 内置（sipc 共享内存通道） |

## 11. 软件栈（本机应用）

| 组件 | 说明 |
|---|---|
| 主程序 | `/usr/local/bin/lvgl_demo`（LVGL **9.6** 自编译，`/root/lvgl_install` 安装树：liblvgl.a 含自启用 montserrat_48） |
| 页面框架 | 自研 lv_page_manager（activity 栈 + onCreate/onResume/onPause/onDestroy） |
| 模拟器 | miniretro（FC，git 原版）+ miniretro_gba（mgba core）+ miniretro_psp（PPSSPP core，JIT+480x272），直写 /dev/fb0 |
| 视频播放 | ffmpeg 移植（VSP 硬解 / rotate 替代 scale） |
| 守护 | `/root/lvgl_watchdog.sh`（5s 拉起）、`log_rotate.sh` + busybox crond |
| 开机 | `/etc/local.d/00_lvgl_demo.start`（setsid 方式） |
| 应用数 | launcher 内置 18 应用 + 最多 16 个外部进程应用 |
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
