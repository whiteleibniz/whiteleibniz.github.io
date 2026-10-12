---
title: "FM出声_厂商官方音频通路与实操步骤"
date: 2026-09-23 12:16:40
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM 出声：厂商官方音频通路（2026-09-23）

> 背景：本机 FM「应用层已通」（TUNE / RDS / 音量都有），唯独**没有声音**。
> 先前结论是「FM 音频在用户态不可行」，理由是：card1 DAPM 路由不完整、8 个 capture 全 EIO、
> `codec_reg` 是空文件。
> 本次**推翻该结论的一半**：FM 音频并非只能靠 `marlin_fm.ko` 里的那几个音频 ioctl ——
> **厂商其实已经把 FM 音频通路写进了 Android 分区的配置文件里**，而且
> **本机 card1 上这些 kcontrol 全部存在**。
> 之前没出来，是因为从来没人按那份配置去设过。
>
> 状态：**待你在设备上手动验证**（我不再跑验证）。本文档给出控件名、顺序、命令、排错要点。

---

## 1. 先说结论

| 项 | 结论 |
|---|---|
| `OVER_BT_ENABLE(0x1d)` / `I2S_SETTING(0x21)` / `ANA_SWITCH(0x1e)` / `GET_AUDIO_INFO(0x30)` | 本机 `marlin_fm.ko` 里**是空壳**：`fm_ioctl` 进 case 只 printk 一行名字就返回，不发任何 SDIO 命令（反汇编已确认）。**不要再指望用 FM ioctl 切音频通路**。 |
| 上游开源驱动（同一份 `marlin2_fm`） | 同样把这几个 case 写成 `ret = 0; break;`——**厂商从来没在这条链路上实现**。这是 `OVER_BT_ENABLE` 这条路已死的权威证据。 |
| **真正的通路在哪** | 在 **AP codec 侧**，厂商在 Android system 分区 `/etc/tiny_hw.xml` 里给了完整定义。FM 芯片出来的音频（数字 DIGFM 或模拟 AIL/AIR line-in）→ codec → SPK/耳机，**AP 不需要搬音频数据**。 |
| 本机是否具备 | **具备**。card1（`sprdphone`）里 `Digital FM Function`、`AD IISMUX`（enum 含 `DIGFM`）、`Line Function`、`ADCL/ADCR Mixer AILADCL/AIRADCR`、`SPKL Mixer ADCLSPKL`、`HPL Mixer ADCRHPL` 等控件**全部存在**。 |
| 为什么之前没出来 | 先前只设了 `Speaker Function`（把 DACL→EAR 打通），**没设 FM 侧的任何一个控件**，也**没有打开 `hw:1,4`(`Dfm`) PCM 去触发 DAPM 上电**。两件事都没做，自然没声。 |

---

## 2. 厂商官方 path 定义（原文）

来源：设备 Android system 分区 `/etc/tiny_hw.xml`（只读挂载在 `/mnt/android_sys`）。

### 2.1 数字 FM —— `<device name="digital-fm">`

```xml
<device name="digital-fm">
  <path name="on">
     <ctl name="Digital FM Function" val="1" />
     <ctl name="DA0 ADDST MUX" val="0" />
     <ctl name="DA1 ADDST MUX" val="0" />
     <ctl name="AD IISMUX" val="2" />        <!-- 2 = DIGFM -->
  </path>
  <path name="off">
     <ctl name="Digital FM Function" val="0" />
     <ctl name="DA0 ADDST MUX" val="0" />
     <ctl name="DA1 ADDST MUX" val="0" />
     <ctl name="DA0 ADDFM MUX" val="0" />
     <ctl name="DA1 ADDFM MUX" val="0" />
     <ctl name="AD IISMUX" val="0" />
  </path>
</device>
```

`AD IISMUX` 的 enum 选项（本机 card1 实测）：
`[0]=AUDIIS0  [1]=DIGFM  [2]=EXTDIGFM  [3]=EXTIIS6  [4]=AUDIIS1`

⚠️ **注意**：本机 dump 出来的 enum 顺序是 `(AUDIIS0/DIGFM/EXTDIGFM/EXTIIS6/AUDIIS1)`，
`val="2"` 在这个顺序里落在 **EXTDIGFM** 而不是 DIGFM。XML 是给另一份 kernel/codec 版本写的，
**两个值都要试**（建议先 2，再 1）。这是本方案里最可能需要现场调的一个值。

### 2.2 模拟 FM（line-in → codec loop）

```xml
<device name="line">                      <!-- 模拟输入侧 -->
  <path name="on">
     <ctl name="HeadPhone Mute" val="1" />      <!-- 先 mute，防 pop -->
     <ctl name="ADCL Mixer AILADCL Switch" val="1" />
     <ctl name="ADCR Mixer AIRADCR Switch" val="1" />
     <ctl name="Line Function" val="1" />
     <ctl name="HeadPhone Mute" val="0" />      <!-- 再放开 -->
  </path>
  <path name="off">
     <ctl name="Line Function" val="0" />
     <ctl name="ADCL Mixer AILADCL Switch" val="0" />
     <ctl name="ADCR Mixer AIRADCR Switch" val="0" />
  </path>
</device>

<device name="line-speaker">              <!-- 模拟 → 扬声器 -->
  <path name="on">
     <ctl name="SPKL Mixer ADCLSPKL Switch" val="1" />
     <ctl name="SPKL Mixer ADCRSPKL Switch" val="1" />
  </path>
</device>

<device name="line-headphone">            <!-- 模拟 → 耳机 -->
  <path name="on">
     <ctl name="HPL Mixer ADCRHPL Switch" val="1" />
     <ctl name="HPR Mixer ADCLHPR Switch" val="1" />
  </path>
</device>
```

### 2.3 输出侧（数字 FM 也要配一个）

```xml
<device name="speaker">
  <path name="on">
     <ctl name="SPKL Mixer DACLSPKL Switch" val="1" />
     <ctl name="SPKL Mixer DACRSPKL Switch" val="1" />
     <ctl name="Speaker Function" val="1" />
  </path>
</device>

<device name="headphone">
  <path name="on">
     <ctl name="HPL Mixer DACLHPL Switch" val="1" />
     <ctl name="HPR Mixer DACRHPR Switch" val="1" />
     <ctl name="HeadPhone Function" val="1" />
  </path>
</device>
```

参考：SC9832A 平台同款 SoC 的公开分析确认 FM 音频从 codec 的 **AIL/AIR**（类似 MIC 的 line-in）进
codec，再「FM playback patch」直出，或经 VBC 给主控录音——与上面的配置文件完全对得上。

---

## 3. 你怎么跑（手动验证步骤）

### 3.0 准备

1. FM 上电链先起来：WiFi 固件下载 → `bt_bringup.start`（含 wcn BT-OPEN）→ 向 `@wcnd` 发 `wcn FM-OPEN`
   并**长期保持连接**。
2. `fm_user_daemon` 常开 `/dev/fm`（socket `/tmp/fm_ctl.sock`），TUNE 到一个本地强信号电台。
3. 通过 `/tmp/fm_ctl.sock` 执行 `mute 0`，确认 FM 未处于静音（socket 命令写法见
   `AI工作流/*/docs/` 与 `lv_pages/radio_page.c`）。
4. 没有 `amixer`/`tinymix`，用已有的 `/root/fm_ctl`：`fm_ctl <op> <card> ...`

### 3.1 先确认控件真名（非常重要）

之前 dump 出来的名字**不一定等于 ALSA 全名**（例如 dump 里是 `ADCL Mixer AILADCL`，
XML 里是 `ADCL Mixer AILADCL Switch`）。先 grep 一次拿真名：

```sh
/root/fm_ctl grep card1 AIL
/root/fm_ctl grep card1 IISMUX
/root/fm_ctl grep card1 "Digital FM"
/root/fm_ctl grep card1 SPKL
/root/fm_ctl grep card1 Function
```

### 3.2 方案 A：数字 FM → 扬声器（推荐先试）

```sh
# 1) 输出侧 speaker（先铺好输出）
/root/fm_ctl set card1 "Speaker Function" 1
/root/fm_ctl set card1 "SPKL Mixer DACLSPKL Switch" 1
/root/fm_ctl set card1 "SPKL Mixer DACRSPKL Switch" 1

# 2) 数字 FM 通路
/root/fm_ctl set card1 "Digital FM Function" 1
/root/fm_ctl set card1 "DA0 ADDST MUX" 0
/root/fm_ctl set card1 "DA1 ADDST MUX" 0
/root/fm_ctl set card1 "AD IISMUX" 2        # 无声再试 1 / 3

# 3) 打开 FM PCM 触发 DAPM 上电（关键！本机 card1 的 01-04 就是 Dfm）
#    编译：gcc -O2 -o /root/fm_pcm fm_pcm.c -lasound
/root/fm_pcm "hw:1,4" 60 &                  # 保持写 60 秒
```

> **第 3 步是最容易漏的一步**：`Dfm` 这个 PCM 设备存在的意义就是「开流把 DAPM 拉起来」，
> 只设 kcontrol 而 stream 没起来，`bias_level` 会一直停在 `Off`（这正是之前观察到的现象）。

### 3.3 方案 B：模拟 line-in → 扬声器 / 耳机

```sh
/root/fm_ctl set card1 "Line Function" 1
/root/fm_ctl set card1 "ADCL Mixer AILADCL Switch" 1
/root/fm_ctl set card1 "ADCR Mixer AIRADCR Switch" 1

# 出到扬声器
/root/fm_ctl set card1 "SPKL Mixer ADCLSPKL Switch" 1
/root/fm_ctl set card1 "SPKL Mixer ADCRSPKL Switch" 1

# 或出到耳机
/root/fm_ctl set card1 "HPL Mixer ADCRHPL Switch" 1
/root/fm_ctl set card1 "HPR Mixer ADCLHPR Switch" 1
/root/fm_ctl set card1 "HeadPhone Function" 1
```

### 3.4 关 / 复位

```sh
/root/fm_ctl set card1 "Digital FM Function" 0
/root/fm_ctl set card1 "AD IISMUX" 0
/root/fm_ctl set card1 "Line Function" 0
/root/fm_ctl set card1 "Speaker Function" 0
```

---

## 4. 排错要点

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 完全无声，`bias_level` 仍 Off | `hw:1,4` 没被打开/写入 | 确认 `fm_pcm` 进程在跑且 `writei` 没返回错误 |
| 有声但很小 / 失真 | 走的是 line-in 模拟通路，增益没配 | 只保留一条 route（两条同时开会互相串扰），并换另一个 `AD IISMUX` 取值再试 |
| `AD IISMUX` 设不动 | enum 值范围不同 | 先 `fm_ctl get card1 "AD IISMUX"` 看允许的取值范围 |
| 需要插耳机 | FM 天线可能挂在耳机线上 | 不插耳机 TUNE 到最强台再试；若必须插，UI 要有提示 |
| 数字 FM 一直不成 | 本机固件可能没把 FM 数字口接到 VBC | 退回方案 B（模拟 line-in），这条路最好 route 完整 |

沿用「末端证据」原则：**判断标准是人耳听到电台声**，不是 ioctl 返回 0。

---

## 5. 待确认清单（验证后回填）

- [ ] `AD IISMUX` 正确取值（1 / 2 / 3 哪个是 `DIGFM`）
- [ ] 数字 FM 与模拟 line-in 哪条在本机真的通
- [ ] 是否需要插耳机当天线
- [ ] 音量到底归 `SETVOL`(0x04) 管还是归 codec 的 pga（`codec_pga.xml` 里 `digital-fm` profile 用 `VBC STL DG Set` / `VBC STR DG Set`）
- [ ] FM 与 A2DP 同时开时的串扰情况（决定声道仲裁怎么写）

---

## 6. 附：证据来源

| 文件 | 内容 |
|---|---|
| `/mnt/android_sys/etc/tiny_hw.xml` | 厂商 mixer path 全量定义（本文 §2 原文出处） |
| `/mnt/android_sys/etc/codec_pga.xml` | `digital-fm` profile → `VBC STL DG Set`(bit 0) / `VBC STR DG Set`(bit 16) |
| `radio_docs/mixer_card1.txt` | 本机 card1 全部 kcontrol dump（确认控件存在） |
| LKML `[PATCH 2/2] misc: added Spreadtrum's radio driver`（Chunyan Zhang, 2017） | 驱动上游源码：`FM_IOCTL_*` 全表、chip 侧 `FM_*_CMD` 编号、以及 I2S/AudioInfo case 是空实现 |
| 公开分析《Sprd 9832A Android6.0 FM 模式下的几种 Audio 路径》 | AIL/AIR 输入、三种模式（Line_in-Codec / Line_in-VBC-Codec / Digital FM-VBC-Codec）的信号流 |
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
