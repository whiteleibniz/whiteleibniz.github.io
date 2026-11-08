---
title: "netTV 硬解（40）：把「第二 IDR 取证三件套」落成工具——判决代码要先于判决被测试"
date: 2026-11-09 02:40:00
tags:
  - 嵌入式
  - 展讯 SC9832A
  - VSP
  - 硬解
  - 调试方法
categories:
  - [项目笔记, netTV 硬解]
  - [嵌入式, 展讯平台]
  - [工程实践, 调试方法]
copyright: "本文由 whiteleibniz 原创，采用 CC BY-NC-SA 4.0 协议，转载请注明出处 whiteleibniz.github.io"
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/11/09/nettv-40-forensic-toolkit-second-idr/) · [繁體中文](https://whiteleibniz.github.io/2026/11/09/zh-tw/nettv-40-forensic-toolkit-second-idr-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/09/nettv-40-forensic-toolkit-second-idr-en/)

> 系列第 40 篇。设备连续第 12 轮没上电，在线实验继续排队。上轮（39）已经用静态审计把我方
> 代码嫌疑清场，本轮做的是纯工具活：把 11-08 定下的「第二 IDR SIGSEGV 在线取证三件套」
> 从三条散落的计划落成**两个可以直接上机的零改码工具**，设备一上电就能跑。

## 1. 三件套是什么、为什么是它

第二 IDR 必 SIGSEGV（addr=0x747474）这个头号问题，39 篇已排除我方越界写，嫌疑收敛到
「厂商库内部」和「输入 buffer 头信任」。要再往下分，只有两条路：在线抓现场，或者继续猜。
猜不值钱，所以本轮把取证方案固化成工具。三件套分别是：

1. **segv 现场 PC → 符号映射**：崩溃处理器输出的 `pc-off` + `lib=` 只是「库内偏移」，
   要落到「哪个函数」才好归因；
2. **`NETTV_IDRREPLAY=K` 重投二分**：v32 内置的诊断开关（2026-10-19 加的，一直没机会跑），
   捕获首 IDR 后零累积连投 K 次——重投即挂是「组件状态」问题（A），重投后才挂是
   「累积漂移」问题（B），修法完全不同；
3. **`[inbuf]`/`[split]` 输入侧日志**：端口重配后输入 buffer 头被改的假设，靠它验证。

关键前提核对：v32 现网二进制里这三个探针**全部已内置**，所以整套取证不需要编译任何新代码，
符合项目「离线只产零改码测量工具」的铁律。

## 2. 工具一：`_pcmap.py`（PC 端，符号映射器）

输入就是 segv 日志原文。解析两类行：

```
*** SIGSEGV sig=b addr=00747474 step: feed-idr
  >>> pc-off=0x3d7c lib=/system/lib/libstagefright_sprd_h264dec.so
```

对每条 `(lib, pc-off)`，在本地 ELF（复用 38 篇那套极简动态符号表解析器）里二分找
「值 ≤ off 的最近符号」，输出形如：

```
pc-off=0x3d7c lib=libstagefright_sprd_h264dec.so
  → _ZN7android14SPRDAVCDecoder20onPortFlushCompletedEj+0x0 [符号内]
```

本地没有的库会明确提示「需从设备拉取」而不是静默跳过——**缺证据要大声说出来**，
这也是这轮反复强调的原则。用真库自测：已知 `SPRDAVCDecoder::onPortFlushCompleted`
在 0x3d7c，映射器精确命中；换一个不存在的库名，正确报缺。

## 3. 工具二：`_ntseg2.sh`（设备端，两臂取证编排）

单脚本一次跑完两臂（每臂默认 600s ≈ 4×150s 故障周期，符合泊松观测铁律）：

- **A0 基线臂**（`IDRREPLAY=0`）：历史稳定复现配置，**必须崩**，否则整轮
  `NOT_REPRODUCED` 禁止下结论——这是把 11-03「对照臂不复现时实验臂的『洁』不具判决力」
  的方法论直接搬过来；
- **R 重投臂**（`IDRREPLAY=3`，`NTSEG2_K` 可调）：首 IDR 连投 3 次。

两臂之外顺手取证（不作判据）：每 20s 逐线程 SigBlk 掩码巡检（H2 判据命中计数）、
每 90s 快照 worker 的 maps（崩溃后进程没了，lib 基址靠它补）、segv.log 按臂归档。

判决是纯函数，8 组模拟分流自检全过：状态 A、状态 B、R 不崩、基线不复现、零帧判废、
env 未生效判废、重投完成后久挂、门槛优先于结果。**两臂跑完 PC 端只需轮询一个
`/tmp/ntseg2.log`**，收尾一律 SIGTERM + usleep 900ms，绝不碰解码中的进程。

## 4. 本轮最值钱的教训：判读代码自己也会撒谎

写采样器时第一版用 shell 的 `case "$sb" in ????)` 做「SigBlk 长度守卫」——只匹配 4 或
8 个字符的值。但真实的 `/proc/.../status` 里 SigBlk 是 **32 位十六进制串**
（如 `00000000000000000000000000000400`），case 守卫会让所有真实值全部落进
`*) continue`，**掩码巡检静默采到恒 0**，最后日志里「maskedhit=0」会被读成
「没有线程屏蔽 SIGSEGV」——一条彻头彻尾的假阴性证据。

这和 11-07 那个「curl 探针只认 200 把 206 的好源判死」是同一类错误：
**测量工具自身的解析 bug 会伪装成被测系统的正常表现**。修法也一样——工具的取值逻辑
必须先用真实数据形态测试过（SigBlk 用 32 位串测），而不是用想当然的短串。现在代码里
留了注释：`# 真实 SigBlk 是 32 位十六进制串, 不能用 case 长度守卫——会漏采`。

## 5. 下次在线怎么跑（约 22 分钟）

```
# 上传 outputs/_ntseg2.sh 后设备端执行：
sh /tmp/_ntseg2.sh 600
# 轮询 /tmp/ntseg2.log，先看两臂 GATE V= 全 1，再看 VERDICT
# 拿到 segv 现场后 PC 端：
python outputs/_pcmap.py <segv日志>
```

INVALID 整轮重跑、禁改码；NOT_REPRODUCED 则把 A0 延到 1200s。拿到判决后再决定走
GOP 边界软复位（A）还是泄漏排查（B）。

---

*本文由 whiteleibniz 原创，采用 CC BY-NC-SA 4.0 协议，转载请注明出处 whiteleibniz.github.io*
