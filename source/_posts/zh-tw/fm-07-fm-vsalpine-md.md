---
title: "FM收音啟動流程_安卓vsAlpine對比"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-07-fm-vsalpine-md/
---


# 展訊 SC9832A FM 收音啟動流程 —— 安卓 vs Alpine（本設備）對比

> **讀者對象**：需要理解"為什麼我們在 Alpine 上要這麼幹"的人
> **核心價值**：安卓原生有一整套框架，我們在 Alpine 上要用盡量少的代碼替換它——本文把兩邊的每個環節對齊，
> 讓你清楚**哪一段被我們替掉了、替代的依據是什麼**

---

## 1. 芯片物理架構（兩種系統共用）

無論安卓還是 Alpine，**底下三層完全一樣**，這是能互相對照的前提：

```
┌─ 硬件層   Marlin2 combo 芯片，SDIO vendor 0x0000 / device 0x2331
│            WiFi + BT + FM 三合一，共享 SDIO 總線
├─ 固件層   download 一次性燒入 combo 固件（含 FM 部分）
├─ 驅動層   marlin_fm.ko → 註冊 misc 設備 /dev/fm（minor 23）
│
│  ← 以下開始分道揚鑣 →
```

**實測取值**（`spd-box`，本機）：

| 項 | 值 |
|---|---|
| SDIO modalias | `sdio:c00v0000d2331` |
| FM 驅動 | `marlin_fm`（`Used by sprdwl`） |
| FM 設備節點 | `/dev/fm`（misc 23）、`/dev/log_radio`（misc 35） |
| FM PCM | `01-04: Dfm sprd-codec-fm-4`（playback） |
| 內核 | Linux 3.10.65 |

> 驅動自述：`SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI`
> ——這句話在兩種系統下都成立，是分析共享資源問題的出發點。

---

## 2. 安卓 6.0 原生 FM 啟動流程

### 2.1 啟動鏈

```
開機
 └─ init / ueventd
     ├─ insmod sprdwl.ko → 連帶 marlin_fm.ko
     ├─ download（與 WiFi 共用，燒 combo 固件）
     ├─ wcnd（WiFi/藍牙/FM 統一的上電管理）
     └─ SystemServer
         └─ BroadcastRadioService
             └─ 加載 FM HAL
                 ├─ libradio.so / libradioservice.so（HAL 接口）
                 ├─ libFMHalSource.so（音頻源，起線程從 PCM 讀）
                 ├─ libfmjni.so（JNI 橋）
                 └─ libengfm.so（工程模式，只導出 fm_runcommand）
                     └─ 打開 /dev/fm，發命令
         └─ FM App（radio_interactor_service.apk 等）
             └─ AudioFlinger ← FMHalSource → TinyALSA → PCM
```

### 2.2 安卓關鍵點

| 環節 | 安卓的做法 |
|---|---|
| **權限/訪問控制** | SELinux + 設備節點權限，`/dev/fm` 只允許 radio 組訪問 |
| **音頻路由** | `FMHalSource` 持 `pcmHandle`，`FMHalThread::threadLoop()` 讀 PCM → `RingBuffer` → AudioFlinger 混音 |
| **狀態管理** | `BroadcastRadioService` 統一管理 radios，向 App 提供 `RadioManager` API |
| **RDS 處理** | HAL 內部解析（`rds_parser` 在驅動或 HAL 側），經 `RadioMetadata` 上報給 App |
| **多 App 競爭** | 服務層統一仲裁，App 通過 API client 使用 |
| **中間層厚度** | 很厚：App → RadioManager → BroadcastRadioService → JNI → HAL → /dev/fm |

**證據來源**（本機可從 Android 分區直接讀到）：

```sh
ls /mnt/android_sys/lib/{libFMHalSource,libengfm,libfmjni,libradio,libradioservice}.so
ls /mnt/android_sys/priv-app/radio_interactor_service/radio_interactor_service.apk
nm -D /mnt/android_sys/lib/libengfm.so                 # 只有 fm_runcommand
nm -D /mnt/android_sys/lib/libFMHalSource.so | grep -i 'pcm\|thread\|RingBuffer'
```

---

## 3. Alpine（本設備）FM 方案

### 3.1 目標：用最少代碼替換一整套

我們在 Alpine 上**沒有** binder / SystemServer / AudioFlinger / SELinux radio 策略。
所以要替換的是第 ④、⑤ 兩層，**保留 ①–③ 層原樣**。

### 3.2 擬定的啟動鏈

```
開機
 └─ openrc
     ├─ sprdwl.ko → marlin_fm.ko（繼承現有 WiFi 鏈路）
     ├─ logdw
     ├─ download（燒 combo 固件，含 FM）        ← 複用既有
     ├─ wcnd（上電）                            ← 複用既有
     ├─ bt_once(BT-OPEN) → bt_wake.sh           ← 複用既有
     ├─ bt_user_daemon  /tmp/bt_ctl.sock        ← 複用既有
     ├─ fm_radio_daemon /tmp/fm_ctl.sock        ← 【新增】替換安卓整套中間層
     └─ lvgl_demo → 收音機頁 g_radio_page        ← 【新增】替換安卓 FM App
```

### 3.3 Alpine 側的對應關係

| 安卓組件 | Alpine 替代方案 | 說明 |
|---|---|---|
| insmod + 節點權限 | 繼承既有 WiFi 鏈路，無需額外動作 | `/dev/fm` 已可用 |
| BroadcastRadioService | **無** | 用 daemon 的單實例互斥代替服務層仲裁 |
| FM HAL (`libFMHalSource.so`) | **`fm_radio_daemon` 內的音頻線程** | 邏輯同構：讀 PCM → 緩衝 → 輸出 |
| JNI / `libfmjni.so` | **無** | UI 與 daemon 之間用 unix socket 文本協議 |
| `libengfm.so`(`fm_runcommand`) | **自己實現命令封裝** | 提示可採用 AT 命令風格 |
| RadioManager API | **socket 文本命令** | 命令少、好調試、和藍牙 daemon 一致 |
| AudioFlinger 混音/焦點 | **自己寫音頻焦點仲裁** | 必須做，否則 FM/A2DP/本地會串音 |
| FM App (APK) | **LVGL `radio_page`** | 720×1280 豎屏，31px 行高網格 |

---

## 4. 逐環節對比表

| 環節 | 安卓 | Alpine（本機） | 差異要點 |
|---|---|---|---|
| **固件下載** | download in init | download via openrc | 基本相同；Alpine 依賴 WiFi 自啟鏈 |
| **上電管理** | wcnd 統一管理 | wcnd 同上 | 相同 |
| **驅動加載** | insmod sprdwl → marlin_fm | 同（自動加載） | 注意 `marlin_fm` 被 `sprdwl` 依賴 |
| **設備節點** | `/dev/fm`（受限訪問） | `/dev/fm`（misc 23） | Alpine 下 root 直連，無 SELinux 約束 |
| **命令接口** | HAL 封裝 ioctl/AT | daemon 直髮 | **命令號已逆向還原**（`0xC004F500 \| nr`，47 條） |
| **音頻源** | `FMHalSource` + `FMHalThread` + RingBuffer | daemon 自建讀線程 | 架構同構，實現從簡 |
| **音頻混音** | AudioFlinger | **需自建焦點仲裁** | 安卓由框架兜底，Alpine 必須自己寫 |
| **RDS 上報** | `RadioMetadata` → App | socket 文本字段 | RDS 解析能力驅動裡已有，直接取 |
| **UI** | APK + 完整 FM App | LVGL 收音機頁 | 受限於 MCU 級資源，按 720×1280 精簡設計 |
| **多 App 競爭** | 服務層仲裁 | **單 daemon 獨佔 + 上層仲裁** | 簡單但夠用 |
| **命令行工具** | `amixer`/`tinymix`/`tinyplay`（安卓自帶） | **全部沒有** | 只能寫 C 走 libasound.so.2 |

---

## 5. 原理要點（為什麼這樣能通）

1. **組合芯片共享 SDIO 是關鍵約束**：
   固件一次燒入、上電統一管理，所以**不可能單獨給 FM 燒固件或單獨上電**。
   這也是"WiFi 不通 ⇒ FM 一定不通"的根因。

2. **驅動已經把複雜的射頻/解調/RDS 全做完了**：
   用戶態不需要實現任何 FM 協議，只需要按命令集操作。
   所以 Alpine 側用"一個薄 daemon"替代安卓"一整套 HAL+服務+JNI"是可行的。

3. **音頻是唯一必須自己補的框架能力**：
   安卓有 AudioFlinger 做混音與焦點管理；Alpine 側沒有任何東西負責這件事，
   **必須顯式實現 FM / A2DP / 本地播放的三方仲裁**，否則用戶必定遇到串音。

4. **socket 文本協議是刻意的選擇**：
   與既有藍牙 daemon（`/tmp/bt_ctl.sock`，`state`/`on`/`off`）保持一致，
   團隊已有認知、已有踩坑經驗（尤其是"必須設 socket 超時，否則凍 UI"）。

---

## 6. 一句話總結

> 安卓用**一整套框架**（Service + HAL + JNI + AudioFlinger）托住 FM；
> 我們在 Alpine 上保留同樣的**底下三層**（硬件/固件/驅動），
> 用一個 **`fm_radio_daemon`** 替掉中間層，用一個 **LVGL 收音機頁**替掉 App，
> 並**自己補上安卓由框架兜底的那塊——音頻焦點仲裁**。
> 原先唯一的不確定性 **ioctl 命令號** 已解除（見《FM收音ioctl命令表_逆向還原》），整條鏈已可跑通。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
