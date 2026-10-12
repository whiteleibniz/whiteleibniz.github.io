---
title: "DMA支持与安卓移植可行性勘察"
date: 2026-09-23 12:16:40
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# DMA 支持情况 & 从安卓移植的可行性勘察

- **日期**：2026-09-23
- **问题**：本机 DMA 到底支不支持？能不能把安卓那套音频搬过来？
- **结论**：**DMA 硬件与驱动都在，但内核层没有可移植的东西（Alpine 跑的就是原厂安卓内核）**；
  用户态能搬的都试了，全无效。堵点已定位到 **12 个音频电源域全部 disabled、codec 数字部分寄存器读出来全是 0**。

---

## 1. 先纠正一个前提：Alpine 跑的就是原厂安卓内核

```
$ uname -a
Linux spd-box 3.10.65 #13 SMP PREEMPT Fri Apr 27 13:23:49 CST 2018 armv7l Linux

$ cat /proc/cmdline
... androidboot.hardware=sc9832 lcd_id=ID9881 ... androidboot.mode=charger
```

内核版本、编译时间、`androidboot.hardware=sc9832` 都指向**厂商原厂内核**，
boot 分区 `mmcblk0p16` 头部是标准 `ANDROID!` boot.img 魔数。

> 所以「从安卓移植驱动」这个方向**不成立** —— 驱动本来就在这颗内核里，而且全部是 **builtin**
> （Android 侧 `/mnt/android_sys/lib/modules/` 里只有 `sprdwl.ko / marlin_fm.ko / mali.ko /
> gator.ko / autotst.ko / mmc_test.ko`，**没有任何音频模块**）。

## 2. DMA 支持情况：硬件和驱动都在

| 项 | 状态 |
|----|------|
| `/sys/class/dma` | **不存在** —— 但这是正常的：sprd 用的是自家 DMA 驱动，**没走内核 dmaengine 框架** |
| `0.dma-controller` / `0.dmac` | 存在（platform device） |
| `sprd_dma_copy.27` | 存在 |
| `i2s.38 / .39 / .40 / .41` | 存在 |
| `sprd-pcm-audio.42`、`sprd-codec.34` | 存在 |
| `vbc-r2p0.36`、`vaudio.37`、`saudio_lte.0`、`saudio_voip.1` | 存在 |
| `sprd-audio-power.1 ~ .12` | 12 个音频电源域，均带 `regulator` 子目录 |
| regulator framework / `sc2723-regulator` | 正常，共 38 个 regulator |

**结论：DMA 不是缺驱动，也不是缺硬件。**

## 3. 从安卓搬了什么、结果如何

| 可搬项 | 来源 | 结果 |
|--------|------|------|
| **`audio_para`** | `/mnt/android_sys/etc/audio_para`（485KB），HAL 字符串里明确有 `/etc/audio_para` 和 `/data/local/media/audio_para` | ❌ **无效**。已放到 `/etc/audio_para` + `/lib/firmware/audio_para` 并**重启**，codec 数字部分寄存器**仍全是 0** |
| **音频 HAL** | `/mnt/android_sys/lib/hw/audio.primary.sc8830.so` | ❌ 它是 **bionic** 动态库，本机是 musl，**跑不起来**。不过它里面的控件序列我们早先已还原并实测过（见 §5） |
| **tinyplay / tinycap / tinymix** | `/mnt/android_sys/bin/` | ❌ 同样是 bionic 二进制。等价功能已用自写工具（`fm_cap_scan` / `fm_play_probe`）覆盖 |
| **VBC 通路** | HAL 用 `/dev/vbpipe6`、`/dev/pipe/mmi.audio.ctrl` | ❌ **本机 `/dev/vbpipe*` 和 `/dev/pipe` 都不存在** |
| **AGDSP / 音频 DSP** | — | ❌ **sipc 只有 `sipc-lte`(dst 0x5) 和 `sipc-pmsys`(dst 0x6)**，**没有任何 audio DSP 通道**；`/sys/kernel/debug/sipc/` 下是 sblock/sbuf/seblock/sipx/smem/smsg，但 smsg 通道列表里只有 lte/pmsys |

## 4. 堵点定位（本次最重要的发现）

### 4.1 codec 数字部分寄存器读出来全是 0

`/proc/asound/sprdphone/sprd-codec` 可以直接 dump 寄存器：

```
sprd-codec.34 digital part
0x0000 | 0x0000 0x0000 0x0000 0x0000      ← 全 0
0x0010 | 0x0000 0x0000 0x0000 0x0000
0x0020 | 0x0000 0x0000 0x0000 0x0000
0x0030 | 0x0000 0x0000 0x0000 0x0000
sprd-codec.34 analog part
0x0000 | 0x0010 0x0081 0xb400 0x6d3c      ← 模拟部分有正常值
0x0010 | 0x1070 0xa000 0x0000 0x0000
```

模拟部分（走 SC2723 的 ADI 总线）正常，**数字部分是空的**。
放 `audio_para` + 重启之后**依然全 0**。

### 4.2 12 个音频电源域全部没人用

```
sprd-audio-power.1 → regulator.26 = SRG_VREG      num_users=0
regulator.27 SRG_VB        regulator.28 SRG_BG
regulator.29 SRG_BG_IBIAS  regulator.30 SRG_VCOM
regulator.31 SRG_VCOM_BUF  regulator.32 SRG_VBO
regulator.33 SRG_VMICBIAS  regulator.34 SRG_MICBIAS
regulator.35 SRG_AUXMICBIAS regulator.36 SRG_HEADMICBIAS ...
```

全部 **disabled，users=0**。DAPM 里 `Analog Power / DA Clk / AD Clk` 那批 Off 的 widget，
对应的就是这些电源域。

**`/sys/class/regulator/regulator.X/` 下只有 `device name num_users power subsystem
suspend_* type uevent`，没有可写的 `state`** → **用户态无法强制 enable**，必须由内核 DAPM 去做。

### 4.3 完整因果链

```
sipc 无 audio DSP 通道 → VBC/AGDSP 类通路不可用（/dev/vbpipe 也不存在）
                       ↓
DAPM 需要 enable 的 12 个 SRG_* 电源域全部 disabled (users=0)
                       ↓
codec 数字部分上不了电 → 数字寄存器读写不到（全 0）
                       ↓
bias_level 永远 Off，DAPM 不 power up
                       ↓
i2s / DMA 不搬运 → 播放 writei 写一个 buffer 就 EAGAIN、采集 readi 直接 EIO
```

## 5. 已经试过、不要再重复的动作

- 按厂商 `tiny_hw.xml` 配齐 `digital-fm` + `speaker` 完整通路，并用 `fm_hold` 保持 `hw:1,4` running
  → `bias_level` 仍 Off、ON widget 数为 0
- 放 `audio_para` 到 `/etc` 和 `/lib/firmware` 并重启 → 无效
- `unbind/bind` 重新 probe `sprd-codec.34` → **bind 失败，codec 变成 `(null)`**，
  只能靠重启恢复。**不要再对 `sprd-codec.34` 做 unbind**，会把音频子系统搞坏

## 6. 还能做什么

1. **需要厂商内核源码**才能继续：查 `sprd-codec` 的 probe / `set_bias_level` 为什么没把 bias 拉到
   STANDBY、数字寄存器为什么访问不到。本机 `/tmp/linux-3.10.65` 是 vanilla 树，不含厂商代码。
2. 次优：用 `dynamic_debug` 打开 `sprd-codec` / `snd_soc` 的 dapm 与 bias 相关打印，
   能看到 DAPM 决策过程（不需要源码也能拿到一些信息）。
3. **不推荐**的方向：继续在用户态调 kcontrol —— 电源域 enable 不了，控件怎么设都没用。

## 7. 现场状态（勘察后）

- 设备已重启一次，一切正常：`lvgl_demo` / `bt_user_daemon`(1177) / `fm_user_daemon`(1228) / `lvgl_watchdog` 均在跑
- `/etc/audio_para` 与 `/lib/firmware/audio_para` 已部署（实测无效，留着无害）
- 重启后 kcontrol 已回到默认值（此前配的 digital-fm / speaker 组合已清空）
- 新增工具：`/root/fm_cap_scan`（采集矩阵扫描）、`/root/fm_play_probe`（播放矩阵，非阻塞）、
  `/root/fm_hold`（保持 PCM running）
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
