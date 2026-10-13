---
title: "FM收音芯片打通_故障排查手冊"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-13-fm-md/
---


# 展訊 SC9832A FM 收音故障排查手冊 —— spd-box

> **讀者對象**：執行 FM 打通時遇到問題的工程師 / AI
> **排障鐵律**：**自上而下分層定位**，不許跳層。任意一層沒通就往上層猜，必然浪費時間
> **核心價值**：把"現象 → 最可能根因 → 驗證命令 → 修復"串成一張決策表，5 分鐘內定位到層

---

## 0. 排障紀律（先讀，違反會浪費時間）

1. **先分層，後動手**。五層：①固件 ②上電 ③驅動 ④daemon ⑤UI。用 §1 速查表定位到層。
2. **顯示/音頻類結論必須人眼人耳確認**，不許用"日誌返回 OK"代替"真的有畫面/有聲音"。
3. **每條路都先寫一刀切的最小復現**，再談修復。
4. **不要重複已確認的硬事實**（見 `FM收音打通_AI指導手冊.md` §2），也不要重走已驗證死路（§10）。

---

## 1. 分層故障速查總表（一頁定位）

| 現象 | 層 | 首選驗證命令 | 跳轉 |
|---|---|---|---|
| `/dev/fm` 打不開（ENOENT） | ③ 驅動 | `ls /dev/fm && grep -w fm /proc/misc` | §3.1 |
| SDIO 讀不到 `0x2331` | ①② 固件/上電 | `cat /sys/bus/sdio/devices/*/device` | §2.1 |
| WiFi 好，FM 無響應 | ② 上電 | `ps \| grep wcnd` | §2.2 |
| ioctl 返回 `-EINVAL` | ③ 命令號錯 | `dmesg \| tail`（看有無 `----<命令名>----`） | §3.2 |
| ioctl OK 但**沒聲音** | ③/④ 音頻通路 | `cat /proc/asound/pcm \| grep -i fm` | §4 |
| 有聲音但**雜音/音量極小** | ④ 音量鏈路 | 比對 `GETVOL` 與實際聽感 | §4.3 |
| RSSI 恆為 0 或極值 | ③/⑤ 調諧失敗 | 針對已知強信號電臺做單點 TUNE | §5.1 |
| seek 不返回 / 卡住 | ③ 驅動超時 | `dmesg \| grep 'seek Timeout'` | §5.2 |
| **LVGL 頁面卡死** | ⑤ socket 阻塞 | 檢查是否設了 `SO_RCVTIMEO` | §6.1 |
| FM 與藍牙**同時出聲** | ⑤ 缺仲裁 | 檢查音頻焦點模塊 | §6.3 |
| 重啟後 FM 失效 | 自啟順序 | `rc-service fm-radio status` | §7.1 |
| 息屏/後臺**掉臺** | ③ PM 掛起 | `dmesg \| grep -i suspend` | §7.3 |

---

## 2. 固件 / 上電層（①②）

### 2.1 SDIO 讀不到 / `device` 不等於 `0x2331`

```sh
cat /sys/bus/sdio/devices/*/modalias   # 期望 sdio:c00v0000d2331
cat /sys/bus/sdio/devices/*/device     # 期望 0x2331
```

- **根因**：`download` 沒跑起來或固件未燒入 → combo 芯片整體未在線，**FM 當然也不存在**。
- **修復**：先按 `01_WiFi打通` 文檔把 WiFi 拉起來。`download` 必須**常駐**，不要殺。
- **備註**：SDIO 上只有這一個設備，WiFi/藍牙/FM 三者共享它；**沒有獨立的"FM 枚舉"**。

### 2.2 WiFi 正常但 FM 發命令無響應

```sh
ps | grep '[w]cnd'      # 期望有進程
ps | grep '[d]ownload'  # 期望常駐
```

- **根因**：缺少 wcnd 上電環節，芯片帶電狀態不完整（FM 部分尤其明顯）。
- **修復**：補 `wcnd` + `bt_once(BT-OPEN)` 環節，參考 `02_藍牙打通/docs/藍牙芯片打通_操作手冊.md` §3。

---

## 3. 驅動層（③）

### 3.1 `/dev/fm` 不存在

```sh
lsmod | grep marlin_fm            # 期望：marlin_fm ... Used by sprdwl
insmod /lib/modules/marlin_fm.ko
ls -l /dev/fm ; grep -w fm /proc/misc
```

- **注意**：`marlin_fm` 被 `sprdwl` 依賴（`lsmod` 裡 `Used by sprdwl`），
  卸載時要一併處理依賴方，**不要對正在跑業務的 WiFi 貿然 rmmod**。
- 正常情況下這不該發生：該模塊在 WiFi 打通時已經自動加載。

### 3.2 ioctl 返回 `-EINVAL` / `-ENOTTY`（**本項目頭號故障**）

```sh
dmesg -c >/dev/null
# 再發一次你的 ioctl 命令
dmesg | tail -30
```

- **判斷**：驅動為每個命令打 `----<命令名>----`。
  - 若發的是甲命令，`dmesg` 卻打出 `/----乙----/` → **命令號映射錯了**；
  - 若 `dmesg` 完全沒有新打印 → **命令號根本沒落到任何已知分支**。

- **修法**：查《FM收音ioctl命令表_逆向還原》的結論表核對 `nr`。命令號已全部還原，此處只剩"抄錯"或"用了未定義區間"兩種可能，**不再是阻塞項**。
- 🔒 **不要用暴力全量遍歷**：亂髮 ioctl 可能讓固件進入異常狀態。只做受控單步試探，並準備復位手段。

### 3.3 `dmesg` 出現 `seek Timeout(%d sec), fm seek end !`

- **這是驅動自帶的 seek 超時機制**，不是 bug（字符串來自驅動源碼）。
- **上層必須配套**：daemon/UI 也要有自己的超時兜底，並在超時後給出"未找到電臺"提示，避免界面一直轉圈。

---

## 4. 音頻層（出聲與否）—— 最容易"以為好了"的一層

### 4.1 ioctl 成功但沒有聲音

```sh
cat /proc/asound/pcm | grep -i fm
# 期望看到：01-04: Dfm sprd-codec-fm-4 : : playback 1
```

| 可能原因 | 排查 |
|---|---|
| 未選擇正確的音頻路徑 | 依次試 `ANA_SWITCH`（默認）→ `I2S_SETTING` → `OVER_BT_ENABLE`，**每條都用耳朵確認** |
| 主輸出音量沒打開 | 本機沒有 `amixer`，只能寫代碼用 `libasound.so.2` 查 mixer；`SETVOL` 可能只是 FM 模塊內部增益 |
| **沒插耳機而設計依賴耳機天線** | 不插耳機 TUNE 到最強電臺試聽；若必須插耳機，UI 要有明確提示 |
| 聲道被別人佔著（A2DP/本地播放） | 見 §6.3 |

> ⚠️ **不許用日誌判定出聲**。TUNE 返回 OK 與"聽到廣播"之間沒有必然聯繫。

### 4.2 聲音斷續 / 有卡頓感

- 檢查 `fm_suspend` / `fm_resume`：驅動實現了 dev_pm_ops，**系統掛起時 FM 很可能被一起掛起**（見 §7.3）。
- 檢查 SDIO 帶寬：FM 與 WiFi/藍牙共享 SDIO，WiFi 高吞吐時可能有影響——這是共享芯片的固有特性，需實測評估。

### 4.3 音量不對 / `SETVOL` 無效

- 先確認 `GETVOL` 返回值是否隨你寫的值變化：
  - 變化 → FM 內部增益生效，但主輸出（codec/揚聲器）音量是另一條鏈路，需走 ALSA；
  - 不變 → 命令沒成功或取值範圍不對（取值範圍需實測標定）。

---

## 5. 調諧 / 掃描層

### 5.1 RSSI 恆為 0 或恆定極值

```sh
# 用本地已知最強電臺做單點基準
python3 - <<'EOF'
import socket,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(5)
s.connect('/tmp/fm_ctl.sock')
def cmd(c):
    s.sendall((c+"\n").encode()); time.sleep(0.3); return s.recv(4096).decode().strip()
print(cmd("tune 97400"))   # 換成你手邊最強的那個頻點（單位 kHz）
print(cmd("rssi"))
EOF
```

- 單點都拿不到合理值 → 回到 §3.2（命令號）或 §4（天線/通路）。
- 單點 OK 但掃描不對 → 檢查 `SCAN` / `SCAN_GETRSSI` 的用法。

### 5.2 掃描很慢 / 中途停不下來

- 全頻段 87.5–108.0 MHz，步進 100 kHz ≈ 205 個頻點，每點要駐留測量 → 慢是**正常的**。
- UI 必須：① 顯示百分比進度；② 顯示已發現臺數；③ 提供可點擊的**停止**按鈕（`STOP_SCAN`）。
- daemon 側也要設總體超時，不能無限等。

---

## 6. 應用層（④⑤ daemon → socket → LVGL）

### 6.1 LVGL 頁面卡死 / 切頁無響應

- **根因**：LVGL 定時器回調裡做 socket I/O，而 daemon 沒響應 → UI 線程被阻塞。
- **修復（必須）**：
  ```c
  struct timeval tv = { .tv_sec = 0, .tv_usec = 200*1000 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
  ```
- 這與藍牙頁踩過的坑完全一致。

### 6.2 `connect /tmp/fm_ctl.sock` 失敗

```sh
ls -l /tmp/fm_ctl.sock          # 期望 socket 且權限 0666
ps | grep '[f]m_radio_daemon'   # 期望進程在
tail -30 /tmp/fm_daemon.log     # 看 daemon 啟動有沒有報錯
```

- daemon 沒起來 → 手工跑一次看輸出（`./fm_radio_daemon` 前臺跑）。
- socket 存在但連不上 → 檢查是否殘留舊 socket 文件（daemon 應在啟動時 `unlink` 舊套接字）。

### 6.3 FM 與藍牙 A2DP / 本地播放**同時出聲**

- **根因**：三者共用一套音頻輸出，沒有仲裁。
- **修復**：實現音頻焦點模塊（見 `FM收音機_LVGL界面設計與交互規格.md` §5.4）：
  - FM 遇 A2DP → 自動 **mute（不是 close）**，A2DP 結束後詢問是否恢復；
  - A2DP 遇 FM → 彈確認框，用戶同意後暫停/斷開 A2DP 再由 FM 接管；
  - 本地播放與 FM 互相獨佔。
- ⚠️ 注意 `OVER_BT_ENABLE` 的語義尚未確認（是"FM 聲音送給藍牙"還是"允許共存"），**先實測再寫仲裁**。

### 6.4 返回桌面後停臺 / 息屏掉臺

- `onPause` 裡**不許**調用 close 或 mute，只停 UI 定時器/回調。
- 播放狀態由 **daemon 持有**，與頁面生命週期解耦。
- 若息屏掉臺：查 `fm_suspend` 是否被系統 PM 觸發（見 §7.3）。

---

## 7. 系統 / 自啟層

### 7.1 重啟後 FM 不自動可用

```sh
rc-service fm-radio status
rc-status | grep -E 'fm-radio|download|wcnd'
```

- **頭號根因**：自啟順序早於 WiFi 上電鏈，FM 起來時芯片還沒電。
- **修復**：openrc service 的 `depend()` 裡聲明 `after` WiFi/上電相關服務。
  正確鏈：**`logdw → download → wcnd → bt_once → bt_wake → bt_user_daemon → fm_radio_daemon`**。

### 7.2 daemon 反覆重啟

- 檢查是否是`<設備上的 watchdog>`誤判；調試期間注意按 PID 殺進程，
  **不要用 `pkill -f <pattern>`**——它會匹配到承載該命令的 shell 自身，把自己的 SSH 會話殺掉。

### 7.3 息屏 / 系統掛起後 FM 掉臺

```sh
dmesg | grep -i 'suspend\|resume'
```

- 驅動符號裡有 `fm_suspend` / `fm_resume`（靜態函數，`nm` 顯示為 `t`），說明實現了 dev_pm_ops。
- 若產品要求"息屏續聽"，需要額外處理（持鎖或阻止 suspend）——**這項必須實測確認，不可假定**。

---

## 8. 診斷工具箱（關鍵節點速查）

| 目的 | 命令 |
|---|---|
| 一次性體檢 | 見 `操作手冊.md` §1.2 六段腳本 |
| 驅動命令名清單 | `strings /lib/modules/marlin_fm.ko \| grep -- '----' \| sed 's/.*----//;s/----//' \| sort` |
| RDS 函數清單 | `nm /lib/modules/marlin_fm.ko \| grep ' T ' \| grep rds_` |
| 共享 SDIO 的證據 | `strings /lib/modules/marlin_fm.ko \| grep description=` |
| ioctl 是否落到正確分支 | `dmesg -c >/dev/null` → 發命令 → `dmesg \| tail` 看 `----<命令名>----` |
| FM PCM 是否存在 | `cat /proc/asound/pcm \| grep -i fm` |
| socket 連通性 | 見 §6.1 的 python3 片段 |
| seek 超時日誌 | `dmesg \| grep 'seek Timeout'` |

---

## 9. 還需實測定標的項（當前**不是**既定事實）

| 項 | 為什麼重要 |
|---|---|
| ioctl **命令號** | 阻塞全流程 |
| 是否依賴**耳機當天線** | 決定 UI 是否要"請插入耳機"提示 |
| `OVER_BT_ENABLE` 確切語義 | 決定聲道仲裁怎麼寫 |
| `SETVOL` 與主輸出音量的關係 | 決定音量控制走哪條鏈路 |
| **RSSI 閾值**分界 | 決定信號條几格怎麼畫（不要照搬網上 dBm 值，本機返回的是驅動原始值） |
| 系統 suspend 時 FM 行為 | 決定"息屏續聽"可行性 |

---

## 10. 已驗證死路（不要重試）

| 路線 | 結論 |
|---|---|
| 在 `/tmp/linux-3.10.65` 找展訊 FM 源碼 | ❌ 那是 vanilla 樹，沒有私有 FM 源碼 |
| 找現成 FM 命令行工具 | ❌ 全盤沒有，必須自己寫 daemon |
| 用 `amixer`/`tinymix` 切通路 | ❌ 本機沒裝這些工具，只能寫代碼調 ALSA lib |
| 直接動態加載 Android 的 `libFMHalSource.so` | ❌ 依賴 Android 運行時，Alpine 下跑不起來 |

---

## 11. 紅線（任何情況下）

1. 文檔中**禁止**寫 SSH 密碼/賬號/真實 IP。
2. 音頻/顯示結論**必須人耳人眼確認**，不接受"日誌 OK"作為通過判據。
3. LVGL 內做 socket I/O **必須**設超時。
4. 殺進程**按 PID**，禁止 `pkill -f` 匹配可能命中自身命令行的串。
5. 提交前核對 `git diff --stat` 與 `git diff --ignore-cr-at-eol --stat`（`main.c` 是全倉唯一 CRLF 文件）。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
