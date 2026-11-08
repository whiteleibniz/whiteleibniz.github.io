---
title: netTV 硬解攻堅（十四）：17fps 基線實測與一次 dup2 誤判——判"有沒有出幀"不能只看主日誌
date: 2026-10-20 14:45:00
categories:
  - 嵌入式
  - netTV 硬解攻坚
  - 性能优化
tags:
  - SC9832A
  - VSP
  - HLS
  - H.264 硬解
  - framebuffer
  - 性能分析
permalink: zh-tw/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-14-17fps-baseline-and-dup2-misjudgment-en/)


> 系列第 14 篇。上一篇（十三）把「O_SYNC 日誌」定為隱形幀率殺手並默認關掉了它，
> 本篇回答：關掉之後到底跑多少幀？結論是 **17fps**——以及我是怎麼被 `dup2`
> 誤導、差點把"能跑"誤判成"0 幀"的。

## 一、先糾正上一篇遺留的一個懸案

上一篇結尾說 A/B 實驗被用戶桌面播放佔著 ION 池擋住，重跑之後拿到了真實數據。
但重跑第一步就撞上一個詭異現象：A 組、B 組日誌都只有 **271~291 字節、6 行**，
幀數為 0、心跳 0、性能彙總 0——和上一次"池被佔"的表現一模一樣。

但這次 ION 池是空的（我的實例 `earlyion g_nout=1`、`out[0]` 拿到了 3.2MB 真物理地址）。
於是做單變量復現：**只加 `NETTV_VLOG=1`**（開詳細日誌，其他全部不動）——
12 秒出了 48 幀，一切正常。

也就是說：**VLOG=0 不出幀，VLOG=1 出幀。** 一個環境變量怎麼可能控制出不出幀？
順著源碼查 `vlog_on()` 的全部引用，在 193 行抓到了真兇：

```c
static void child_log_bound(void) {
    if (vlog_on()) return;   /* 調試模式: 保留調用方重定向 */
    int f = open("/tmp/nettv_child.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    dup2(f, 1); dup2(f, 2);  /* ← 子進程 stdout 被換成了文件 */
    if (f > 2) close(f);
}
```

這是 10-16 加的"限磁盤佔用"設計：非調試模式下，把子進程的 stdout 重定向到
`/tmp/nettv_child.log`，防止每幀的庫內打印把 `/tmp/lvgl_demo.log` 撐到 131MB。
**重定向之後，幀統計 `[STAT]`、每 200 條 AU 的性能彙總 `[perf]`、幀上屏標記，
全部寫進了 `nettv_child.log`**——而主日誌只剩啟動橫幅那幾行。

>A 組和 B 組其實一直正常出幀。271 字節的主日誌 ≠ 0 幀。
>我看到 `nettv_child.log` 裡出現 `FilledDone 解碼幀` 時，還判斷那是"用戶會話的輸出"。

**教訓（已立為項目鐵律）**：判"播放器有沒有出幀、幀率多少"，必須
`grep /tmp/nettv_child.log`（`FilledDone` / `已上屏` / `[STAT]` / `[perf]`），
不能看主 log。凡是 stdout 被 `dup2` 過的進程，主日誌的行數說明不了任何事。
另外注意源碼 191 行 `kdiag_on()` 的實現是 `g_kdiag || vlog_on()`——
**設 `NETTV_VLOG=1` 會連帶打開全部 kdiag 診斷**，調試時這個耦合要注意。

## 二、診斷默認關之後的真實基線

修正判據後重跑（瀘縣 1080p 源，完全新默認環境，60 秒）：

- **825 幀 / 48.4 秒，`[STAT] fps_x10=170`，即 17fps**
- 對比上一篇 v15（診斷全開）的 13.2fps：**+29%**，診斷默認關的修復確認有效、無迴歸

`[perf]` 每 AU 分賬（牆鍾均值 112ms）：

| 段 | 耗時 | 內容 |
|---|---|---|
| 段循環 / DRIVE | **32.4ms** | 硬件解碼 14ms（廠商自報）+ 庫側約 18ms（phys ioctl 查地址、bind/unbind、雙份 FilledDone） |
| snap_state | 0ms | kdiag 門控生效 ✓ |
| 讀幀 | **45.5ms** | 3MB memcpy 到緩存暫存 ~20ms + 內容簽名掃描 ~25ms |
| fb_render | **30.5ms** | CPU 單遍幾何合成（縮放 + 旋轉 + NV12→ARGB），採樣均值 34ms |
| 其餘 | ~3.6ms | 尾部 fill(out) 補隊列等 |

## 三、賬算清楚：25fps 的預算夠不夠

25fps 需要 ≤40ms/AU，現在 112ms。分段砍：

1. **簽名掃描裁掉/降頻**（讀幀 45.5→約 22ms）：簽名本來用於"畫面不變不重複渲染"判重，
   但廠商 `FilledDone` 回調每幀必達（心跳就是用它做的），判重完全可以改成回調計數，
   不需要 CPU 掃 8K 個採樣點；Y 非零判空只留前幾幀即可。
2. **fb_render NEON 化**（30.5→約 10ms）：幾何合成是規則的定點運算，
   ARMv7 NEON 有成熟寫法。
3. **DRIVE 庫側緩存**（32.4→約 24ms）：phys ioctl 每 AU 重查 fd→PA，
   按 fd 緩存可省一半。
4. 三項全砍完：24 + 22 + 10 = **56ms ≈ 18fps，仍然不夠。**

**結論：光靠"砍"到不了 25fps，唯一的路是流水線。** 現在 worker 是純串行：
解碼的 32ms 裡 CPU 在等；渲染的 30ms 裡 VSP 在閒著。只要把"讀幀+渲染"挪到
解碼下一幀的**並行時段**（安卓的 BufferQueue 模型），單 AU 牆鍾就趨近
`max(解碼, 渲染) ≈ 35ms`，**約 28fps**。

流水線的硬約束是老問題：**雙緩衝要 2×3.1MB 輸出 + mbinfo 653KB + 輸入 256KB
≈ 7.1MB，而 CMA 池名義只有 ~7MB**。要麼先擴池（內核 cmdline），
要麼賭池子實際比標稱松一點（廠商 init 搶的是 C1 池，不一定全在 CMA 裡）。
這也是下一篇要實驗的第一件事。

## 四、下一步（單變量順序）

1. 簽名掃描降頻（讀幀 45.5→~22ms，最穩的一刀，先動）
2. fb_render NEON 幾何合成（30.5→~10ms）
3. 雙緩衝流水線（CMA 池擠 2 路）—— 決定能否到 25fps+
4. DRIVE 內 fd→PA 緩存
5. 更遠的路：recon 顯示驅動 overlay 能力，NV12 直送顯示層 + 硬件旋轉，
   把整個 CPU 合成省掉（對標安卓 HWComposer）

---

*本系列文章與實驗腳本隨項目同步維護，僅代表個人嵌入式學習與調試過程記錄。*
*本文為原創技術總結，轉載請註明出處，禁止商業用途。*
