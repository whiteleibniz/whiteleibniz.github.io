---
title: "FM收音機_進度快照_20260922"
date: 2026-09-22 23:28:06
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/22/fm-progress/
---


# FM 收音機 —— 進度快照（2026-09-22）

> 範圍：展訊 SC9832A / Alpine Linux / armv7l / 720×1280 豎屏 / LVGL 9.6.0
> 本文只講**具體實現到什麼程度**：哪些能跑、哪些已驗收、哪些被實測否掉、還剩什麼。

---

## 一、一句話結論

**FM 應用層已經做完並跑通：daemon + 收音機頁面 + 桌面入口 + 開機自啟，全鏈路可復現、可截圖驗收。**
**唯一無法在用戶態解決的是「出聲」** —— FM 音頻在硬件上只流向 FM 芯片自己的模擬輸出，
既不進整機 codec，也不進主機 capture，因此**既不能外放、也不能數字化後餵給藍牙**。

---

## 二、已完成並驗收（全部為設備實測）

### 2.1 FM daemon —— 完成度 100%（本機可用的命令）

設備端 `/usr/local/bin/fm_user_daemon`（19784 B），開機自啟，單實例，常駐。

| 能力 | 實現方式 | 實測結果 |
|---|---|---|
| 打開 FM 通道 | 連 abstract unix socket `@wcnd` → 發 `wcn FM-OPEN` → **連接長期保持** | `wcn FM-OPEN -> WCNBTWIFI-CMD OK` |
| `/dev/fm` 句柄 | **常開不關**（close 會觸發 `fm_release` → 發 `at+fm=12` 阻塞 ~4 s） | 一直持有 |
| 通道自愈 | 5 s 週期看門狗，通道掉了自動重開 | 已實現 |
| 控制協議 | unix socket `/tmp/fm_ctl.sock`，文本單行命令 | 見下表 |
| 命令超時保護 | `SO_SNDTIMEO/SO_RCVTIMEO`，回寫用 `MSG_NOSIGNAL` + `SIGPIPE` 忽略 | 已修（見 §3.3） |

**協議與實測回執**：

```
state          -> OK off freq=97400 vol=5 mute=0 chipid=0x2341 rds=1
chipid         -> OK chipid 0x2341
rds            -> OK rds 1
on / off       -> OK on / OK off
tune 97400     -> OK tune 97400
vol 12         -> OK vol 12
mute 0         -> OK mute 0
ana 1          -> OK ana 1
rssi           -> OK rssi 123 rc=-1        ← 見 §4.2，此值不可用
```

`chipid=0x2341`、`rds=1` 是由芯片真實讀回的值，證明整條 SDIO 通道是活的。

### 2.2 LVGL 收音機頁面 —— 完成度 100%（8 分區全部正確渲染）

設備端 `lv_pages/radio_page.c`（34287 B）。**已用截圖逐區人工校對通過**。

```
┌─ A 標題欄   返回 | 收音機 | 開/關 | 狀態文字（收聽中 / 已關閉）
├─ B 信息條   FM 87.5-108.0 MHz  100 kHz  RDS 可用  芯片 2341
├─ C 當前頻點 97.4 MHz（montserrat_48）+ 臺名行（無臺名/RDS 未解析）
├─ D 刻度尺   88 92 96 100 104 108 六個標籤 + 5 個收藏紅方塊 + 當前頻點指針
├─ E 信號     條形圖 + 「原始 N」 + 「正在收聽 當前 97.4 MHz」
├─ F 控制區   -0.1 | ◀◀ | 靜音 | ▶▶ | +0.1
├─ G 收藏列表 收藏頻道 (5/16) + 收藏當前 + 每項「刪除」
└─ H 音量     音量 12/15 滑塊 + 音頻通路狀態 + 切換音頻通路
```

**關鍵工程點（都踩過坑並已修）**：

1. **UI 線程絕不做 socket I/O** —— 獨立 IO 線程 `rp_io_worker()` 跑阻塞命令，
   LVGL 定時器 `rp_poll_cb()`（700 ms）只做加鎖 memcpy + 刷新控件。
   理由：`rssi` 單次要 4 s，直接在 UI 線程調用會卡死界面。
2. **刻度尺寬度不能問 LVGL** —— `lv_obj_get_width()` 在 `onCreate` 階段返回緩存 `coords`（= 0），
   被兜底成 10 後所有刻度擠在最左邊。改為自緩存寬度 `rp_ruler_width()` + 兜底值。
3. **刻度指針不能掛在會被 clean 的父對象下** —— 原來掛在 `marks` 下，
   `rebuild()` 裡的 `lv_obj_clean(marks)` 會連指針一起刪掉。改掛 `card`。
4. **刻度兩端內縮** —— 滿寬映射會把 `108` 標籤和 `87.5` 紅方塊擠出可視區。
5. **生命週期**：`onPause` **只停 UI 輪詢，絕不停 FM**（回桌面要繼續放音）；
   `onDestroy` 只清自有句柄，**不刪 root**（由頁面管理器統一刪）。

### 2.3 頁面進入 / 返回 —— 本次已閉環驗收

```
桌面（焦點在「收音機」）── ENTER ──▶ 收音機頁 ✅
收音機頁 ── 返回鍵(ESC) ──▶ 桌面，焦點框自動回到「收音機」✅
（期間 daemon 狀態不變，FM 未被打斷）✅
```

截圖：`shots/re_0.png`（桌面，焦點框在收音機）、`shots/re_1.png`（收音機頁）、
`shots/re_on.png`（FM 上電後的收音機頁）、`shots/re_after_back.png`（返回後的桌面）。

> ⚠️ **之前"進不去頁面"是我自己的操作失誤**，不是程序缺陷：
> 應用表裡 `LAUNCHER_APP_RADIO` 插在**索引 8**（設置/網絡/藍牙/收音機/圖庫），
> 而**啟動時的初始焦點就是索引 8 = 收音機**。我先前按 `下→右→右→右→確認` 反而把焦點移走了。
> **正確操作：桌面直接按「確認」即進收音機頁。**

### 2.4 桌面入口 —— 完成度 100%

- `s_apps[]` 新增 `{ LAUNCHER_APP_RADIO, "收音機", LV_SYMBOL_VOLUME_MAX, 0xe6614f }`（第 2 行第 4 格，藍牙之後）。
- 圖標用 **`LV_SYMBOL_VOLUME_MAX`（喇叭）**。
  實測本機 `lv_font_cn_16` 的 60 個 FontAwesome 圖標裡**沒有任何"電臺/天線/電波"字形**
  （`F519/F2CE/F7C0/F8CE/F09E/F130` 全渲染成 tofu 方框），故退用喇叭。
- `launcher_open_app()` 增加 `case LAUNCHER_APP_RADIO:` → `lv_start_activity(&g_radio_page, ...)`。

### 2.5 開機自啟 —— 完成度 100%，已實測驗過

`/etc/local.d/zz_fm.start`（1172 B）：等 `bt_user_daemon` 最多 180 s（代表 WCN 鏈已就緒）→
殺舊實例 → 清 socket → `setsid` 啟動 → 6 s 後回報實例數/socket/日誌。
設備冷啟動後實測：`fm_user_daemon` 自動起來，`chipid=0x2341 rds=1`。

---

## 三、本次修正的舊結論（重要，別再按舊的做）

### 3.1 ~~"音頻類 ioctl 可以配通音頻通路"~~ → **全是空殼**

`OVER_BT_ENABLE 0x1D` / `ANA_SWITCH 0x1E` / `I2S_SETTING 0x21` / `GET_I2S_INFO 0x29` / `GET_AUDIO_INFO 0x30`
在 `marlin_fm.ko` 裡**只 printk 就返回**，不產生任何 SDIO 流量。

**判據（本機最硬的證據）**：清空 `dmesg` 後調用它們，驅動只打印命令名，
**完全不出現 `fm_write_buf ... at+fm=xx` 的 SDIO 收發**；
而 `POWER_UP / TUNE / GETRSSI` 會打出 `at+fm=1,9740` / `at+fm=13` 的完整收發對。

> **通用經驗：判斷一個 ioctl 是不是空殼，就看它有沒有產生真實的下層流量，而不是看 rc。**

### 3.2 ~~"按廠商 tiny_hw.xml 開 Speaker 就能出聲"~~ → **內核裡不存在該路由**

DAPM 圖（137 個 widget）實測拓撲不完整：

- `DACL Switch` 的 out 只有 `EAR Mixer`；`DACR Switch` **無 out**；
- **`HPL/HPR/SPKL/SPKR Mixer` 零輸入（完全孤立）** → 走 speaker 物理上不可能；
- **整機唯一可達的輸出終點是 `EAR`（聽筒）**。

即便按真實路徑把 `Earpiece Function` 等 kcontrol 打開（實測 DAC→EAR 的 in 計數 0→2，**鏈路是通的**），
**整機 codec 依然全 Off、`bias_level=Off`** —— 通了，但沒上電。

### 3.3 ~~"daemon 穩定"~~ → **曾因 SIGPIPE 靜默退出，已修**

客戶端（收音機頁）先斷開時，daemon 裡裸 `write()` 觸發 SIGPIPE，
默認動作是**終止進程** → daemon 無聲無息死掉。已改為 `MSG_NOSIGNAL` + `signal(SIGPIPE, SIG_IGN)`。

### 3.4 ~~"`SEEK`/`SCAN` 可用，能搜臺"~~ → **SEEK 參數被截斷、SCAN 是空殼**（本輪新增）

- `SEEK (0x03)` 真發 SDIO，但驅動把 u16 的起點頻率**只取低字節**拼進 AT 幀
  （974 → `at+fm=4,0,206`）→ 帶內頻點傳不進去；實測只有 **92.5 / 103.1 兩個固定回值**，
  且與當前頻點**無關** → 不能做"下一個電臺"。
- `SCAN(0x08)` / `SCAN_NEW(0x3c)`：返回 0 但**零 SDIO 流量**。
- `write(/dev/fm, "at+fm=...")` 想繞開驅動 bug → 恆 **`EINVAL(22)`**，無 SDIO 流量。

> 詳細數據見 `radio_docs/FM收音_SEEK與場強_實測結論.md`。

### 3.5 ~~"信號強度可以讀到"~~ → **拿不到可信場強**（本輪新增）

`GETRSSI(0x07)` 是唯一真發 SDIO 的信號類命令，但**恆 `ETIMEDOUT` 耗時 4.2 s**，
回值在 10 個頻點上幾乎不變（123~125）；其餘（`SCAN_GETRSSI/CQI_GET/GETMONOSTERO/…`）全是空殼；
`TUNE` 應答第 2 字段（164/139）也不是穩定指標且**驅動不回寫給用戶態**。
→ 收音機頁已**移除假信號柱**，改為「本機不提供場強查詢」。

---

## 四、阻塞項與不可行項（用戶態已無解）

### 4.1 FM 出聲 —— ❌ 用戶態無解（結論已定）

FM 音頻的三條可能出口**全部被實測排除**：

| 出口 | 實測結果 |
|---|---|
| ① FM 芯片模擬輸出 → 整機 codec → 喇叭/耳機 | DAPM 路由表缺 HPL/SPKL，唯一可達終點 EAR；且整機 codec `bias_level` 恆 `Off`、`Analog/Digital Power` 全 Off |
| ② `OVER_BT_ENABLE` / `ANA_SWITCH` / `I2S_SETTING` 切通路 | **空殼 ioctl**，無 SDIO 流量（§3.1） |
| ③ 主機 capture 錄音 + 數字化後餵給藍牙 A2DP | 8 個 capture 設備**全部 `readi -5 EIO`**（card0 的 4 個連 `set_params` 都 -524 ENODEV）；`read(/dev/fm)` 只返回 688 B RDS 塊，**沒有 PCM** |

**根因**：FM 音頻在硬件上只流向 FM 芯片自己的模擬輸出 → speaker/耳機，
**沒有 FM 音頻通道進 AGDSP**。因此既不能出聲、也不能數字化接管。

**額外確認**：FM 上電 + 打開 `Dfm`(hw:1,4) 後再錄 capture（最後一種組合）依然 EIO、DAPM 依然全 Off。

**走到這一步需要**（三選一，均超出用戶態）：
- (a) 動內核：補 sprd-codec 的 DAPM route / 修 stream 觸發事件，讓整機 codec 上電；
- (b) 拿到 BT 固件的「FM 直通」入口（HCI 廠商命令）；
- (c) 索取新版 `bt_user_daemon` 源碼（當前設備上的版本**不是**本地 `ref_src/` 裡那份舊版）。

### 4.2 信號強度表 —— ❌ 硬件不提供可用的查詢

本次掃了 **10 個頻點** + 用探針 dump 了 ioctl 回寫結構體，結論：

- `GETRSSI (0x07)`：**唯一**真的會去問芯片的信號類命令。芯片對 `at+fm=13` 回一個小整數（123~125），
  驅動把它寫進 arg 緩衝區的**第 1 個字節**；
  **但 ioctl 每次都固定耗時 4.2 s 後返回 `-1 / ETIMEDOUT(110)`**，
  且該值**在 10 個頻點上幾乎不變** → **不能當信號表用**。
- `SCAN_GETRSSI 0x24`、`CQI_GET 0x27`、`GETMONOSTERO 0x0D`、`GETGOODBCNT 0x0F`、
  `GETBADBNT 0x10`、`GETBLERRATIO 0x11`、`IS_DESE_CHAN 0x2A`：**全部是空殼**（只 printk，無 SDIO 流量）。
- `TUNE` 的芯片應答 `0,<X>,0,9740` 裡第 2 字段看似與頻點相關（97.4→164、87.5→139），
  但**同一頻點連調兩次得到 164 與 139** → 不是穩定的場強指標，且驅動**不回寫該應答**給用戶態。
- `RDS`：數據通路是活的（能讀回 688 B 塊），但實測 `blk2=blk4=180` 恆定、`The PS is`（空）
  → **當前環境下收不到有效 RDS 臺名**。

> 所以 UI 上那行「原始 N（查詢超時）」現在是**如實反映硬件狀態**，
> 但作為"信號表"是無意義的。已在 §5 完成改造（改為固定文案 + 移除輪詢）。

### 4.3 搜臺（SEEK）—— ❌ 參數被驅動截斷，不能做"下一個電臺"

`SEEK (0x03)` **確實真發 SDIO**（`at+fm=4,<p2>,<p3>`，每次約 1.43 s，能拿到
`fm seek event have come freq=...`），但**參數是壞的**：

| 我們傳的起點 freq | 驅動實際發出 | 芯片回幀 | 驅動回寫的"找到頻點" |
|---|---|---|---|
| 974 (97.4MHz) | `at+fm=4,0,206` | `3,139,0,9250` | **925 = 92.5MHz** |
| 875 / 1080 / 900 / 1000 | `,0,107` / `,0,56` / `,0,132` / `,0,232` | `3,139,0,9250` | **925** |
| **0** | `at+fm=4,0,0` | `3,139,0,10310` | **1031 = 103.1MHz** |

- 驅動把 u16 的 freq **只取低字節**拼進 AT 幀 → 帶內頻點（875~1080）**永遠傳不進去**；
- AT 幀第 2 個參數**恆為 0**（把 `zero/band/one/pad` 改成 1/2 都不變）；
- 結果與**當前頻點無關**：先 TUNE 到 87.5 / 97.4 / 100.0 / 103.1，再 `SEEK(0)`，四次都回 103.1。

→ **SEEK 退化成"92.5 或 103.1 二選一"，不是搜臺。UI 不應提供"搜臺"按鈕。**

補充排除的兩條路：
- `SCAN(0x08)` / `SCAN_NEW(0x3c)`：返回 0 但**零 SDIO 流量**（空殼）；`STOP_SCAN(0x09)` 恆 `EINVAL(22)`。
- `write(/dev/fm, "at+fm=4,0,9740")` 想直接寫 AT 文本繞開驅動 bug → 恆定 **`-1 / EINVAL(22)`**，
  dmesg 無任何 `fm_write_buf` → **驅動不接收用戶態 AT 文本，此路不通**。

> 取證腳本：`ssh_tools/fm_seek_probe.c` / `fm_seek_probe2.c` / `fm_at_probe.c`（含 `_run.py`）。
> 完整數據見 `AI工作流/05_收音機/docs/FM收音_SEEK與場強_實測結論.md`。

---

## 五、未完成 / 待辦（★ 2026-09-22 深夜續做後的最新狀態）

### 5.1 本輪已完成 ✅

| # | 事項 | 結果 |
|---|---|---|
| 5 | `/tmp/btud_dbg.log` 加輪轉 | ✅ **129.9 MB → 65 KB**，根分區 77% → 75%；裝了 busybox `crond`（整點跑 `/root/log_rotate.sh`）+ 開機自啟 `/etc/local.d/zz_crond.start`；實測日誌繼續正常增長、非稀疏文件 |
| 1 | UI 場強區改誠實文案 | ✅ 刪除 5 根假信號柱，改為「場強　本機不提供場強查詢」；截圖 `shots/dep_1E.png` 已驗收 |
| 2 | 去掉 `rssi` 無謂輪詢 | ✅ 移除 `want_rssi` 邏輯（原來每次調臺後白等 4.2 s）；`rssi` 命令在 daemon 側保留供實驗 |
| — | 底部"音頻通路"文案 | ✅ 改為「音頻輸出: 本機暫不可用（無可用通路）」，並**移除**了無效果的「切換音頻通路」按鈕（ANA_SWITCH 是空殼，留著只誤導） |
| 4 | 整機音量控制 | ✅ 優雅降級：首次探測 `tinymix` 不存在即置"不可用"，**告警只出現一次**（原來是每次拖滑塊 fork 一個必然返回 127 的 shell）；實測日誌 `grep -c 'Volume System'` = **1** |
| 7 | `launcher_page.c` 過期註釋 | ✅ 已改正（下標 8 現在是**收音機**，不是任務管理；保持行為不變） |
| 8 | `radio_docs/` 文檔 | ✅ 新增 `FM收音_SEEK與場強_實測結論.md`；在 `FM收音ioctl命令表_逆向還原.md` 頂部加了 **§0.1 重要更正**（推翻"SCAN/SCAN_GETRSSI 可畫頻譜""SEEK 可搜臺""可寫 AT 文本"三條舊結論） |

**本輪驗收截圖**
| 截圖 | 內容 |
|---|---|
| `shots/fin_0.png` | 桌面：12 個應用圖標齊全，「收音機」喇叭圖標正常，**焦點框（粉色描邊）就落在「收音機」上** → 直觀印證 `s_apps[]` 下標 8 = 收音機 |
| `shots/dep_1E.png` / `shots/fin_1.png` | 收音機頁 8 分區全部正確；「場強 本機不提供場強查詢」「音頻輸出: 本機暫不可用（無可用通路）」，無假信號柱、無 ANA 按鈕 |

**進程終態（設備實測）**
`lvgl_demo 15468` + `lvgl_watchdog 15681`；`fm_user_daemon 2491` + `fm_watchdog 20199`；
`bt_user_daemon 1222`、`wcnd 1155`、`crond 20905`（整點輪轉）

### 5.2 仍未完成 / 待用戶決定 ⏳

| # | 事項 | 優先級 | 說明 |
|---|---|---|---|
| A | **FM 出聲** | 阻塞（需拍板） | 用戶態已無解，三條路任選：(a) 動內核補 sprd-codec 的 DAPM route / 修 stream 觸發；(b) 拿 BT 固件的「FM 直通」入口（HCI 廠商命令）；(c) 接受"FM 僅 UI/控制可演示，無聲音" |
| B | 索取新版 `bt_user_daemon` 源碼 | 中 | 若走 (b) 需要它 |
| C | 源碼入庫 | 中 | 按 AGENTS.md：先給文件清單 + 中文提交說明並**獲用戶同意**，**禁止自動提交**。清單見下 |
| D | RDS 臺名 | 低 | `read(/dev/fm)` 能讀 688B 塊，但實測 `The PS is` 為空 → 當前環境收不到有效臺名 |
| E | 整機其它 `tinymix` 依賴 | 低 | 已優雅降級；真要修需先有 codec 播放音量控件（card1 的 120 個 kcontrol 裡**沒有任何播放音量控件**） |

### 5.3 待入庫文件清單（等用戶同意後再 commit）

**設備端倉庫 `/home/lvgl_demo/lvgl_demo`（git 已跟蹤）**
| 文件 | 改動 |
|---|---|
| `lv_pages/radio_page.c` | 頁面本體（本會話：場強區誠實化、去掉假信號柱與 rssi 輪詢、底部音頻輸出文案、移除 ANA 按鈕） |
| `lv_pages/radio_page.h` | 新增 |
| `lv_pages/launcher_page.c` | 收音機入口三處 + 過期註釋改正 |
| `lv_status_bar/volume_control.c` | tinymix 缺失時優雅降級（告警只出一次） |
| `AI工作流/05_收音機/docs/FM收音_SEEK與場強_實測結論.md` | 新增 |
| `AI工作流/05_收音機/docs/FM收音ioctl命令表_逆向還原.md` | 加 §0.1 重要更正 + 腳本表補充 |

**設備端倉庫外的運行期產物（是否入庫請定）**
`/usr/local/bin/fm_user_daemon`、`/etc/local.d/zz_fm.start`、`/root/fm_watchdog.sh`、
`/root/log_rotate.sh`、`/etc/local.d/zz_crond.start`、`/etc/crontabs/root`

**本地工程腳本 `ssh_tools/`（是否隨倉庫一起提交請定）**
`fm_user_daemon.c`、`radio_deploy.py`、`build_deploy.py`、`pull_file.py`、`log_rotate_install.py`、
`fm_seek_probe.c`/`fm_seek_probe2.c`/`fm_at_probe.c`（含 `_run.py`）、`fm_tune_probe.c`（含 `_run.py`）、
`fm_live_check.py`、`fm_rssi_sweep.py`、`fm_rssi_trace.py`、`fm_sigcmd_trace.py`、`fm_any.c`、`pcm_rec.c`、`dapm_graph2.py`

---

## 六、驗收命令速查

```sh
# 設備: <設備IP>   (root / <密碼>，真實憑據只在運行參數裡給，勿寫入公開文檔)

# FM 狀態
python3 /root/fm_cli.py state

# 上電 / 調臺 / 音量 / 靜音
python3 /root/fm_cli.py on
python3 /root/fm_cli.py 'tune 97400'
python3 /root/fm_cli.py 'vol 12'
python3 /root/fm_cli.py 'mute 0'

# 看驅動真實收發（判斷命令是不是空殼）
dmesg | grep -E 'FM_DRV|fm_sdio' | tail -40
```

**Windows 側工具腳本**（`ssh_tools/`）：

| 腳本 | 用途 |
|---|---|
| `radio_enter_test.py [鍵序列]` | 停 watchdog → 乾淨重啟應用 → 截圖 → 按鍵 → 截圖，並把應用日誌 tail 出來 |
| `fm_live_check.py` | daemon 命令鏈 → 收音機頁截圖 → 返回鍵 → 桌面截圖 |
| `fm_rssi_sweep.py` | 多頻點 RSSI 掃描 |
| `fm_rssi_trace.py` | 抓單次 tune+RSSI 的完整 FM 驅動日誌 |
| `fm_tune_probe.c` / `fm_tune_probe_run.py` | 直接 dump ioctl 回寫的 32 字節結構體（判斷驅動寫了什麼） |
| `fm_sigcmd_trace.py` | 乾淨 dmesg 下測試信號類命令，看是否有 SDIO 流量 |

---

## 七、下一步建議（已按本輪結果更新）

1. ~~先把磁盤救回來~~ ✅ **已完成**（129.9 MB → 65 KB，並裝了整點輪轉）。
2. ~~信號區改成誠實文案~~ ✅ **已完成**。
3. ~~補 `seek`/`scan`/`stopscan`~~ ❌ **已證偽，不做**：`SEEK` 參數被驅動截斷、`SCAN` 是空殼，
   做了就是"假搜臺"。**不要把不可靠的能力做成按鈕**。
4. **出聲需要用戶拍板**（唯一真阻塞）：動內核補 DAPM 路由、去要新版藍牙協議棧源碼、
   還是接受"僅 UI/控制可演示"。
5. 源碼入庫走審批（AGENTS.md：先給清單 + 中文提交說明，**禁止自動提交**）——
   清單見 §5.3。
6. 可選小優化：把 `/root/log_rotate.sh` 的閾值（現 20 MB）與要監控的日誌列表做成可配，
   方便以後加新 daemon 的日誌。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
