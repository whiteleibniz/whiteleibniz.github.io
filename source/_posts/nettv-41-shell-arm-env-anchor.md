---
title: "netTV 硬解（41）：把「从没上过机」的脚本先测掉——造臂脚本的末行假设与可执行级自检"
date: 2026-11-10 02:40:00
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

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/11/10/nettv-41-shell-arm-env-anchor/) · [繁體中文](https://whiteleibniz.github.io/2026/11/10/zh-tw/nettv-41-shell-arm-env-anchor-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/10/nettv-41-shell-arm-env-anchor-en/)

> 系列第 41 篇。设备离线第 13 轮，在线实验继续排队。前两轮已经把我们自己的代码从
> 「第二个 IDR 必崩」里摘了出去（边界审计全过），取证工具也备好了。这一轮不猜崩溃，
> 改成先给两个**从没上过机**的脚本做体检——结果真挖出一个会让 50 分钟在线窗口白跑的缺陷。

## 一、这次为什么不继续猜崩溃

上一轮（40）把「第二 IDR SIGSEGV」的在线取证做成两个工具：一个 PC 端符号映射器、
一个设备端两臂编排脚本。它们都还没上过机。而设备已经连续 13 轮不在线（没上电就没网卡），
离线能做的静态分析基本做完了，再往下就是拿没有数据支撑的臆测去改代码——这是要写进
黑历史的做法。

于是换了个角度：**在线窗口是这项目最贵的资源**（22~50 分钟，还要人守着），
先保证那两个脚本不会在窗口里掉链子。

判断标准不是「语法过不过」，而是这个项目已经被咬过两次的那类问题：

- 一次是探测源时只认 HTTP 200，带 `Range` 的探针真实返回 206，于是把三个活源判死；
- 一次是采 `SigBlk` 掩码时用字符串长度做守卫，而真实值是 32 位十六进制串，
  于是采样恒为 0，报告却写「没有线程屏蔽 SIGSEGV」。

两次都**不是语法错**，都会把「测量工具自己的 bug」伪装成「被测系统一切正常」。
所以这轮的验收标准是：能不能用真实格式的样本，把脚本里最容易静默失效的那几段跑出来。

## 二、挖到的真缺陷：造臂脚本假设「wrapper 末行就是 exec」

在线实验要做 A/B，靠的是「造臂」：复制播放器的 wrapper，把本臂要的 `export NETTV_xxx=...`
塞进去。旧实现长这样（两个脚本同源）：

```sh
mkarm() {
  tag=$1; k=$2
  { sed '$d' "$WRAP"            # 去掉末行（以为是 exec）
    echo "export NETTV_IDRREPLAY=$k"
    tail -1 "$WRAP"             # 再把它接回来
  } > /tmp/w_$$tag.sh
}
```

它成立的前提是：**wrapper 的最后一行就是那条 `exec`**。

问题是这个前提没人守。wrapper 只要多一个尾随空行（编辑器保存、`echo >>` 追加、手改留白
都会发生），`sed '$d'` 删掉的是那个空行，`tail -1` 接回来的也还是那个空行，于是：

```
#!/bin/sh
export LD_LIBRARY_PATH=...
exec /usr/local/bin/nettv_player.real "$@"   ← exec 在这里
export NETTV_RPOOL=0                          ← 插到了 exec 之后
export NETTV_RPOOL_IDLE=1                     ← 永远不会执行
```

`exec` 一执行，后面的行就再也不会被 shell 读到了。结果：

- 四条臂**全部跑成现网基线配置**，实验等于没做；
- 判读脚本看到四臂数据一致，会给出「这个配置不崩」的结论——错的是解读，不是脚本报错；
- 原有的 `WRAP_LASTLINE_BAD` 自检只看末行是否含 `NETTV_`，末行是空行，查不出来；
- 唯一能兜住的是「生效 env 硬校验」（要求该键恰好一条且等于期望），但它兜住的代价是
  一个 `INVALID`——**50 分钟在线窗口换来一句"这轮作废"**。

这类缺陷的危险点在于：它不是崩溃，不是报错，而是"数据看起来特别干净"。

## 三、修法：按 `exec` 行定位，而不是按行号猜

把「末行」换成「第一条 `exec` 行」，用 `awk` 在它前面插入：

```sh
awk -v k="$k" '
  /^[[:space:]]*export[[:space:]]+NETTV_IDRREPLAY=/ { next }   # 先删旧的同名 export
  ins==0 && /^[[:space:]]*exec[[:space:]]/ { print "export NETTV_IDRREPLAY=" k; ins=1 }
  { print }
' "$WRAP" > "$out"
```

三个附带收益：

1. 对尾随空行、尾随注释免疫；
2. 删掉 wrapper 里已有的同名 `export`，保证「恰好一条」成立，也顺手让脚本可重跑（幂等）；
3. 万一 wrapper 结构变了、根本没有 `exec` 行，退回旧行为并在文件头写 `ARMK_FALLBACK=1`，
   让人一眼看见，而不是静默生成一个坏文件。

四臂版（`NETTV_RPOOL` / `_IDLE` / `AUDIO_ASYNC` / `HLSBUF`）同样处理，并且先把原文件
落成 `.raw` 再做变换，不再管道套 `sed '$d'`——那种写法一旦中间环节行为变化，很难看出
到底少了一行还是多了一行。

## 四、怎么证明修好了：可执行级 + 变异自检

光自己 `sh -n` 通过没有意义（旧版也通过）。这轮给两个脚本加了 `NTLIB=1` 库模式：
置位后 `source` 只定义函数、不启动实验、不碰日志。测试脚本因此可以**直接加载真文件**，
断言的是线上要跑的那份代码，而不是抄一份副本——函数改了，测试自动跟随。

覆盖三段最容易白跑的判据：

| 用例组 | 测什么 | 关键断言 |
|---|---|---|
| `mkarm` | 尾随空行 / 已有同名 export / 无 exec 行 | 四条 export **紧邻 exec 之上且顺序正确** |
| `env_key_ok` | 匹配 / 值不符 / 重复两条 / 空文件 / 缺文件 | 只有"恰好一条且值相等"才算生效 |
| H2 判据 | 直接从脚本里抽出那 3 行真实代码，喂 8 个真实 `SigBlk` | 大小写、全 0、空串、过短串都不能误判 |

第一条断言特别值得说：最初写成「exec 之前存在这条 export 就算过」，结果它对
「插到 exec 之后」也是绿的——因为 wrapper 体内那行被就地改写后本身就在 exec 之前。
把断言收紧成「**紧邻 exec 上一行**」才真正测到落位。测试写松了，比没有测试更糟：
它会给你一个"已验证"的错觉。

然后是这套测试自己的灵敏度：故意把被测代码改坏，看用例抓不抓得到。

```
--mutcheck
  OK 造臂锚点变异被抓出（退化为旧版末行插入 ⇒ W1 必失败）
  OK 大写 SigBlk 变异被抓出（缺 tr 归一 ⇒ 大写漏采）
  OK bis35c 造臂锚点变异被抓出
MUTCHECK=PASS
```

三条变异全被抓出，说明这 30 项断言不是"恒通过"。测试和被测代码一起被验证，才算数。

## 五、测试自己踩的两个坑

**坑 1：测试驱动自己会假通过。** 第一版驱动用命令替换收集输出、统计 `✗FAIL` 行数。
但相位函数如果一进门就 `return`（比如 `source` 失败），一行 `✗FAIL` 都不会产生，
计数为 0，于是打印 `LIBTEST_RESULT=PASS`——和上一轮「`maskedhit` 恒 0」一模一样的形状。
修法是：每个相位必须输出 `PHASE_RESULT` 且退出码为 0，缺一个就记失败。
**"没有失败样本"不等于"通过"，除非你明确验过"该产生样本的路径确实走了"。**

**坑 2：`dash` 的 `.` 会走 PATH。** `. "_ntseg2.sh"` 在 bash 里按当前目录找，在
`dash`/`ash` 里对无斜杠文件名做 PATH 查找，直接 not found。写成 `. "./$SRC"` 才一致。
平时都在 bash 里写脚本，这类差异只有真拿严格 POSIX shell 跑才会露出来。

## 六、顺手确认的两件事

- 两个脚本在 `dash`（真 POSIX）下 `-n` 通过，各自的判决自检仍是 8 组 / 7 组 + 选源 5 组全对；
- 之前那个崩溃地址 `0x747474`（ASCII `ttt`）在源码里查过：没有对应填充常量、也没有字符型
  `memset`，所以**不是我们自己的填充模式**——嫌疑仍在厂商库或输入 buffer 头，
  等设备回来用线上取证拿 pc 偏移，别在这里继续猜。

## 七、状态与下一步

- 现网仍是上一版二进制，本轮未编译、未部署、未动设备仓库；
- 设备回来后的顺序不变：先过一遍离线自检 → 开跑闸门（路由 + 源可播）→ 每臂 GATE 全 1
  → 最后才看 VERDICT；`INVALID` 整轮重跑，禁止据它改代码；
- 如果生成出来的 wrapper 头一行出现 `ARMK_FALLBACK`，说明设备上 wrapper 结构变了，
  先 `cat` 出来看一眼再跑。

设备第 13 轮离线，这一轮就是把「下次开机不要浪费」这件事做扎实。
