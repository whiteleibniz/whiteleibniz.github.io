---
title: "netTV 硬解（42）：1200 秒雙臂定案——首 IDR 重投無罪，週期性 SIGSEGV 是累積漂移"
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

> 🌐 語言：[简体中文](https://whiteleibniz.github.io/2026/11/10/nettv-42-drift-verdict/) · [繁體中文](https://whiteleibniz.github.io/2026/11/10/zh-tw/nettv-42-drift-verdict-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/10/nettv-42-drift-verdict-en/)

> 系列第 42 篇。設備終於回到線上。這一輪只做一件事：把備好的取證編排 `_ntseg2.sh`
> 真機跑起來，給「週期性 SIGSEGV（約 3 分鐘一次）」下一個有數據支撐的判決。

## 先說結論

**判決：狀態 B（累積漂移）。** 首 IDR 重投（IDRREPLAY）無罪——零次重投的基線臂和重投
3 次的實驗臂，崩潰節奏完全一致。崩點不在重投路徑上，而在後續真 IDR / 推進路徑裡，
排查方向轉向**洩漏 / 池耗散**。

## 實驗設計

兩個臂，每臂 1200 秒，同一條 1080p 直播源：

- **A0 臂**：基線配置（IDRREPLAY=0），即歷史穩定復現配置；
- **R 臂**：在 A0 基礎上把首 IDR 連續重投 3 次（製造「重投窗口」壓力）。

判決看三點：每臂 GATE（閘門：殘留清零、env 恰好一條、幀證據 ≥5fps、崩潰計數來自
phase.log 的 `mon-child-signal=11`），以及兩側崩潰次數的對比。

## 數據

| 臂 | 重投 | 崩潰次數 | 崩潰間隔 | fps 峰值 | GATE |
|----|------|---------|---------|---------|------|
| A0 | 0 | 6 | ~157s | 283 | V=1 |
| R  | 3 | 7 | ~152-186s | 279 | V=1 |

兩臂崩潰節奏一致（151-186 秒，嚴格的週期性），fps 都正常。如果重投是誘因，R 臂應該
崩得更多或更早；實際 6≈7，**重投這個變量被乾淨地排除了**。這正是 A/B 雙臂的意義：
一個變量，一次判決，不靠猜。

## 兩個值得記的細節

**第一輪 600 秒跑出了 NOT_REPRODUCED**——基線臂零崩潰。按 3 分鐘一個故障週期，
600 秒只覆蓋 2 個週期，泊松方差下完全可能一次都撞不上。延長到 1200 秒（4 個週期）
立刻復現。老經驗再次驗證：**觀測窗口必須 ≥4~5 個故障週期**，否則「沒崩」不構成證據。

**測量工具自己出了 bug**：ARM 頭行顯示 `IDRREPLAY=NETTV_IDRREPLAY`，一查是
`env_key_ok` 函數把參數直接寫進全局變量 `k`（沒加 `local`），污染了調用方的計數器。
萬幸 `mkarm` 在污染發生之前已經用正確的值造好了臂，**實驗配置沒受影響**——但如果
順序反過來，這就是一次「工具 bug 偽裝成實驗結果」的事故。已修復（全部參數加
`local`）並用變異自檢驗證。

## 附帶觀察

兩臂的 segv.log 都是 0 條：SIGSEGV 處理器一次都沒進過。這與之前的根因鏈（信號掩碼
傳染 → force_sig_info 強制 SIG_DFL）一致——崩潰落在被屏蔽的執行流上，處理器根本沒有
機會執行。`maskedhit` 採樣峰值 0，說明採樣間隔沒撞上掩碼窗口，這條線索還沒閉環。

## 下一步

狀態 B 的兩個可判據：**洩漏的指數特徵**（崩潰間隔隨時間縮短）vs **恆定節拍**
（固定槽位/定時器踩踏）。下一輪把採樣裡的 CmaFree/ION 欄位修好，基線臂延長到
2400 秒，看崩潰是加速還是恆速。

---
*版權聲明：本文為 whiteleibniz 原創文章，採用 CC BY-NC-SA 4.0 許可協議。轉載請註明出處 whiteleibniz.github.io。*
