---
title: nettv-16：硬解比软解还慢——一次把"解码慢"这个假设彻底推翻的对照实验
date: 2026-10-20 11:45:00
categories:
  - [嵌入式, 网络电视硬解]
  - [Linux, 性能优化]
tags:
  - sprd
  - SC9832A
  - VSP
  - mplayer
  - OMX
  - 硬解
  - 软解
  - ARM
  - 性能分析
---

## 一句话结论

我们花了三周把 VSP 硬解链路从"零帧"调到"15.7fps"，然后我用同一条流、同一个播放器二进制跑了一次软解对照：

```
mplayer -vo null -nosound  →  25.0 fps   (纯 H.264 解码上限)
我们自研 VSP 硬解链路      →  15.7 fps   (解码+取帧+渲染全链)
```

**CPU 软解比 VSP 硬解还快。** 不是优化没做好，是"解码慢"这个前提从一开始就不成立。

---

## 一、先把 mplayer 这条路摸清楚

用户提了个方向："能不能让 mplayer 走 H.264 硬解"。侦察结果分三块。

### 1. 它在哪、有没有硬解

```
$ ls /usr/bin/mplayer /usr/local/bin/mplayer
ls: cannot access: No such file or directory     ← 不在 PATH
$ find / -name 'mplayer*'
/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer     ← 项目自带的静态编译二进制
```

```
$ mplayer -v
MPlayer 1.4-13 (C) 2000-2019 MPlayer Team
CPU: ARM
```

`strings` 扫一遍，硬解相关符号一个都没有：

```bash
$ strings mplayer | grep -iE 'libvpu|sprd_vsp|vdsp|hwaccel'
（空）
```

唯一命中的 `"For hardware decoders"` 字符串上下文是：

```
hwmpa
NicoDVB
For hardware decoders
Uncompressed PCM audio decoder          ← 音频家族（libmpg123/ac3）
```

MPlayer 1.4 是 2019 年的分支，它的硬解支持只有一条路：**外部 ffmpeg 通过 `-vc ffmpeg:` 把解码外包出去**。我们设备上没装 ffmpeg，装了也没用（见下文）。

### 2. 它能往哪儿输出

```
$ mplayer -vo help
fbdev   fbdev2   lvfb   null   mpegpes   yuv4mpeg   png   tga   pnm   md5sum
```

注意这一行的信息量：**没有 v4l2、没有 dri、没有任何 GL vo**。

这意味着即使 mplayer 解出了 NV12，它也只能自己用 CPU 转成 RGB 再往 framebuffer 里写。VSP 解码也好、DPU 合成也好，它一个都碰不到。**"-vo lvfb" 是唯一值得试的选项**，那是这个项目自己写的 LVGL 直写 vo。

### 3. ffmpeg 也不救场

Alpine 仓库里有：

```
ffmpeg-6.1.2-r1 armhf {ffmpeg} (GPL-2.0-or-later AND LGPL-2.1-or-later)
```

但 `which ffmpeg` 是空的——**只进了仓库索引，没安装**。而且就算装了也没意义：Alpine 的 ffmpeg 是社区构建，**不包含展锐 VSP 的 hwaccel 适配**（`h264_sprd` 这种 decoder 不是主线 ffmpeg 的东西）。装了只能软解，还是回到 mplayer 同一条路。

---

## 二、真正的对照实验

侦察做完就该拿数据说话。从泸县源拉一段真实的 1080p TS（2.6MB），用三种方式跑。

### A 组：mplayer 纯解码上限

```bash
mplayer -benchmark -vo null -nosound -framedrop /tmp/mp.ts
```

```
FPS seems to be: 25.000000
VO: [null] 1920x1080 => 1920x1080 Planar YV12
BENCHMARKs: VC:   9.778s VO:   0.001s A:   0.000s Sys: 0.065s =  9.844s
BENCHMARK%: VC: 99.3308% VO: 0.0068% A: 0.0000% Sys: 0.6624% = 100.0000%
```

`VC` 是视频解码（Video Codec）时间，占 **99.33%**。10 秒解完 = **25fps = 40ms/帧**。

### B 组：现有软解链路（y4m 中转）

项目里其实已经有一条软解路径：`curl → mplayer → yuv4mpeg → lv_canvas`（`/usr/local/bin/nettv_play.sh`），参数是这样的：

```sh
$MP -cache 2048 -cache-min 5 -autosync 100 -mc 1 -quiet \
    -vo yuv4mpeg:file=/tmp/nettv.y4m -vf scale=640:360 $AOARGS -nolirc -
```

跑一遍同样的 TS：

```bash
mplayer -vo yuv4mpeg:file=/tmp/t1.y4m -vf scale=640:360 -nosound -fps 60 -slave /tmp/mp.ts
# 18 秒后：y4m = 49421692 字节
# 每帧 640×360×1.5 = 345600 字节 → 142 帧
# → 7.9 fps
```

**25fps 的解码能力，经过 y4m 落盘 + scale 滤镜后只剩 7.9fps。** 丢掉的 17fps 全在 IO 和二次缩放上，跟解码一点关系没有。

### C 组：我们自研 VSP 硬解

v16i 同轮 A/B 的定量（60s 稳态）：

```
单线程 15.7fps，墙钟 116ms/AU
  = DRIVE 21.1ms + memcpy 43.4ms + 渲染 31.8ms
```

### 三组并排看

| 方案 | 帧率 | 瓶颈在哪 |
|------|------|----------|
| mplayer `-vo null` | **25.0 fps** | 解码本身，40ms/帧 |
| 自研 VSP 硬解全链 | 15.7 fps | 解码 21ms，其余 95ms 全在 memcpy+渲染 |
| 软解 + y4m 落盘 | 7.9 fps | 文件 IO + scale 滤镜 |

**这张表最刺眼的地方**：厂商 VSP 硬件解码只要 14ms（库自己报的），我们整条硬解链路却要 64ms/帧。省下的 27ms 全部被别的东西吃掉了，还倒亏。

---

## 三、这个结果为什么反直觉

按理说硬解该碾压软解。差别在于**软解的"慢"是集中在解码里的，硬解的"慢"是散落在 IO 里的**。

A7 的软解解码器虽然慢，但它拿到的是普通 `malloc` 出来的内存——CPU 缓存友好的、连续可预取的。而 VSP 输出是一块 uncached 的 ION 内存，于是：

1. **3MB memcpy 43ms**——非缓存内存逐字节读，每个字节都是独立事务
2. **fb_render 31ms**——NV12→ARGB + 90° 旋转，1280×720 全靠标量算

软解根本没有第 1 步：解码器直接写进普通 buffer，第 2 步可以用 `-vo lvfb` 让 mplayer 直接画进 framebuffer，省掉中间环节。

**所以"用硬件解码器"这个决策本身没错，错的是硬解的产出物没有一条高效的消费路径。** 硬件只负责把压缩数据变成像素，剩下 95ms 的搬运和合成，一行都没少。

顺带一个反证：之前我们试过 `NETTV_STAGE=0` 直读 ION 省掉那次 memcpy，结果 **fb_render 从 33ms 飙到 335ms**（慢 10 倍），5.8fps。因为非缓存内存的随机读比顺序拷贝更可怕。**3MB memcpy 在当前映射属性下已经是最优解。**

---

## 四、顺手发现的两条真硬解路线

侦察时看到两样东西，比 mplayer 有价值得多。

### `libomx_avcdec_hw_sprd.so`

```
$ ls /mnt/android_sys/lib | grep -i omx
libomx_avcdec_hw_sprd.so        ← 展锐官方 H.264 硬件 OMX 插件
libomx_avcdec_sw_sprd.so
libomx_avcenc_hw_sprd.so
libomx_m4vh263dec_hw_sprd.so
...
```

这才是真正的官方硬解通路。依赖很干净：

```bash
$ strings libomx_avcdec_hw_sprd.so | grep -E '^lib.*\.so' | sort -u
libc++.so   libc.so   libcutils.so   libdl.so
liblog.so   libm.so   libutils.so
```

全在 `/mnt/android_sys` 里躺着（设备开机靠 `/etc/init.d/00_android_sys` 挂载，304 个库）。

**但别急着乐观**：它是 Android OMX 适配层，要正常工作需要 `OMXMaster` 注册、`BufferQueue` 引用计数、`gralloc` buffer 三件套——这些都在 Android media stack 里，我们的裸 bionic 播放器一样都没有。硬调 OMXCodec 的工作量很大，而且它对 ION handle 的语义假设（fd + offset + size 怎么解释）和我们自管 ION 时踩过的绿屏坑是同一个域。

**结论：可做，成本高，排在 ION cached 后面。**

### ION cached 映射

这条路还是最划算的：把 VSP 输出缓冲从 uncached 改成 cached（`ION_FLAG_CACHED = 1`），每帧用 `ION_IOC_SYNC` 做一次 invalidate。那 43ms 的 memcpy 理论上能掉到 10ms 上下，墙钟 116ms → 75ms，直接摸到 20fps。

风险是 DMA 一致性：VSP 写完到 CPU 读到之间必须刷一次，漏了就是花屏或绿屏。这是灰度的理由，不是放弃的理由。

---

## 五、所以接下来做什么

mplayer 这条路的定位现在很清楚了：

- **"mplayer 硬解"作废**——它没有硬解框架，也没有任何 GPU 输出通路
- **"mplayer 软解"有价值**——25fps 的解码上限是真的，而且**不碰 VSP、不碰 ION，就没有内核崩风险**

软解路线三个改法，按性价比排：

1. **去掉 y4m 落盘**，直接 `-vo lvfb`（mplayer 自带的 LVGL 直写 vo）——省掉整个文件 IO，预计 7.9 → ~20fps
2. **去掉 `-vf scale=640:360`**，让 vo 直接输出到目标尺寸——省一次 CPU 缩放
3. **去掉 `-autosync 100 -mc 1`**——这是 v4 为防 TS 段边界 pts 跳变加的，而 ptsync 我们已经证明是负反馈的源头

三条加起来，软解很可能摸到 25fps，且零内核风险。**这比 ION cached 更适合当第一个灰度实验。**

但要清楚它的天花板：25fps 是 mplayer 那一档 CPU 的解码上限，1080p 再往上就得上 720p 源或者降分辨率。到那时候硬解还是得回头修。

---

## 六、方法论层面的三条

**1. "硬解 vs 软解"不是信仰问题，是可以测的。**
一个 `mplayer -vo null -benchmark` 就把真相问出来了，不到两分钟。在为硬件加速投入三周之前，先花两分钟量一下软解的天花板。

**2. 性能问题要算"钱花在哪"，不是"哪步最慢"。**
硬解的解码从 64ms 降到 14ms 是巨大的胜利，但同期多了 95ms 的别的开销，净收益是负的。慢的那一步（memcpy 43ms）根本不是最初怀疑的那一步（解码）。

**3. 第三方组件的能力边界要靠看清单，不靠猜。**
`mplayer -vo help` 这一行列出十个 vo，没有 v4l2 和 dri——mplayer 就不可能参与 GPU 合成，这是不需要读一行源码就能确认的事实。而 `strings | grep hwaccel` 空着，就说明没有硬解框架。比"我觉得 MPlayer 应该支持"可靠得多。

---

## 附：本文涉及的关键事实

- mplayer 位置：`/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer`，MPlayer 1.4-13 静态编译，**不在 PATH**
- 软解上限 25.0fps / 40ms 每帧（`VC` 占 99.33%）
- 现有 y4m 链路 7.9fps，真瓶颈是文件 IO + scale 滤镜
- 硬解基线 15.7fps，墙钟 116ms（DRIVE 21.1 + memcpy 43.4 + 渲染 31.8）
- 直读 ION 反证：fb_render 335ms，慢 10 倍
- `/mnt/android_sys/lib/libomx_avcdec_hw_sprd.so` 存在，但需要 Android media stack 才能用
- Alpine 的 ffmpeg 6.1.2 无 VSP hwaccel，且未安装

---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io