---
title: "ref_FM_蓝牙_硬件加速"
date: 2026-09-23 20:16:57
lang: zh-CN
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 蓝牙
---


# 参考（细节）— FM 收音机 / 蓝牙 A2DP / 硬件加速

> 由 `MEMORY.md §8~10` 拆出，避免主笔记超限。结论级摘要仍在 MEMORY.md。
> 原始专文：`radio_docs/`（SEEK与场强、ioctl命令表、出声蓝牙路线、上电脚本、DMA勘察）、
> `outputs/FM收音机_进度快照_20260922.md`、`outputs/Mali400与硬件加速_勘察结论.md`

## A. FM 收音机（应用层完工；**出声无解**）

- **★★ 结论：整个 AP 音频子系统是死的**
  - `card0` capture `-5 EIO`；播放侧 PCM start 后 DMA 从不搬运；DAPM `bias_level` 永远 Off（codec 从没上电）
  - 根因：**sipc 只暴露 LTE 通道、无音频 DSP 通道 → AGDSP 无从加载**
  - FM 音频 ioctl（`OVER_BT_ENABLE`/`I2S_SETTING`/`ANA_SWITCH`/`GET_AUDIO_INFO`）在本机 `.ko` 与上游 `marlin2_fm`
    全是空实现；蓝牙协议栈无 FM
  - → **FM 经蓝牙出声在用户态不可行**，只剩动内核（需厂商源码）
- **上电链（FM 可用性的关键）**：`01_wifi.start` → `bt_bringup.start`（等 18s）→ 向 @wcnd 发 `"wcn FM-OPEN"`
  并**长期保连接**（abstract unix socket `sun_path[0]=0+"wcnd"`），否则 `set_marlin_wakeup ack timeout`
- **产物**：
  - `/usr/local/bin/fm_user_daemon`（常开 fd，因为 `close(/dev/fm)` 会阻塞 ~4s）
  - 开机 `/etc/local.d/zz_fm.start` → 调 `/root/fm_powerup.sh`（拉 daemon + 补电 + 拉 `fm_watchdog`）
  - 控制 socket `/tmp/fm_ctl.sock`：`state|on|off|tune <kHz>|vol|mute|ana|rssi|chipid|rds`
- **★ `daemon 在跑 ≠ FM 工作`**：必须再发 `on`(POWER_UP) 射频才起；**socket 写须 `MSG_NOSIGNAL` + 忽略 `SIGPIPE`**
  （否则客户端断开触发 SIGPIPE 终止进程）；脚本禁用 `rssi`（每次固定 4.2s 超时）
- **★ 场强/搜台都做不了（勿再试）**：`GETRSSI` 每次固定 4.2s `-ETIMEDOUT` 且回值不变；`SEEK` 驱动只取频率低字节 →
  TUNE 到任意频点 SEEK 全回 103.1 → **UI 不要做"搜台"按钮**

## B. 蓝牙 A2DP —— "已连接"必须看末端证据（2026-09-23 修复）

- **★ `conn` 只表示 ACL 链路，不等于连接可用**；UI 绝不能拿 `conn` 当"已连接"
- **★ 唯一用户态可见的 A2DP 真相 = `/tmp/bt_audio.fifo` 有无读者**（非阻塞开写端：`ENXIO`=无读者=空链路）→
  已落地 `lv_pages/bluetooth_page.c` 的 `bp_a2dp_ready()`（三态：链路+音频=绿 / 仅链路=橙 / 仅配对=灰）
- **★ link key 失效 = 音箱类设备一级排查项**：删 `/tmp/bt_linkkey.conf` 该行 → 真重启 daemon → 重连（走完整 SSP）
- **★ `openrc restart` 不换进程**：改了状态要用真重启（kill -9 + sleep + setsid 拉起 + sleep，并校验 pid 变没变）
- 自研 `bt_user_daemon`（74KB，含 A2DP Sink/Source）；音频源 `/tmp/bt_audio.fifo`（44100/2ch/S16_LE）；
  配对设备"小爱音箱-1303"

## C. 硬件加速（详见 `outputs/Mali400与硬件加速_勘察结论.md`）

- **Mali-400 是 3D GPU 不是显示控制器**；显示归 `sprdfb`→`/dev/fb0`；视频硬解在 AP 的 **VSP**
- **Mali 在本机用不起来**：`mali.ko` 可 insmod 但唯一 DDK 是 bionic 库、musl 加载不了；mesa 无 `lima_dri.so`、
  `/dev/dri` 不存在 → **GPU 不能治卡顿**（卡是 CPU 软解，`nproc=2`）
- **真正该挖的**：VSP 硬解 `/dev/sprd_vsp`、GSP 2D 加速 `/dev/sprd_gsp`+ION（硬件缩放 + YUV→RGB，省 swscale）
- 视频预转码参数：720x1280 + H.264 baseline + 无 B 帧 + ≤1Mbps + 24fps；
  mplayer 在 `/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer`（不在 PATH）
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
