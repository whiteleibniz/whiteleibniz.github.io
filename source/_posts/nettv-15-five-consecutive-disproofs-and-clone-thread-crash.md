---
title: nettv-15：五连证伪——为什么“想当然”的优化全部无效，以及裸 clone 线程是怎么把设备搞重启的
date: 2026-10-20 11:30:00
categories:
  - [嵌入式, 网络电视硬解]
  - [Linux, 性能优化]
tags:
  - sprd
  - SC9832A
  - VSP
  - ION
  - 性能分析
  - ARM
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-15-five-consecutive-disproofs-and-clone-thread-crash-en/)


> 系列第 15 篇。上一篇（nettv-14）我们把“卡”定性成了 ptsync 正反馈和 O_SYNC 日志，
> 拿到 17fps 基线。这一篇是从 17fps 往 25fps 冲的过程——**基本全是反面教材**：
> 五个看起来很合理的优化，四个被 A/B 实验直接证伪，一个把设备重启了两次。
> 结论比过程重要，所以先把结论拍在前面。

## 一句话结论

**每帧 116ms 的账：解码 21ms + 拷贝 43ms + 渲染 32ms。真正的瓶颈是 3MB 的 memcpy，
而它慢，是因为 ION buffer 是非缓存映射。** 所有对“解码/渲染/流水线”的优化，
在 uncached 内存这堵墙面前都是隔靴搔痒。

## 背景：116ms 的墙

泸县 1080p 直播源，每 AU（一个访问单元 ≈ 一帧）实测：

| 段 | 耗时 | 内容 |
|---|---|---|
| DRIVE | 21.1ms | 厂商库同步解码，其中硬件只算 14ms |
| 读帧 | 43.4ms | 3MB 的 `memcpy(uncached ION → 缓存暂存)` |
| 渲染 | 31.8ms | NV12→ARGB + 旋转合成 + 写 fb |

监控 `[STAT] fps_x10=157`，即 15.7fps。目标 25fps，意味着总账必须从 116ms 压到 40ms 以内。
下面是我们依次试过的五件事。

## 证伪一：签名扫描降频——“读帧 45ms 里有 25ms 是扫描”

逻辑上无懈可击：每帧对 Y/UV 平面做内容签名（判重复帧用），步长 256 抽样也要
8K+4K 次访问，看着就像大头。

改成“周期签 + 回调计数判重”后 A/B 实测：

```
A 组(降频后): 读帧 44.6ms
B 组(每帧全签): 读帧 44.8ms
```

**差异是噪声。** 签名扫描从来就不是瓶颈，全部耗时是 memcpy 的。
教训：你以为的“大头”和真正的大头之间，只隔一次单变量 A/B。

## 证伪二：fb_render 查表化——“消除每像素 3 次乘法”

BT.601 转换 `r=y+f(v)` 这类公式，教科书式优化是预计算系数表：

```c
static short sRV[256], sGU[256], sGV[256], sBU[256];
static inline unsigned pxlut(int yv, int u, int v) {
    int r = yv + sRV[v];
    int g = yv - sGU[u] - sGV[v];
    int b = yv + sBU[u];
    ...
}
```

三乘六 clamp 变成四查表三加法，理论上很美。实测：

```
A 组(LUT):   渲染 39.3ms，fb_render 均值 39ms
B 组(标量):  渲染 32.5ms，fb_render 均值 36ms
```

**查表慢了 20%。** Cortex-A7 的硬件乘法器一个周期完事，4 张 256 项表的
随机索引访问（相邻像素的 U/V 跳跃）带来的是 L1/L2 miss。我们最后把默认值
翻了回来（`NETTV_LUT=1` 才启用），只留代码作 A/B 教材。

## 证伪三：直读 ION 省掉 memcpy——“copy 就是浪费”

既然 memcpy 占 43ms，那让渲染直接读 ION buffer 不香吗？`NETTV_STAGE=0` 就是
这个开关。实测：

```
5.8fps，fb_render 均值 335ms
```

**比拷贝版慢 10 倍。** 原因是 ION 分配时 `flags=0`，映射出来的是**非缓存
（uncached）内存**：copy 版是一次顺序大块读（DRAM  burst、硬件预取都舒服），
之后所有访问都落在缓存；直读版是每像素一次 uncached 事务，每笔都是完整总线
周期。排序扫描/混合访问在 uncached 内存上等于自杀。

**3MB memcpy 不是浪费，是最优解。** 但“43ms”这个数字本身成了新靶子。

## 翻车四：裸 clone 双线程流水线——两次重启

到这一步单线程已经砍不动了，账本上唯一的出路是流水线：
worker 解码+拷贝，另起线程做渲染，两者重叠。
裸 bionic（-nostdlib）没有 pthread，我们直接用 `clone` syscall 拉了线程：

```c
#define CLONE_VM 0x00000100
long r = syscall(120 /* clone ARM EABI */,
                 CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD,
                 sp, 0, 0, 0);
if (r == 0) { fn(); syscall(1, 0); }
```

20 秒试跑，功能全对：render 线程启动、DRIVE 降到 18ms、墙钟 80ms。
换成 60 秒长测——**设备重启了，而且是一天两次**（连 `/tmp` 里的二进制都被
截成 0 字节，典型的掉电级文件系统损坏）。

复盘抓到的根因有两条，都是“裸线程”特有的雷：

1. **没设 TLS**。`clone` 时没给 `CLONE_SETTLS`，新线程跑的是父线程的 TLS。
   而 render 线程里调了 bionic 的 `snprintf`（日志打印）——bionic stdio 内部走
   `__nbuf` 线程局部缓冲池，也就是 **TLS**。子线程拿着别人的 TLS 写，线程结构
   被踩坏，什么时候炸取决于时序（所以 20s 不炸、60s 炸）。
2. **共享信号 handler**。`CLONE_SIGHAND` 下 SIGSEGV/SIGALRM 的 handler 可能被
   任一线程执行，而 handler 里有 `siglongjmp`——跨线程 longjmp 是未定义行为。

修复（v16i）：render 线程入口先 `rt_sigprocmask` 屏蔽进程handler 的所有信号；
线程内禁用一切涉 TLS 的 libc 调用（`P`/`snprintf` 改成手写 `write` syscall，
memcpy 是纯汇编、不用 TLS，保留）。修复后 60s 长测**不再崩**。

> **裸 clone 线程铁律**：子线程内只允许 raw syscall 和编译器内建的 memcpy；
   进线程第一件事是屏蔽信号；snprintf/P 宏一律算违禁品。

## 负优化五：修好之后，流水线反而更慢

不崩只是拿到了实验资格，单变量对照的结果是：

```
A 组(双线程流水线): 12.3fps，墙钟 80ms（口径含重叠）
B 组(单线程):       15.7fps，墙钟 116ms
```

**慢 22%。** 归因：
- DRIVE 确实从 21ms 降到 18ms，但 **memcpy 43ms 一动不动**（这是链尾瓶颈）；
- 两个线程都在猛吃内存带宽，L2 争抢让双方的“读”都变慢；
- 握手的 `usleep(200µs)` 粒度把本来想做流水的并行又卡回半串行；
- render 的 32ms 被 worker 的 62ms 完全掩埋，等于白干。

安卓的 BufferQueue 能成立，前提是“输出 buffer 多个轮转 + 解码器异步”；
我们 `g_nout=1`、单路输出、解码同步阻塞，把渲染线程挂上去也只是换了个
地方串行。**架构不匹配时，抄形态没用。**

## 那到底怎么才能快？

三个数放在一起，路线图自己就出来了：

```
DRIVE 21ms（其中硬件解码 14ms，库侧文书 7ms —— 已接近极限）
memcpy 43ms（3MB uncached —— 唯一的靶子）
渲染 32ms（可被流水线掩埋，但掩埋它没有净收益）
```

- **第一刀：ION 改缓存映射。** 分配时带 `ION_FLAG_CACHED`，每帧 `ION_IOC_SYNC`
  做 invalidate。memcpy 从“uncached 顺序大块”变成“cached 大块”，预期 43ms→10ms
  量级，总墙钟 116→约 75ms，**20fps+**。风险是 DMA 一致性（VSP 写、CPU 读 cache
  stale → 花屏），必须灰度。
- **第二刀：DRIVE 库侧 7-18ms 的 phys ioctl 缓存化**（fd→PA 建表，一次查长期用）。
- **第三刀：fb_render 的 32ms**，在 ARMv7 编译禁 NEON 的前提下做循环展开和
  8 像素预取。
- **玄学刀：显示驱动 overlay。** 如果 sprd DPU 能直接吃 NV12+旋转，CPU 合成整段
  消失——这是追平安卓 50fps 的真正大杀器，但需要 recon 驱动能力。

## 方法论沉淀

1. **“一眼可见的大头”必须 A/B 验证。** 本轮五个里有三个（签名、LUT、直读）
   在实测面前翻了车，其中两个翻得反直觉。
2. **每加一个优化，同时 A/B 一个旧行为做反证。** 没有 B 组就没有结论，
   只有感觉。
3. **性能归因要到内存属性这一层。** uncached/cached、顺序/随机、命中/miss，
   比算法层面的优化更能解释数量级差异。
4. ** risky 的运行时抽象（裸线程）上线前，先确认它能用满 3 倍的时长。**
   20 秒能跑不代表 60 秒能跑——时序性 bug 不挑时间，只挑概率。
5. 设备重启 = `/tmp` 文件被截断的第一嫌疑对象。md5 对不上先怀疑掉电，再怀疑代码。

---

*上一篇：nettv-14《从 6.3fps 到 17fps：O_SYNC 日志与一次 dup2 误判》*
