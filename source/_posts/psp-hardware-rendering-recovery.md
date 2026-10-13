---
title: PSP 硬渲恢复复盘：从 20fps 到 33fps
date: 2026-10-12 18:00:00
lang: zh-CN
search: true
categories:
- 排障手记
tag:
- PPSSPP
- Mali
- ARM
- bionic
---

# 背景

手头有一台展讯 SC9832A（2×Cortex-A7 @1.3GHz，Mali-400 MP1，720×1280 竖屏）的 Linux 设备，跑着自制 LVGL 桌面 + libretro 模拟器前端。PSP 模拟走 ppsspp_libretro core + 自研 miniretro 前端，此前一直走软件渲染，只有 20fps。历史上（更早的固件版本）曾实测过硬渲 34-38fps，因此目标明确：把硬渲修回来。

# 现象与排查路径

整个排查经历了三层根因，一层比一层深。记录如下，希望后来的朋友少走弯路。

## 第一层：reloc type 17，新 core 无法加载

我尝试用设备上新升级的工具链（gcc14 + binutils 2.43）重编 core，结果 dlopen 直接报 `unknown reloc type 17`。经过对最终 .so 的重定位表逐一排查，确认 17 号是 `R_ARM_TLS_DTPMOD32`——TLS 动态重定位。

根因不是新编译的 .o 引入了 TLS，而是：同一批 .o，老 binutils 链接时会做 TLS GD（global-dynamic）→ LE（local-exec）的静态收敛，最终产物里动态 TLS 重定位为 0；新 binutils 2.43 不再做这个收敛，于是 4 个 DTPMOD32 留在了动态重定位表里，而设备上的老 Android bionic linker 根本不支持动态 TLS。

我做了三步尝试：

1. 把 4 处 `std::call_once` 改成原子标志交换，把 sol2 头文件里的 `thread_local` 去掉；
2. 提供 non-TLS 版的 `__cxa_get_globals` shim，防止 libstdc++.a 的 eh_globals.o（TLS 版实现）被链接器拉入——注意 shim 必须放在 libstdc++.a **之前**参与链接，放后面会 multiple definition；
3. 试过 `-ftls-model=local-exec` 重编，被链接器以 `R_ARM_TLS_LE32 not permitted in shared object` 拒绝（shared lib 里不能用 local-exec）。

以上做完，TLS 动态重定位确实清零了，但新 core 依然在 dlopen 时崩。用二分法关掉 init_array 里的构造函数，定位到崩在 libstdc++ 的 `std::ios_base::Init` 全局构造；而老 core 里同一个构造函数却能正常跑。新工具链的构造函数链与老 bionic linker 之间还有更深的不兼容，我决定不再深挖——**老 core 本来就完好，回退**。

## 第二层：FBO 读回黑洞

换回老 core 后 GL 后端能激活，但屏幕全黑，抓屏非黑像素占比 0.08%。这里我走了最长的弯路：之前我把前端改成了「自建 FBO → PPSSPP 渲染到 FBO → glReadPixels 读回 → 软件缩放旋转 → 写 framebuffer」的路径，并且加过 POT 纹理、缓存扫除、rmmod/insmod 等各种排除实验。

最终用一个专门写的 EGL 探针程序做出判决：**这颗 Mali DDK 上，从 FBO 做 glReadPixels 读回的内容恒为 0（连 glClear 都不行），但从默认帧缓冲（pbuffer）在真实 draw 之后读回是正常的**。也就是说，0af7630 时代能跑通的老前端，`hw_get_current_framebuffer()` 返回的本来就是 0、读的本来就是默认面——是我自己后来改坏了。

修复：把前端恢复成历史验证过的路径——FB0 直读、EGL_SURFACE_TYPE 只留 PBUFFER_BIT、删掉自建 FBO 全套代码。立即出画面。

## 第三层：useEmuThread 与 GL 上下文

PPSSPP 的 libretro glue 有个逻辑：GL 后端激活时（`GetGPUCore() == GPUCORE_GLES`）会启用 EmuThread，把所有 GL 调用搬到 core 自己的线程上跑。而 EGL 上下文 current 在前端线程，于是 GL 全部无效。core 源码里 `useEmuThread = false;` 一行修复。这个问题在老 core 上不存在（当年的构建已等价处理），但如果你要重编 core，这里是必踩的坑。

# 额外的坑

- **fb mmap 断连**：fb 驱动被多次 FBIOPAN/FBIOPUT 实验折腾后，新进程 mmap /dev/fb0 的写入到不了真实显存（pread 读回全 0，连 memset 都无效），重启才恢复。诊断方法：用 python 的 `os.pwrite/os.pread` 走文件路径验证读写一致性，再对比进程自己 mmap 区域的内容。
- **重启后静默退软渲**：设备重启后必须 `mount` Android 分区（保证 /system/lib 的 EGL 库链路存在）+ `insmod mali.ko`，否则 EGL 初始化失败，前端静默退回软渲——表面症状只是 fps 从 33 变 20。
- **bionic sigset_t 只有 16 字节**：在裸 bionic 探针里装信号处理器时，如果按 glibc 的 128 字节排布 sigaction 结构体，会静默失败。
- **bison linker 拒收 local-exec**：shared library 里 `-ftls-model=local-exec` 编出的 `R_ARM_TLS_LE32` 不被允许，TLS 修复只能走「源头消灭 TLS」路线。

# 结果

老 core + 恢复后的前端，实测 33fps（软渲 20fps），性能提升 65%。遗留问题：个别游戏（如某个旋转立方体 demo）在硬渲下仍黑屏，怀疑其渲染目标用法踩了 FBO 黑洞，待查。

# 方法论总结

1. 改前端 GL 逻辑之前，先写一个独立 EGL 探针，把「这颗 GPU 什么通路是好的」实证清楚，再动主程序。
2. dlopen 失败先看动态重定位类型直方图，新老产物的 ELF 元数据 diff 往往直接给出答案。
3. 「屏上黑」不等于「没画面」：先统计 framebuffer 各页非零像素，再区分「没渲染」「读回失败」「翻页失败」三种情况。

---

> **版权声明**：本文为 whiteleibniz 原创文章，版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
