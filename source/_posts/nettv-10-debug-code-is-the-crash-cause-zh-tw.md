---
title: 除錯程式自己就是崩因：一次 VSP 核心崩潰的 8 層證偽
date: 2026-10-19
tags:
  - nettv
  - vsp
  - 展訊
  - sc9830
  - 核心崩潰
  - 除錯方法論
  - MMIO
categories:
  - 技術
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause/) · [繁體中文](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/19/nettv-10-debug-code-is-the-crash-cause-en/)

# 除錯程式自己就是崩因：一次 VSP 核心崩潰的 8 層證偽

> 背景：展訊 SC9832A（sc8830 系列）上做 HLS 直播硬解，裸調 `SprdSimpleOMXComponent`，
> 輸出 framebuffer。某天新版程式每跑必崩 —— 崩在 `DRIVE fill(out) #1`，
> 裝置隨即重啟。**行程級保護攔不住，堆疊上也沒有任何線索。**
>
> 真兇是一段「為了查掛死而加的」除錯程式。

## 症狀

相位樁（`O_SYNC` 直寫 `/tmp/phase.log`）顯示每一輪都停在同一行：

```
t=1385724329 >> fill(out)#1 开始 g_nout=1
t=1385724331    fill(out) 交第0路 hdr=0xb6d8ec80 pBuffer=0xb6d9ba80
                                     ← 没有下一行，设备重启，uptime 回 1 分钟
```

`sigsetjmp` 攔不住、`dmesg` 無 OOM、`MemFree` 有 882 MB。

## 8 層證偽

崩潰點那行程式碼和 10-18 能跑版**逐位元組相同**。所以差異在它**之前**。
我把自己能想到的每一條都單獨做了 A/B：

| # | 假設 | 驗證方式 | 結果 |
|---|------|---------|------|
| 1 | 補調 `useBuffer` 導致廠商 ASSERT | `NETTV_UBMODE=0` 不補調 | 仍崩同一處 |
| 2 | `setParameter(0x7f000011)` 是崩因 | `NETTV_SP228=0` 跳過 | 仍崩 |
| 3 | 自管 ION 的假 native_handle 是崩因 | `NETTV_NOFAKE=1` 整個禁用 | 仍崩 |
| 4 | 投餵切分 `offsplit`/`chunk` 是崩因 | 強制 `g_offsplit=0 g_chunk=0` | 仍崩 |
| 5 | `NOUT 6→4` 回滾動到了 BSS | 回滾後 | 仍崩 |
| 6 | handle 來源是 gralloc vs 自管 ION | `NETTV_EARLY=1` 提前搶到自管 ION，handle 變回堆積位址 | 仍崩 |
| 7 | carveout_mm 池被搶空（`total 0`） | 重試 6 輪 + 退避 + 尺寸階梯，第 6 輪真搶到 | 仍崩 |
| 8 | 記憶體不足 | MemFree 882 MB，dmesg 無 OOM | 排除 |

第 8 層排除後，能解釋「同環境 AB 對照」的就只剩一件事：**舊版沒有的程式碼**。

## 真兇

10-18 晚上為了抓「掛死現場」，我加了一套暫存器取證：

```c
static int vrp_hook(void *d, unsigned off, ...)   /* hook 廠商 VSP 暫存器寫函式 */
{
    int r = g_vrp_real ? g_vrp_real(...) : -1;
    g_vsp_rb = *(unsigned *)d;                    /* ← 取 VSP 暫存器視窗基底位址 */
    unsigned rb = *(unsigned *)d;
    volatile unsigned *W = (volatile unsigned *)(rb + 0x60901000);
    volatile unsigned *B = (volatile unsigned *)(rb + 0x60908000);
    P("[W10] 1010=%08x ...", W[0x10/4], ...);    /* ← 直接讀 MMIO */
}
```

以及 `tr_line()`，在**每次 DRIVE 前後各呼叫一次**，讀 `W[0x1c/4]`、`B[0x34/4]`。

`vrp_hook` 是**每一輪輪詢都會走**的高頻路徑。等於在解碼過程中持續
從 `0x60901000` / `0x60908000` 這兩塊暫存器視窗**讀 MMIO**。

結果是：VSP 狀態機被打亂，崩在緊隨其後的 `DRIVE fill(out) #1`。
**崩潰點不在除錯程式那行，而在它造成的下一處破壞。**

修法就一行語意：

```c
{ static int mmo = -1;
  if (mmo < 0) { const char *em = getenv("NETTV_TRACE_MMIO");
                 mmo = (em && em[0] == '1') ? 1 : 0; }
  if (!mmo) return r; }        /* 預設關，不碰 MMIO */
```

驗證：新版跑到 `AU[299]`，phase.log 裡 1032 次 `fill(out)` 全部「已返回」，
裝置零重啟。

## 三條方法論

**1. 「除錯程式自己就是崩因」是一類獨立故障模式。**
它不會崩在自己那行，所以堆疊、日誌、ASAN 全都指不到它。
只有把舊版和新版**放在同一裝置同一環境連跑對照**、逐欄位比對執行時期狀態
（我打的是 handle 的 `ints[0..23]`、`g_gh_n`、`g_nout`），才能看出「舊版沒有這段」。

**2. 排查期要有一個絕對可靠的日誌通道。**
這個專案裡 stdout 被自訂 stdio 的 4KB 塊緩衝吞掉，崩潰時緩衝區全丟 ——
於是我一度靠空日誌誤判過三次。`O_SYNC` 直寫的相位樁是唯一可信通道。
同理，腳本上傳後必須 `md5sum` 校驗，我踩過 3 次「0 位元組腳本導致誤判新版不崩」。

**3. 判準要選可重現的。**
「ALIVE=0」這個訊號毫無資訊量（舊版正常自退也是 0）；
`uptime` 是否回 1 分鐘 + 相位樁最後一行，才是可靠判準。

## 附帶修好的一個真問題

`g_gh_n=0`（carveout_mm 池被元件 init 階段性搶空）時，
`ghOut` 會留在 gralloc 的真 handle 上。而 gralloc 走的是 IOMMU heap，
**沒有實體連續 backing**，VSP 會往假實體位址寫影格。

所以加了兩道防線：
- 搶池加重試（6 輪 × 120ms 退避 × 4 檔尺寸輪轉），實測第 6 輪能搶到；
- 仍搶不到就 `_exit(12)` 交給看門狗重生 —— **寧可不出畫面，也不打飛核心**。

## 寫在最後

「加個暫存器 dump 看看」這句話，在硬體加速除錯裡是有代價的。
讀 MMIO 不是 `read()` 一個普通變數，它是**在別人的狀態機上插一腳**。

排查複雜問題的方法歸根到底只有一句：**把「能跑的版本」和「崩的版本」擺在一起，
逐項二分**。這次要不是手上有 10-18 那份能跑的原始碼當基線，
我會一直在這個坑裡猜第八、第九、第十個假設。
