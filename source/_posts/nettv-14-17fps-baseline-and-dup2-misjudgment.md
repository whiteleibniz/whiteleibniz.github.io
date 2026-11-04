---
title: netTV 硬解攻坚（十四）：17fps 基线实测与一次 dup2 误判——判"有没有出帧"不能只看主日志
date: 2026-10-20 14:45:00
categories:
  - 嵌入式
  - netTV 硬解攻坚
  - 性能优化
tags:
  - SC9832A
  - VSP
  - HLS
  - H.264 硬解
  - framebuffer
  - 性能分析
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment-en/)


> 系列第 14 篇。上一篇（十三）把「O_SYNC 日志」定为隐形帧率杀手并默认关掉了它，
> 本篇回答：关掉之后到底跑多少帧？结论是 **17fps**——以及我是怎么被 `dup2`
> 误导、差点把"能跑"误判成"0 帧"的。

## 一、先纠正上一篇遗留的一个悬案

上一篇结尾说 A/B 实验被用户桌面播放占着 ION 池挡住，重跑之后拿到了真实数据。
但重跑第一步就撞上一个诡异现象：A 组、B 组日志都只有 **271~291 字节、6 行**，
帧数为 0、心跳 0、性能汇总 0——和上一次"池被占"的表现一模一样。

但这次 ION 池是空的（我的实例 `earlyion g_nout=1`、`out[0]` 拿到了 3.2MB 真物理地址）。
于是做单变量复现：**只加 `NETTV_VLOG=1`**（开详细日志，其他全部不动）——
12 秒出了 48 帧，一切正常。

也就是说：**VLOG=0 不出帧，VLOG=1 出帧。** 一个环境变量怎么可能控制出不出帧？
顺着源码查 `vlog_on()` 的全部引用，在 193 行抓到了真凶：

```c
static void child_log_bound(void) {
    if (vlog_on()) return;   /* 调试模式: 保留调用方重定向 */
    int f = open("/tmp/nettv_child.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    dup2(f, 1); dup2(f, 2);  /* ← 子进程 stdout 被换成了文件 */
    if (f > 2) close(f);
}
```

这是 10-16 加的"限磁盘占用"设计：非调试模式下，把子进程的 stdout 重定向到
`/tmp/nettv_child.log`，防止每帧的库内打印把 `/tmp/lvgl_demo.log` 撑到 131MB。
**重定向之后，帧统计 `[STAT]`、每 200 条 AU 的性能汇总 `[perf]`、帧上屏标记，
全部写进了 `nettv_child.log`**——而主日志只剩启动横幅那几行。

>A 组和 B 组其实一直正常出帧。271 字节的主日志 ≠ 0 帧。
>我看到 `nettv_child.log` 里出现 `FilledDone 解码帧` 时，还判断那是"用户会话的输出"。

**教训（已立为项目铁律）**：判"播放器有没有出帧、帧率多少"，必须
`grep /tmp/nettv_child.log`（`FilledDone` / `已上屏` / `[STAT]` / `[perf]`），
不能看主 log。凡是 stdout 被 `dup2` 过的进程，主日志的行数说明不了任何事。
另外注意源码 191 行 `kdiag_on()` 的实现是 `g_kdiag || vlog_on()`——
**设 `NETTV_VLOG=1` 会连带打开全部 kdiag 诊断**，调试时这个耦合要注意。

## 二、诊断默认关之后的真实基线

修正判据后重跑（泸县 1080p 源，完全新默认环境，60 秒）：

- **825 帧 / 48.4 秒，`[STAT] fps_x10=170`，即 17fps**
- 对比上一篇 v15（诊断全开）的 13.2fps：**+29%**，诊断默认关的修复确认有效、无回归

`[perf]` 每 AU 分账（墙钟均值 112ms）：

| 段 | 耗时 | 内容 |
|---|---|---|
| 段循环 / DRIVE | **32.4ms** | 硬件解码 14ms（厂商自报）+ 库侧约 18ms（phys ioctl 查地址、bind/unbind、双份 FilledDone） |
| snap_state | 0ms | kdiag 门控生效 ✓ |
| 读帧 | **45.5ms** | 3MB memcpy 到缓存暂存 ~20ms + 内容签名扫描 ~25ms |
| fb_render | **30.5ms** | CPU 单遍几何合成（缩放 + 旋转 + NV12→ARGB），采样均值 34ms |
| 其余 | ~3.6ms | 尾部 fill(out) 补队列等 |

## 三、账算清楚：25fps 的预算够不够

25fps 需要 ≤40ms/AU，现在 112ms。分段砍：

1. **签名扫描裁掉/降频**（读帧 45.5→约 22ms）：签名本来用于"画面不变不重复渲染"判重，
   但厂商 `FilledDone` 回调每帧必达（心跳就是用它做的），判重完全可以改成回调计数，
   不需要 CPU 扫 8K 个采样点；Y 非零判空只留前几帧即可。
2. **fb_render NEON 化**（30.5→约 10ms）：几何合成是规则的定点运算，
   ARMv7 NEON 有成熟写法。
3. **DRIVE 库侧缓存**（32.4→约 24ms）：phys ioctl 每 AU 重查 fd→PA，
   按 fd 缓存可省一半。
4. 三项全砍完：24 + 22 + 10 = **56ms ≈ 18fps，仍然不够。**

**结论：光靠"砍"到不了 25fps，唯一的路是流水线。** 现在 worker 是纯串行：
解码的 32ms 里 CPU 在等；渲染的 30ms 里 VSP 在闲着。只要把"读帧+渲染"挪到
解码下一帧的**并行时段**（安卓的 BufferQueue 模型），单 AU 墙钟就趋近
`max(解码, 渲染) ≈ 35ms`，**约 28fps**。

流水线的硬约束是老问题：**双缓冲要 2×3.1MB 输出 + mbinfo 653KB + 输入 256KB
≈ 7.1MB，而 CMA 池名义只有 ~7MB**。要么先扩池（内核 cmdline），
要么赌池子实际比标称松一点（厂商 init 抢的是 C1 池，不一定全在 CMA 里）。
这也是下一篇要实验的第一件事。

## 四、下一步（单变量顺序）

1. 签名扫描降频（读帧 45.5→~22ms，最稳的一刀，先动）
2. fb_render NEON 几何合成（30.5→~10ms）
3. 双缓冲流水线（CMA 池挤 2 路）—— 决定能否到 25fps+
4. DRIVE 内 fd→PA 缓存
5. 更远的路：recon 显示驱动 overlay 能力，NV12 直送显示层 + 硬件旋转，
   把整个 CPU 合成省掉（对标安卓 HWComposer）

---

*本系列文章与实验脚本随项目同步维护，仅代表个人嵌入式学习与调试过程记录。*
*本文为原创技术总结，转载请注明出处，禁止商业用途。*
