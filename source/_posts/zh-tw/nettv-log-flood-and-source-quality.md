---
title: 展訊 SC9832A 網絡電視攻堅（五）：播放器把系統盤寫爆了——每幀日誌的代價，以及"花屏"其實強依賴源
categories:
  - [嵌入式, 展讯平台]
  - [嵌入式, 音视频]
tags: [VSP, 硬解, fb, 日志, m3u8, 展讯, 嵌入式]
date: 2026-10-16 16:00:00
permalink: zh-tw/2026/10/16/nettv-log-flood-and-source-quality/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality/) · [繁體中文](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/16/nettv-log-flood-and-source-quality-en/)


> 版權聲明：本文為博主原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處鏈接和本聲明。

上一篇（四）把"假物理地址"修掉了，第二個 IDR 不再崩、也不再切軟解。這次接著在真機上驗證，結果順手抓出一個跟畫面無關、但足以讓整機"慢性死亡"的問題：**播放器把系統盤寫爆了**。同時把"到底修好沒修好"這件事，拆成兩個更準確的結論：畫面質量其實強依賴源，而 IDR 掛死才是真正的攔路虎。

## 一、現象：幾小時後 /tmp/lvgl_demo.log 變成 131MB

驗證時習慣性看一眼磁盤，發現 `/tmp/lvgl_demo.log` 已經 **131621286 字節（≈131MB）**，而根分區只剩 586MB（91% 已用）。更糟的是它還在漲。

日誌尾巴長這樣，一眼就能看出刷屏源：

```
    DRIVE empty(全量): m=0xb0b7a400 what=3048035944 hdr=0xb6cced70
    DRIVE empty(全量) → 返回, 隊列:  in  queue=0xb4ec9304 begin=b4e8c060 end=00000000 (空)
    DRIVE fill(out): m=0xb0b7ae00 what=3048035944 hdr=0xb6ccedc0
    DRIVE fill(out) → 返回, 隊列: ...
```

每條診斷本身沒問題——調試硬解時全靠它。問題是**它每幀都在打**，而且不止一處。

## 二、根因：三層疊加

1. **投餵日誌是"每幀級"的。** `DRIVE` 宏每投餵一個 buffer 就打兩行（還有隊列快照），一幀要投餵好幾次 → 實測 **~9KB/s**。
2. **廠商解碼庫也往 stdout 打。** `SprdSimpleOMXComponent` / `SPRDAVCDecoder` 內部有 `fillThisBuffer` / `onQueueFilled` 之類的打印，跟著我們的調用一起吐。
3. **最要命的一點：UI 拉起的播放器繼承了 UI 的 stdout。** 網絡電視頁是 `fork + execl("/usr/local/bin/nettv_player", url)`，沒有重定向——於是播放器的所有輸出都灌進了 LVGL 主程序的日誌文件 `/tmp/lvgl_demo.log`。

9KB/s × 幾小時 = 上百 MB。對一個 24 小時開著的電視盒子，這是必然爆盤。

## 三、修法：一個閘門 + 一次重定向綁定

思路是兩條：

**① 每幀診斷加開關（默認關）。** 加一個只認環境變量的閘門：

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

然後把 `DRIVE` 宏裡的兩行、以及每幀的"已上屏"打印用 `if (vlog_on())` 包起來。要查問題時 `NETTV_VLOG=1` 跑一次即可，平時零開銷。

**② 把子進程的輸出"綁"到一個每次重生都截斷的固定文件。** 因為廠商庫的打印我們在源碼裡管不著，只能從 fd 層面下手：

```c
static void child_log_bound(void) {
    if (vlog_on()) return;                        /* 調試模式: 保留調用方重定向 */
    int f = open("/tmp/nettv_child.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    dup2(f, 1); dup2(f, 2);
    if (f > 2) close(f);
}
```

在 monitor `fork` 出來的子進程一開始就調用它。兩個好處疊加：

- UI 的 `/tmp/lvgl_demo.log` 不再被灌（播放器輸出進了自己的文件）；
- 這個文件是 **O_TRUNC** 打開的，而 monitor 每次兜底重生都會重新 `fork` 一次 → 文件被反覆截斷，磁盤佔用被死死限制在"**單個子進程**"的量級。

**實測對比：**

| 指標 | 修前 | 修後 |
| --- | --- | --- |
| `/tmp/lvgl_demo.log` | 131MB（持續漲） | **965 字節** |
| 子進程日誌 | 混在 UI 日誌裡 | `/tmp/nettv_child.log`，~59KB（單子進程） |
| 每幀診斷 | 每幀多行 | 默認 0（`NETTV_VLOG=1` 才開） |
| `[STAT]` 心跳 | 有 | 保留（每 25 幀一條） |

## 四、順帶糾正兩個認知

這次是"上機驗證"，驗證過程本身糾正了兩個之前的判斷：

**① "花屏"不是二元的，它強依賴源。**
- 好源（lxfile 瀘縣/成都）：畫面主體清晰，只有中右局部糊 + 邊緣少量塊狀；
- 差源（某 cztv 1080p 頻道）：幾乎全屏花，不可辨認。

也就是說，用"有沒有馬賽克"來判斷"修沒修好"是不準的——得固定用一個已知好源做基線。

**② 真正的穩定性攔路虎仍是 IDR 掛死，跟假 PA 無關。**
日誌顯示每個子進程都終止在同一點：

```
  ── empty AU[69] 104222 字節 @7876ms t=5 (8c=1, 9a清0) ──
*** GOP#3 IDR: 原生續解(3s 掛死看門狗兜底) ***
```

即：**喂第 3 個 GOP 的 IDR 時，`DRIVE empty(全量)` 永不返回**——和上一篇的結論一致（假 PA 不是它的根因）。monitor 每 ~8-30s 兜底重生一次，所以畫面是"能看幾分鐘、卡一下、再恢復"的節奏。要"穩定流暢"，下一步必須啃這塊。

（附帶一個小插曲：抓屏時發現兩次抓到的幀**字節完全相同**，一度以為畫面卡死。後來才想起播放器有"幀簽名去重"——只在畫面簽名變化時才重繪 fb。靜態場景下兩幀相同是**正常優化**，不是故障。抓圖驗證動態畫面時得選有運動的場景。）

## 五、一句話教訓

> **調試打印是雙刃劍：調的時候越詳細越好，上線的時候越安靜越好。** 尤其是當程序是被別的進程 `fork+exec` 拉起、又沒有重定向 stdout 時——你以為"只是多打了幾行日誌"，幾小時後就變成了一顆 131MB 的定時炸彈。給它一個環境變量開關，再把子進程的輸出綁到一個會被自動截斷的文件上，代價幾乎為零，收益是整機不會慢性死亡。
