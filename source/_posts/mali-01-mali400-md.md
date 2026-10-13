---
title: "Mali400_工作过程总结"
date: 2026-09-30 16:44:04
lang: zh-CN
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# 展讯 SC9832A Mali-400 GPU 打通 —— 工作过程总结

> 记录从"Mali 用不了"到"GLES2 硬件渲染跑通 + 独立 GPU 跑分程序可用"的完整分析路径、关键决策、失败路线与最终方案。
> 时间线：09-23 只读勘察（结论"废了"）→ 09-29 重大纠错（其实能用）→ 09-30 bionic 路线打通 PSP 硬件渲染并落地 gpu_bench 跑分。

---

## 1. 任务背景与初始目标

设备是"保留安卓 6.0 内核（3.10.65）+ switchroot 到 Alpine Linux"的展讯 SC9832A 平板，720x1280 fb，2 核 1.3GHz，916MB 内存。用户的目标：

> 1. Mali-400 到底能不能用？能不能用到显示 / 视频 / UI 上？
> 2. 仿鲁大师/3DMark 做一个多场景 2D/3D GPU 跑分程序，屏幕上显示帧率与评分，并在桌面放图标入口。

## 2. 分析框架：先把"GPU 能用"拆成三层

动手前先建立心智模型——Mali-400 能用，需要三层全部打通：

```
① 内核驱动层   mali.ko 是否 insmod、/dev/mali0 是否出现？
② 用户态层     有没有可用的 EGL/GLES 库？musl 还是 bionic？
③ 应用层       程序怎么调用？回读怎么取像素？显示怎么上屏？
```

每一层都有明确的"验通标准"，不通就往下一层排查。

## 3. 攻坚过程（按时间线）

### 阶段 A：09-23 只读勘察 —— 结论"Mali 用不了"

- 查 `/dev/dri`、`/sys/class/drm` 都不存在；mesa 有 `libEGL.so` 但无 `lima_dri.so`；`mali.ko` 未加载。
- 唯一 Mali DDK `libGLES_mali.so` 是 bionic 二进制，musl 加载不了 → 下结论"用不起来，GPU 不治卡顿"。
- **教训**：只查了 `/dev/dri`（mesa/DRM 路子）就下结论，漏了 Mali 专有驱动路径 `/dev/mali0`。

### 阶段 B：09-29 重大纠错 —— 其实能用（关键转折）

- 发现 Mali 专有驱动走 `/dev/mali0`，`mali.ko` 模块就在本机（`/lib/modules/mali.ko`，4.6MB，vermagic 匹配）。
- `insmod /lib/modules/mali.ko` → `/dev/mali0` 出现。
- 搭 bionic 运行环境：`/system/bin/linker` + `/system/lib` + `egl/libGLES_mali.so` 软链。
- ★ 用 **musl gcc 编出 bionic 程序**成功：`-nostdlib -Wl,--entry=main -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib -lGLESv2 -lEGL`。
- 实测：`GL_RENDERER=Mali-400 MP`，GLES2 跑通，480x272 清屏+quad 300 次 **0.15ms/次 = 864 Mpixel/s**；CPU 软渲同样活 **9.7ms → 慢 65 倍**。
- **结论翻转**：PSP 卡顿真因是我们在用 CPU 干 GPU 的活（SoftGPU），不是 CPU 不行。

### 阶段 C：09-30 bionic 路线打通 PSP 硬件渲染

- 前端 `miniretro_psp_hw`（musl gcc 编的 bionic 程序）：EGL pbuffer + ES2 → `SET_HW_RENDER` → `glReadPixels` → R/B 交换 → `scale_rotate90` → FBIOPAN。
- core = `ppsspp_libretro_hw.so`（bionic 重编，自带 shim）。
- 实测游戏加载、Mali GLES2 出画面，**20~36fps**（软渲上限 10fps）；干净环境 34~38fps（core 总 ~28ms：GL回读~11.7 / 缩放写屏~9.1 / core 本身~7）。
- ★ 前端必须在 `av_info` 后调 `context_reset()`，否则 `draw_=NULL` 段错误。
- ★ 判活/杀进程一律按 `/proc/<pid>/cmdline`：PPSSPP 把主线程名改成 `{Main}`，`ps -o pid,comm|awk` 必漏。
- 遗留：商业 ISO 开场动画处冻结/随机段错误（已 ptrace 定位 PPSSPP 内部 IO 死锁，未修）。

### 阶段 D：独立验收 / 测试 / 跑分程序（不依赖 PSP）

- `mali_check.c → /root/mali_check`：7 项验收（mali0/EGL/RENDERER/渐变quad回读/填充率/回读速度/CPU对照）+ 第8项扫 PSP maps。
- `gpu_test.c → /usr/local/bin/gpu_test`：全屏图形测试（三角形+网格，显示 `GPU:Mali-400 MP` / `FPS` / `READ` / `SCALE`），实测稳定 **32.8fps**。
- `gpu_bench.c → /usr/local/bin/gpu_bench`：仿 3DMark 五场景跑分（2D SPRITE / 2D OVERDRAW / 3D PARTICLES / 3D TERRAIN / 3D SHADER），按纯 GPU 渲染时间计分，几何平均出总分，实测 **6636~9052（GOOD 级）**。
- 桌面"GPU测试"图标 → `/usr/local/bin/gpu_test` 软链到 `gpu_bench`，点击走 `patch_launcher_gputest.py` 让出 fb 范式。

### 阶段 E：回读不可靠天坑（显示致命，至今未根治）

- 现象：`glReadPixels` 在 pbuffer 上 clear/普通 2D 四边形回读**全黑或陈旧红**；仅带深度大网格（TERRAIN）偶发正确。
- 已验证四种办法**均无效**：① FBO 离屏渲染再回读 ② 去掉 glFinish 直接读 ③ eglSwapBuffers 强制解析 ④ 全局开 GL_DEPTH_TEST。
- 根因 = **Mali TBDR 惰性解析 + pbuffer 回读路径缺陷**（PSP 前端靠 PPSSPP 核心内部 flush 才正常出图；`_gldump.c` 最小测试任何 clear/draw 全黑且不别名 fb）。
- 后果：屏幕 3D/2D 场景发黑，只有 CPU 直写 fb 的 HUD（帧率/分数/标题）可见；**评分与帧率不受影响**（计时只量 render+glFinish，不含回读）。

## 4. 关键决策与教训

| 决策点 | 选择 | 理由 |
|---|---|---|
| Mali 能不能用 | 先 insmod 看 /dev/mali0 | 别只查 /dev/dri，专有驱动有独立路径 |
| 用户态 GL 栈 | 搭 bionic 环境 + musl gcc 编 bionic 程序 | 本机唯一 DDK 是 bionic，mesa 无 lima |
| 架构 | musl 主程序 fork+exec bionic 子进程 | musl 与 bionic 不能共存同一进程 |
| 屏幕出图 | 暂未根治回读 | 直渲 fb 的 window surface 探针在 linker 阶段崩溃待排 |
| 评分 | 只量 render+glFinish | 绕开不可靠回读对分数的污染 |

**经验教训**：

1. 查不到 `/dev/dri` 不等于 GPU 废了——先看专有驱动路径（`/dev/mali0`）。
2. musl 与 bionic 不能共存于同一进程，但可以两个进程各用各的（fork+exec 架构）。
3. 回读（`glReadPixels`）在这套 Mali-400 + pbuffer 上是显示杀手，不是加速；要出图优先直渲 fb。
4. 判据落到最末端：Mali 是否真在干活，看 `GL_RENDERER` / maps 里 `libGLES_mali.so` / `MaliWorker` 线程，而非 insmod 成功。
5. bionic 独立程序交叉编译链路已跑通，关键脚本/符号补全集中在 `bionic_shim.cpp` 与 `_build_hw.sh`，新病人先复用。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
