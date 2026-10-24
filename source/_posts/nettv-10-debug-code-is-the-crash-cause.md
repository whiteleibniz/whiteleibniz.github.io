---
title: '调试代码自己就是崩因：一次 VSP 内核崩溃的 8 层证伪'
date: 2026-10-19
tags: [nettv, vsp, 展讯, sc9830, 内核崩溃, 调试方法论, MMIO]
categories: [技术]
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause/) · [繁體中文](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause-en/)


# 调试代码自己就是崩因：一次 VSP 内核崩溃的 8 层证伪

> 背景：展讯 SC9832A（sc8830 系列）上做 HLS 直播硬解，裸调 `SprdSimpleOMXComponent`，
> 输出 framebuffer。某天新版代码每跑必崩 —— 崩在 `DRIVE fill(out) #1`，
> 设备随即重启。**进程级保护拦不住，栈上也没有任何线索。**
>
> 真凶是一段"为了查挂死而加的"调试代码。

## 症状

相位桩（`O_SYNC` 直写 `/tmp/phase.log`）显示每一轮都停在同一行：

```
t=1385724329 >> fill(out)#1 开始 g_nout=1
t=1385724331    fill(out) 交第0路 hdr=0xb6d8ec80 pBuffer=0xb6d9ba80
                                     ← 没有下一行，设备重启，uptime 回 1 分钟
```

`sigsetjmp` 拦不住、`dmesg` 无 OOM、`MemFree` 有 882 MB。

## 8 层证伪

崩溃点那行代码和 10-18 能跑版**逐字节相同**。所以差异在它**之前**。
我把它能想到的每一条都单独做了 A/B：

| # | 假设 | 验证方式 | 结果 |
|---|------|---------|------|
| 1 | 补调 `useBuffer` 导致厂商 ASSERT | `NETTV_UBMODE=0` 不补调 | 仍崩同一处 |
| 2 | `setParameter(0x7f000011)` 是崩因 | `NETTV_SP228=0` 跳过 | 仍崩 |
| 3 | 自管 ION 的假 native_handle 是崩因 | `NETTV_NOFAKE=1` 整个禁用 | 仍崩 |
| 4 | 投喂切分 `offsplit`/`chunk` 是崩因 | 强制 `g_offsplit=0 g_chunk=0` | 仍崩 |
| 5 | `NOUT 6→4` 回滚动到了 BSS | 回滚后 | 仍崩 |
| 6 | handle 来源是 gralloc vs 自管 ION | `NETTV_EARLY=1` 提前抢到自管 ION，handle 变回堆地址 | 仍崩 |
| 7 | carveout_mm 池被抢空（`total 0`） | 重试 6 轮 + 退避 + 尺寸阶梯，第 6 轮真抢到 | 仍崩 |
| 8 | 内存不足 | MemFree 882 MB，dmesg 无 OOM | 排除 |

第 8 层排除后，能解释"同环境 AB 对照"的就只剩一件事：**旧版没有的代码**。

## 真凶

10-18 晚上为了抓"挂死现场"，我加了一套寄存器取证：

```c
static int vrp_hook(void *d, unsigned off, ...)   /* hook 厂商 VSP 寄存器写函数 */
{
    int r = g_vrp_real ? g_vrp_real(...) : -1;
    g_vsp_rb = *(unsigned *)d;                    /* ← 取 VSP 寄存器窗口基址 */
    unsigned rb = *(unsigned *)d;
    volatile unsigned *W = (volatile unsigned *)(rb + 0x60901000);
    volatile unsigned *B = (volatile unsigned *)(rb + 0x60908000);
    P("[W10] 1010=%08x ...", W[0x10/4], ...);    /* ← 直接读 MMIO */
}
```

以及 `tr_line()`，在**每次 DRIVE 前后各调一次**，读 `W[0x1c/4]`、`B[0x34/4]`。

`vrp_hook` 是**每一轮轮询都会走**的高频路径。等于在解码过程中持续
从 `0x60901000` / `0x60908000` 这两块寄存器窗口**读 MMIO**。

结果是：VSP 状态机被打乱，崩在紧随其后的 `DRIVE fill(out) #1`。
**崩溃点不在调试代码那行，而在它造成的下一处破坏。**

修法就一行语义：

```c
{ static int mmo = -1;
  if (mmo < 0) { const char *em = getenv("NETTV_TRACE_MMIO");
                 mmo = (em && em[0] == '1') ? 1 : 0; }
  if (!mmo) return r; }        /* 默认关，不碰 MMIO */
```

验证：新版跑到 `AU[299]`，phase.log 里 1032 次 `fill(out)` 全部"已返回"，
设备零重启。

## 三条方法论

**1. "调试代码自己就是崩因"是一类独立故障模式。**
它不会崩在自己那行，所以栈、日志、ASAN 全都指不到它。
只有把旧版和新版**放在同一设备同一环境连跑对照**、逐字段比对运行时状态
（我打的是 handle 的 `ints[0..23]`、`g_gh_n`、`g_nout`），才能看出"旧版没有这段"。

**2. 排查期要有一个绝对可靠的日志通道。**
这个项目里 stdout 被自定义 stdio 的 4KB 块缓冲吞掉，崩溃时缓冲区全丢 ——
于是我一度靠空日志误判过三次。`O_SYNC` 直写的相位桩是唯一可信通道。
同理，脚本上传后必须 `md5sum` 校验，我踩过 3 次"0 字节脚本导致误判新版不崩"。

**3. 判据要选可复现的。**
"ALIVE=0" 这个信号毫无信息量（旧版正常自退也是 0）；
`uptime` 是否回 1 分钟 + 相位桩最后一行，才是可靠判据。

## 附带修好的一个真问题

`g_gh_n=0`（carveout_mm 池被组件 init 阶段性抢空）时，
`ghOut` 会留在 gralloc 的真 handle 上。而 gralloc 走的是 IOMMU heap，
**没有物理连续 backing**，VSP 会往假物理地址写帧。

所以加了两道防线：
- 抢池加重试（6 轮 × 120ms 退避 × 4 档尺寸轮转），实测第 6 轮能抢到；
- 仍抢不到就 `_exit(12)` 交给看门狗重生 —— **宁可不出画面，也不打飞内核**。

## 写在最后

「加个寄存器 dump 看看」这句话，在硬件加速调试里是有代价的。
读 MMIO 不是 `read()` 一个普通变量，它是**在别人的状态机上插一脚**。

排查复杂问题的方法归根到底只有一句：**把"能跑的版本"和"崩的版本"摆在一起，
逐项二分**。这次要不是手上有 10-18 那份能跑的源码当基线，
我会一直在这个坑里猜第八、第九、第十个假设。
