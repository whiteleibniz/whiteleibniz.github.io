---
title: "netTV 硬解（35）：屏蔽了 SIGSEGV 的线程，处理器永远跑不到——v34 掩码净化与厂商线程钩子"
date: 2026-11-02 02:30:00
tags:
  - 嵌入式
  - 展讯 SC9832A
  - VSP 硬解
  - 崩溃取证
  - Linux 信号
categories:
  - [项目笔记, netTV 硬解]
  - [嵌入式, 展讯平台]
copyright: 本文为原创，遵循 CC BY-NC-SA 4.0 协议，转载请注明出处：whiteleibniz.github.io
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/11/02/nettv-35-signal-mask-blocks-sigsegv-handler/) · [繁體中文](https://whiteleibniz.github.io/2026/11/02/zh-tw/nettv-35-signal-mask-blocks-sigsegv-handler-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/02/nettv-35-signal-mask-blocks-sigsegv-handler-en/)

> 系列第 35 篇。上一轮把「处理器为什么一次都没跑到」在内核层面解释成了**可证伪的假说**，这一轮动手把它做成**代码**：给处理器装一个"我到底进没进来"的二值探针，把我们自己造的每一条执行流上的信号屏蔽解掉，再用一个 `pthread_create` 钩子把厂商库自建的线程也覆盖进去。顺手挖出一个差点踩进去的经典坑：**`setjmp` 不能包进函数**。

## 1. 先把上一条线索复述清楚

现网每约 150 秒死一次，死因 `st=0xb`（SIGSEGV），但是：

* `/tmp/nettv_segv.log` 一次都没生成；
* stdout（重定向到 `child.log`）里没有处理器的任何一行 dump；
* 加了 `sigaltstack` + `SA_ONSTACK` 之后依然零输出 ⇒ 排除"栈溢出没栈可跑"。

内核语义给出的唯一自洽解释是：硬件同步故障（缺页/越界）产生的是**线程定向**信号；如果故障发生的那个线程**屏蔽了该信号**，`force_sig_info()` 会把动作强制改回 `SIG_DFL`、清掉掩码位、然后立刻按默认动作杀进程 —— **用户态处理器一次都不会被调用**。进程死因显示 SIGSEGV，现场却一个字节都没有。

于是排查对象从"哪块内存被踩"换成"哪条执行流屏蔽了 SIGSEGV"。

## 2. 屏蔽是怎么"传染"的

这是本轮最值得记住的一条：**信号掩码会被新建的执行流继承**。

* `fork()`：子进程继承父进程的掩码；
* `clone()`（`CLONE_THREAD` 造线程同理）：新线程继承创建者的掩码；
* `pthread_create()`：POSIX 明确规定新线程继承创建线程的信号掩码。

也就是说，只要在"已屏蔽"的状态下创建过任何线程，那个线程就会带着屏蔽一直跑到死。而我们自己的代码里恰好有这种地方：

```c
static void rp_block_sig(void) {          /* 屏蔽 SEGV/BUS/ILL/ALRM/TERM/INT/PIPE */
    syscall(175 /* rt_sigprocmask */, 0 /* SIG_BLOCK */, set, 0, 8);
}
static void render_child(void) {
    rp_block_sig();
    signal(SIGSEGV, SIG_DFL);             /* ★ 只复位了"动作", 没有解除"掩码" */
    ...
}
```

`signal(..., SIG_DFL)` 改的是 disposition，掩码还堵着。这个 fork 出来的池子进程一旦 fault，就是标准的"零输出 + 静默被杀"，父进程只能看到一行 `[rpool] 子进程失效 → 永久回退串行`。厂商库自建的线程同理 —— 我们甚至不知道它们屏蔽了什么，所以只能靠采样 `/proc/<pid>/task/<tid>/status` 的 `SigBlk` 去看，或者……

## 3. v34 的四处改动（全部行为中性）

### ① 处理器入口二值探针

进处理器第一件事就是落一行，只用 `write` / `open` / `close` 三个异步信号安全调用，不碰堆也不碰 TLS：

```c
static void segv(int sig, siginfo_t *si, void *uc) {
    {   static const char m0[] = "\n*** SIGSEGV-HANDLER-ENTERED ***\n";
        write(1, m0, (int)sizeof m0 - 1);
        int sf0 = open("/tmp/nettv_segv.log", O_WRONLY|O_CREAT|O_APPEND, 0644);
        if (sf0 >= 0) { write(sf0, m0, (int)sizeof m0 - 1); close(sf0); } }
    ...
```

这一行把"处理器到底跑没跑"从推理变成**读一行日志**。顺带在 dump 里加了 `tid=`，一眼能看出崩在哪个线程。

### ② 解屏蔽：`nt_unblock_fatal()`

```c
static void nt_unblock_fatal(void) {
    int sg[] = { SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP, 0 };
    syscall(175 /* rt_sigprocmask */, 1 /* SIG_UNBLOCK */, set, 0, 8);
}
```

调用点：裸 `clone` 出来的线程入口（`thread_start`）、`render_child()`、`pan_thread()`。后两处原本靠"屏蔽"来避免跨线程 `siglongjmp`，现在处理器自带了护栏（见 ④），屏蔽不再是必需品。

### ③ `pthread_create` 钩子：让厂商库造的线程也解屏蔽

动态链接下可执行文件的符号排在最前，依赖库 PLT 里的 `pthread_create` 会绑到我们导出的这一份（编译本来就有 `-Wl,--export-dynamic`）。

**坑 1：拿真实实现不能用 `RTLD_NEXT`。** 这份源码第 289 行早就记过："bionic 无 RTLD_NEXT"。更危险的是用 `RTLD_DEFAULT` 会直接拿到**我们自己**，无限递归。正确做法是用**显式 handle** —— `dlopen("libc.so")` 拿到的 handle 只搜该对象及其依赖，永远绕得开本进程的覆盖：

```c
int pthread_create(void *tid, const void *attr, nt_pcfn_t fn, void *arg) {
    if (!g_pc_inited) {
        g_pc_inited = 1;
        void *lc = dlopen("/system/lib/libc.so", 2);
        if (lc) g_real_pc = (...)__dlsym_bionic(lc, "pthread_create");
    }
    if (!g_real_pc) return 11;                              /* 绝不递归调自己 */
    if (!nt_hook_on()) return g_real_pc(tid, attr, fn, arg); /* 默认纯转发 */
    ...
    return g_real_pc(tid, attr, nt_pc_tramp, w);             /* tramp 里解屏蔽 */
}
```

默认 `NETTV_PCHOOK=0`（纯转发，行为与 v33 逐字节一致），实验时置 1 才真钩 —— 未经联机验证的东西不能默认打开。

### ④ 跨线程 `siglongjmp` 护栏

处理器的收尾是 `siglongjmp(g_jb, 1)`，而 `g_jb` 是**设置它的那个线程**的栈上下文。厂商库自建线程里 fault 却跳过去，等于两个线程共用一块栈，现场必被冲掉 —— 本文件 4425 行自己就写过这条铁律，但只对 `pan_thread` / `render_child` 做了防护，厂商线程一直裸奔。

对策：记录"谁设的 `g_jb`"，处理器里比对 tid，不匹配就**不跳**，登记现场后 `_exit(88)`（与 signal 11 一眼可分）。

**坑 2（本轮差点踩进去）：记录 tid 不能用函数包 `setjmp`。** 我第一版写成了

```c
static int nt_setjmp(void) { int r = sigsetjmp(g_jb, 1); if (r == 0) g_jb_tid = nt_tid(); return r; }
```

这行不通：`setjmp` 家族保存的是**调用点所在的栈帧**，包进函数后函数一返回那帧就死了，之后 `siglongjmp` 过去是标准明确写了的**未定义行为**（栈上那段保存 LR 的区域早被后续调用踩烂）。必须用宏，把整件事留在调用者帧内完成：

```c
#define SETJB() (g_jb_tid = nt_tid(), sigsetjmp(g_jb, 1))
```

全文件 11 处 `sigsetjmp(g_jb,1)` 机械替换成 `SETJB()`。

## 4. 顺带做的离线静态审计（结论：H1 在我们自己的代码里被证伪）

设备这轮仍然离线，所以先把"资源泄漏触顶"（假说 H1）能静态排除的都排掉：

| 怀疑对象 | 结论 |
| --- | --- |
| 帧号索引的 ~4096 项定长表（4200 帧 ≈ 150s，数字太巧） | 不存在，全文件 `4096` 只出现在页对齐/`g_chunk`/shm 尺寸 |
| 每帧 `mmap` 不 `munmap`（VMA 泄漏） | 每帧路径只有 `if (g_dump)` 内的落盘 mmap，且成对 `munmap`；播放器模式 `g_dump=0` |
| 每帧 `open` 泄漏 fd | 同上，只在落盘分支 |
| ION 记录数组 | `ionrec_add()` 有 `g_ionrec_n >= IONRECN` 上限，有界 |
| m3u8 段数组 | `g_segs[HLS_SEG_MAX]` 写入前判 `g_segs_n < HLS_SEG_MAX`，有界 |
| 处理器在打印前二次 fault（例如 `g_last` 是野指针） | `static char g_last[64]`，永远是有效地址，排掉 |

结论：**我们自己的代码里找不到任何随时间单调增长的资源**，H1 只剩"厂商库内部泄漏"这一种可能，而那正好是 `_hw34.sh` 用 RSS / threads / fd / ION 曲线能量到的。

## 5. 判读表（下轮联机一次出结果）

跑 `sh /tmp/_r34.sh 900`（v34 + `NETTV_PCHOOK=1` + 现网同源），同时起 `sh /tmp/_hw34.sh 900 3` 采样：

| 现象 | 判定 | 下一步 |
| --- | --- | --- |
| `segv.log` 里出现 `HANDLER-ENTERED` | 处理器跑到了 | 直接读 `pc/lr/sp/addr/tid`，崩溃点一次锁定 |
| 没有 `HANDLER-ENTERED`，但 `[rpool]` 出现 `signal=11` | 死的是我们 fork 的池子进程 | 修池子，与厂商线程无关 |
| 两者都没有，仍然每 ~150s 死一次 | 屏蔽不在覆盖范围内 | 看 `_hw34.sh` 的逐线程 `SigBlk`，对号入座 |
| 曲线单调涨 | H1（厂商库泄漏） | 追泄漏点，或"每 N 段主动重生"兜底 |

## 6. 待验证

* v34 能否在设备上编译通过（`pthread_create` 同名导出 + `dlopen("libc.so")` 是唯一的编译/运行风险点）；
* `NETTV_PCHOOK=1` 下厂商库能否正常建线程（钩子一旦失效，播放器会起不来，所以默认关）；
* 三语版本同步发布。

---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
