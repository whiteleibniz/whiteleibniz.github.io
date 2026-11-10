---
title: "netTV 硬解（42）：1200 秒双臂定案——首 IDR 重投无罪，周期性 SIGSEGV 是累积漂移"
date: 2026-11-10 16:00:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Hardware Decode
  - Debugging
categories:
  - [Project Notes, netTV HW Decode]
  - [Embedded, Spreadtrum Platform]
  - [Engineering Practice, Debugging Methods]
copyright: "Original works by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduce with attribution to whiteleibniz.github.io"
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/11/10/nettv-42-drift-verdict/) · [繁體中文](https://whiteleibniz.github.io/2026/11/10/zh-tw/nettv-42-drift-verdict-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/10/nettv-42-drift-verdict-en/)

> 系列第 42 篇。设备终于回到线上。这一轮只做一件事：把备好的取证编排 `_ntseg2.sh`
> 真机跑起来，给「周期性 SIGSEGV（约 3 分钟一次）」下一个有数据支撑的判决。

## 先说结论

**判决：状态 B（累积漂移）。** 首 IDR 重投（IDRREPLAY）无罪——零次重投的基线臂和重投
3 次的实验臂，崩溃节奏完全一致。崩点不在重投路径上，而在后续真 IDR / 推进路径里，
排查方向转向**泄漏 / 池耗散**。

## 实验设计

两个臂，每臂 1200 秒，同一条 1080p 直播源：

- **A0 臂**：基线配置（IDRREPLAY=0），即历史稳定复现配置；
- **R 臂**：在 A0 基础上把首 IDR 连续重投 3 次（制造「重投窗口」压力）。

判决看三点：每臂 GATE（闸门：残留清零、env 恰好一条、帧证据 ≥5fps、崩溃计数来自
phase.log 的 `mon-child-signal=11`），以及两侧崩溃次数的对比。

## 数据

| 臂 | 重投 | 崩溃次数 | 崩溃间隔 | fps 峰值 | GATE |
|----|------|---------|---------|---------|------|
| A0 | 0 | 6 | ~157s | 283 | V=1 |
| R  | 3 | 7 | ~152-186s | 279 | V=1 |

两臂崩溃节奏一致（151-186 秒，严格的周期性），fps 都正常。如果重投是诱因，R 臂应该
崩得更多或更早；实际 6≈7，**重投这个变量被干净地排除了**。这正是 A/B 双臂的意义：
一个变量，一次判决，不靠猜。

## 两个值得记的细节

**第一轮 600 秒跑出了 NOT_REPRODUCED**——基线臂零崩溃。按 3 分钟一个故障周期，
600 秒只覆盖 2 个周期，泊松方差下完全可能一次都撞不上。延长到 1200 秒（4 个周期）
立刻复现。老经验再次验证：**观测窗口必须 ≥4~5 个故障周期**，否则「没崩」不构成证据。

**测量工具自己出了 bug**：ARM 头行显示 `IDRREPLAY=NETTV_IDRREPLAY`，一查是
`env_key_ok` 函数把参数直接写进全局变量 `k`（没加 `local`），污染了调用方的计数器。
万幸 `mkarm` 在污染发生之前已经用正确的值造好了臂，**实验配置没受影响**——但如果
顺序反过来，这就是一次「工具 bug 伪装成实验结果」的事故。已修复（全部参数加
`local`）并用变异自检验证。

## 附带观察

两臂的 segv.log 都是 0 条：SIGSEGV 处理器一次都没进过。这与之前的根因链（信号掩码
传染 → force_sig_info 强制 SIG_DFL）一致——崩溃落在被屏蔽的执行流上，处理器根本没有
机会执行。`maskedhit` 采样峰值 0，说明采样间隔没撞上掩码窗口，这条线索还没闭环。

## 下一步

状态 B 的两个可判据：**泄漏的指数特征**（崩溃间隔随时间缩短）vs **恒定节拍**
（固定槽位/定时器踩踏）。下一轮把采样里的 CmaFree/ION 字段修好，基线臂延长到
2400 秒，看崩溃是加速还是恒速。

---
*版权声明：本文为 whiteleibniz 原创文章，采用 CC BY-NC-SA 4.0 许可协议。转载请注明出处 whiteleibniz.github.io。*
