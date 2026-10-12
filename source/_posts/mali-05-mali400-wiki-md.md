---
title: "Mali400原理与移植学习Wiki"
date: 2026-09-30 16:44:04
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# HT0 Mali-400 原理与移植学习 Wiki

> 这份文档不是操作手册，而是**原理课**：讲清楚这颗 Mali-400 为什么能在这台"安卓内核 + Alpine 用户态"的机器上跑起来、安卓原来怎么做、我们为什么改成现在这样、每一行关键代码在干什么。
> 读完你应该能：面对一台"安卓内核 + 别的用户态"的 Mali 设备，自己分析出该怎么把 GPU 点亮。

---

## 0. 一句话先建立直觉

> Mali-400 不是显示控制器，而是一颗**需要内核驱动 + 用户态 GL 栈 + 正确 ABI 桥**才能点亮的 3D 渲染 GPU。
> 安卓用一整套 bionic 服务（SurfaceFlinger + hwcomposer + libGLES_mali）替你把这套栈搭好了；
> 我们把这套栈**用最小的交叉编译桥**重写了一遍，跑在 Alpine 的 musl 用户态上。

---

## 1. 硬件长什么样

这颗芯片平台是展讯 SC9832A，GPU 是 **Mali-400 MP**（ARM 的 Utgard 架构，OpenGL ES 2.0，TBDR 瓦片渲染）：

```
                ┌──────────────────────────────┐
                │       展讯 SC9832A AP        │
                │  ┌──────────┐   ┌───────────┐ │
                │  │ sprdfb    │   │ Mali-400  │ │
                │  │ (dispc)  │   │ (GPU)     │ │
                │  │ /dev/fb0 │   │ /dev/mali0│ │
                │  └────┬─────┘   └────┬──────┘ │
                └───────┼──────────────┼────────┘
                    扫描输出        渲染目标(buffer)
                    显示器          GPU 画进内存再由 dispc 显示
```

两条"输出"路径，分工完全不同：

| 部件 | 干什么 | 用户态看到 |
|---|---|---|
| sprdfb / dispc | 把内存里的像素扫到屏幕 | `/dev/fb0`（最终输出口） |
| Mali-400 | 把 3D/2D 图形算进内存 buffer | `/dev/mali0` + EGL/GLES |
| VSP | 视频硬解（H.264 等） | `/dev/sprd_vsp` |
| GSP | 2D 加速（缩放/YUV→RGB） | `/dev/sprd_gsp` + ION |

**关键认知**：GPU **不能接管显示**——它只把图画进 buffer，再由 dispc 显示。安卓靠 SurfaceFlinger 的 overlay 图层完成这最后一步，本机没有这套东西，所以我们的程序要自己"GPU 画 → 回读 → 写 fb"。

---

## 2. GPU 能用的三层模型（最重要的分析框架）

任何 Mali 能用，都要三层全通。**每一层都有明确的"验通标准"**，不通就停在那层查，别跨层瞎试。

```
① 内核驱动层   mali.ko 加载了吗？/dev/mali0 出现吗？
               验通：insmod rc=0；ls /dev/mali0 有设备节点
② 用户态层     有可用的 EGL/GLES 库吗？ABI 对得上吗？
               验通：eglInitialize 成功；GL_RENDERER=Mali-400 MP
③ 应用层       程序怎么调？像素怎么取？怎么上屏？
               验通：gpu_bench 出分；PSP 前端出画面
```

我们这次几乎每踩一个坑，都是"误以为在上层，其实卡在下层"：

- RENDERER 不是 Mali → 不是程序错，是 mali.ko 没 insmod（第①层）；
- bionic 程序崩 before main → 不是逻辑错，是缺 `-Wl,--entry=main`（第②层编译）；
- 屏幕发黑 → 不是画错，是 pbuffer 回读在 TBDR 下拿不到帧（第③层显示）。

---

## 3. 关键概念逐个讲透

### 3.1 bionic vs musl —— 为什么需要 ABI 桥

本机用户态是 Alpine 的 **musl libc**；而 Mali 唯一的 DDK `libGLES_mali.so` 是安卓 **bionic libc** 二进制。两者 ABI 不兼容（符号名、结构体布局、time_t 宽度都不同），musl 直接 `dlopen` 会崩。

**我们的桥**：

- 内核读 ELF 的 INTERP 自动加载 `/system/bin/linker`（bionic 动态链接器），让 bionic 程序自己跑；
- musl gcc 编译但**不链 musl libc**，改用 `-nostdlib -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib -lGLESv2 -lEGL -lc` 去链 bionic 的 libc；
- 少量 musl 特有符号（time64、errno、tls、getentropy 等）用 `bionic_shim.cpp` 补桩。

### 3.2 EGL pbuffer + GLES2 context —— GPU 画在哪

```c
// 创建离屏 pbuffer surface（不在屏幕上，画进内存）
EGLSurface surf = eglCreatePbufferSurface(dpy, cfg, NULL);  // cfg 含 EGL_DEPTH_SIZE,16
eglMakeCurrent(dpy, surf, surf, ctx);
// 之后所有 gl* 都渲染到这个 pbuffer 的默认 framebuffer
```

PSP 前端与 gpu_bench 都用这套：GPU 把图渲染进 pbuffer，再 `glReadPixels` 取回 CPU，最后缩放旋转写 `/dev/fb0`。

### 3.3 glReadPixels 回读与 TBDR 惰性解析（最坑的一点）

Mali-400 是 **TBDR（Tile-Based Deferred Renderer）**：它把屏幕切成瓦片，延迟到 `glFinish`/swap 才真正把瓦片解析（resolve）进内存。

- 在 pbuffer 上，**回读时机不对就拿不到这一帧**——表现为 clear/普通四边形回读全黑或陈旧红，只有带深度的大网格（驱动被迫提前解析）偶发正确。
- 已验证 FBO / 去 glFinish / eglSwapBuffers / 开深度 四种办法均无效，根因在驱动层 TBDR + pbuffer 回读路径，应用层绕不开。
- 对策：评分计时只量 `render+glFinish`（不含回读），不受污染；要真出画面得改"直渲 fb 的 window surface"（不走回读）。

### 3.4 字节序 R/B 交换

`glReadPixels` 回读的是 **fb 真实字节序**，与驱动内部可能相反——依 PSP 前端实测：`g_swap_rb = 0`（**不交换** R/B）。回读后直接按 `[R,G,B,X]` 写 fb 即可。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
