---
title: "FM出声_蓝牙路线实测验证结论"
date: 2026-09-23 12:16:40
lang: zh-CN
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM 出声 —— 蓝牙（A2DP）路线实测验证结论

- **日期**：2026-09-23
- **目标**：本机无耳机孔，把 FM 音频数字化后写进 `/tmp/bt_audio.fifo`，经蓝牙 A2DP 送到小爱音箱
- **结论**：**用户态不可行**。三条子路线全部实测封死，且**根因不在 FM，而在整个 AP 音频子系统不上电**
- **验证方式**：全部由我上机实跑（用户要求「你直接帮我验证」），证据见 §3

---

## 1. 路线拆解

要让小爱音箱出 FM 的声音，必须凑齐两个条件：

```
条件 A：拿到 FM 的 PCM 数据（数字化）
条件 B：把 PCM 写进 /tmp/bt_audio.fifo，由 bt_user_daemon 走 A2DP 发出
```

**条件 B 已经通了**（09-23 上午验证过：灌 8.6MB 静音 PCM，链路 49s 不掉、HCI credit 持续变化）。
**条件 A 是死结**，本文验证的就是它，以及它的三条候选实现。

| 路线 | 做法 | 结果 |
|------|------|------|
| A1 | codec 模拟输入（AIL/AIR）→ capture PCM 读出来 | ❌ `readi` 恒 `-5 (EIO)` |
| A2 | 数字 FM（`AD IISMUX=DIGFM`）→ capture PCM 读出来 | ❌ 同上，且配与不配结果完全一致 |
| A3 | combo 芯片内部 FM→BT 直通（用户选的 b 路线） | ❌ 见 §3.4，驱动与协议栈两侧都没这个能力 |

---

## 2. 本次新写/新编的工具

| 工具 | 作用 |
|------|------|
| `ssh_tools/fm_cap_scan.c` → `/root/fm_cap_scan` | 一次扫完所有 capture 设备 × 采样率 × 声道，报告 `nonzero / rms / peak` |
| `ssh_tools/fm_play_probe.c` → `/root/fm_play_probe` | 同样方式扫 playback，判定 DMA 到底动不动 |
| `ssh_tools/fm_hold.c` → `/root/fm_hold` | 保持某个 playback PCM 处于 running，用来触发 DAPM 上电 |

**★ 编译坑（必记）**：本机**没有 alsa 头文件**（`/usr/include/alsa` 不存在），
`#include <alsa/asoundlib.h>` 直接编不过。必须照 `fm_ctl.c` 的套路走 `dlopen("libasound.so.2")`
取符号，命令是 `gcc -O2 -o xxx xxx.c -ldl -lm`（**不是** `-lasound`）。
我之前写 `fm_pcm.c` 时踩过一次，这次三个工具全部改用 dlopen 版。

**★ 第二个坑**：playback 必须用 **非阻塞** 打开。第一次用阻塞模式跑矩阵，`hw:1,4`
的 `writei` 永久卡死，整个矩阵被第一个组合拖到超时，什么数据都没拿到。

---

## 3. 实测证据

### 3.1 所有 capture PCM 一律 EIO（配控件前后都一样）

不配任何控件、配数字 FM 通路、配 line-in 通路，三种情况下跑 `fm_cap_scan`，结果**完全相同**：

```
hw:1,0  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,1  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,2  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,3  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
plughw:1,0 ...   同上
（44100 / 16000 / 8000，1ch / 2ch 全部如此）
```

**关键对照**：`card0` 是 `i2s.X null-codec-dai`（跟 FM 毫无关系的空 codec），
它的 capture **同样是 `-5 EIO`**。

> 这一条推翻了「FM 音频进不了主机」的说法 ——
> 不是 FM 的问题，是**整个 AP 音频采集通路都不工作**。

### 3.2 播放侧：DMA 启动一下就停，硬件指针不前进

`fm_play_probe`（非阻塞）结果：

```
hw:1,4  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
hw:1,0  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
hw:1,1  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
```

读法很重要：**`frames=9600` 说明 writei 一开始是成功的**（9600 帧 = 200ms 缓冲，
正好填满整个 ring buffer），之后才 `-11 (EAGAIN)`。

即：PCM start 了，数据进了 ring buffer，但 **DMA 从不搬运，硬件指针不前进**。
这与 capture 侧 EIO 是同一个根因的两面。

### 3.3 DAPM 永远不上电（决定性证据）

用 `fm_hold` 保持 `hw:1,4` running，同时按厂商 `tiny_hw.xml` 配齐完整通路：

```
Digital FM Function=1  DA0 ADDST MUX=0  DA1 ADDST MUX=0
AD IISMUX=2            AD23 IISMUX=1
Speaker Function=1     SPKL Mixer DACLSPKL=1  SPKR Mixer DACRSPKR=1
```

然后查 DAPM：

```
$ cat /sys/kernel/debug/asoc/sprdphone/sprd-codec.34/dapm/bias_level
Off

$ dapm_dump.sh | sed -n '/汇总/,$p'
----- 汇总 -----          ← 空的，一个 On 的 widget 都没有

DFM-OUT                 Off  in=1  out=0     ← 链路"连上了"
DFM-Output               Off  in=1  out=0
ADie Digital DACL Switch Off  in=1  out=0
Analog Power             Off  in=0  out=0    ← 模拟电源没开
DA Clk                   Off  in=0  out=0    ← 时钟没开
AD Clk                   Off  in=0  out=0
```

**这是最硬的一条证据**：`in=1` 说明 DAPM 的**连接关系**是通的（正如此前"路由通了"的观察），
但 `bias_level=Off`、所有 widget 全 Off —— **codec 从头到尾没上过电**。
没有上电，DAC 不出声、ADC 不采样，capture 自然 EIO。

### 3.4 蓝牙直通（b 路线）也是死的

- **驱动侧**：`marlin_fm.ko` 里 `OVER_BT_ENABLE(0x1d)` / `ANA_SWITCH(0x1e)` /
  `I2S_SETTING(0x21)` / `GET_AUDIO_INFO(0x30)` 全是空壳（进 case 只 printk 名字）。
  更硬的证据是上游同源驱动（LKML 2017 展讯 `marlin2_fm` 补丁）里这几个 case 写的就是
  `ret = 0; break;` —— **展讯压根没实现**，不是我们这版被裁掉。
- **协议栈侧**：`strings /usr/local/bin/bt_user_daemon | grep -i 'fm'` **一个 FM 相关串都没有**，
  只有 `[TX] opcode=0x%04x ...`。自研协议栈不认识 FM，没有 FM 直通入口。
- **绕过驱动的口子也不存在**：dmesg 里能看到内核自己发 `mdbg_proc->write_buf:at+loopcheck`，
  但 `/dev/mdbg*` **不存在**，那是内核内部通道，用户态够不着；
  `write(/dev/fm, "at+fm=...")` 恒 `EINVAL`。

### 3.5 顺带排除的假设

| 假设 | 排查结果 |
|------|----------|
| 缺 `audio_para` 导致 codec 初始化不全 | Android 分区里有 `/etc/audio_para`（485KB），但 codec kcontrol 全部正常注册（120 个），说明 probe 是成功的，不是参数缺失 |
| AGDSP 固件没加载 | **sipc 只暴露了 `spipe_lte0~14`（LTE modem 通道）**，没有任何音频 DSP 通道；sysfs 里只有 `saudio_lte.0` / `saudio_voip.1`（都是给 LTE/voip 的共享内存音频），**没有 AGDSP 的 saudio 通道**。固件就算有也无从加载 |
| 固件里有隐藏的 FM 音频路由 AT 命令 | wcnmodem 分区 dump 里只有 `marlin_fm_ctrl.c`、`Handle_FM_RX_CMD_ENABLE`、`fm_cfg 0x%x,%x,%x`、`marlin_fm_seek_*` 等少量串，没有 `at+fm` 命令族、没有 `over_bt` 相关串 |

---

## 4. 根因判断

```
内核侧 sipc 没有音频 DSP 通道（只有 LTE）
   → AGDSP 无从加载 / 无通信
   → codec 驱动的 set_bias_level 依赖的电源与时钟起不来
   → DAPM bias_level 永远 Off，Analog Power / DA Clk / AD Clk 全 Off
   → DAC 不出声、ADC 不采样、DMA 不搬运
   → 播放 EAGAIN、采集 EIO、FM 拿不到 PCM
```

**所以：这不是"FM 音频没接进来"，而是"这台机器在 Alpine 下整个音频子系统是死的"。**
这也解释了此前所有"路由通了但就是没声音"的观察。

## 5. 结论与剩余选项

**用户态（当前内核）**：FM 经蓝牙出声 —— **不可行**，三条子路线已全部实测封死。

要走通只剩**动内核**（原方案 a），且要动的地方比预想的多：

1. 设备树 / sipc 配置里补上 AGDSP 音频通道（当前只有 LTE 通道）；
2. 把 AGDSP 固件加载起来（需先确认固件在哪个分区，当前 `/proc/partitions` 里没有明确命名的 dsp 分区）；
3. 确认 codec 的 `set_bias_level` 具体卡在哪一步（可用 `dynamic_debug` 打开 sprd-codec 的
   `dapm` / `bias` 相关打印来定位）。

这三项都需要**内核源码**（本机 `/tmp/linux-3.10.65` 是 vanilla 树，不含厂商代码），
且重新编译内核后要能刷机。**请确认手上有没有厂商内核源码树**，没有的话这条路也走不动。

**可以立刻做的、不需要内核的退路**：FM 功能保留为 UI 可演示（调频、RDS、搜台的替代交互），
出声这块如实标注"本机音频子系统不可用"。

## 6. 现场状态（验证后留在设备上的）

- 控件目前配置在「数字 FM + Speaker 输出」状态（`Digital FM Function=1`、`AD IISMUX=2`、
  `Speaker Function=1`、`SPKL Mixer DACLSPKL=1`、`SPKR Mixer DACRSPKR=1`）
- FM daemon 已上电、TUNE 在 97.4MHz、`mute=0`
- `/root/fm_hold` 可能仍在后台占着 `hw:1,4`（最多 170s 后自行退出）。
  要再跑一次 `fm_cap_scan` / `fm_play_probe`，先 `kill` 掉它，否则会 `Resource busy`
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
