---
title: "netTV 硬解（39）：靜態排除法——第二個 IDR SIGSEGV，先把「我方嫌疑」清場"
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
permalink: zh-tw/2026/11/08/nettv-39-static-clearance-second-idr/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr/) · [繁體中文](https://whiteleibniz.github.io/2026/11/08/zh-tw/nettv-39-static-clearance-second-idr-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr-en/)

> 系列第 39 篇。設備又沒上電（連續第 11 輪），在線實驗做不了。這次把一個懸了很久的問
> 題做了零成本的推進：**第二個 IDR 必 SIGSEGV、故障地址 0x747474**——先用靜態審計把
> "我們自己代碼越界寫" 這個嫌疑整個清掉，把在線取證的範圍縮小一半以上。

## 1. 崩潰現場像什麼

崩潰記錄裡的故障地址是 `0x747474`。按小端讀內存，這仨字節是 `74 74 74 00`，也就是
ASCII 的 `"ttt\0"`。**一個像文本數據、不像合法地址的值出現在了指針位置上**——這是典
型的「指針被數據覆蓋」特徵：某處把流數據寫過了界，把旁邊結構體裡的指針踩了，之後解引
用它的那一刻才崩。

所以排查方向很清楚：找到所有「往緊湊結構體旁邊寫數據」的拷貝點。在我們的播放器裡，
就是 NAL 投餵路徑上的每一次 `memcpy`。

## 2. 九處 memcpy，逐一過堂

把現網 v32 源碼裡全部 9 處 `memcpy`/`memmove` 拉出來，逐個核對邊界檢查：

| # | 位置 | 拷貝目標 | 邊界保證 | 結論 |
|---|------|----------|----------|------|
| 1 | `rb_put` | 環形緩衝 slot | `n ≤ RB_DCAP/2` 先擋 + 背壓檢查 + 跨尾迴繞 | ✅ 有界 |
| 2 | `auagg_add` | AU 聚合緩衝 | 超限先 flush、單 NAL 超限直投 | ✅ 有界 |
| 3 | `idrmix_feed` | 連體投餵緩衝 | 首段 memcpy 未查 SPS 長度，但 SPS 僅幾十字節且該路徑默認關 | ✅ 實際有界 |
| 4 | `cfg` 寫入 | SPS..IDR 連續區 | `(idr_end - sps_at) ≤ sizeof cfg` 顯式檢查 | ✅ 有界 |
| 5 | `nal_local` 拷出 | 512KB 本地副本 | `nlen > sizeof nal_local` 直接跳過 | ✅ 有界 |
| 6 | IDR 重投診斷 | 512KB 重投緩衝 | `nlen ≤ sizeof irp_buf` 顯式檢查 | ✅ 有界 |
| 7 | 首段投餵 | 輸入 buffer | `n > bhIdr->nAllocSize` 先跳過再拷 | ✅ 有界 |
| 8 | 拆段循環 | 輸入 buffer 偏移處 | `segs[si]+slen > n` 則 continue，子塊由 csz 切分推導 | ✅ 有界 |
| 9 | 渲染/out 路 | fb 與 staging | 定長 3MB / 定長 24 字結構 | ✅ 有界 |

連帶查了兩個易漏點：URL 拼接的 `memcpy(host, p, hl)` 有 `hl ≥ sizeof host` 鉗位；
out 路補分配的 24 字結構拷貝雙方都是定長靜態數組。

**結論：我方投餵/渲染路徑上不存在能踩壞指針的越界寫。**

## 3. 嫌疑收斂到哪

清場之後，嫌疑只剩兩類：

1. **廠商庫內部**。我們繞過 OMX 第二層直接驅動 `SprdSimpleOMXComponent`，輸入
   buffer 頭（`pBuffer`/`nAllocSize`）與組件內部結構全由廠商代碼維護。歷史已有
   ptrace 定案的「GOP#3 IDR 全量 DRIVE 觸發輸入隊列 UAF」，就是這一類。
2. **緩衝頭本身的信任問題**。我們每輪都信 `bhIdr->nAllocSize`/`pBuffer`，如果某輪
   廠商側把頭改了（比如端口重配後沒重建），我們的「有界」檢查就界錯了對象。

順帶說明：這個崩潰在現網 v32 已經被多層緩解（超限跳過、32KB 拆段、IDR 看門狗、軟解
降級重生），所以它表現為「歷史現象」而不是「日常事故」。但根因沒定位，緩解層就是
在薄冰上跑。

## 4. 在線取證清單（設備一上電就能跑）

- **處理器已修好**（uc 偏移 +32），崩潰時會留下 addr/pc/寄存器。拿到 pc 後用
  `elf_syms.py` 映射：落在我們的 `.text` → 審計有漏；落在廠商庫 → 第 1 類實錘。
- **`NETTV_IDRREPLAY=K`**（v32 內置診斷）：捕獲首 IDR 後連投 K 次。第一次重投就掛
  → 組件狀態問題（A）；重投不掛、正常播放到第 2 個真 IDR 才掛 → 累積漂移（B）。
  這一個 env 就能把成因二分掉。
- 關注 `[inbuf]`（超限跳過）與 `[split]`（拆段）日誌：如果崩潰前有超限跳過記錄，
  說明流裡出現了比歷史更大的 NAL，先查源再查代碼。

## 5. 方法論收尾

故障地址像文本數據 ⇒ 先懷疑「指針被數據覆蓋」；而**覆蓋發生的地點和崩潰的地點通常
不是同一個地方**，所以不能只在崩潰棧附近找。靜態清場的價值在於：花半小時把「我們
自己不會越界」變成有據的結論，在線窗口（本項目最貴的資源）就不用浪費在排查自己身上。

**負面結果也是結果**：這一輪沒有改任何代碼，但搜索空間從「全部代碼」縮到了「廠商庫
+ 緩衝頭信任」兩類，下次復現時取證路徑是現成的。

> 🌐 其他語言：[繁體中文](https://whiteleibniz.github.io/2026/11/08/zh-tw/nettv-39-static-clearance-second-idr-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/08/nettv-39-static-clearance-second-idr-en/)
