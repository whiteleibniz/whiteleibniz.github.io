---
title: 展讯 SC9832A 网络电视攻坚（三）：修好硬解之后，画面为什么永远在循环同一段
categories:
  - [嵌入式, 展讯平台]
  - [嵌入式, 音视频]
tags: [VSP, 硬解, HLS, OMX, LVGL, 展讯]
date: 2026-10-15 02:00:00
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart/) · [繁體中文](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart-en/)


> 版权声明：本文为博主原创文章，遵循 CC 4.0 BY-SA 版权协议，转载请附上原文出处链接和本声明。

前两篇把 1080p 直播流在 SC9832A 上用 VSP 硬解跑通了，也修掉了「第 5 块 mbinfo 分配失败 → 组件永久切软解」的真因。按理说接下来就该是丝滑播放了，结果真机上画面永远是**同一段 2.7 秒反复循环**。这篇记录怎么把这个最后一层窗户纸捅破的。

## 一、现象与量化工具

先给播放器加了个帧率心跳（裸 bionic 下别用 %f，纯整数最稳）：

```c
static void frame_beat(void) {          /* 每解 25 帧打一条 */
    if (!g_t0ms) g_t0ms = sys_time_ms();
    if ((++g_fr % 25) != 0) return;
    long el = sys_time_ms() - g_t0ms;
    P("    [STAT] frames=%u elapsed=%ldms fps_x10=%lu\n",
      g_fr, el, g_fr * 10000UL / el);
}
```

跑 40 秒抓日志，结果非常诡异：

```
[STAT] frames=25 elapsed=2660ms fps_x10=93
[STAT] frames=25 elapsed=2667ms fps_x10=93
[STAT] frames=25 elapsed=2690ms fps_x10=92
```

**永远是 frames=25**，连 elapsed 都几乎不变。也就是说：进程每活 2.7 秒就死一次，然后新进程把完全相同的 AU[23] 再解一遍。

## 二、真凶：一年前的绕过手段变成了毒药

翻源码，找到了 10-09 埋的这段：

```c
/* ★★ 厂商库缺陷(2026-10-09 定案): 第 2 个 GOP 的 IDR 喂入
 * empty(thisBuffer) 必永久挂死……绕过 = 检测到第二个 IDR 立即 _exit(9)
 * 主动重生: 父进程 0.15s 内拉起新子进程, 画面只断 1~2s。 */
if (nt2 == 5) {
    static int idr_seen = 0;
    idr_seen++;
    if (idr_seen > 1) { P("*** GOP#%d IDR 到来, 主动重生…"); _exit(9); }
}
```

时间线还原一下，这是个教科书级的「绕过手段过期」案例：

1. **10-09**：不知道为什么第二个 IDR 会挂死，于是来了个狠的——一到第二个 IDR 就整个进程自杀重启。画面确实能看了（只断 1~2 秒），当时看是"解药"。
2. **10-13**：查明真因是 CMA 池只够 4 块 mbinfo → ENOMEM → 组件永久切软解。做了 mbinfo 复用修复，切软解的现象消失了。
3. **10-15**：但那个「一到第二个 IDR 就自杀」还在。于是现在是：**硬解已经能继续跑了，进程却还是按老规矩在第一个 GOP 边界自杀**。更糟的是，m3u8 的已播段记录（`g_last_seg`）跟着进程一起归零，新进程一上来又拉同一个段——所以画面永远是同一段。

**教训**：绕过手段（workaround）一定要带上"为什么"和"什么时候可以删"的注释，并且在修掉真因之后**回头清理**。它不会自己过期。

修法：默认改成原生续解，`NETTV_RESPAWN=1` 保留逃生门：

```c
static int respawn_on = -1;
if (respawn_on < 0) {
    const char *ev = getenv("NETTV_RESPAWN");
    respawn_on = (ev && ev[0] == '1') ? 1 : 0;
}
if (respawn_on) { P("*** 主动重生(NETTV_RESPAWN=1) ***"); _exit(9); }
P("*** GOP#%d IDR: 原生续解(3s 挂死看门狗兜底) ***", idr_seen);
```

## 三、顺手踩的坑：`gcc | head` 会把编译掐死

顺手还修了个构建脚本 bug，值得单独记一笔：

```sh
gcc ... 2>&1 | head -14     # ❌ 诊断行超过 14 条时，head 关闭管道
                             #    gcc 收到 SIGPIPE 被杀死 → 不产出目标文件
                             #    脚本报 BUILD FAIL，真错误被 head 吃掉
```

改成输出重定向到文件再 `tail`，一次见效。凡是「构建突然开始失败、但报错信息残缺」的场景，先怀疑管道下游。

## 四、结果：好消息和坏消息

改完后 100 秒实测（泸县 1080p 源）：

```
帧回调 280 次（≈140 真帧）/ 4 段 m3u8 / 0 次切软解 / 0 SIGSEGV
[STAT] 稳态 fps_x10=87~93
```

画面能推进了，抓 framebuffer 也抓到了真实图像（街道、台标都对，rot90 正常）。**但**：

1. GOP#2 能原生喂过去了，**GOP#3 的 IDR 还是挂死**（`DRIVE empty(全量)` 永不返回）——所谓「第二个 IDR 挂死」没消失，只是被 mbinfo 修复多撑了一个 GOP。
2. 更有意思的是：**SIGALRM 看门狗在挂死期间完全不送达**（alarm(3)、alarm(6) 都没触发，进程状态是 S 不是 D）。信号这条路在这台设备的厂商库里走不通，最后是让 monitor 父进程在 shm 里立旗标（`shm[4]=1` 表示正在喂 IDR），把停滞宽限从 8 秒压到 2 秒，靠 kill+重启兜底。
3. 抓帧看，画面约 2/3 干净、1/3 是块状马赛克——和日志里「复用块 pa=0x00000000」（mbinfo 复用块拿到的是假物理地址）完全吻合，这是下一个要攻的点。

## 五、下一步

- 给 mbinfo 复用块拿真物理地址（或查清 653824B 的块为什么 `0xc008602a` 和 cmd0 都拿不到 PA）——注意直接换 heap mask 会内核崩，别碰。
- 挂死根除后做多 GOP 长稳 + 换台资源回收。
- 然后才是提帧率：13-20fps → 25fps。

一句话总结：**修 bug 的时候，把当年的绕过手段一起清掉，不然它会在你意想不到的地方变成新 bug。**
