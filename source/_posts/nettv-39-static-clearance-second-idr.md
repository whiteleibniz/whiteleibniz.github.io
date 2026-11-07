---
title: "netTV 硬解（39）：静态排除法——第二个 IDR SIGSEGV，先把「我方嫌疑」清场"
date: 2026-11-08 02:40:00
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

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr/) · [繁體中文](https://whiteleibniz.github.io/2026/11/08/zh-tw/nettv-39-static-clearance-second-idr-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr-en/)

> 系列第 39 篇。设备又没上电（连续第 11 轮），在线实验做不了。这次把一个悬了很久的问
> 题做了零成本的推进：**第二个 IDR 必 SIGSEGV、故障地址 0x747474**——先用静态审计把
> "我们自己代码越界写" 这个嫌疑整个清掉，把在线取证的范围缩小一半以上。

## 1. 崩溃现场像什么

崩溃记录里的故障地址是 `0x747474`。按小端读内存，这仨字节是 `74 74 74 00`，也就是
ASCII 的 `"ttt\0"`。**一个像文本数据、不像合法地址的值出现在了指针位置上**——这是典
型的「指针被数据覆盖」特征：某处把流数据写过了界，把旁边结构体里的指针踩了，之后解引
用它的那一刻才崩。

所以排查方向很清楚：找到所有「往紧凑结构体旁边写数据」的拷贝点。在我们的播放器里，
就是 NAL 投喂路径上的每一次 `memcpy`。

## 2. 九处 memcpy，逐一过堂

把现网 v32 源码里全部 9 处 `memcpy`/`memmove` 拉出来，逐个核对边界检查：

| # | 位置 | 拷贝目标 | 边界保证 | 结论 |
|---|------|----------|----------|------|
| 1 | `rb_put` | 环形缓冲 slot | `n ≤ RB_DCAP/2` 先挡 + 背压检查 + 跨尾回绕 | ✅ 有界 |
| 2 | `auagg_add` | AU 聚合缓冲 | 超限先 flush、单 NAL 超限直投 | ✅ 有界 |
| 3 | `idrmix_feed` | 连体投喂缓冲 | 首段 memcpy 未查 SPS 长度，但 SPS 仅几十字节且该路径默认关 | ✅ 实际有界 |
| 4 | `cfg` 写入 | SPS..IDR 连续区 | `(idr_end - sps_at) ≤ sizeof cfg` 显式检查 | ✅ 有界 |
| 5 | `nal_local` 拷出 | 512KB 本地副本 | `nlen > sizeof nal_local` 直接跳过 | ✅ 有界 |
| 6 | IDR 重投诊断 | 512KB 重投缓冲 | `nlen ≤ sizeof irp_buf` 显式检查 | ✅ 有界 |
| 7 | 首段投喂 | 输入 buffer | `n > bhIdr->nAllocSize` 先跳过再拷 | ✅ 有界 |
| 8 | 拆段循环 | 输入 buffer 偏移处 | `segs[si]+slen > n` 则 continue，子块由 csz 切分推导 | ✅ 有界 |
| 9 | 渲染/out 路 | fb 与 staging | 定长 3MB / 定长 24 字结构 | ✅ 有界 |

连带查了两个易漏点：URL 拼接的 `memcpy(host, p, hl)` 有 `hl ≥ sizeof host` 钳位；
out 路补分配的 24 字结构拷贝双方都是定长静态数组。

**结论：我方投喂/渲染路径上不存在能踩坏指针的越界写。**

## 3. 嫌疑收敛到哪

清场之后，嫌疑只剩两类：

1. **厂商库内部**。我们绕过 OMX 第二层直接驱动 `SprdSimpleOMXComponent`，输入
   buffer 头（`pBuffer`/`nAllocSize`）与组件内部结构全由厂商代码维护。历史已有
   ptrace 定案的「GOP#3 IDR 全量 DRIVE 触发输入队列 UAF」，就是这一类。
2. **缓冲头本身的信任问题**。我们每轮都信 `bhIdr->nAllocSize`/`pBuffer`，如果某轮
   厂商侧把头改了（比如端口重配后没重建），我们的「有界」检查就界错了对象。

顺带说明：这个崩溃在现网 v32 已经被多层缓解（超限跳过、32KB 拆段、IDR 看门狗、软解
降级重生），所以它表现为「历史现象」而不是「日常事故」。但根因没定位，缓解层就是
在薄冰上跑。

## 4. 在线取证清单（设备一上电就能跑）

- **处理器已修好**（uc 偏移 +32），崩溃时会留下 addr/pc/寄存器。拿到 pc 后用
  `elf_syms.py` 映射：落在我们的 `.text` → 审计有漏；落在厂商库 → 第 1 类实锤。
- **`NETTV_IDRREPLAY=K`**（v32 内置诊断）：捕获首 IDR 后连投 K 次。第一次重投就挂
  → 组件状态问题（A）；重投不挂、正常播放到第 2 个真 IDR 才挂 → 累积漂移（B）。
  这一个 env 就能把成因二分掉。
- 关注 `[inbuf]`（超限跳过）与 `[split]`（拆段）日志：如果崩溃前有超限跳过记录，
  说明流里出现了比历史更大的 NAL，先查源再查代码。

## 5. 方法论收尾

故障地址像文本数据 ⇒ 先怀疑「指针被数据覆盖」；而**覆盖发生的地点和崩溃的地点通常
不是同一个地方**，所以不能只在崩溃栈附近找。静态清场的价值在于：花半小时把「我们
自己不会越界」变成有据的结论，在线窗口（本项目最贵的资源）就不用浪费在排查自己身上。

**负面结果也是结果**：这一轮没有改任何代码，但搜索空间从「全部代码」缩到了「厂商库
+ 缓冲头信任」两类，下次复现时取证路径是现成的。

> 🌐 其他语言：[繁體中文](https://whiteleibniz.github.io/2026/11/08/zh-tw/nettv-39-static-clearance-second-idr-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr-en/)
