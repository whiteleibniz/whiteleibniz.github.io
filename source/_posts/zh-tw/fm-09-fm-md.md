---
title: "FM收音打通_工作過程總結"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-09-fm-md/
---


# 展訊 SC9832A FM 收音打通 —— 工作過程總結

> **讀者對象**：需要了解"這個方案是怎麼想出來的"的人（含後續接手的 AI）
> **階段說明**：本文記錄的是 **2026-09-22 的探索與設計階段**，尚未進入實裝與**聲音/入耳驗證**階段
> **核心價值**：記錄關鍵判斷的依據、走了哪些彎路、以及**刻意沒有做的事**——比"結論"本身更有複用價值

---

## 1. 任務背景與初始目標

WiFi 與藍牙均已打通（同一顆 combo 芯片），現在要在同一個 LVGL demo 裡**新增 FM 收音機功能**，
要求是"經典收音機 App 佈局"，覆蓋三塊內容：**入口與圖標、頁面佈局、功能清單**，
並按 `AI工作流/02_藍牙打通/docs` 的文檔類型產出一整套中文文檔，放在 `03_收音機/docs` 下。

初始認知只有一個輸入：**"本機 WiFi、藍牙、FM 集成在同一塊芯片（SDIO 枚舉 0x2331）上"**。

---

## 2. 分析框架：先把"FM 能不能做"拆成五層

沒有急著畫界面，而是先建立一個判斷能不能做的分層模型：

```
① 硬件：芯片是真的嗎？        SDIO 0x2331 能枚舉嗎？
② 固件：FM 部分燒進去了嗎？   要不要單獨燒？
③ 驅動：有驅動嗎？設備節點在嗎？
④ daemon：有人管這個節點嗎？  有沒有現成工具？
⑤ UI：界面怎麼畫？
```

**這個分層的價值**：它讓我們能在動手之前就判斷出
"這是'從零造輪子'還是'把現成東西接出來'"——而答案決定了整個項目的性質和工作量。

---

## 3. 攻堅過程（按時間線）

### 階段 A：確認硬件存在 —— SDIO 只有一個設備

```sh
cat /sys/bus/sdio/devices/*/modalias   # → sdio:c00v0000d2331
cat /sys/bus/sdio/devices/*/device     # → 0x2331
```

總線上的 SDIO 設備**只有一個**，印證了"三合一、共享 SDIO"的說法。

### 階段 B：意外發現 —— FM 驅動早就加載了

```sh
lsmod | grep marlin_fm
# → marlin_fm  17554  1 sprdwl
```

**這是本次最重要的轉折點**：原本以為 FM 是一塊從沒碰過的新功能，
結果發現驅動不僅存在、而且**被 WiFi 驅動 `sprdwl` 依賴**（說明加載是常態、自動的）。

緊接著：

```sh
ls -l /dev/fm            # → crw-rw---- 10, 23
grep -w fm /proc/misc    # → 23 fm
```

**設備節點已經註冊好了。**

> 💡 **結論改變到這裡已經很明確**：這活兒不是"打通 FM 芯片"，而是"接出一個已經在跑的功能"。

### 階段 C：把驅動能力完整摸出來 —— 用 strings + nm 反推

因為設備上**沒有廠商源碼**（`/tmp/linux-3.10.65` 是 vanilla 樹），只能用符號級取證：

```sh
strings /lib/modules/marlin_fm.ko | grep -- '----'     # 還原 ioctl 命令名錶
nm /lib/modules/marlin_fm.ko | grep ' T '              # 還原函數符號表
strings /lib/modules/marlin_fm.ko | grep description=  # 拿到官方描述
```

三條命令拿到了全部關鍵事實：

1. **40+ 個命令名**（TUNE/SEEK/SCAN/GETRSSI/MUTE/SETVOL/ANA_SWITCH/I2S_SETTING/OVER_BT_ENABLE/RDS_*）
2. **完整 RDS 解析函數**（`rds_get_ps` 臺名、`rds_get_rt` 文本、`rds_get_pty`、`rds_get_af` 備用頻率、`rds_get_ct`、`rds_get_ews` 緊急廣播…）
3. **官方描述**：`SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI`

最後一行是**決定性的**：它把"與 WiFi/藍牙共享 SDIO"從推測變成了芯片廠商的正式表述，
直接支撐了後續的"固件依賴 WiFi、上電依賴既有鏈、自啟必須排隊"等一系列設計。

### 階段 D：一個額外的線索 —— AT 命令風格

驅動裡發現 `parse_at_fm_cmd` / `parse_at_fm_num`；Android 側 `libengfm.so` **只導出一個符號 `fm_runcommand`**。

兩者呼應，提示 FM 控制可能是 **AT 命令風格**（往節點寫命令字符串）。
這條線索後來成了突破點：**同一套常量在 `libfmjni.so` 裡以字面量存在**，
成為命令號編碼的獨立交叉驗證（詳見《FM收音ioctl命令表_逆向還原》§2.4）。

### 階段 E：音頻路由 —— 發現 FM 專用 PCM，也發現沒有命令行工具

```sh
cat /proc/asound/pcm | grep -i fm
# → 01-04: Dfm sprd-codec-fm-4 : : playback 1
```

確認存在 FM 專用 PCM 設備（card 1 device 4，僅 playback）。

但同一輪發現：**沒有 `amixer` / `tinymix` / `aplay`**，只有 `libasound.so.2`。
→ **結論：音頻通路只能寫 C 代碼操作，不能靠命令行調試。這顯著改變了音頻層的工作方式。**

同時 Android 側 `libFMHalSource.so` 的符號（`pcmHandle` + `FMHalThread::threadLoop` + `RingBuffer`）
揭示了安卓的音頻架構：**起線程從 PCM 讀 → 環形緩衝 → 輸出**。我們自己的 daemon 要復刻同構邏輯。

### 階段 F：確認"沒有現成用戶態"（防止重複造輪子）

```sh
ls /usr/bin /usr/sbin /bin /sbin | grep -i 'fm\|radio'   # 無輸出
find / -maxdepth 4 -name '*fm*' -type f                  # 只有 .ko 和 Android 庫
```

→ **必須自己寫 daemon**。同時確認 Android 的 FM 庫**不能直接用**（依賴 Android 運行時）。

### 階段 G：UI 集成點 —— 照著藍牙的模式做

讀 `launcher_page.c` / `bluetooth_page.c` / `lv_page_manager.h`，確認三件事：

1. 桌面網格**順序由 `s_apps[]` 數組決定**（不是枚舉值），所以插在藍牙項之後即可自動排到藍牙後面；
2. 頁面註冊範式是 `lv_page_t g_xxx_page = { .onCreate, .onPause, .onDestroy, ... }`；
3. 頁面管理器明確規定：**`onDestroy` 裡必須自己清定時器/回調，但不要刪 `page->root`**。
   這條直接決定了"後臺播放"的設計：`onPause`/`onDestroy` 都**不能**停臺。

### 階段 H：字體約束 —— 一個容易翻車的點

查到 `lv_font_cn_16` 的真實 metrics：**`line_height = 31px，base_line = 9px`**（名義 16px）。
項目歷史上已經有過"按 16px 硬編碼行高導致中文被裁切"的返工。
→ **本次所有 y 座標按 31px 網格重算**，並在文檔裡明確紅線程（不許"視覺微調"成 16px 網格）。

---

## 4. 關鍵決策回顧（為什麼這麼做）

| 決策 | 理由 |
|---|---|
| **不重寫協議棧，只寫薄 daemon** | 射頻/解調/RDS 全在芯片與驅動裡做完了，用戶態只需發命令 |
| **daemon 對外用 unix socket 文本協議** | 完全鏡像已驗證的 `bt_user_daemon`，團隊零額外認知成本；且 socket 超時的坑已經踩過 |
| **系統性鏡像藍牙 daemon 的 socket 路徑命名**（`/tmp/fm_ctl.sock`） | 一致性優先 |
| **聲道仲裁列 P0** | 三者共用音頻輸出；不做必然串音，是用戶必定踩到的問題 |
| **UI 用 RDS 數據**（PS 臺名 / RT 滾動） | 驅動能力已有且是本方案差異化價值，不用就退化成"只有數字的界面" |
| **所有座標按 31px 行高網格** | 避開本項目已有的中文裁切返工 |
| **額外增加一份界面規格文檔** | 參考目錄裡沒有 UI 類文檔，但本次需求的核心就是 UI，不能套不存在的模板 |
| **把"未知項"明確列表** | 關鍵信息缺失時寫"待確認"比假裝知道更有工程價值；但**能自己算出來的就別列進未知項** |

---

## 5. 最終成果與沉澱

### 5.1 交付物

`AI工作流/03_收音機/docs/` 下 7 份文檔：

| 文檔 | 作用 |
|---|---|
| `FM收音機_LVGL界面設計與交互規格.md` | **核心**：入口圖標 / 頁面佈局 / 功能清單（對應需求 ①②③） |
| `FM收音打通_AI指導手冊.md` | 硬事實 + 執行流程 + 決策表，防止重複探查 |
| `FM收音芯片打通_操作手冊.md` | Step-by-step 可執行命令 |
| `FM收音芯片打通_故障排查手冊.md` | 分層速查表 |
| `HT0FM收音原理與移植學習Wiki.md` | 原理與遷移方法論 |
| `FM收音啟動流程_安卓vsAlpine對比.md` | 安卓怎麼幹 vs 我們怎麼幹 |
| `FM收音拉起_部署交付文檔.md` | 產物清單與部署步驟 |
| `FM收音打通_工作過程總結.md` | 本文 |

### 5.2 沉澱下來的硬事實（可直接複用）

- Marlin2 combo 芯片，`0x2331`，**WiFi/藍牙/FM 共享 SDIO**（廠商描述為證）；
- `marlin_fm.ko` 已加載且被 `sprdwl` 依賴，`/dev/fm` = misc 23 已註冊；
- 完整 ioctl 命令名清單 + 完整 RDS 函數清單；
- FM 專用 PCM：`01-04 Dfm sprd-codec-fm-4`（僅 playback）；
- 無 ALSA 命令行工具，只有 `libasound.so.2`；
- 無現成 FM 用戶態，Android 庫不可直接複用；
- `lv_font_cn_16` 行高 31px；頁面 `onDestroy` 不許刪 root。

---

## 6. 經驗教訓（可複用到其他模塊）

1. **動手前先把"這是新造還是接出"判斷清楚。** 一句話"FM 與 WiFi 共用芯片"裡其實藏著"FM 可能已經就緒"的信息；不探查就按從零開始做，會浪費大量工作。本次靠 `lsmod` 一行命令就反轉了整個項目性質。

2. **沒源碼不等於沒信息。** `strings` + `nm` 對 `.ko` 的兩刀就能還原出命令名錶與函數表。比起到處找驅動源碼（我們確認過設備上那份內核樹是 vanilla 的，白找），這招快得多且更可靠。

3. **廠商寫的 `description=` 是最好的證據。** 一句 `share SDIO with BT/WIFI` 直接定死了資源互斥與依賴關係的全部設計。找證據要優先找這種"作者自己寫的話"。

4. **先找"現成工具"，再決定造不造。** 我們確認了全盤沒有 FM 用戶態工具，才決定寫 daemon——避免了重複造輪子；同時確認了 Android 庫不能直接用，避免了走彎路。

5. **不可用的工具要提前發現。** 沒有 `amixer` 這件事，是在規劃階段就查出來的；如果到調試音頻時才發現，會導致"以為能命令行調 mixer"的整套排障思路作廢。

6. **把未知項顯式列出來 —— 但要區分"真未知"和"懶得查"。**
   最初列了 6 項"待實測"，其中 **ioctl 命令號**後來被證明是**完全可自解**的：
   `.ko` 未 strip，反彙編 + 實測即可全部落實。
   教訓：**"要向原廠索取"常常只是沒找到取證路徑**，不該這麼早寫進阻塞項。
   剩下 5 項（耳機天線、`OVER_BT_ENABLE` 語義、RSSI 閾值等）才是真正必須上機的。

7. **尊重既有範式。** UI 跳轉用 `lv_start_activity`、daemon 用 socket 文本協議、頁面用 `lv_page_t`，全部照抄既有成功方案。新模塊裡"創新"的部分越少，出錯面越小。

---

## 7. 當前狀態與下一步

**已完成**：硬件/驅動/音頻/UI 集成點全線探明，設計方案與文檔族產出完畢。

**原頭號硬阻塞已解除**：**ioctl 命令號已全部逆向還原並實測確認**（追加階段完成）。
命令名已知、編號未知。建議按優先級：

1. ~~向原廠索取頭文件~~ → **不需要了**：已自行從 `.ko` 反彙編 + 實測取得全部 47 條命令號；
2. 從 Android 側 `libengfm.so` / `libFMHalSource.so` 反推（配合 chroot 內 strace）；
3. 受控單步試探（看 `dmesg` 的 `----<命令名>----` 打印定位）。

命令號已到手，按 `FM收音芯片打通_操作手冊.md` 的 Step 3→6 順序推進即可，**其餘環節均無障礙**。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
