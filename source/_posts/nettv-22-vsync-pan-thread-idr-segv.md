---
title: 展讯 SC9832A 网络电视攻坚（二十二）：一个"治拖影"的翻页线程，让每个 IDR 都崩
categories:
  - [嵌入式, 展讯平台]
  - [嵌入式, 音视频]
  - [调试方法, A/B 实验]
tags: [VSP, 硬解, SIGSEGV, vsync, framebuffer, LVGL, 展讯, 裸clone线程]
date: 2026-10-22 02:00:00
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv/) · [繁體中文](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv-en/)


> 版权声明：本文为博主原创文章，遵循 CC 4.0 BY-SA 版权协议，转载请附上原文出处链接和本声明。

上一篇我们把帧率从 14.3fps 推到 21.8fps，顺手还塞进两个"用户体验修复"：curl 抗弱网（治卡顿）和**独立 vsync 翻页线程**（治拖影）。结果第二天一跑——**零帧，每次喂 IDR 就 SIGSEGV，看门狗无限重启**。这篇讲怎么用一次干净的背靠背 A/B 把真凶钉死，以及一个更值钱的教训：**崩溃现场的日志，往往是最会骗人的那一层**。

## 一、现象：0 帧 + 无限重启

默认配置跑泸县 1080p 源，父进程日志只有这些：

```
*** monitor: 子进程自退 st=0xb ***
*** monitor: 重启 (子进程 @0 帧)
（重复 6 次）
```

`st=0xb` = 子进程被 11 号信号（SIGSEGV）打死。子进程日志 `/tmp/nettv_child.log` 里只有 16 行，看起来"连解码器都没起来"。

## 二、第一层误判：看 child.log 会被骗得很惨

先说结论：**这个场景下唯一可信的轨迹是 `/tmp/phase.log`，不是子进程 stdout。**

原因有三个，叠在一起：

1. 裸 bionic（`nostdlib -Wl,--entry=main`）下 `_exit()` **不 flush stdio**，进程一崩缓冲区里的东西全丢；
2. stdout 是 4KB 全缓冲，只有写满 4KB 才会落盘一次——所以你看到的往往只是"第一个 4KB"；
3. monitor 每次重启子进程都会 `O_TRUNC` 截断 child.log，前面几代的全部线索直接抹掉。

而 `ph()` / `phx()` 这两个诊断函数是 `open(O_APPEND|O_SYNC)` 直接 write 的，崩了也不丢一行。于是判崩溃点的正确姿势是：

```sh
grep -B3 'mon-child-signal=11' /tmp/phase.log
```

一查，七次崩溃**完全同构**：

```
t=... DRIVE empty(in) 喂 IDR+SPS+PPS (Annex-B 全序列, nFlags=0)
t=... mon-child-signal=11 st=0xb
```

崩溃点 100% 落在"投喂 IDR"之后。

## 三、第二层误判：`g_gh_n=0` 不是"ION 池被吃干"

日志里有这么一行，很容易被当成铁证：

```
[earlyion] 可用输出路数 g_nout=1 (g_gh_n=0)
```

我以前的笔记里也确实把它写成了"ION 池被泄漏吃干 ⇒ 必须重启设备"。**这是误读。** 看代码：

```c
int early = 0;                      /* NETTV_EARLY 默认 0 */
for (char **ep = environ; *ep; ep++)
    if (!strncmp(*ep, "NETTV_EARLY=", 12)) early = atoi(*ep + 12);
for (int i = 0; i < early; i++) { ... g_gh_n++; }
```

默认 `early=0`，循环一次都不跑，`g_gh_n` **必然是 0**——这是"组件先拿足内存、输出缓冲在组件 init 后再分配"这条 10-18 定案的正常表现，跟池子空不空没关系。

顺手把"池到底空不空"也证伪掉了，这两条命令值得记下来：

```sh
cat /sys/kernel/debug/ion/clients          # 空 ⇒ 没有进程持 ION
cat /sys/kernel/debug/dma_buf/bufinfo      # Total 0 objects ⇒ 没有泄漏的 dma_buf
```

两个都是干净的，所以这次**不是**"池被吃干 → 重启设备"，别急着按老药方抓药。

## 四、真凶：一个刚加的"治拖影"线程

4f2f17f 里新增了两处：curl 限速参数（跟解码无关），以及**独立 vsync 翻页线程**——等 `FBIO_WAITFORVSYNC` 消隐期再 `FBIO_PAN_DRAW`，把翻页从"随机扫描相位"改成"消隐期内翻页"，治运动画面的撕裂。

它有 env 逃生门 `NETTV_VSYNCPAN=0`，于是这就是一次天然的单变量 A/B。同一份二进制、同一段 TS、背靠背跑：

| 组 | env | signal=11 次数 | 真帧 | fps | 墙钟 |
|---|---|---|---|---|---|
| A | 默认（翻页线程开） | **6** | 0 | — | — |
| B | `NETTV_VSYNCPAN=0` | 0 | 1094 | 21.6 | 41.9 ms |
| A2（复测） | 默认 | **6** | 0 | — | — |
| B2（复测） | `NETTV_VSYNCPAN=0` | 0 | 1094 | 21.6 | 41.9 ms |

四组数据，A 侧两次全崩、B 侧两次全活，帧率还正好是我们熟悉的 21.6fps。**同二进制、唯一变量、双向复现**——这就不用再吵了。

### 它跟"第二个 IDR 必崩"是同一件事

有个反直觉的细节：翻页线程是 `vspan_publish()` 在**第一帧渲染之后**才创建的，那为什么崩溃发生在"第一个 IDR"？

因为崩溃的是 monitor 重启后的**后续代**。每一代跑起来 → 出几帧 → 创建翻页线程 → 喂下一个 IDR → 崩；而 child.log 被 O_TRUNC 抹掉了前几代的帧输出，只剩下最后一代那几行"还没出帧就死了"的假象。

翻回历史笔记——10-15 那篇"第二个 IDR 必崩"[当时归因为 ION 池干掉的次生崩溃]，10-21 那篇"第二个 IDR 必崩已否证"——**真正的答案既不是"IDR 有毒"，也不是"池子漏了"，而是这条线程**。它是在 10-21 晚上才加进去的，时间线也对得上。

## 五、处置：一行，把默认值翻到安全侧

```c
static inline void vspan_publish(int pg) {
    if (g_pan_off) return;
    if (g_vspan < 0) {
        const char *e = getenv("NETTV_VSYNCPAN");
-       g_vspan = (e && e[0] == '0') ? 0 : 1;
+       g_vspan = (e && e[0] == '1') ? 1 : 0;   /* 10-22: 默认关(必崩), =1 才开 */
    }
    ...
}
```

重建部署后，默认（**不设任何 env**）跑 60s 验收：

```
signal=11 次数 = 0
末 STAT   = [STAT] frames=2150 real=1022 elapsed=46533ms fps_x10=219
末 perf   = [perf] AU#1000 均值: 墙钟=41.3 段循环=14.0 (bsOnMsg=14.1 睡眠=0.0)
            snap=0.0 读帧=2.6 渲染=23.8 (ms) pan=0
```

0 崩溃、1022 真帧、**21.9fps**，墙钟构成跟 10-21 的 21.8fps 基线完全一致 ⇒ 帧率没有退化，只是把翻页线程关掉了。

代价是：**拖影问题回到未修状态**。这是取舍——先保"能播"，再谈"好看"。

## 六、三条可复用的经验

1. **崩溃现场最可信的那层日志，往往不是 stdout。** 给关键路径留一个 `O_APPEND|O_SYNC` 的 phase 轨迹，它会救你很多次；反过来，靠"看起来什么都没打"去判断"死在哪一行"，基本是在掷骰子。
2. **不要用"某个变量等于 0"当结论，要看它为什么等于 0。** `g_gh_n=0` 我误读了两个星期；顺手查 `ion/clients` + `dma_buf/bufinfo` 只要十秒，就能省掉一次"重启设备再说"。
3. **加了新特性就一定要留 env 逃生门，而且要双向都跑一遍。** 这次如果没有 `NETTV_VSYNCPAN=0`，就只能靠"编译上一版二进制"去二分，代价高一个数量级。默认值该选"用户能用的那一侧"，不是"技术上更优的那一侧"。

## 七、下一步

翻页线程还得修，只是不再挡着播放。候选方案：

- 查崩因：裸 clone（无 `CLONE_SETTLS`）线程里调 `ioctl(WAITFORVSYNC/PAN_DRAW)`、栈上放 `struct fb_var_screeninfo`，与 VSP 解码并发时到底踩了什么；
- 降级方案：不单独起线程，改在主线程内"等 vsync → 同步 PAN"，代价是每帧多 0~18ms（均值约 9ms），21.9fps 大概掉到 17fps 左右。

先等用户目视确认"拖影到底明不明显"，再决定要不要为它付这笔帧率。

---

**本文涉及的文件**（设备端仓库 `/home/lvgl_demo/lvgl_demo`）：`deploy/nettv_player/sprd_msg_np.c`（`vspan_publish()` / `pan_thread()` / `thread_start()`），构建脚本 `deploy/nettv_player/build.sh`。
