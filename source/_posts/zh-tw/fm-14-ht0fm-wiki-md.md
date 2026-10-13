---
title: "HT0FM收音原理與移植學習Wiki"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-14-ht0fm-wiki-md/
---


# HT0 FM 收音機原理與移植學習 Wiki

> **讀者對象**：想搞懂"這顆芯片的 FM 到底怎麼回事"、以及將來要遷移到別的平臺的工程師
> **閱讀方式**：§0–§2 建立直覺 → §3 理解軟硬件分層 → §4 看安卓怎麼幹 → §5 看我們怎麼幹 → §8 排障方法論 → §9 遷移清單
> **核心價值**：把散落在 `.ko` 符號、ALSA 拓撲、Android 原廠庫裡的事實，整理成一條能讀懂的知識鏈

---

## 0. 一句話先建立直覺

**FM 收音機在這顆芯片上，不是一塊獨立硬件，而是 Marlin2 這顆"三位一體"芯片裡的第三個功能模塊。**

它的射頻、解調、RDS 解碼都在芯片內部完成，對外只暴露一個 SDIO 上的控制通道和一個 `/dev/fm` 字符設備。
你在 Linux 用戶態能做的，本質只有三件事：**給它命令、問它場強、把它產出的音頻接到 codec 上**。

---

## 1. 硬件長什麼樣

### 1.1 一顆芯片，三個功能

```
                        ┌─────────────────────────┐
   SDIO 總線  ──────────▶  Unisoc(展訊) Marlin2   │
   (共享！)              │  ┌───────────────────┐ │
                         │  │ WiFi  (sprdwl)    │ │
                         │  ├───────────────────┤ │
                         │  │ Bluetooth (BT/UART)│ │
                         │  ├───────────────────┤ │
                         │  │ FM Radio (marlin_fm)│ │
                         │  └───────────────────┘ │
                         └───────────┬───────────┘
                                     │ 音頻輸出
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              內部 codec 直通      I2S 總線      Over BT（走藍牙）
```

**實測證據**：

| 事實 | 取值 | 獲取方式 |
|---|---|---|
| SDIO modalias | `sdio:c00v0000d2331` | `cat /sys/bus/sdio/devices/*/modalias` |
| SDIO 設備路徑 | `mmc2:8800:1` | `ls /sys/bus/sdio/devices/` |
| vendor / device | `0x0000` / `0x2331` | `cat .../vendor`、`.../device` |
| **共享 SDIO 官方表述** | `SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI` | `strings /lib/modules/marlin_fm.ko \| grep description=` |

最後一行是**最關鍵的一條**：驅動作者自己寫明 FM 與 BT/WiFi **共享 SDIO**。
這條決定了 FM 的一切可用性依賴（固件、上電）都跟 WiFi/藍牙綁在一起。

### 1.2 "共享 SDIO"意味著什麼

| 影響面 | 說明 |
|---|---|
| **固件** | `download` 一次把 combo 固件整體燒入，**含 FM 部分**。沒有獨立的 FM 固件流程 |
| **上電** | 沒有獨立的 FM 上電開關，芯片整體帶電即可（依賴 `wcnd` / BT-OPEN 那條鏈） |
| **帶寬** | SDIO 是共享總線，WiFi 高吞吐時理論上可能影響 FM 數據流，**需實測評估** |
| **故障耦合** | WiFi 掛了 ⇒ SDIO 不枚舉 ⇒ FM 必然不可用。**排障必須先確認 WiFi** |

---

## 2. 軟件分層（五層模型）

```
⑤ UI 層      LVGL 收音機頁         ← 本項目新增主體
      │ unix socket /tmp/fm_ctl.sock
④ daemon 層  fm_radio_daemon       ← 本項目新增，獨佔 /dev/fm
      │ ioctl / AT 命令
③ 驅動層      marlin_fm.ko → /dev/fm (misc 23)   ← 已存在
      │ SDIO 事務
② 固件層      Marlin2 combo 固件（含 FM）        ← 隨 WiFi 一起燒好
      │ SDIO 物理鏈路
① 硬件層      Marlin2 芯片 FM 部件               ← 已存在
```

**每層對應的"驗證標準"**（這是排障的分層依據）：

| 層 | 通過判據 |
|---|---|
| ① 硬件 | `cat /sys/bus/sdio/devices/*/device` 得到 `0x2331` |
| ② 固件 | WiFi 能起來（`download` 常駐） |
| ③ 驅動 | `lsmod \| grep marlin_fm` 且 `ls /dev/fm` 且 `grep -w fm /proc/misc` 得到 `23 fm` |
| ④ daemon | `connect /tmp/fm_ctl.sock` 成功，`state` 返回 `OK *` |
| ⑤ UI | 能調臺、聽到聲音、返回桌面不停臺 |

---

## 3. 驅動給能力的邊界：命令清單與 RDS

### 3.1 控制命令（來自 `strings marlin_fm.ko` 的調試打印）

驅動為 ioctl 的每個分支打印 `----<命令名>----`，據此還原：

| 類別 | 命令 |
|---|---|
| 基礎 | `TUNE`、`TUNE_NEW`、`SEEK`、`SEEK_NEW`、`MUTE`、`SETVOL`、`GETVOL`、`IS_FM_POWERED_UP` |
| 掃描 | `SCAN`、`SCAN_NEW`、`STOP_SCAN`、`SCAN_GETRSSI`、`PRE_SEARCH`、`RESTORE_SEARCH` |
| 信號 | `GETRSSI`、`GETMONOSTERO`、`SETMONOSTERO`、`SOFT_MUTE_TUNE`、`DESENSE_CHECK`、`IS_DESE_CHAN`、`CQI_GET`、`FULL_CQI_LOG` |
| 音頻 | `ANA_SWITCH`、`I2S_SETTING`、`GET_I2S_INFO`、`GET_AUDIO_INFO`、`OVER_BT_ENABLE` |
| RDS | `RDS_SUPPORT`、`RDS_ONOFF`、`RDS_GROUPCNT`、`RDS_BC_RST` |
| 信息 | `GETCHIPID`、`GET_HW_INFO`、`GETCAPARRAY`、`GETCURPAMD`、`GETGOODBCNT`、`GETBADBNT`、`GETBLERRATIO` |
| 量產調試 | `RW_REG`、`TOP_RDWR`、`HOST_RDWR`、`DUMP_REG`、`EM_TEST`、`SIM_DATA`、`GET_LOG` |

> ✅ **更新（2026-09-22）**：命令號**已全部還原並實測確認**，見
> [`FM收音ioctl命令表_逆向還原.md`](FM收音ioctl命令表_逆向還原.md)。
> 編碼統一為 `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`，47 條中 45 條實測通過。
> 本節保留作**功能視角**的分類，取數字請查那份文檔。

### 3.2 AT 命令風格 —— 已實測確認，而且是真的

驅動裡有 `parse_at_fm_cmd` / `parse_at_fm_num` 兩個函數；Android 側 `libengfm.so` 只導出一個符號 `fm_runcommand`
（直譯就是"跑一條 FM 命令"）。

**這不是猜測，實測抓到了 AT 幀**。調用 `TUNE` 時完整內核日誌：

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_write-348 -- fm_write_completion done=0X0
FM_DRV: fm_write_buf-337 -- * fmdev->write_buf: at+fm=1,0 *
fm_sdio_write size: 11
```

結論：

1. 驅動通過 SDIO 下發的確實是 **AT 文本**，格式 **`at+fm=<opcode>,<param>`**
   （`at+fm=1,0` 是 10 字符 + NUL = 11 字節，與 `fm_sdio_write size: 11` 對得上）。
2. **AT opcode 與 ioctl nr 是兩套編號**：`TUNE` 的 ioctl nr 是 `0x02`，AT opcode 卻是 `1`。
   目前只確認 `power up -> at+fm=0`、`TUNE -> at+fm=1,<freq>`。**AT 全表尚未標定，別混用**。
3. 另一條副產品：**`TUNE` 是阻塞調用**，失敗路徑耗時約 **3.99 s**（日誌時間戳跨度
   `11448.618` → `11452.613`）。所以 daemon 必須把 TUNE/SEEK 放獨立線程，socket 必須設超時。

### 3.3 RDS —— 本項目的差異化價值

`nm marlin_fm.ko` 顯示出完整 RDS 解析器：

| 字段 | 函數 | 長度/含義 |
|---|---|---|
| **PS** | `rds_get_ps` | 電臺名，**8 字符** |
| **RT** | `rds_get_rt` | 電臺文本，**64 字符**（滾動字幕） |
| PTY | `rds_get_pty` | 節目類型（新聞/古典/搖滾…） |
| PI | `rds_get_pi_code` | 節目識別碼 |
| **AF** | `rds_get_af` / `rds_get_af_method` | **備用頻率**——信號變差時自動切到同一套節目的另一個頻率 |
| TP/TA | `rds_get_tp_ta` | 交通節目 / 交通通告 |
| CT | `rds_get_ct` | 電臺時鐘 |
| DI/MS | `rds_get_di_ms` | 解碼標識 / 音樂-語音 |
| **EWS** | `rds_get_ews` | **緊急廣播**（有合規意義） |
| PTYN / PIN / SLC | `rds_get_ptyn` / `rds_get_pin` / `rds_get_slc` | 節目類型名 / 條目號 / SLC |
| ODA / TDC | `rds_get_oda` / `rds_get_oda_aid` / `rds_get_tdc` | 開放數據應用 / 透傳數據通道 |
| EON | `rds_get_eon` / `rds_get_eon_ta` | 增強其他網絡信息 |

**這意味著收音機 App 不只是"能出聲"，而是能顯示臺名、滾動字幕、節目類型，還能自動追頻**。
設計 UI 時務必把這些能力用起來，不要退化成一個只有頻率數字的界面。

---

## 4. 安卓原生是怎麼幹的（對照樣本）

設備上的 `/mnt/android_sys` 掛著原廠 Android 分區，可以直接翻：

| 組件 | 路徑 | 說明 |
|---|---|---|
| FM HAL 音頻源 | `/mnt/android_sys/lib/libFMHalSource.so` | `android::FMHalSource` 類 |
| 工程模式庫 | `/mnt/android_sys/lib/libengfm.so` | **只導出 `fm_runcommand`** |
| JNI 橋 | `/mnt/android_sys/lib/libfmjni.so` | Java ↔ native |
| 廣播服務 | `libradio.so` / `libradioservice.so` / `libradio_metadata.so` | 標準 broadcast radio HAL 棧 |
| 服務 APK | `/mnt/android_sys/priv-app/radio_interactor_service/` | 上層服務 |
| 驅動 | `/mnt/android_sys/lib/modules/marlin_fm.ko` | 與本機加載的同一份 |

### 4.1 從 `libFMHalSource.so` 讀出來的音頻架構

`nm -D` 顯示該類持有：

- **`pcmHandle`**（tinyalsa PCM 句柄）
- `mSamplerate` / `mPeriodSize` / `mPeriodCount` / `mChannel`
- 一個後臺線程 `FMHalThread::threadLoop()`
- 一個 `RingBuffer`（`GetData/PutData/GetBuf/PutBuf/BufCount`）

**結論**：安卓側是**起線程從 PCM 讀數據，經環形緩衝再交給音頻輸出**的一條典型音頻管線。
我們自己在 Alpine 上寫的 daemon，本質上要復刻這同一條鏈路（但可以用更簡單的實現）。

### 4.2 為什麼**不能直接複用**這些庫

它們依賴 Android 運行時（binder、`sp<>` 智能指針、`ALooper`、`RingBuffer` 等 Android 基礎設施），
在 Alpine 上**動態加載跑不起來**。只能當作**對照樣本/事實來源**，不能當組件複用。

---

## 5. 我們的方案：在 Alpine 上用最少的代碼替換一整套

### 5.1 設計取捨

| 決策 | 選擇 | 理由 |
|---|---|---|
| 是否重寫 FM 協議棧 | **否** | 芯片內已實現，我們只發命令 |
| 控制通道 | 寫 FM daemon 獨佔 `/dev/fm` | 避免多進程競爭；與藍牙 daemon 的做法保持一致 |
| 對外接口 | unix socket + 純文本命令 | 完全鏡像既有 `bt_user_daemon`（`/tmp/bt_ctl.sock`），團隊認知成本最低 |
| 音頻輸出 | 優先試內部 codec 直通（`ANA_SWITCH`） | I2S 與 Over-BT 作為備選，**待實測** |
| UI 承載 | LVGL 收音機頁 | 與桌面其它 App 同構 |

### 5.2 為什麼"鏡像 bt_user_daemon"是正確選擇

藍牙 daemon 已經是團隊驗證過的範式：

```
unix socket /tmp/bt_ctl.sock，文本命令，chmod 0666
    發 "state"  → 回 "OK ON" / "OK OFF"
    發 "on"     → 回 "OK ON"
    發 "off"    → 回 "OK OFF"
```

FM 照抄這套：**同樣減少對莫名其妙新協議的認知負擔，且 socket 超時、重連等坑已經踩過一遍**。

### 5.3 那個必須記住的坑：socket 超時

> 🔒 在 LVGL 定時器回調裡做 socket I/O，**必須**設 `SO_RCVTIMEO` / `SO_SNDTIMEO`（建議 200ms）。
> 否則 daemon 一旦無響應，**整個 UI 線程凍結**。這是本項目藍牙頁已經踩過的硬教訓，FM 不要再踩一次。

---

## 6. 音頻通路：三種可能，必須實測選一

本機 ALSA 拓撲實測：

```
0 [alli2s]       00-00~00-03: i2s.0~i2s.3 null-codec-dai-N   playback + capture
1 [sprdphone]    01-00 HiFi sprd-codec-i2s-0                  playback + capture
                 01-01 Voice sprd-codec-vaudio-1              playback + capture
                 01-02 AuxRecord                              capture
                 01-03 AuxDSPCaptrue                          capture
                 01-04 Dfm sprd-codec-fm-4                    playback  ← FM 專用！
2 [saudiovoip]   ...
3 [saudiolte]    ...
```

對應驅動三個 ioctl：

| 路徑 | ioctl | 狀態 |
|---|---|---|
| 模擬/內部 codec 直通 | `ANA_SWITCH` | 默認候選 |
| I2S | `I2S_SETTING` / `GET_I2S_INFO` | 備選 |
| FM 音頻走藍牙 | `OVER_BT_ENABLE` | 語義待確認 |

**工具現狀**：本機有 `libasound.so.2`，但**沒有** `amixer` / `tinymix` / `aplay`
→ **不能靠命令行調 mixer，必須寫 C 代碼**。

**尚未確認**（不能當事實）：
1. FM 是否需要插耳機當天線（`01-04` 的存在暗示可以不插，但需實測）；
2. `OVER_BT_ENABLE` 的確切語義；
3. `SETVOL` 是 FM 模塊內部增益還是主輸出音量。

---

## 7. 三個字：不確定性

本 Wiki 中**尚未實測**的關鍵項，在正式動手前必須逐項確認（集中列在這裡便於對照）：

| # | 待確認項 | 影響 |
|---|---|---|
| 1 | ioctl **命令號** | 全流程阻塞，拿不到就沒法發命令 |
| 2 | 是否依賴耳機天線 | 決定 UI 是否要有"請插入耳機"態 |
| 3 | `OVER_BT_ENABLE` 語義 | 決定聲道仲裁邏輯 |
| 4 | `SETVOL` 作用域 | 決定音量控制鏈路 |
| 5 | RSSI 原始值量綱與閾值 | 決定信號條怎麼畫 |
| 6 | 系統 suspend 時 FM 行為 | 決定"息屏續聽"能否做 |

> 這個列表本身就是一份交付物：**把"知道不知道"講清楚，比假裝全知道更有工程價值。**

---

## 8. 排障方法論（遷移時照這個查）

1. **先分層**：①②固件上電 → ③驅動 → ④daemon → ⑤UI。任何一層不通都不要往上層猜。
2. **用節點說話**：`lsmod` / `ls /dev/fm` / `/proc/misc` / `sdio device` 四條命令判生死。
3. **ioctl 對不對看 dmesg**：驅動會打 `----<命令名>----`，這是判斷命令號映射是否正確的唯一直接證據。
4. **音頻不許用日誌判定**：必須人耳聽。
5. **UI 卡死先懷疑 socket 阻塞**：查是否設了超時。

---

## 9. 遷移到類似設備的通用清單

要把這套 FM 方案遷到另一臺同類設備（展訊/Unisoc Marlin 系列），按順序做：

1. **確認 SDIO 枚舉**：`cat /sys/bus/sdio/devices/*/device`，看 device id 是否一致。
2. **確認驅動**：`lsmod | grep <fm 驅動名>`、`ls /dev/<fm 節點>`。
3. **確認共享關係**：`strings <fm驅動>.ko | grep description=`，搞清是否與 WiFi/BT 共享 SDIO。
4. **拉命令清單**：`strings <驅動>.ko | grep -- '----'`，以及 `nm <驅動>.ko | grep ' T '`。
   **再進一步——把命令號也反推出來**：`file <驅動>.ko` 看是否 `not stripped`，
   然後 `objdump -d --disassemble=<ioctl函數>`，讀二分查找樹裡的常量。
   若驅動會打印 `----<命令名>----`，用「全零參數單步調用 + `dmesg -c` 清空取日誌」逐條實測確認。
   **能自己算出來的，就不要列成"要向原廠索取"。**
5. **確認音頻拓撲**：`cat /proc/asound/pcm | grep -i fm`。
6. **找 userspace 缺口**：有沒有現成 FM 工具？（本機沒有，需自己寫 daemon）
7. **鏡像既有 daemon 範式**：照抄本設備已驗證成功的那個 socket daemon 的用法。
8. **重新跑一遍 §7 的六項待確認**——不同設備的答案可能不同，**不要照搬本機的結論**。

---

## 10. 這份 Wiki 想讓你記住的

> **FM 是"現成的"，不是"要做的"。**
>
> 芯片裡有 FM、固件裡有 FM、驅動裡躺著 FM、甚至 RDS 解析器都寫好了——
> 我們真正要做的只有三件工程活：**把 `/dev/fm` 的操作包裝成一個 daemon、把音頻接到 codec 上、畫一個能用 RDS 的界面**。
>
> **而"信息缺口"這件事，比想象中好解決得多。**
> 最初我們把"ioctl 命令號拿不到"列為頭號硬阻塞，甚至準備去求原廠頭文件。
> 最後發現：`.ko` **沒被 strip**，命令號就明文躺在機器碼裡；
> 加上驅動會把每條命令的名字打進內核日誌，**反彙編定位候選 + 全零參數單步實測**就把 47 條全部落實了。
>
> 所以第一優先級不是"去要頭文件"，而是——**先看看它是不是根本不用要**。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
