---
title: 展讯 SC9832A 网络电视攻坚（五）：播放器把系统盘写爆了——每帧日志的代价，以及"花屏"其实强依赖源
categories:
  - [嵌入式, 展讯平台]
  - [嵌入式, 音视频]
tags: [VSP, 硬解, fb, 日志, m3u8, 展讯, 嵌入式]
date: 2026-10-16 16:00:00
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality/) · [繁體中文](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality-en/)


> 版权声明：本文为博主原创文章，遵循 CC 4.0 BY-SA 版权协议，转载请附上原文出处链接和本声明。

上一篇（四）把"假物理地址"修掉了，第二个 IDR 不再崩、也不再切软解。这次接着在真机上验证，结果顺手抓出一个跟画面无关、但足以让整机"慢性死亡"的问题：**播放器把系统盘写爆了**。同时把"到底修好没修好"这件事，拆成两个更准确的结论：画面质量其实强依赖源，而 IDR 挂死才是真正的拦路虎。

## 一、现象：几小时后 /tmp/lvgl_demo.log 变成 131MB

验证时习惯性看一眼磁盘，发现 `/tmp/lvgl_demo.log` 已经 **131621286 字节（≈131MB）**，而根分区只剩 586MB（91% 已用）。更糟的是它还在涨。

日志尾巴长这样，一眼就能看出刷屏源：

```
    DRIVE empty(全量): m=0xb0b7a400 what=3048035944 hdr=0xb6cced70
    DRIVE empty(全量) → 返回, 队列:  in  queue=0xb4ec9304 begin=b4e8c060 end=00000000 (空)
    DRIVE fill(out): m=0xb0b7ae00 what=3048035944 hdr=0xb6ccedc0
    DRIVE fill(out) → 返回, 队列: ...
```

每条诊断本身没问题——调试硬解时全靠它。问题是**它每帧都在打**，而且不止一处。

## 二、根因：三层叠加

1. **投喂日志是"每帧级"的。** `DRIVE` 宏每投喂一个 buffer 就打两行（还有队列快照），一帧要投喂好几次 → 实测 **~9KB/s**。
2. **厂商解码库也往 stdout 打。** `SprdSimpleOMXComponent` / `SPRDAVCDecoder` 内部有 `fillThisBuffer` / `onQueueFilled` 之类的打印，跟着我们的调用一起吐。
3. **最要命的一点：UI 拉起的播放器继承了 UI 的 stdout。** 网络电视页是 `fork + execl("/usr/local/bin/nettv_player", url)`，没有重定向——于是播放器的所有输出都灌进了 LVGL 主程序的日志文件 `/tmp/lvgl_demo.log`。

9KB/s × 几小时 = 上百 MB。对一个 24 小时开着的电视盒子，这是必然爆盘。

## 三、修法：一个闸门 + 一次重定向绑定

思路是两条：

**① 每帧诊断加开关（默认关）。** 加一个只认环境变量的闸门：

```c
static int g_vlog = -1;
static int vlog_on(void) {
    if (g_vlog < 0) {
        const char *e = getenv("NETTV_VLOG");
        g_vlog = (e && *e && *e != '0') ? 1 : 0;
    }
    return g_vlog;
}
```

然后把 `DRIVE` 宏里的两行、以及每帧的"已上屏"打印用 `if (vlog_on())` 包起来。要查问题时 `NETTV_VLOG=1` 跑一次即可，平时零开销。

**② 把子进程的输出"绑"到一个每次重生都截断的固定文件。** 因为厂商库的打印我们在源码里管不着，只能从 fd 层面下手：

```c
static void child_log_bound(void) {
    if (vlog_on()) return;                        /* 调试模式: 保留调用方重定向 */
    int f = open("/tmp/nettv_child.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    dup2(f, 1); dup2(f, 2);
    if (f > 2) close(f);
}
```

在 monitor `fork` 出来的子进程一开始就调用它。两个好处叠加：

- UI 的 `/tmp/lvgl_demo.log` 不再被灌（播放器输出进了自己的文件）；
- 这个文件是 **O_TRUNC** 打开的，而 monitor 每次兜底重生都会重新 `fork` 一次 → 文件被反复截断，磁盘占用被死死限制在"**单个子进程**"的量级。

**实测对比：**

| 指标 | 修前 | 修后 |
| --- | --- | --- |
| `/tmp/lvgl_demo.log` | 131MB（持续涨） | **965 字节** |
| 子进程日志 | 混在 UI 日志里 | `/tmp/nettv_child.log`，~59KB（单子进程） |
| 每帧诊断 | 每帧多行 | 默认 0（`NETTV_VLOG=1` 才开） |
| `[STAT]` 心跳 | 有 | 保留（每 25 帧一条） |

## 四、顺带纠正两个认知

这次是"上机验证"，验证过程本身纠正了两个之前的判断：

**① "花屏"不是二元的，它强依赖源。**
- 好源（lxfile 泸县/成都）：画面主体清晰，只有中右局部糊 + 边缘少量块状；
- 差源（某 cztv 1080p 频道）：几乎全屏花，不可辨认。

也就是说，用"有没有马赛克"来判断"修没修好"是不准的——得固定用一个已知好源做基线。

**② 真正的稳定性拦路虎仍是 IDR 挂死，跟假 PA 无关。**
日志显示每个子进程都终止在同一点：

```
  ── empty AU[69] 104222 字节 @7876ms t=5 (8c=1, 9a清0) ──
*** GOP#3 IDR: 原生续解(3s 挂死看门狗兜底) ***
```

即：**喂第 3 个 GOP 的 IDR 时，`DRIVE empty(全量)` 永不返回**——和上一篇的结论一致（假 PA 不是它的根因）。monitor 每 ~8-30s 兜底重生一次，所以画面是"能看几分钟、卡一下、再恢复"的节奏。要"稳定流畅"，下一步必须啃这块。

（附带一个小插曲：抓屏时发现两次抓到的帧**字节完全相同**，一度以为画面卡死。后来才想起播放器有"帧签名去重"——只在画面签名变化时才重绘 fb。静态场景下两帧相同是**正常优化**，不是故障。抓图验证动态画面时得选有运动的场景。）

## 五、一句话教训

> **调试打印是双刃剑：调的时候越详细越好，上线的时候越安静越好。** 尤其是当程序是被别的进程 `fork+exec` 拉起、又没有重定向 stdout 时——你以为"只是多打了几行日志"，几小时后就变成了一颗 131MB 的定时炸弹。给它一个环境变量开关，再把子进程的输出绑到一个会被自动截断的文件上，代价几乎为零，收益是整机不会慢性死亡。
