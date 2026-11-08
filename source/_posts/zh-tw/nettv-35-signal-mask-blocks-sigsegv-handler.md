---
title: "netTV 硬解（35）：屏蔽了 SIGSEGV 的線程，處理器永遠跑不到——v34 掩碼淨化與廠商線程鉤子"
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
permalink: zh-tw/2026/11/02/nettv-35-signal-mask-blocks-sigsegv-handler/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/11/02/nettv-35-signal-mask-blocks-sigsegv-handler/) · [繁體中文](https://whiteleibniz.github.io/2026/11/02/zh-tw/nettv-35-signal-mask-blocks-sigsegv-handler-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/02/nettv-35-signal-mask-blocks-sigsegv-handler-en/)

> 系列第 35 篇。上一輪把「處理器為什麼一次都沒跑到」在內核層面解釋成了**可證偽的假說**，這一輪動手把它做成**代碼**：給處理器裝一個"我到底進沒進來"的二值探針，把我們自己造的每一條執行流上的信號屏蔽解掉，再用一個 `pthread_create` 鉤子把廠商庫自建的線程也覆蓋進去。順手挖出一個差點踩進去的經典坑：**`setjmp` 不能包進函數**。

## 1. 先把上一條線索複述清楚

現網每約 150 秒死一次，死因 `st=0xb`（SIGSEGV），但是：

* `/tmp/nettv_segv.log` 一次都沒生成；
* stdout（重定向到 `child.log`）裡沒有處理器的任何一行 dump；
* 加了 `sigaltstack` + `SA_ONSTACK` 之後依然零輸出 ⇒ 排除"棧溢出沒棧可跑"。

內核語義給出的唯一自洽解釋是：硬件同步故障（缺頁/越界）產生的是**線程定向**信號；如果故障發生的那個線程**屏蔽了該信號**，`force_sig_info()` 會把動作強制改回 `SIG_DFL`、清掉掩碼位、然後立刻按默認動作殺進程 —— **用戶態處理器一次都不會被調用**。進程死因顯示 SIGSEGV，現場卻一個字節都沒有。

於是排查對象從"哪塊內存被踩"換成"哪條執行流屏蔽了 SIGSEGV"。

## 2. 屏蔽是怎麼"傳染"的

這是本輪最值得記住的一條：**信號掩碼會被新建的執行流繼承**。

* `fork()`：子進程繼承父進程的掩碼；
* `clone()`（`CLONE_THREAD` 造線程同理）：新線程繼承創建者的掩碼；
* `pthread_create()`：POSIX 明確規定新線程繼承創建線程的信號掩碼。

也就是說，只要在"已屏蔽"的狀態下創建過任何線程，那個線程就會帶著屏蔽一直跑到死。而我們自己的代碼裡恰好有這種地方：

```c
static void rp_block_sig(void) {          /* 屏蔽 SEGV/BUS/ILL/ALRM/TERM/INT/PIPE */
    syscall(175 /* rt_sigprocmask */, 0 /* SIG_BLOCK */, set, 0, 8);
}
static void render_child(void) {
    rp_block_sig();
    signal(SIGSEGV, SIG_DFL);             /* ★ 只復位了"動作", 沒有解除"掩碼" */
    ...
}
```

`signal(..., SIG_DFL)` 改的是 disposition，掩碼還堵著。這個 fork 出來的池子進程一旦 fault，就是標準的"零輸出 + 靜默被殺"，父進程只能看到一行 `[rpool] 子進程失效 → 永久回退串行`。廠商庫自建的線程同理 —— 我們甚至不知道它們屏蔽了什麼，所以只能靠採樣 `/proc/<pid>/task/<tid>/status` 的 `SigBlk` 去看，或者……

## 3. v34 的四處改動（全部行為中性）

### ① 處理器入口二值探針

進處理器第一件事就是落一行，只用 `write` / `open` / `close` 三個異步信號安全調用，不碰堆也不碰 TLS：

```c
static void segv(int sig, siginfo_t *si, void *uc) {
    {   static const char m0[] = "\n*** SIGSEGV-HANDLER-ENTERED ***\n";
        write(1, m0, (int)sizeof m0 - 1);
        int sf0 = open("/tmp/nettv_segv.log", O_WRONLY|O_CREAT|O_APPEND, 0644);
        if (sf0 >= 0) { write(sf0, m0, (int)sizeof m0 - 1); close(sf0); } }
    ...
```

這一行把"處理器到底跑沒跑"從推理變成**讀一行日誌**。順帶在 dump 里加了 `tid=`，一眼能看出崩在哪個線程。

### ② 解屏蔽：`nt_unblock_fatal()`

```c
static void nt_unblock_fatal(void) {
    int sg[] = { SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP, 0 };
    syscall(175 /* rt_sigprocmask */, 1 /* SIG_UNBLOCK */, set, 0, 8);
}
```

調用點：裸 `clone` 出來的線程入口（`thread_start`）、`render_child()`、`pan_thread()`。後兩處原本靠"屏蔽"來避免跨線程 `siglongjmp`，現在處理器自帶了護欄（見 ④），屏蔽不再是必需品。

### ③ `pthread_create` 鉤子：讓廠商庫造的線程也解屏蔽

動態鏈接下可執行文件的符號排在最前，依賴庫 PLT 裡的 `pthread_create` 會綁到我們導出的這一份（編譯本來就有 `-Wl,--export-dynamic`）。

**坑 1：拿真實實現不能用 `RTLD_NEXT`。** 這份源碼第 289 行早就記過："bionic 無 RTLD_NEXT"。更危險的是用 `RTLD_DEFAULT` 會直接拿到**我們自己**，無限遞歸。正確做法是用**顯式 handle** —— `dlopen("libc.so")` 拿到的 handle 只搜該對象及其依賴，永遠繞得開本進程的覆蓋：

```c
int pthread_create(void *tid, const void *attr, nt_pcfn_t fn, void *arg) {
    if (!g_pc_inited) {
        g_pc_inited = 1;
        void *lc = dlopen("/system/lib/libc.so", 2);
        if (lc) g_real_pc = (...)__dlsym_bionic(lc, "pthread_create");
    }
    if (!g_real_pc) return 11;                              /* 絕不遞歸調自己 */
    if (!nt_hook_on()) return g_real_pc(tid, attr, fn, arg); /* 默認純轉發 */
    ...
    return g_real_pc(tid, attr, nt_pc_tramp, w);             /* tramp 裡解屏蔽 */
}
```

默認 `NETTV_PCHOOK=0`（純轉發，行為與 v33 逐字節一致），實驗時置 1 才真鉤 —— 未經聯機驗證的東西不能默認打開。

### ④ 跨線程 `siglongjmp` 護欄

處理器的收尾是 `siglongjmp(g_jb, 1)`，而 `g_jb` 是**設置它的那個線程**的棧上下文。廠商庫自建線程裡 fault 卻跳過去，等於兩個線程共用一塊棧，現場必被沖掉 —— 本文件 4425 行自己就寫過這條鐵律，但只對 `pan_thread` / `render_child` 做了防護，廠商線程一直裸奔。

對策：記錄"誰設的 `g_jb`"，處理器裡比對 tid，不匹配就**不跳**，登記現場後 `_exit(88)`（與 signal 11 一眼可分）。

**坑 2（本輪差點踩進去）：記錄 tid 不能用函數包 `setjmp`。** 我第一版寫成了

```c
static int nt_setjmp(void) { int r = sigsetjmp(g_jb, 1); if (r == 0) g_jb_tid = nt_tid(); return r; }
```

這行不通：`setjmp` 家族保存的是**調用點所在的棧幀**，包進函數後函數一返回那幀就死了，之後 `siglongjmp` 過去是標準明確寫了的**未定義行為**（棧上那段保存 LR 的區域早被後續調用踩爛）。必須用宏，把整件事留在調用者幀內完成：

```c
#define SETJB() (g_jb_tid = nt_tid(), sigsetjmp(g_jb, 1))
```

全文件 11 處 `sigsetjmp(g_jb,1)` 機械替換成 `SETJB()`。

## 4. 順帶做的離線靜態審計（結論：H1 在我們自己的代碼裡被證偽）

設備這輪仍然離線，所以先把"資源洩漏觸頂"（假說 H1）能靜態排除的都排掉：

| 懷疑對象 | 結論 |
| --- | --- |
| 幀號索引的 ~4096 項定長表（4200 幀 ≈ 150s，數字太巧） | 不存在，全文件 `4096` 只出現在頁對齊/`g_chunk`/shm 尺寸 |
| 每幀 `mmap` 不 `munmap`（VMA 洩漏） | 每幀路徑只有 `if (g_dump)` 內的落盤 mmap，且成對 `munmap`；播放器模式 `g_dump=0` |
| 每幀 `open` 洩漏 fd | 同上，只在落盤分支 |
| ION 記錄數組 | `ionrec_add()` 有 `g_ionrec_n >= IONRECN` 上限，有界 |
| m3u8 段數組 | `g_segs[HLS_SEG_MAX]` 寫入前判 `g_segs_n < HLS_SEG_MAX`，有界 |
| 處理器在打印前二次 fault（例如 `g_last` 是野指針） | `static char g_last[64]`，永遠是有效地址，排掉 |

結論：**我們自己的代碼裡找不到任何隨時間單調增長的資源**，H1 只剩"廠商庫內部洩漏"這一種可能，而那正好是 `_hw34.sh` 用 RSS / threads / fd / ION 曲線能量到的。

## 5. 判讀表（下輪聯機一次出結果）

跑 `sh /tmp/_r34.sh 900`（v34 + `NETTV_PCHOOK=1` + 現網同源），同時起 `sh /tmp/_hw34.sh 900 3` 採樣：

| 現象 | 判定 | 下一步 |
| --- | --- | --- |
| `segv.log` 裡出現 `HANDLER-ENTERED` | 處理器跑到了 | 直接讀 `pc/lr/sp/addr/tid`，崩潰點一次鎖定 |
| 沒有 `HANDLER-ENTERED`，但 `[rpool]` 出現 `signal=11` | 死的是我們 fork 的池子進程 | 修池子，與廠商線程無關 |
| 兩者都沒有，仍然每 ~150s 死一次 | 屏蔽不在覆蓋範圍內 | 看 `_hw34.sh` 的逐線程 `SigBlk`，對號入座 |
| 曲線單調漲 | H1（廠商庫洩漏） | 追洩漏點，或"每 N 段主動重生"兜底 |

## 6. 待驗證

* v34 能否在設備上編譯通過（`pthread_create` 同名導出 + `dlopen("libc.so")` 是唯一的編譯/運行風險點）；
* `NETTV_PCHOOK=1` 下廠商庫能否正常建線程（鉤子一旦失效，播放器會起不來，所以默認關）；
* 三語版本同步發佈。

---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
