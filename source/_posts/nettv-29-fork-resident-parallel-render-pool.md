---
title: netTV 硬解攻坚(29)：把 23 毫秒的渲染摊到 4 个核——fork 常驻并行渲染池
date: 2026-10-29 02:45:00
tags:
  - 嵌入式
  - 展讯 SC9832A
  - VSP 硬解
  - 多进程
  - 性能剖析
categories:
  - [项目实战, netTV 硬解]
  - [嵌入式, 展讯平台]
copyright: 原创文章，遵循 CC BY-NC-SA 4.0 版权协议，转载请注明出处：whiteleibniz.github.io
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool/) · [繁體中文](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool-en/)

> 系列第 29 篇。前面几轮把「选段 5 秒」砍到 0.3 秒、把「音频排空 5 秒」做成异步泵之后，帧率的下一道墙就露出来了：**每帧渲染 23~32 毫秒，而且它只吃了一个核**。本篇记录把渲染拆成多进程的完整思路，重点是三个「不崩、但悄悄错」的坑。

## 一、为什么现在是渲染

翻一下这一路的账单（同一台四核 Cortex-A7 设备、同一条 1080p25 直播流）：

| 阶段 | 耗时 | 状态 |
|---|---|---|
| `bsOnMsg`（厂商同步解码） | 14.1 ms | 硬底线，动不了 |
| 选段 | 4981 ms → 225 ms | 已修（窗口内顺序推进） |
| 音频排空 | 5231 ms → 1 ms | 已修（异步泵，待部署） |
| **渲染 `fb_render`** | **23~32 ms** | **本次目标** |

解码 14.1 + 渲染 23.2 ≈ 37 ms，换算上限只有 27 fps。换句话说：**就算把供数做到零等待，也摸不到「流畅」那条线**。渲染成了唯一剩下的大块。

而这里有个刺眼的事实：这台设备是真四核（我们早在 10-23 就用吞吐反推翻了案——`sysfs` 的 `online`/`offline` 和 `/proc/cpuinfo` 全是谎报，别读文件，跑基准）。渲染却只吃了一个核，另外三个在旁边看着。

## 二、能不能并行：先看写侧撞不撞

渲染做的是 NV12 → ARGB → 旋转 90° 写 framebuffer，输出 720×1280。核心循环是按「带（band）」组织的：

```c
for (oy0 = 0; oy0 < 1280; oy0 += bandh) {      /* 每带 bandh 行，默认 64 */
    for (int i = 0; i < 720; i++) {
        int r = 1079 - i*3/2;                   /* 源行 */
        yuv2px8_neon(Y + r*1920 + c0, C + (r>>1)*1920 + (c0 & ~1),
                     colbase + i, 720, bandh);
    }
}
```

拆开看两侧的访存：

- **写侧**：第 `oy0` 带只写输出行 `[oy0, oy0+bandh)`。带与带之间**行区间完全不相交**。
- **读侧**：源 NV12 全程只读。

这就够了——**写不相交 + 源只读 = 不需要任何锁**。既不原子操作也不用 semaphore，把 1280 行按带切成 N 段扔给 N 个执行体即可。这是那种「看一眼就知道能并行，但真动手才发现有三个坑」的活。

## 三、坑一：渲染侧一律 fork，不许裸 clone

这条是这个项目的铁律，代价是两次设备重启换来的。

早先我们为了省 `fork` 的开销，用裸 `clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD)` 起渲染线程。问题是**没有 `CLONE_SETTLS`**：父子共用同一份 TLS。bionic 的 stdio 里 `snprintf`/`vsnprintf` 走的是 `__nbuf` 这个 TLS 缓冲池，子线程一调用，就把父线程的线程结构踩坏了。

表现还特别有迷惑性：不是稳定的崩，而是「喂第二个 IDR 必 SIGSEGV，地址是个像 `0x747474` 的怪值」。我们曾经一路查 NAL 投喂 buffer 复用、SPS/PPS 重发时序，全查错方向。

所以这次并行，我**一个 `clone` 都没用**，老老实实 `fork()`。fork 出来的子进程有完整的私有 TLS 副本，踩不到父进程。

## 四、坑二：最危险的不是崩，是「画面错但不报错」

这是本次设计里我认为最值得记的一条。

并行渲染的子进程要读当前这一帧。而这一帧在我们的链路里，是先从 ION 缓冲 `memcpy` 到一块「staging 暂存区」再渲染的（ION 是非缓存映射，逐字节读实测 500 ms/帧，必须先顺序搬进缓存）。问题在于这块 staging 原本是这么来的：

```c
if (!g_stage) g_stage = (unsigned char *)malloc(ST_SIZE);
```

`malloc` 出来的是**私有内存**。`fork()` 之后子进程拿到的是一份**冻结副本**——地址一样，值却是 fork 那一刻的旧内容。后果是什么？不崩、不报错、不告警，只是画面永远慢一拍甚至错乱。这种 bug 在真机上能让排查成本翻十倍。

修法一行：

```c
void *sm = mmap(0, ST_SIZE, PROT_READ|PROT_WRITE, MAP_SHARED|MAP_ANONYMOUS, -1, 0);
g_stage = (sm == MAP_FAILED || !sm) ? malloc(ST_SIZE) : sm;
g_stage_shared = (sm != MAP_FAILED && sm);
```

`MAP_SHARED` 匿名映射，父子共用同一批物理页。单进程下行为和 `malloc` 完全一致，所以串行路径零改变。

顺手加了个保险：如果 `mmap` 失败退化回 `malloc`，就**直接禁用并行池**（`g_stage_shared == 0`）。宁可慢，不要错。

## 五、坑三：每帧 fork 一次是判负的

那是不是「每帧 fork N 个子进程」就行了？不行，这条路我们 10-22 走过一次并判负了：当时的档 2 fork 流水线实测 17.5 fps，反而输给单线程的 21.8 fps。怀疑是每帧 3 MB 帧数据跨进程往返的代价盖过了并行收益。

所以这次改成**常驻池**：启动时 `fork` 一次，之后靠 `pipe` 收发任务，每帧只传 20 字节的结构体：

```c
struct rp_job { const unsigned char *nv; unsigned long dst; int y0, y1; };
```

子进程主体就三行逻辑，而且**不碰任何 libc 的 TLS 相关入口**：

```c
static void rpool_child(int rfd, int wfd) {
    for (;;) {
        struct rp_job j;
        if (read(rfd, &j, sizeof j) != (long)sizeof j) break;   /* 0 = 父关闭 */
        fb_render_range(j.nv, (unsigned *)j.dst, j.y0, j.y1);
        if (write(wfd, &ack, 1) != 1) break;
    }
    _exit(0);
}
```

父进程派发时先把 N 个任务全部写出去（pipe 缓冲放得下），再按序收 N 个完成字节。任一步失败就整帧串行重做并**永久回退**——现场不能因为优化把直播搞挂。

子进程还设了 `PR_SET_PDEATHSIG = SIGKILL`，父进程没了内核会收走它们，不留孤儿。

## 六、首帧自检：让「静默错画面」无处可藏

既然坑二告诉我们这类错误是不报错的，那就**主动造一个会报错的机制**。

首帧进并行路径时，先串行渲染一遍到 framebuffer 的草稿页（我们映射了 3 页，播放只用 1/2 页，第 0 页空闲），算一个 FNV-1a 哈希；再走并行渲染到真页，再算一次哈希。两者不等就判定并行有问题，打印告警并永久回退串行：

```c
fb_render_range(nv, scr, 0, 1280);   unsigned h1 = rp_hash(scr);
fb_render_pool (nv, dst);            unsigned h2 = rp_hash(dst);
if (h1 != h2) { P("[rpool] 自检失败 串=%08x 并=%08x → 永久回退串行\n", h1, h2); ... }
```

代价只在首帧：多一次渲染 + 一次 3.6 MB 哈希（约 1~2 ms）。换来的是「只要并行结果和串行不等，就一定会被抓到」。**对这类无锁并行改动，我认为这个自检比优化本身更重要。**

## 七、重构：把带循环区间化

为了让同一段代码既能串行跑也能被子进程分段跑，把 `fb_render` 的内层带循环抽成区间函数：

```c
static void fb_render_range(const unsigned char *nv, unsigned *dst, int y0, int y1);
```

串行时调 `(0, 1280)`，与旧路径**逐位等价**；并行时每个子进程调自己那段。这里有个细节：渲染配置原本是 `fb_render` 里的 `static`（`g_bandh`、`use_neon`、`use_lut`…），子进程是不会去调 `render_cfg_init()` 的，所以我把它们**提升为文件作用域全局变量**，靠 `fork` 继承。稍有疏忽（比如漏掉 `g_prof`）就会出现「某个 env 开关悄悄失效」——这类静默失效和坑二是一类病。

另外帧率度量也顺手对齐了：旧的采样换算系数写错过一次（`[perf]` 报 25 ms 而 AU 段报 32.3 ms 自相矛盾），这次按区间实际的带数/采样数还原，不再依赖固定系数。

## 八、怎么验：唯一变量 + 硬门槛

门控是 `NETTV_RPOOL=N`（1~8，默认 **0 = 原串行路径**，行为零改变）。A/B 三臂背靠背：0 / 2 / 4，同二进制、同源、同臂长。

判据我设了四条，其中第二条是硬门槛：

1. `[STAT] fps_x10` 明显高于基线；
2. **`[rpool] 自检通过 串/并一致`**——不一致直接判负，帧率再高也不算赢；
3. `/tmp/nettv_segv.log` 无 `signal=11`；
4. ION clients 不增长（并行渲染不应该额外占 ION）。

第二条为什么这么硬：并行渲染最坏的情况不是变慢，是**画面悄悄错**。帧率涨了、画面花了，这种「优化」上线就是事故。

## 九、当前状态与下一步

本篇写于设备离线期间（连续第三轮没联上机），所以**以上都是设计与静态审查的结论，还没有实测数字**。已经落地的产物：

- 源码 v30（v29 的异步音频泵修复 + 本篇的并行渲染池）；
- 设备端构建脚本与三臂 A/B 脚本；
- 首帧自检、非共享 staging 自动禁用、子进程失效永久回退三道保险。

上电后的顺序是：先跑异步音频泵的 A/B（上一轮就准备好的），确认段间隙降到 6 秒以内、帧率上到 22 fps 以上；再跑本篇的并行池 A/B。两者都过了，才谈部署——因为异步音频泵带一个「起播延迟 +18 秒」的取舍，得先让用户确认能不能接受。

> 待验证清单见文末。这类改动的验证必须上真机：fps 数字、画面正确性、长时间稳定性，三样都得看。

## 待用户验证清单

1. 编译：`_b30.sh` 是否 `BUILD_OK`（v30 新增 `pipe`/`fork` 路径，先看有无编译错误）。
2. 自检：日志里是否出现 `[rpool] 自检通过 串/并一致`，**不是** `自检失败`。
3. 帧率：三臂 `[STAT] fps_x10` 对比，开臂是否明显高于基线 `0`。
4. 画面：真机肉眼看有无色带、横条、错行（哈希自检只能保证与串行一致，不能保证串行本身对）。
5. 稳定性：`signal=11` 计数为 0、ION clients 不增长、收尾 `left=0`。
