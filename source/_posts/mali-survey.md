---
title: "Mali400与硬件加速_勘察结论"
date: 2026-09-23 11:06:07
lang: zh-CN
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# Mali-400 GPU 与硬件加速：勘察结论

> 日期：2026-09-23　设备：展讯 SC9832A（Alpine / 内核 3.10.65 原厂安卓内核 / 720x1280 fb）
> 问题：MPlayer 播放卡；Mali-400 有没有用上；能不能用到显示/视频/UI 上。
> 性质：只读勘察，**未执行任何播放验证**（按约定验证由用户上机做）。

---

## 0. 先纠正两个概念

1. **Mali-400 是 3D 渲染 GPU，不是显示控制器。**
   显示由 `20800000.fb`（sprdfb / dispc）硬件扫描输出，`/dev/fb0` 就是最终输出口。
   GPU **不能"接管显示"**——它只能把图画进内存 buffer，再由 dispc 显示（Android 靠
   SurfaceFlinger + hwcomposer 的 overlay 图层完成这一步，本机没有这套东西）。
2. **Marlin 不负责视频。** Marlin2 是 WiFi / BT / FM / GNSS 的 combo 芯片。
   视频硬解在 AP 侧，叫 **VSP**（`/dev/sprd_vsp`，配 `sprd_coda7l`）。

---

## 1. 硬件与驱动现状（实测）

| 部件 | 存在的证据 | 当前状态 |
|---|---|---|
| Mali-400 GPU | 设备树 `60000000.gpu`；`/lib/modules/mali.ko`（4.6 MB） | ❌ **完全没用**：平台设备**无 driver 绑定**，模块未加载，**`/dev/mali` 不存在** |
| 显示控制器 | `20800000.fb` → `/dev/fb0`，720x1280 32bpp，`accel false` | ✅ 在用（fbdev 软件写入） |
| VSP 视频编解码 | `/dev/sprd_vsp`、`/dev/sprd_coda7l`（misc 已注册 = probe 成功） | ⚠️ 驱动在，**没有任何程序用** |
| JPG 硬编解码 | `/dev/sprd_jpg` | ⚠️ 同上 |
| GSP 2D 加速 | `/dev/sprd_gsp` + `/dev/sprd_iommu_gsp` | ⚠️ 同上（blit/缩放/旋转/YUV→RGB） |
| ION 内存分配器 | `/dev/ion` + 3 个 ion-heap 平台设备 | ✅ 可用（GPU/VSP/GSP 都依赖它） |

补充：`nproc = 2`（**只有 2 核在线**，非 4 核），最高 1.3 GHz，内存 916 MB。
mplayer 二进制在 `/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer`（13.7 MB，不在 PATH 里）。

---

## 2. Mali-400 能不能用起来：不能

要用 GPU 必须三层齐全：**内核驱动 → 用户态 EGL/GLES 库 → 应用**。逐层看：

### 2.1 内核层：能点亮（但不是瓶颈）

```
mali.ko vermagic = 3.10.65 SMP preempt mod_unload modversions ARMv7
```

与当前内核**完全一致**（本机跑的本就是原厂安卓内核）。
所以 `insmod /lib/modules/mali.ko` 大概率成功，`60000000.gpu` 会绑定驱动、`/dev/mali` 会出现。
**这一步能做到，但没用**——见下一条。

### 2.2 用户态层：死结（bionic vs musl）

整机唯一存在的 Mali 用户态 DDK 是安卓分区里的
`/mnt/android_sys/lib/egl/libGLES_mali.so`（1.2 MB，内含 "Mali online shader compiler r6p0-01rel0"）。
它依赖的库：

```
libc.so(→ bionic)  libc++.so  libbinder.so  libcutils.so  libhardware.so
libion.so  liblog.so  libui.so  libutils.so  libboost.so  libapplist.so
```

→ 是 **bionic 二进制，musl 加载不了**。
要救只能：搭 glibc chroot，再手搓 bionic 桩，还要实现 `libbinder`（Android IPC）——不现实。

### 2.3 开源 mesa-lima 路线：也不通

Alpine 装了 mesa（`libEGL.so` / `libGLESv2.so` / `libgbm.so` 都在），但：

- `/usr/lib/dri/` 只有 `nouveau/r600/radeonsi/virtio_gpu_drv_video.so` —— 这 4 个是
  **VA-API 视频驱动**，**没有 `lima_dri.so`**（Mali-400/450 的开源 3D 驱动）；
- **`/dev/dri` 与 `/sys/class/drm` 都不存在** —— lima 是 DRM 驱动，需要内核 4.20+，
  本机是 3.10.65。移植等于把整个 DRM 子系统搬进 3.10，不现实。

**结论：Mali-400 在这台机器上用不起来。** 内核侧能点亮，但没有任何可用的用户态 GL 栈。

---

## 3. 就算 GPU 能用，也不是卡的原因

- **视频卡顿的真因是 CPU 软解码**。2 核 1.3 GHz 软解 H.264（尤其 720p / high profile / B 帧）
  必然吃不住，**GPU 不做视频解码**。
- **UI（LVGL）用 GPU 大概率更慢**：LVGL 现在 fbdev 直写、只刷脏矩形（面积小），
  是最短路径。改走 GLES 后要把结果 `glReadPixels` 回读再写 fb —— Mali-400 的回读极慢，
  属于典型的"加速反而变慢"。

---

## 4. 真正该用的两个硬件（都在，且已 probe）

### 4.1 VSP —— 视频硬解（解决"卡"的正解）

安卓分区里有硬件编解码 OMX 组件：

```
libomx_avcdec_hw_sprd.so        H.264 硬解
libomx_m4vh263dec_hw_sprd.so    MPEG4 / H.263 硬解
libomx_vpxdec_hw_sprd.so        VP8/VP9 硬解
libomx_avcenc_hw_sprd.so        H.264 硬编
libomxvpu.so                    VPU 封装层
```

证明 **硬件解码能力确实存在**，内核节点 `/dev/sprd_vsp`、`/dev/sprd_coda7l` 也都就位。
但这些 OMX 库同样是 bionic，不能直接用。

**唯一出路**：自己写用户态驱动，直接 ioctl `/dev/sprd_vsp`（展讯私有 ioctl，需要逆向；
工作量与之前逆向 FM ioctl 同一量级），再喂给 mplayer/自建播放器。

### 4.2 GSP —— 2D 加速（这才是"用到显示上"的正解）

`/dev/sprd_gsp` + `/dev/sprd_iommu_gsp`，配合 `/dev/ion` 分配 buffer，能硬件做：

- **YUV → RGB 色彩转换**
- **任意比例缩放**
- 旋转、alpha 混合、blit

对 mplayer 的价值：省掉软件缩放 + 色彩转换（`-vf scale` / swscale），
这部分在软解播放里通常占 **30~50% CPU**，是仅次于解码的第二大头。
对 LVGL：可做整屏合成，但 LVGL 本身软件渲染，收益有限。

---

## 5. 不动内核、不逆向，立刻能做的（推荐先做这几步）

1. **量化瓶颈**（决定后面走哪条路）：
   ```sh
   cd /home/lvgl_demo/lvgl_demo/libs
   ./mplayer/mplayer -benchmark -vo null -nosound 你的视频.mp4
   ```
   - 若纯解码就能 ≥25 fps → 瓶颈在**缩放/写 fb**：
     把视频**预先转码成 720x1280 固定分辨率**再播（省掉运行时缩放，收益最大）；
     或降 `-vf scale` 的复杂度（`-sws 0` 最快）。
   - 若纯解码也只有 ~10 fps → 瓶颈是**解码**：降规格或走 VSP 硬解。
2. **预转码为基线规格**（最省事、收益明确）：
   H.264 **baseline**、无 B 帧、720x1280（或 480x854）、≤1 Mbps、24~25 fps。
   baseline 无 CABAC/无 B 帧，软解开销能降一大截。
3. **播放参数减负**：`-framedrop -nosound -noautoquality -vo fbdev`；
   音频解码在 2 核机器上也是实打实的 CPU 开销。

---

## 6. 后续可选路线（按性价比排序）

| # | 路线 | 收益 | 代价 |
|---|---|---|---|
| d | 预转码 + benchmark 定位瓶颈 | 中（很可能直接解决卡顿） | 几乎为零 |
| b | 逆向 `/dev/sprd_gsp` 做硬件缩放/色彩转换 | 中高（视频播放明显轻松） | 中（ioctl 逆向 + ION 分配） |
| a | 逆向 `/dev/sprd_vsp` 做硬解 | 高（根本解决解码瓶颈） | 大（类比 FM ioctl 逆向） |
| c | `insmod mali.ko` 点亮内核层 | **几乎为零**（无用户态 GL 栈可用） | 小，但**不建议做** |
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
