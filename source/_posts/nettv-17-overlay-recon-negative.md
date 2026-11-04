---
title: nettv-17：overlay recon 判负——当"唯一出路"被证伪时，我们剩下什么
date: 2026-10-20 13:10:00
categories:
  - [嵌入式, 网络电视硬解]
  - [Linux, 性能优化]
tags:
  - sprd
  - SC9832A
  - fbdev
  - overlay
  - DPU
  - Mali
  - recon
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative-en/)


## 背景：一句话交代

昨天我们把帧率瓶颈精确定位到 **「YUV→RGB→framebuffer」这一步**（三条完全不同的链路撞同一堵墙），所以我把「显示控制器硬件 overlay 直吃 NV12」列为唯一出路。

豆包的方案里也是这么说的：

> 弃用 Mali 做 YUV 转换，改用显示控制器硬件旋转 + YUV 转换。SC9832A 的显示模块本身支持 YUV 输入和画面旋转。把 NV12 帧直接送显示层，Mali 只用来叠加 UI 字幕。

听起来很对。硬件在，芯片支持，理论上能省掉全部 CPU 像素路径。**这轮就是去验证它到底能不能做。**

结论先给：**硬件确实在，但用户态接口一个都没有。这条路被封死了。**

---

## 侦察手法：kallsyms 优先

没有源码、没有驱动二进制、没 root 调试器。这种情况下第一反应通常是去 `dmesg` 里刨，或者找 `.ko` 文件 `strings`。**这两条都是错的。**

`dmesg` 里能找到的只有：

```
c0 ###---- BIT_DISPC_EB still set ----###
c0 sprdfb: [sprdfb_dispc_check_esd] (4590, 0, 0)
```

`BIT_DISPC_EB` 是个诱人的线索，但只有这一个 bit 说明不了任何事。

**正确的入口是 `/proc/kallsyms`。** 内核符号表直接告诉你驱动实现了什么：

```
$ grep sprdfb /proc/kallsyms | awk '{print $3}'
sprdfb_pan_display
sprdfb_ioctl                    ← 用户态唯一的入口
sprdfb_check_var
sprdfb_probe
sprdfb_panel_change_fps
sprdfb_dispc_enable_overlay      ★
sprdfb_dispc_display_overlay     ★
sprdfb_dispc_logo_proc
sprdfb_dispc_ctrl
sprdfb_dispc_refresh
...
```

**DPU overlay 硬件确实存在**，`sprdfb_dispc_display_overlay` 和 `sprdfb_dispc_enable_overlay` 两个函数明明白白在内核里。

到这里是个好消息。但接下来的问题才是关键：**这两个函数，用户态能不能调？**

---

## 死路一：反汇编这条路被堵死了

想把 `sprdfb_ioctl` 反汇编出来，看它的 ioctl 分派表里有没有 overlay 命令。需要拿到内核代码。有三条路：

| 手段 | 结果 |
|---|---|
| `find / -name "sprdfb*.ko"` | **空** —— 驱动是**内建**进内核的，没有模块文件 |
| `dd if=/proc/kcore` | **0 字节** —— 内核没开 `CONFIG_KCORE` 读权限 |
| `dd if=/dev/mem` | **No such file** —— 设备根本没创这个节点 |

三条全断。

顺带说一个中途的弯路：我原本写了个「盲发 ioctl 扫描」的程序——对 `/dev/fb0` 遍历 `'S'/'D'/'F'/'s'` 四个 magic × 96 个 nr × 三种编码，约 700 个自定义 ioctl 全试一遍，看哪个不是 EINVAL。

**写完我立刻把这个念头掐了。** 显示驱动的 ioctl 分支通常会直接解引用用户指针，而我对它传的是全零的假结构体。这和之前踩过的「FBIOPAN 用假短结构体导致内核崩」是同一类错误——**用一个可能触发内核崩的手段去探测，代价太大，而且失败了就什么都没学到。**

后来换成只读方式（`GET_VSCREENINFO` / `GET_FSCREENINFO` / `PUT` 被拒就看 errno），风险为零，信息还更准。这才是对的做法。

---

## 关键证据：fbdev 能力探测

既然只能从 fbdev 接口反推，就老老实实测。设备上有 gcc，直接编译一个探测程序（顺便说一句，这个内核的 `fb.h` 是老版本，`FB_ROTATE_90` 和 `FB_ACTIVATE_ROTATE` 宏都不存在，得用字面值；`fb_fix_screeninfo` 里也没有 `flags` 字段，只有 `capabilities`——这种细节只有真去编译才会撞到）：

```c
ioctl(fd, FBIOGET_VSCREENINFO, &v);
ioctl(fd, FBIOGET_FSCREENINFO, &f);
/* 试硬件旋转 */
r.activate = FB_ACTIVATE_NOW | 0x100;  r.rotate = 1;
ioctl(fd, FBIOPUT_VSCREENINFO, &r);
/* 试各种像素格式 */
```

结果：

```
[VAR] 720x1280 virt 720x3840 bpp=32
[VAR] rotate=0 colorspace=0 nonstd=0
[VAR] rgb: 0/8 8/8 16/8 transp=0/0
[FIX] id="sprdfb" smem_start=0x9ed74000 smem_len=11059200 line_len=2880
[FIX] type=0 visual=2 accel=0x0 capabilities=0x0
[FIX] mmio_start=0x0 mmio_len=0
[FIX] panstep x=0 y=1 ywrap=0

ROTATE_90 : 拒绝 (errno=22)
bpp=16 : 接受    bpp=32 : 接受    bpp=24 : 接受
bpp=12 : 接受    bpp=15 : 接受
```

逐条读：

| 行 | 含义 |
|---|---|
| `ROTATE_90 : 拒绝 (errno=22)` | **fbdev 层没有硬件旋转**。EINVAL 是驱动明确说「这个参数组合我不支持」 |
| `capabilities=0x0` | 驱动**一个能力位都没声明**（没有 MMIO、没有硬件加速、没有 overlay） |
| `mmio_start=0x0 mmio_len=0` | **致命**——用户态拿不到 DPU 寄存器基地址，等于没有「自己配 overlay」的可能 |
| `accel=0x0` | 同上，无硬件加速标识 |
| `bpp=12 : 接受` | 这行是个**陷阱**。驱动根本不校验像素格式，任何 bpp 都点头。**不能拿它当「NV12 可用」的证据** |
| `virt 720x3840` | 3840 = 1280 × 3，**三缓冲**——我们一直用的 FBIOPAN 双/三缓冲就是它 |
| `smem_len=11.06MB line_len=2880` | 2880 = 720 × 4 字节，ARGB8888，和我们的认知完全一致 |

**`mmio_start = 0` 这一条基本宣判了。** 即使 overlay 硬件在，没有寄存器访问权，用户态连一个 bit 都改不了。

---

## 为什么安卓能做到，我们做不到

安卓的 NV12 直送显示层，是这么实现的：

```
MediaCodec → 输出到 gralloc buffer (NV12)
  → BufferQueue 交接 GraphicBuffer(fd)
    → SurfaceFlinger 收到，交给 HWC
      → libhwcomposer 决定用哪个 display layer
        → DPU 在硬件里做 NV12→RGB + 缩放 + 合成
```

这里面每一环都是**用户态代码**：SurfaceFlinger、libhwcomposer、gralloc。我们一样都没有。

我去安卓镜像里确认过：

```
$ ls /mnt/android_sys/lib | grep -iE "hwc|composer|display|overlay"
（空）
```

这个镜像只带了媒体相关的东西（`libomx_avcdec_hw_sprd.so`、`libmedia*.so` 等 304 个库），**完全不含显示合成栈**。它当初的设计用途就是「给 LVGL 提供 musl libc 和 bionic 库」，不是跑完整 Android。

所以豆包方案的第 1、2、4 条在这台设备上的问题是同一个：**它假设了一套我们没有的用户态基础设施**。第 1 条说「VSP 输出 dma-buf 共享给 Mali」，可我们播放器现在根本没有 GL 上下文；第 4 条说「别用 glReadPixels 直接绑 fb0」，可我们从来没用过它——那是 PSP 那条线的历史问题。

---

## 定量封顶：CPU 路线的天花板

三条**完全独立**的链路，实测撞的是同一堵墙：

| 链路 | 端到端 fps | 撞在哪 |
|---|---|---|
| 自研 VSP 硬解 | 15.7 | uncached ION memcpy 43.4ms + fb_render 31.8ms |
| ffmpeg 4 线程 + rgba | 10.2 | YUV→RGB ≈ 25ms + 旋转缩放 ≈ 45ms |
| mplayer y4m 链路 | 7.9 | y4m 落盘 + scale 滤镜 |

**解码侧已经榨干了**——ffmpeg 多线程 `-threads 4 -f null` 能跑 **34.9fps**（4.3 秒解完 150 帧，比单线程的 10.7 秒快 2.5 倍），这是全项目最高的解码吞吐。但一加上 `-vf scale,transpose -pix_fmt rgba`，立刻掉到 10.2fps。

**多线程挣来的 2.5 倍，全部被 CPU 像素转换吃光。**

这就是结论：**只要画面必须经过 CPU 像素路径，不管软解硬解、不管几线程，天花板就是 13-16fps。** 这不是「优化得不够」，是物理上的路径决定。

---

## 还剩什么：Mali

overlay 封了之后，唯一的 GPU 路径是 **Mali**：

- `/dev/mali0` 设备节点在
- `insmod mali.ko` 可用（已验证）
- 项目里 `lv_hardware/gpu_env.c` 的 `gpu_env_ensure()` **已经实现**（未提交）
- 已知坑：pbuffer 的 `glReadPixels` 在 TBDR 架构上不可靠，必须**直渲 window surface**

做法是用 GLES shader 完成 NV12→RGB + 旋转，然后直接画进 window surface。这样画面就不再经过 CPU 的 YUV→RGB 标量计算，理论上能把那 45-70ms 的开销转移给 GPU。

**但我要诚实说明：这条路也不是保证成功的。** 显存要装得下 1080p NV12（3.1MB），Mali 在这块板子上的实际带宽和 shader 吞吐都还是未知数，shader 编译/驱动的坑也没趟过。它值得试，但它现在的状态是「唯一可选」，不是「确定可行」。

**另一个诚实的选项是调整验收标准。** 如果 GPU 这条路也走不通，就把帧率目标定在 15-20fps，然后做 ION cached 映射（memcpy 43→10ms）把硬解稳定推到 20fps 左右，剩下那 20ms 的 fb_render 靠 loop 展开和 8 像素预取榨一榨。**这是一个能交付的、不用赌的方案。**

---

## 方法论：这次侦察学到的三件事

**1. 「硬件在」不等于「你能用」。**
kallsyms 里有 `sprdfb_dispc_display_overlay`，硬件是有的。但 `mmio_start=0`、没有 ioctl、`capabilities=0x0`——用户态用不了。**判断一个能力可用，必须验证到「用户态能触达的接口」这一层**，符号表只能证明第一层。

**2. 「驱动点头」是最不可信的证据。**
`bpp=12 : 接受` 看起来像「NV12 支持」。但驱动连自己的格式都不校验，说明它压根没在管格式这件事。**一个不校验的接口，它的任何「同意」都不构成证据。** 相比之下 `ROTATE_90 : 拒绝 (errno=22)` 是硬证据——驱动明确表态了。

**3. 别用可能崩的手段去探测。**
盲发 700 个 ioctl 的计划看起来很巧妙，但它可能让内核崩，还换不来多少信息。只读 ioctl（GET_*）加「试探 + 看 errno」是风险为零的等价方案。**探测的价值不取决于你有多大胆，取决于你有多精确。**

---

## 附：本文涉及的事实

- 内核符号：`sprdfb_dispc_display_overlay`@0xc024adcc、`sprdfb_dispc_enable_overlay`@0xc0249db4、`sprdfb_dispc_ctrl`@0xc088c1cc
- 驱动为内建（无 `sprdfb.ko`），`/proc/kcore` 与 `/dev/mem` 均不可读
- fbdev：`rotate=90` 被拒（EINVAL）、`capabilities=0x0`、`mmio_start=0`、`accel=0x0`
- fbdev 实参：720×1280、virt 720×3840（三缓冲）、bpp32 ARGB8888、`smem_len=11.06MB`、`line_len=2880`
- `/mnt/android_sys/lib` 无 hwcomposer/libcomposer，该镜像只含媒体库
- 三链路端到端：硬解 15.7fps / ffmpeg 4线程+rgba 10.2fps / mplayer y4m 7.9fps
- ffmpeg `-threads 4` 纯解码 34.9fps（解码侧上限）

---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io