---
title: 展訊 SC9832A 網絡電視攻堅（二十二）：一個"治拖影"的翻頁線程，讓每個 IDR 都崩
categories:
  - [嵌入式, 展讯平台]
  - [嵌入式, 音视频]
  - [调试方法, A/B 实验]
tags: [VSP, 硬解, SIGSEGV, vsync, framebuffer, LVGL, 展讯, 裸clone线程]
date: 2026-10-22 02:00:00
permalink: zh-tw/2026/10/22/nettv-22-vsync-pan-thread-idr-segv/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv/) · [繁體中文](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv-en/)


> 版權聲明：本文為博主原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處鏈接和本聲明。

上一篇我們把幀率從 14.3fps 推到 21.8fps，順手還塞進兩個"用戶體驗修復"：curl 抗弱網（治卡頓）和**獨立 vsync 翻頁線程**（治拖影）。結果第二天一跑——**零幀，每次喂 IDR 就 SIGSEGV，看門狗無限重啟**。這篇講怎麼用一次乾淨的背靠背 A/B 把真兇釘死，以及一個更值錢的教訓：**崩潰現場的日誌，往往是最會騙人的那一層**。

## 一、現象：0 幀 + 無限重啟

默認配置跑瀘縣 1080p 源，父進程日誌只有這些：

```
*** monitor: 子進程自退 st=0xb ***
*** monitor: 重啟 (子進程 @0 幀)
（重複 6 次）
```

`st=0xb` = 子進程被 11 號信號（SIGSEGV）打死。子進程日誌 `/tmp/nettv_child.log` 裡只有 16 行，看起來"連解碼器都沒起來"。

## 二、第一層誤判：看 child.log 會被騙得很慘

先說結論：**這個場景下唯一可信的軌跡是 `/tmp/phase.log`，不是子進程 stdout。**

原因有三個，疊在一起：

1. 裸 bionic（`nostdlib -Wl,--entry=main`）下 `_exit()` **不 flush stdio**，進程一崩緩衝區裡的東西全丟；
2. stdout 是 4KB 全緩衝，只有寫滿 4KB 才會落盤一次——所以你看到的往往只是"第一個 4KB"；
3. monitor 每次重啟子進程都會 `O_TRUNC` 截斷 child.log，前面幾代的全部線索直接抹掉。

而 `ph()` / `phx()` 這兩個診斷函數是 `open(O_APPEND|O_SYNC)` 直接 write 的，崩了也不丟一行。於是判崩潰點的正確姿勢是：

```sh
grep -B3 'mon-child-signal=11' /tmp/phase.log
```

一查，七次崩潰**完全同構**：

```
t=... DRIVE empty(in) 喂 IDR+SPS+PPS (Annex-B 全序列, nFlags=0)
t=... mon-child-signal=11 st=0xb
```

崩潰點 100% 落在"投餵 IDR"之後。

## 三、第二層誤判：`g_gh_n=0` 不是"ION 池被吃幹"

日誌裡有這麼一行，很容易被當成鐵證：

```
[earlyion] 可用輸出路數 g_nout=1 (g_gh_n=0)
```

我以前的筆記裡也確實把它寫成了"ION 池被洩漏吃幹 ⇒ 必須重啟設備"。**這是誤讀。** 看代碼：

```c
int early = 0;                      /* NETTV_EARLY 默認 0 */
for (char **ep = environ; *ep; ep++)
    if (!strncmp(*ep, "NETTV_EARLY=", 12)) early = atoi(*ep + 12);
for (int i = 0; i < early; i++) { ... g_gh_n++; }
```

默認 `early=0`，循環一次都不跑，`g_gh_n` **必然是 0**——這是"組件先拿足內存、輸出緩衝在組件 init 後再分配"這條 10-18 定案的正常表現，跟池子空不空沒關係。

順手把"池到底空不空"也證偽掉了，這兩條命令值得記下來：

```sh
cat /sys/kernel/debug/ion/clients          # 空 ⇒ 沒有進程持 ION
cat /sys/kernel/debug/dma_buf/bufinfo      # Total 0 objects ⇒ 沒有洩漏的 dma_buf
```

兩個都是乾淨的，所以這次**不是**"池被吃幹 → 重啟設備"，別急著按老藥方抓藥。

## 四、真兇：一個剛加的"治拖影"線程

4f2f17f 裡新增了兩處：curl 限速參數（跟解碼無關），以及**獨立 vsync 翻頁線程**——等 `FBIO_WAITFORVSYNC` 消隱期再 `FBIO_PAN_DRAW`，把翻頁從"隨機掃描相位"改成"消隱期內翻頁"，治運動畫面的撕裂。

它有 env 逃生門 `NETTV_VSYNCPAN=0`，於是這就是一次天然的單變量 A/B。同一份二進制、同一段 TS、背靠背跑：

| 組 | env | signal=11 次數 | 真幀 | fps | 牆鍾 |
|---|---|---|---|---|---|
| A | 默認（翻頁線程開） | **6** | 0 | — | — |
| B | `NETTV_VSYNCPAN=0` | 0 | 1094 | 21.6 | 41.9 ms |
| A2（複測） | 默認 | **6** | 0 | — | — |
| B2（複測） | `NETTV_VSYNCPAN=0` | 0 | 1094 | 21.6 | 41.9 ms |

四組數據，A 側兩次全崩、B 側兩次全活，幀率還正好是我們熟悉的 21.6fps。**同二進制、唯一變量、雙向復現**——這就不用再吵了。

### 它跟"第二個 IDR 必崩"是同一件事

有個反直覺的細節：翻頁線程是 `vspan_publish()` 在**第一幀渲染之後**才創建的，那為什麼崩潰發生在"第一個 IDR"？

因為崩潰的是 monitor 重啟後的**後續代**。每一代跑起來 → 出幾幀 → 創建翻頁線程 → 喂下一個 IDR → 崩；而 child.log 被 O_TRUNC 抹掉了前幾代的幀輸出，只剩下最後一代那幾行"還沒出幀就死了"的假象。

翻回曆史筆記——10-15 那篇"第二個 IDR 必崩"[當時歸因為 ION 池幹掉的次生崩潰]，10-21 那篇"第二個 IDR 必崩已否證"——**真正的答案既不是"IDR 有毒"，也不是"池子漏了"，而是這條線程**。它是在 10-21 晚上才加進去的，時間線也對得上。

## 五、處置：一行，把默認值翻到安全側

```c
static inline void vspan_publish(int pg) {
    if (g_pan_off) return;
    if (g_vspan < 0) {
        const char *e = getenv("NETTV_VSYNCPAN");
-       g_vspan = (e && e[0] == '0') ? 0 : 1;
+       g_vspan = (e && e[0] == '1') ? 1 : 0;   /* 10-22: 默認關(必崩), =1 才開 */
    }
    ...
}
```

重建部署後，默認（**不設任何 env**）跑 60s 驗收：

```
signal=11 次數 = 0
末 STAT   = [STAT] frames=2150 real=1022 elapsed=46533ms fps_x10=219
末 perf   = [perf] AU#1000 均值: 牆鍾=41.3 段循環=14.0 (bsOnMsg=14.1 睡眠=0.0)
            snap=0.0 讀幀=2.6 渲染=23.8 (ms) pan=0
```

0 崩潰、1022 真幀、**21.9fps**，牆鍾構成跟 10-21 的 21.8fps 基線完全一致 ⇒ 幀率沒有退化，只是把翻頁線程關掉了。

代價是：**拖影問題回到未修狀態**。這是取捨——先保"能播"，再談"好看"。

## 六、三條可複用的經驗

1. **崩潰現場最可信的那層日誌，往往不是 stdout。** 給關鍵路徑留一個 `O_APPEND|O_SYNC` 的 phase 軌跡，它會救你很多次；反過來，靠"看起來什麼都沒打"去判斷"死在哪一行"，基本是在擲骰子。
2. **不要用"某個變量等於 0"當結論，要看它為什麼等於 0。** `g_gh_n=0` 我誤讀了兩個星期；順手查 `ion/clients` + `dma_buf/bufinfo` 只要十秒，就能省掉一次"重啟設備再說"。
3. **加了新特性就一定要留 env 逃生門，而且要雙向都跑一遍。** 這次如果沒有 `NETTV_VSYNCPAN=0`，就只能靠"編譯上一版二進制"去二分，代價高一個數量級。默認值該選"用戶能用的那一側"，不是"技術上更優的那一側"。

## 七、下一步

翻頁線程還得修，只是不再擋著播放。候選方案：

- 查崩因：裸 clone（無 `CLONE_SETTLS`）線程裡調 `ioctl(WAITFORVSYNC/PAN_DRAW)`、棧上放 `struct fb_var_screeninfo`，與 VSP 解碼併發時到底踩了什麼；
- 降級方案：不單獨起線程，改在主線程內"等 vsync → 同步 PAN"，代價是每幀多 0~18ms（均值約 9ms），21.9fps 大概掉到 17fps 左右。

先等用戶目視確認"拖影到底明不明顯"，再決定要不要為它付這筆幀率。

---

**本文涉及的文件**（設備端倉庫 `/home/lvgl_demo/lvgl_demo`）：`deploy/nettv_player/sprd_msg_np.c`（`vspan_publish()` / `pan_thread()` / `thread_start()`），構建腳本 `deploy/nettv_player/build.sh`。
