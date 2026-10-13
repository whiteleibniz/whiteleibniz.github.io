---
title: "FM收音打通_AI指導手冊"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-08-fm-ai-md/
---


# 展訊 SC9832A（spd-box）FM 收音打通 —— AI 執行指導手冊

> **讀者對象**：AI 助手 / 工程師，需在同類設備（展訊 SC9832A + Marlin2 combo 芯片，安卓內核 + Alpine 用戶態）上把 FM 收音機做起來
> **使用方式**：先讀 §1–§3 建立上下文 → 按 §5 分層驗證 → 按 §6 執行 → 遇故障查 §7 決策表
> **核心價值**：本文所有硬件事實均已在設備上實測取得；照著做可**跳過全部底層探查**，直接進入"寫 daemon + 畫 UI"階段；§3 明確標註了不要再走的死路

---

## 1. 設備與環境速覽

| 項目 | 值 |
|---|---|
| 主機名 / 內核 | `spd-box` / `Linux 3.10.65` armv7l |
| 系統組合 | 保留安卓 6.0 內核 + switchroot 到 **Alpine Linux** 用戶態 |
| 無線芯片 | **展訊 Marlin2 combo WCN** —— WiFi + 藍牙 + FM **同一顆芯片，共享 SDIO** |
| SDIO 枚舉 | `sdio:c00v0000d2331`，`/sys/bus/sdio/devices/mmc2:8800:1` 的 `device=0x2331` |
| FM 內核驅動 | **`marlin_fm`（已加載）**，/lib/modules/marlin_fm.ko，17554 字節 |
| FM 設備節點 | **`/dev/fm`**（misc，`/proc/misc` 中登記為 `23 fm`）、`/dev/log_radio`（`35`） |
| 顯示 | 720×1280 豎屏 framebuffer，LVGL 9.6.0 |
| SSH | `root@<設備IP>`（密碼與 IP 見環境記錄，勿寫入文檔） |
| Android 原廠分區 | 已掛載在 `/mnt/android_sys`（可作為信息源與對照樣本） |

> ⚠️ 隱私紅線：所有交付物中**禁止**出現 SSH 密碼、賬號、真實 IP，一律寫 `<設備IP>` / `<密碼>` 佔位符。

---

## 2. 已確認的硬事實（無需重新探查，直接信任）

> 以下每一條都註明了獲取方式，**標 ✅ 的是實測結論，可直接當作設計依據**。

### 2.1 芯片與資源共享（最關鍵的一條）

1. ✅ **FM 與 WiFi/藍牙共享 SDIO，同屬一顆 Marlin2 芯片**。
   證據一：SDIO 總線上只有**一個**設備，modalias 為 `sdio:c00v0000d2331`。
   證據二：驅動模塊描述原文（取自 `strings /lib/modules/marlin_fm.ko`）：
   ```
   description=SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI
   ```
   **這條直接決定了 FM 的可用性依賴 WiFi 上電鏈**（詳見 §4）。

2. ✅ **FM 驅動已經加載，且 `marlin_fm` 被 `sprdwl` 依賴**（`lsmod` 顯示 `marlin_fm 17554 1 sprdwl`）。
   說明它不是孤立模塊，卸載/重載要注意 WiFi 的依賴關係。

3. ✅ **`/dev/fm` 已經存在且已註冊**（`/proc/misc` 第 23 項），**不需要重新 insmod 或 mknod**。

### 2.2 驅動能力清單（來自 `strings marlin_fm.ko` 的調試輸出）

驅動為每個 ioctl 命令打印 `----<命令名>----`，據此還原出完整命令集：

| 類別 | 命令 |
|---|---|
| **基礎控制** | `TUNE`、`TUNE_NEW`、`SEEK`、`SEEK_NEW`、`MUTE`、`SETVOL`、`GETVOL`、`IS_FM_POWERED_UP` |
| **掃描** | `SCAN`、`SCAN_NEW`、`STOP_SCAN`、`SCAN_GETRSSI`、`PRE_SEARCH`、`RESTORE_SEARCH` |
| **信號** | `GETRSSI`、`GETMONOSTERO`、`SETMONOSTERO`、`SOFT_MUTE_TUNE`、`DESENSE_CHECK`、`IS_DESE_CHAN`、`CQI_GET`、`FULL_CQI_LOG` |
| **音頻路徑** | `ANA_SWITCH`、`I2S_SETTING`、`GET_I2S_INFO`、`GET_AUDIO_INFO`、`OVER_BT_ENABLE` |
| **RDS** | `RDS_SUPPORT`、`RDS_ONOFF`、`RDS_GROUPCNT`、`RDS_BC_RST` |
| **芯片信息** | `GETCHIPID`、`GET_HW_INFO`、`GETCAPARRAY`、`GETCURPAMD`、`GETGOODBCNT`、`GETBADBNT`、`GETBLERRATIO` |
| **調試/量產** | `RW_REG`、`TOP_RDWR`、`HOST_RDWR`、`DUMP_REG`、`EM_TEST`、`SIM_DATA`、`GET_LOG` |

> ⚠️ **誠實標註**：上表命令**名**來自驅動內部的調試打印字符串，可確信這些命令分支真實存在；
> **命令號已於 2026-09-22 全部逆向還原並實測確認**，見 [`FM收音ioctl命令表_逆向還原.md`](FM收音ioctl命令表_逆向還原.md)：
> 統一編碼 `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`，47 條中 45 條已由設備實測確認。
> 本節的分類表保留作功能視角，**具體數字一律查那份文檔**，不要憑猜。

### 2.3 RDS 能力（來自 `nm marlin_fm.ko` 的函數符號）

驅動內含完整 RDS 解析器，**這是本項目 FM 功能的最大價值點**：

| 函數 | 含義 | UI 用途 |
|---|---|---|
| `rds_get_ps` | Program Service，**電臺名 8 字符** | 主頻點下顯示臺名 |
| `rds_get_rt` | Radio Text，**電臺文本 64 字符** | 滾動字幕 |
| `rds_get_pty` | Program Type 節目類型 | 小標籤（新聞/音樂/交通） |
| `rds_get_af` / `rds_get_af_method` | Alternative Frequency 備用頻率 | 自動切強信號同臺頻率 |
| `rds_get_pi_code` | Programme Identification | 臺標識 |
| `rds_get_tp_ta` | Traffic Program / Announcement | 交通廣播標 |
| `rds_get_ct` | Clock Time 電臺時鐘 | 狀態欄時間可選源 |
| `rds_get_di_ms` | Decoder ID / Music-Speech | 立體聲/語音標 |
| `rds_get_ews` | Emergency Warning System | 緊急廣播（有合規意義） |
| `rds_get_ptyn` / `rds_get_pin` / `rds_get_slc` | 節目類型名 / 條目號 / SLC | 擴展字段 |
| `rds_get_oda` / `rds_get_oda_aid` / `rds_get_tdc` | 開放數據應用 | 擴展字段 |
| `rds_get_eon` / `rds_get_eon_ta` | Enhanced Other Networks | 跨臺信息 |
| `rds_parser` / `rds_parser_init` / `fm_read_rds_data` | 解析器主體 | — |

其他確認存在的函數符號：`fm_open`、`fm_ioctl`、`fm_read`、`fm_write`、`fm_tune`、`fm_seek`、`fm_getrssi`、`fm_mute`、`fm_powerup`、`fm_powerdown`、`fm_rds_onoff`、`fm_sdio_read`、`fm_sdio_write`、`receive_tasklet`、`fm_suspend`、`fm_resume`、`parse_at_fm_cmd`、`parse_at_fm_num`。

### 2.4 音頻現狀（決定了聲道仲裁的設計）

| 事實 | 現狀 |
|---|---|
| ALSA 聲卡 | `0 [alli2s]` / `1 [sprdphone]` / `2 [saudiovoip]` / `3 [saudiolte]` |
| **FM 專用 PCM** | **`01-04: Dfm sprd-codec-fm-4`，僅 playback**（無對應 capture 節點） |
| 其他 PCM | card 0 有四路 `i2s.x null-codec-dai-x`，**均同時支持 playback + capture** |
| ALSA 用戶態庫 | ✅ 有 `libasound.so.2`（可寫 C 直接操作 PCM 與 mixer） |
| ALSA **命令行工具** | ❌ 無 `amixer` / `tinymix` / `aplay` / `alsamixer` —— **必須寫代碼，不能用 shell 調 mixer** |

> 推論：FM 音頻既有可能走內部 codec 直通（對應 `01-04`），也有可能經某路 I2S 進入 codec。
> **`ANA_SWITCH` 與 `I2S_SETTING` 二選一的取捨，必須實測後才能定**（見 §8 待辦第 2 條）。

### 2.5 既有上電鏈（FM 必須掛靠其上）

藍牙/WiFi 已固化的鏈路（`01_WiFi打通` / `02_藍牙打通` 文檔記錄）：

```
logdw → download(常駐) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)
```

其中 `download` 一次把 combo 固件（含 FM 部分）燒入芯片。

---

## 3. 已驗證死路（不要重試，浪費輪次）

| 路線 | 結果 | 原因 |
|---|---|---|
| 在設備上找 `marlin_fm` 的**驅動源碼** | ❌ 沒有 | `/tmp/linux-3.10.65` 是 **vanilla 內核樹**，只有 `wl128x`、`sf16fmr2` 等通用 radio 驅動，**沒有**展訊私有 FM 源碼；不要指望在設備上讀到 `fm.h` |
| 找現成的 FM 用戶態守護進程/命令行工具 | ❌ 沒有 | `ls /usr/bin /usr/sbin /bin /sbin \| grep fm` 無輸出，全盤也沒找到 FM 可執行文件。**必須自己寫 daemon** |
| 用 `amixer`/`tinymix` 切音頻通路 | ❌ 裝都沒裝 | 見 §2.4，只能寫代碼走 ALSA lib 或直接 ioctl |
| 指望 Android 層的 FM 庫直接複用 | ❌ 不能直接跑 | `/mnt/android_sys/lib/` 下有 `libFMHalSource.so`、`libengfm.so`、`libfmjni.so`、`libradio*.so`，但它們依賴 Android 運行時（binder/ALooper/`sp<>` 等），**在 Alpine 上無法直接動態加載** |
| 誤以為 RDS 不存在 | ❌ 恰恰相反 | 驅動裡 RDS 解析函數很完整（§2.3），是本項目 FM 的差異化價值點，別丟掉 |

> **`libengfm.so` 值得單獨說一句**：它只導出一個符號 `fm_runcommand`。這暗示原廠工程模式就是以"跑命令"的方式操作 FM
> （與驅動裡的 `parse_at_fm_cmd` / `parse_at_fm_num` 呼應）→ 提示 FM 控制很可能走 **AT 命令風格**，這是探查 ioctl 數字之外的第二條可行路線。

---

## 4. 系統模型：五層 + 每層驗證標準

```
┌─ ① 固件層    download 已把 combo 固件燒入 Marlin2
│      驗證：WiFi 可用 ⇒ FM 固件就緒
├─ ② 上電層    wcnd / BT-OPEN 使芯片整體帶電；FM 共享 SDIO，無獨立上電步驟
│      驗證：/sys/bus/sdio/devices/mmc2:8800:1 存在，device=0x2331
├─ ③ 驅動層    marlin_fm.ko 已加載並註冊 misc 設備
│      驗證：lsmod | grep marlin_fm   且   ls /dev/fm   且   grep fm /proc/misc
├─ ④ daemon 層 FM daemon 獨佔 /dev/fm，對外暴露 unix socket（★ 本任務要新建的唯一後臺組件）
│      驗證：socket 收發 command 返回 OK
└─ ⑤ UI 層     LVGL 收音機頁，經 socket 與 daemon 通信（★ 本任務主體）
       驗證：點擊可調臺、可出聲、返回後臺不停臺
```

> **分層排障鐵律**：任意一層不通，**不要往上層猜**。先按 §5 自上而下逐層確認，再動手改 UI。

---

## 5. 分層驗證命令（可直接複製）

```sh
# ==== ①+②+③ 一次性確認 ====
ls /dev/fm && echo "設備節點 OK"
grep -w fm /proc/misc && echo "misc 註冊 OK"
lsmod | grep marlin_fm && echo "驅動已加載 OK"
cat /sys/bus/sdio/devices/*/device && echo "SDIO 枚舉 OK (應為 0x2331)"

# ==== ③ 驅動描述（確認共享 SDIO 的依據）====
modinfo marlin_fm 2>/dev/null || strings /lib/modules/marlin_fm.ko | grep description=

# ==== ② WiFi 作為 FM 的前置 ====
ip link show wlan0 | grep -o 'state [A-Z]*'     # 期望 UP / DORMANT，不是 DOWN
ps | grep -c '[d]ownload'                        # 期望 >=1，download 常駐

# ==== ③ 驅動能力清單複核（無需再看 .ko）====
# 見 §2.2 / §2.3 兩張表，已固化在本文中
```

```python
# ==== ④/⑤ socket 層的設備端自測（Alpine 有 python3，無 socat）====
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)                 # ★ 必須設超時，否則 daemon 無響應會掛死
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c + "\n").encode())
    time.sleep(0.2)
    return s.recv(4096).decode()
print("state  ->", cmd("state"))
print("open   ->", cmd("open"))
print("tune   ->", cmd("tune 97400"))
print("rssi   ->", cmd("rssi"))
```

> ⚠️ 上述 socket 路徑 `/tmp/fm_ctl.sock` 是**本手冊規定的設計目標**，當前尚未實現。

---

## 6. 執行流程

| 步驟 | 動作 | 產出 | 完成判據 |
|---|---|---|---|
| **Step 0** | 跑 §5 全部命令，確認 ①–③ 層狀態 | 探查記錄 | `/dev/fm` 存在、驅動已加載、WiFi 已拉起 |
| **Step 1** | ~~探明 ioctl 命令號~~ **已完成** | [`FM收音ioctl命令表_逆向還原.md`](FM收音ioctl命令表_逆向還原.md) | 能對 `/dev/fm` 發起一次成功的 `TUNE`（命令號：`0xC004F502`） |
| **Step 2** | 寫 **FM daemon**：獨佔 `/dev/fm`，封裝 ioctl → socket | `fm_radio_daemon.c` | `state` / `open` / `tune` / `rssi` 四條命令可用 |
| **Step 3** | 寫**最小探針**驗證 `SCAN` 與 RSSI，標定信號強度閾值 | 標定記錄 | 能拿到 ≥3 個本地電臺頻點及場強值 |
| **Step 4** | **確認音頻路徑**（`ANA_SWITCH` vs `I2S_SETTING` vs `OVER_BT_ENABLE`） | 路徑決策 | 揚聲器確實出聲（**必須人耳確認**） |
| **Step 5** | 實現**聲道仲裁**（FM / A2DP / 本地播放互斥） | 仲裁模塊 | 三者兩兩切換無串音 |
| **Step 6** | 畫 **LVGL 收音機頁** | `radio_page.c` | 見 `FM收音機_LVGL界面設計與交互規格.md` |
| **Step 7** | RDS 顯示 + 收藏 + 持久化 + 後臺播放 | 完整 App | 見同文檔 §5 功能清單 |
| **Step 8** | openrc 自啟（`depends on WiFi`） | service 文件 | 重啟後自動可用 |

---

## 7. 故障 → 根因 → 修復 決策表

| 現象 | 最可能根因 | 修復 |
|---|---|---|
| `open /dev/fm` 失敗 ENOENT | `marlin_fm` 未加載 | `insmod /lib/modules/marlin_fm.ko`，確認 `lsmod` |
| `SDIO not enumerated` / `device` 讀不到 | download 沒跑或固件未下成功 | 先修 WiFi：重啟 `logdw → download` 鏈 |
| WiFi 好但 FM 無響應 | 缺 `wcnd` 上電或芯片整體未帶電 | 檢查 `ps \| grep wcnd`，重跑 BT-OPEN |
| ioctl 返回 `-EINVAL` | 命令號寫錯，或落進了**未定義區間**（`0x14~0x16`/`0x19~0x1c`/`0x31~0x3b` 等） | 查 [`FM收音ioctl命令表_逆向還原.md`](FM收音ioctl命令表_逆向還原.md) 的結論表核對 `nr`；再用 `dmesg \| grep FM_DRV` 看是否打出了**別的**命令名 |
| ioctl 成功但**沒有聲音** | 音頻通路未打開 | Step 4：分別在三條路徑上試，用 `GET_AUDIO_INFO` / `GET_I2S_INFO` 查當前狀態 |
| 有雜音/聲音極小 | 音量鏈路不對或 `SETVOL` 非主音量 | 檢查是否還需通過 ALSA mixer 單獨提主輸出音量 |
| RSSI 一直為 0 / 極值 | 未真正 TUNE 成功，或耳機天線未接（若設計依賴耳機） | 先核實能否正常收到單個強信號電臺；再排查天線依賴 |
| seek 卡住不返回 | 驅動有 seek 超時（日誌 `(fmdrv) seek Timeout(%d sec), fm seek end !`） | 上層也要設超時兜底，並給出"未找到電臺"UI |
| LVGL 頁面卡死 | socket I/O 阻塞了 UI 線程 | **必須**設 `SO_RCVTIMEO`/`SO_SNDTIMEO`（200ms）——本項目藍牙頁踩過的坑 |
| 重啟後 FM 失效 | 自啟順序早於 WiFi/上電鏈 | service 裡聲明依賴，Step 8 依序啟動 |
| FM 與藍牙 A2DP **同時出聲** | 沒有做聲道仲裁 | Step 5，參考 UI 規格文檔 §5.4 |

---

## 8. ioctl 命令號：已解決（原頭號阻塞項）

**2026-09-22 已完結。** 具體結果見 [`FM收音ioctl命令表_逆向還原.md`](FM收音ioctl命令表_逆向還原.md)。

做法概括：`marlin_fm.ko` **未 strip** → 反彙編 `fm_ioctl()` 二分查找樹讀出常量候選，
再用「全零參數單步調用 + `dmesg -c` 清空取日誌」逐條實測確認命令名。
下面三條**歷史路線**保留作方法論備忘：

| 路線 | 做法 | 評價 |
|---|---|---|
| **A. 要原廠頭文件**（最省事） | 向芯片原廠/方案商索取 Marlin2 平臺的 FM 用戶態頭文件（通常叫 `fm.h` / `sprd_fm.h`）與 libfm 庫 | ✅ **首選**。有它一切明確 |
| **B. 複用 Android 側二進制反推** | Android 分區裡有 `libengfm.so`（導出 `fm_runcommand`）與 `libFMHalSource.so`。用 `nm`/`readelf` 交叉看它們調用 open/ioctl 的方式，或在 Android chroot 內 **strace** 一次原生 FM APK 的操作序列 | ⚠️ 可行但要動 chroot 環境；注意這條路是**推斷**，得到數字後仍要上機驗證 |
| **C. 直接 ioctl 暴力試探** | 遍歷候選命令號，觀察 `/dev/fm` 的返回值與 `dmesg` 裡 `----<命令名>----` 的打印，看哪個號打出了哪個命令名 | ⚠️ 可行但有風險：亂髮 ioctl 可能讓固件狀態異常。**必須在 WiFi/藍牙不承載業務時做，且有復位手段** |

> 🔒 **紀律**：無論走哪條路線，都**先在本機/Android 側確認，不要把錯誤的命令號寫進 daemon 再上模擬器盲調**。

其他待辦：

1. **確認是否需要耳機當天線**：本機 ALSA 有獨立的 FM PCM（`01-04`），暗示可以內部直通，但**沒有實測**。
   判斷依據：不插耳機時 TUNE 到強信號電臺，看能否出聲。
2. **確認 `OVER_BT_ENABLE` 的確切語義**：是"FM 音頻送給已連接藍牙設備"，還是"允許 FM 與 BT 共存"？
3. **確認 `SETVOL` 與實際輸出音量的關係**：它可能只是 FM 模塊內部增益。
4. **確認系統 suspend 時 FM 是否掉臺**（驅動有 `fm_suspend`/`fm_resume`）——決定"息屏續聽"能否實現。

---

## 9. 紅線與運維紀律

1. **禁止**SFTP 回寫 `main.c` 後不核對行尾直接提交：`main.c` 是本倉庫**唯一**的 CRLF 文件，回寫會被轉成 LF，
   導致提交裡出現 1618 行"整文件重寫"的假改動。提交前必查：
   `git diff --stat` 與 `git diff --ignore-cr-at-eol --stat` 兩個數字應一致。
2. **禁止**在文檔中寫入 SSH 密碼/賬號/真實 IP。
3. **禁止**"看起來對就算通過"：顯示/顏色/音頻類結論**必須人眼/人耳在實機上確認**，不能用"截圖/解碼結果自洽"自證。
4. **禁止**在沒有超時的情況下讓 LVGL 定時器回調做 socket I/O。
5. **禁止** pkill -f 匹配會命中自身命令行的字符串（會殺掉自己的 SSH 會話），一律按 PID 殺。
6. 修改 `/dev/fm` 相關邏輯前，確認 watchdog（`lvgl_watchdog.sh`）已按規程處理，避免干擾實驗。

---

## 10. 設備上已有工具清單（複用，勿重造）

| 工具 | 用途 |
|---|---|
| `python3` | socket 自測、寫探查腳本 |
| `nm` / `readelf` | 分析 `.ko` 與 `.so` 符號（§2 全部事實由此取得） |
| `strings` | 從 `.ko` 提取調試串（命令名由此取得） |
| `libasound.so.2` | 寫 C 操作 PCM / mixer（沒有 amixer，只能寫代碼） |
| `/mnt/android_sys` | Android 原廠分區，`lib/` 下有 FM 相關庫可作為對照樣本 |
| `/tmp/linux-3.10.65` | vanilla 內核樹，**不含**展訊私有 FM 源碼（見 §3 死路） |

---

## 11. 後續增強方向（當前未完成）

| 方向 | 說明 |
|---|---|
| RDS 深度利用 | PTY 標籤、AF 自動切頻、CT 電臺時鐘、EWS 緊急廣播（驅動能力已在 §2.3） |
| 網絡電臺聯動 | FM + WiFi 雙模，WiFi 在線時可拉取電臺增強信息 |
| 錄音/回放 | FM 音頻經 PCM capture 落盤（需先確認有可用 capture 節點） |
| 多地區頻段 | 中國 87.5–108.0 / 日本 76–90 / 歐規 50 kHz 步進 |

---

## 12. 一句話總結

> **本機 FM 的硬件、驅動、RDS 解析能力全部已經現成在跑**（`marlin_fm.ko` 已加載、`/dev/fm` 已註冊、
> 且與 WiFi/藍牙共享同一顆 Marlin2 芯片），缺的只有"中間那一層"：
> **一個把 `/dev/fm` 的 ioctl 包裝成 unix socket 的 FM daemon**，以及**一個畫得下的收音機頁**。
> 原先卡住動手的**唯一一件事**（ioctl 命令號）已經解除（§8），
> 現在剩下的全都是按部就班的工程活：寫 daemon、定音頻通路、做聲道仲裁、畫 UI。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
