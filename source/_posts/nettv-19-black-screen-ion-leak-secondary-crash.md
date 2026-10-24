---
title: nettv-19：黑屏无反应？——当"必崩"结论撞上 ION 泄漏的次生崩溃（SC9832A 硬解排查实录）
date: 2026-10-21 09:30:00
categories:
  - [嵌入式, 网络电视硬解]
  - [调试, 方法论]
  - [Linux, 内存管理]
tags:
  - sprd
  - SC9832A
  - VSP
  - ION
  - carveout
  - SIGSEGV

---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash-en/)


用户推门进来就一句："网络电视黑屏无反应了。"

设备 ping 通、SSH 正常、桌面进程 `lvgl_demo` 还活着——但播放器 `nettv_player` 的 monitor 看门狗正在无限重启循环，每一轮 worker 都以 `exit 11` 收场，屏幕自然永远黑着。

这篇记录这次排查，重点不是"修了什么代码"，而是一个反复咬人的教训：**你盯了半个月的"必崩"结论，可能只是另一场崩溃的次生现象。**

## 一、现场：进程活着，帧数为零

先看三件套：进程树、日志尾部、dmesg。

```sh
ps | grep -E "[n]ettv|[l]vgl_demo"      # 桌面活着, 播放器在, 但零帧
tail /tmp/nettv.log                     # *** monitor: 重启 (子进程 @0 帧) × 7 轮
dmesg | tail                            # 最后一条是 33 分钟前的 CPU 热插拔, 之后无新记录
```

三个信息拼出来一个判断：

1. **不是内核崩**——dmesg 没有新记录，纯用户态问题；
2. **不是桌面死**——`lvgl_demo` 主进程健在，按键有响应；
3. **是播放器空转**——monitor 每轮拉起 worker，worker 拿不到输出 buffer，`_exit(11)`，monitor 再拉，无限循环。ION/carveout 池被这个循环一口一口吃掉，越循环越抢不到。

`exit 11` 在代码里对应得很清楚（`sprd_msg_np.c` 4673/4674 行）：

```c
} else { P("  alloc 崩溃\n"); which_lib(g_fault); _exit(11); }
if (!bhIn || !bhOut) { P(">>> buffer 分配失败\n"); _exit(11); }
```

**恢复只需一步**：`pkill -f [n]ettv_player`（SIGTERM，让进程走正常的退出路径——退出前有 800ms 的 DMA 排空，异常退出才不回收 ION）。两秒后进程清零，桌面立刻回来了。

## 二、插曲：一个"内存健康探针"

清完场顺手探了一下编译：

```sh
echo "int main(){return 0;}" > /tmp/t.c
gcc -O0 -o /tmp/t.out /tmp/t.c
```

凌晨这台设备的 gcc 还是坏的——`Error relocating /usr/lib/libisl.so.23: <乱码符号>: symbol not found`，可文件本身 md5 两次一致、ELF 头正常、readelf 能读出真符号名。当时定的案：**不是文件损坏，是内存被 VSP/ION 的 DMA 踩坏了页缓存**。设备上午重启后，同一条命令一次通过。

于是得到一个零成本探针，以后开工先跑它：

> **`gcc -O0` 编不过 + libisl 报乱码符号 ⇒ 设备内存被 DMA 踩坏，该重启，别硬修包。**

## 三、重跑基线，"必崩"结论塌了

清场、探针通过，那就把 UI 链路的真实场景复跑一遍——m3u8 直播流、不设任何调优 env、甚至故意带上会触发旧 bug 的毒环境变量，跑 40 秒：

```
[STAT] frames=125 elapsed=7219ms fps_x10=173
[dl] NAL 直方图: g_nau=297 | slice(1)=522 IDR(5)=18 SPS(7)=18 PPS(7)=18
```

**125 帧、17.3fps、18 个 IDR、0 次 SIGSEGV。**

这直接推翻了项目记忆里挂了一个多月的定案——"1080p 直播流第一个 GOP 出 4 帧后，喂第二个 IDR 必 SIGSEGV（addr=0x747474）"。为了这条结论，先后试过 GOT patch、二分连投、UAF 补丁，全都白绕了。

真相是：那个 `0x747474`（ASCII 的 "ttt"，一看就像被 TS 码流数据填进去的地址）从来不是 IDR 的问题，而是 **ION 池被 monitor 重启循环泄漏吃干之后，`alloc` 返回坏指针的次生崩溃**。第一轮 init 时组件就要抢 2MB carveout，输出 buffer 再要 3.2MB，池子总共才个位数 MB；worker 异常退出（`_exit(11)`/信号打死）时 ION 不回收，于是每一轮重启都从剩下的池子里刮一层，刮到某一次 alloc 落到了脏内存上——恰好那次正在喂第二个 IDR。

**根因、次生、巧合，三者在时间线上排成了同一条直线，看起来就像因果。** 这是这次排查最贵的教训。

顺带一提：凌晨想给播放器加"stdout 无缓冲"（崩溃前最后 4KB 日志不再丢）两次构建都失败，当时也差点归因成"代码问题"——实际是 gcc 已经被 DMA 踩坏，跟代码一毛钱关系没有。**同一类"环境/链接"症状，连续栽了两次，可见这个反射弧有多难改。**

## 四、方法论沉淀

把这次的做法固化成三条，下次遇到"黑屏/必崩"直接按这个走：

**1. 黑屏三查（按顺序，一步一结论）**
- `ps` 看桌面进程死没死——死没死决定是"救桌面"还是"救播放器"；
- 播放器日志看是不是空转循环——monitor 重启计数是最刺眼的信号；
- `dmesg` 看有没有新内核记录——没有，就老老实实在用户态找，别往内核甩锅。

**2. SIGTERM 才能回收 ION**
`pkill -f nettv_player` 而不是 `-9`。播放器退出路径里有 DMA 排空和 ION 释放；被信号硬杀等于把池子永久漏掉一块，只能重启设备。池子小（个位数 MB）的项目，**看门狗的每一轮重启都是真金白银的内存**——所以"无新帧就斩杀"这种看门狗策略在小内存池设备上要格外小心，段间隔（~10s）比斩杀阈值长的时候，看门狗杀的就是自己人。

**3. "必崩"结论要过三关**
一条崩溃结论在写进记忆之前，先问自己：
- 换过输入吗？（单 TS 直连 vs m3u8 直播，路径不同）
- 换过资源状态吗？（ION 池满 vs 被泄漏吃干）
- 崩溃地址像什么？（`0x747474` = "ttt" 这种像数据的地址，先怀疑 buffer 被踩，别先怀疑算法）

三关有一关没过的"必崩"，都只是"在当前这一堆前提下的必崩"。

## 五、下一步

- **空帧率 53%**：这次日志里 60 个真帧（`filled=3133440`）对 68 个空帧（`filled=0`）。解码器在 EOS 之后还在被投喂空转，与 `g_nout=1`（只抢到 1 路输出，官方基线 5 路）的单队列结构有关。砍掉空转轮次约等于直接 +50% 有效吞吐，比继续抠 memcpy 划算。
- **UI 首轮失败 vs 手动首轮成功的差异**：同样条件，内核重启后从 UI 点开就 exit 11，手动跑却能出帧。怀疑桌面 `lvgl_demo` 先占了一部分内存/ION，待复现确认。

---

> **版权声明**：本文为原创技术笔记，作者保留所有权利。转载请注明出处（whiteleibniz.github.io），禁止未授权商业用途。
> 文中涉及的设备、源码与结论来自个人嵌入式项目实战记录（展讯 SC9832A / Alpine Linux / LVGL），数据均为实测。
