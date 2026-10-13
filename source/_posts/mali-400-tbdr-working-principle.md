---
title: Mali-400 工作原理：TBDR 延迟渲染与它的坏脾气
date: 2026-10-12 18:10:00
lang: zh-CN
search: true
categories:
- 嵌入式硬件
tag:
- Mali
- GPU
- TBDR
- OpenGL ES
---

# Mali-400 是什么

Mali-400 是 ARM 授权的嵌入式 GPU IP 核，在 SC9832A 这类低端 SoC 里以 MP1（单核）形式出现。它不是独立显卡，而是挂在 AMBA AXI 总线上的一个协处理器：CPU（Cortex-A7）与 GPU 共享同一块 DDR 内存，没有独立显存。软件栈从上到下是：OpenGL ES 2.0 应用 → libEGL/libGLESv2 用户态驱动（通常是 Android 变体的 DDK）→ 内核驱动 mali.ko → 硬件。

# 双核心架构

Mali-400 内部由两个职责不同的处理器组成：

- **GP（Geometry Processor，几何处理器）**：负责顶点着色、裁剪，只有 1 个顶点处理单元——几何负载重时它就是瓶颈。
- **PP（Pixel Processor，像素处理器）**：负责片元着色与光栅化，吞吐约 1 像素/时钟。500MHz 主频下纯填充上限约 5 亿像素/秒。

两级之间靠「分块（Tiling）」环节衔接，这正是它与传统 PC 显卡最大的区别。

# TBDR：先记账，后统一画

传统 PC 显卡（IMR，立即渲染）来一个三角形就立刻光栅化，深度测试每个像素都要往返 DDR 读深度值，带宽消耗巨大。Mali-400 的渲染分两遍：

1. **几何遍**：GP 只计算顶点、做裁剪，然后不画——把每个三角形登记进它所覆盖的 16×16 瓦片（tile）列表。
2. **像素遍**：逐瓦片处理。把该瓦片涉及的所有三角形取出来，深度缓冲与颜色缓冲直接放在芯片内部的高速存储里完成计算，整个瓦片算完（遇到 resolve/flush）才一次性写回 DDR。

对没有独立显存、与 CPU 抢 DDR 带宽的手机 SoC 来说，这套省带宽的设计是生存必需。代价是「读回中间结果」这件事在硬件契约上天然不友好。

# 实证出来的 DDK 契约

以下行为是我在 SC9832A 的 Mali-400 DDK（Android 变体驱动）上实测得出的：

1. **从 FBO 做 glReadPixels 读回恒为 0**：帧数据在瓦片 resolve 之前只存在于片上缓冲，这颗 DDK 的 FBO 读回通路等于没有——glClear 后读回是 0，真实 draw 后读回也是 0。
2. **glClear 走特殊通路**：TBDR 里 clear 只是给瓦片设初始值，可以完全不动内存，等回写时才生效。中途去读内存自然什么都读不到。
3. **pbuffer 表面真实 draw 后读回正常**：pbuffer 走驱动完整的 resolve 交换路径，所以数据能落到内存。
4. **裸 framebuffer 结构体喂给 eglCreateWindowSurface 会段错误**：这颗 DDK 是 Android ANativeWindow 变体，依赖 buffer queue 的 dequeue/queue 机制，裸的 fbdev window 撑不起这套流程。

# 对实际开发的启示

- 要把 GPU 画的内容取出来，别走 FBO 读回；让渲染落到 pbuffer/窗口面这类有完整 resolve 路径的表面，再从那里读。
- 「屏上黑」要先分清三种情况：没渲染、读回失败、翻页失败——统计 framebuffer 各页的非零像素比肉眼看截图可靠得多。
- 性能瓶颈先查几何：GP 只有一个顶点单元，顶点负载重的场景（比如模拟器放大管线）很容易先卡在 GP 而不是 PP。

---

> **版权声明**：本文为 whiteleibniz 原创文章，版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
