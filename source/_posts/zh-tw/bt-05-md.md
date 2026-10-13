---
title: "藍牙打通_工作過程總結"
date: 2026-09-13 15:27:33
lang: zh-TW
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
permalink: zh-tw/2026/09/13/bt-05-md/
---


# 展訊 SC9832A 藍牙打通 —— 工作過程總結

> 記錄從"藍牙不可用"到"LVGL 藍牙設置頁可用"的完整分析路徑、關鍵決策、失敗路線與最終方案
> 時間線：WiFi 打通之後，藍牙攻堅持續數天，最終以用戶態方案收尾

---

## 1. 任務背景與初始目標

設備是"保留安卓 6.0 內核（3.10.65）+ switchroot 到 Alpine Linux"的展訊 SC9832A 平板，WiFi 已經打通（download → insmod 驅動 → wpa_supplicant → udhcpc，開機腳本已固化）。用戶的目標：

> 在 LVGL launcher 增加"藍牙設置"應用，功能同 WiFi 設置：**開關 + 搜索列表 + 連接**。
> 用戶放全權："放開所有權限、你最合理思路、我只看結果、甚至用戶態自寫程序也可以。"

---

## 2. 分析框架：先把"藍牙"拆成四層

動手前先建立心智模型——藍牙能用，需要四層全部打通：

```
① 物理/固件層  固件是否燒進芯片？芯片是否上電？（download / wcnd / BT-OPEN）
② 通道層       HCI 控制通道是否可讀寫？（ttyS0 3M + H4 協議）
③ 引擎層       藍牙引擎是否醒著、是否響應標準 HCI？（btwrite 喚醒 + SPRD3 身份幀）
④ 應用層       UI 如何調用？（無 Bluedroid → 自寫 daemon + LVGL 頁面）
```

每一層都有明確的"驗證標準"，不通就往下一層排查，避免在錯誤層次上浪費時間。

---

## 3. 攻堅過程（按時間線）

### 階段 A：BT-OPEN 失敗排查 —— 發現 mdbg 權限根因

**現象**：按 WiFi 流程拉起後，`bt_once` 發 BT-OPEN 一直返回 FAIL。

**排查**：
1. 對比 WiFi 成功路徑：WiFi 不依賴 BT-OPEN（download 後直接驅動加載），藍牙卻必須 BT-OPEN 上電
2. strace wcnd，觀察 BT-OPEN 時它訪問什麼 → 指向 `/tmp/aand/proc/mdbg/*`
3. 檢查發現 chroot 內 mdbg 節點權限為 **600**，wcnd 以 system 用戶運行讀不到

**修復**：`chmod 666 /tmp/aand/proc/mdbg/*` → BT-OPEN 返回 `WCNBTWIFI-CMD OK`

**教訓**：chroot 內安卓用戶態需要訪問 proc 節點，權限模型（600）是移植後最容易踩的坑。

### 階段 B：HCI 通道驗證 —— 確認固件活著

**方法**：不依賴任何驅動，直接用戶態打開 /dev/ttyS0 發 HCI Reset。

**結果**：`hci_3m`（3M + CRTSCTS）收到固件響應 `04 0e 04 01 03 0c 00` —— **固件 HCI 通道完全正常**。

**意義**：證明芯片、固件、UART 全部 OK，問題只在上層怎麼接。

### 階段 C：內核驅動路線 —— 嘗試後放棄（重要決策）

**嘗試**：
- 加載設備自帶預編譯 hci_uart.ko + 自定義 attach → hci0 能註冊（DOWN INIT RUNNING）
- `hciconfig hci0 up` 超時，TX=0

**根因分析**：該內核是安卓定製 3.10.65，hci_uart.ko 內部硬編碼的 tty_struct 偏移與這個內核不匹配 → 數據發不出去。
- Alpine gcc 14.2 編 3.10 老內核模塊 → insmod invalid module format（符號/簽名不符）

**決策**：**放棄內核驅動路線**。理由：
1. 內核模塊只能用設備已有預編譯版，改不了
2. 用戶否決 vhci 虛擬方案（"你別用虛擬了"）
3. 安卓原廠本來就不用內核 hci_uart —— libbt-vendor 直接操作 UART，用戶態是"正統"做法

### 階段 D：用戶態 daemon 誕生（v1 → v4 迭代）

**方案**：寫 C daemon，直接 /dev/ttyS0 3M+CRTSCTS 走 H4，unix socket 對外服務。

**迭代中踩掉的 bug**（每個都是真實教訓）：

| 版本 | 問題 | 修復 |
|---|---|---|
| v1 | 編譯失敗 | 缺 `<stdint.h>` / `<sys/stat.h>` |
| v2 | 幀讀取截斷（非阻塞讀 n=7） | 改阻塞讀（VMIN=1）+ select 超時，按 H4 幀頭（buf[1]=evt, buf[2]=len）讀全長 |
| v3 | 多實例打架，socket connect 掉線 | 清理用 `pkill -9 -x bt_user_daemon`（勿用 `ps|grep` 內嵌模式會誤殺 shell 自身） |
| v4 | 掃描收不到 Inquiry Result | 見階段 F |

### 階段 E：btwrite 喚醒 —— 打通 HCI 的臨門一腳

**現象**：HCI Reset 能收到響應，但發標準命令後固件沉默。

**排查**：
- 反彙編設備原版 bt_vendor.default.so，字符串證實完整流程：**btwrite 喚醒 → 連 wcnd（BT-OPEN）→ 讀 uart_conf → 發 pskey → HCI**
- 發現 `/proc/bluetooth/sleep/btwrite` 存在且可寫（之前誤判"內核無此驅動"）
- H709 對照機日誌顯示藍牙每 30s 週期性 btwrite 寫 1

**修復**：`echo 1 > /proc/bluetooth/sleep/btwrite` → **HCI 立即有響應！** 固件回 SPRD3 身份幀（`55 7e ... 53 50 52 44 33 ...`）
→ 自寫 `/tmp/bt_wake.sh` 每 1.5~2s 喚醒（比安卓 30s 更勤，保證掃描期間不丟響應）

**關鍵認知**：藍牙引擎有省電模式，喚醒是持續的、週期性的動作，不是一次性。

### 階段 F：掃描失敗的根因 —— Write Scan Enable 前置

**現象**：Inquiry 被接受（CMD_STATUS 0x00）但永遠等不到 Inquiry Result。

**排查**：對比探針輪次 —— 輪 2 掃到設備的那次做過 Write Scan Enable。

**修復**：掃描前先發 `Write Scan Enable 0x0c1a (0x03)` → **立即穩定返回 Inquiry Result**
實測：`OK 1 / 48:f1:ae:25:7e:48 5a420c 0`（掃到真實手機）

**這是展訊固件的隱藏要求**：不開掃描使能，Inquiry 就是"石沉大海"。

### 階段 G：pskey 之謎 —— 澄清而非死磕

**疑問**：安卓 libbt-vendor 要發 pskey 固件才就緒，我是不是缺這個？

**結論（決定性證據）**：
- `connectivity_configure.ini` 的 [SETCTION 6] 就是藍牙 pskey 結構（pskey_cmd=0x001C0101、device_addr、UART0 HCI 配置）
- **download 讀取這個文件** → pskey 在固件下載階段已下發
- 實測 Read Features 返回 `ff ff 8d fe`，與 pskey_bt.txt 的 feature_set **完全一致** → pskey 已生效

**決策**：不需要單獨發 pskey，避免在偽問題上浪費時間。

### 階段 H：協議幀細節 —— SLIP 與 SPRD3 引導幀

**現象**：標準 H4 裸幀有時不被響應，固件回 `7e 00 8b 00 00 cb ab 7e`（引導器狀態錯誤幀）。

**分析**：
- 幀格式確認：`7e <type:2B> <len:2B> <data> <crc16> 7e`（download 協議同款）
- CRC 解出：XMODEM（0x1021/init 0）小端存儲
- 固件穩定回 SPRD3 身份幀 = 引擎在啟動循環，等特定初始化序列

**決策**：黑盒試引導命令不完整，最可靠是抓對照機（H709）藍牙開啟時 ttyS0 完整流量重放。用戶協助用 WatchTools ADB 連對照機收集了安卓側信息（init.rc、ueventd.rc、pskey_bt.txt、bt_vendor 庫）——**確認方案可行後，不再死磕引導序列**，因為：
1. 標準 HCI 命令（Reset/Version/BD_ADDR/Features/Scan）已經全部響應
2. 掃描功能已通 → 應用層目標（搜索列表）已滿足
3. 引導序列隻影響"配對/連接"的完整初始化，屬後續增強

### 階段 I：開機自啟固化

- openrc `/etc/init.d/bt_daemon`（command_background=yes），`rc-update add default`
- 與 wifi.start（download 常駐）+ lvgl_demo.start 組成完整開機鏈
- 實測重啟後：SDIO 0x2331、wcnd/bt_once/logdw/download/bt_wake 全在跑，daemon 單實例

### 階段 J：LVGL 藍牙設置頁

- 參照已驗證的 network_page.c（WiFi 模板）寫 bluetooth_page.c/h
- launcher 三處註冊：枚舉 + s_apps 數組 + open_app switch（LV_SYMBOL_BLUETOOTH 存在）
- daemon 文本協議：state/on/off/scan/list/connect
- 修復了部署路徑問題：開機腳本與 watchdog 原指向 build/lvgl_demo（舊版本），統一改為 /usr/local/bin/lvgl_demo

---

## 4. 關鍵決策回顧（為什麼這麼做）

| 決策點 | 選擇 | 理由 |
|---|---|---|
| 內核驅動 vs 用戶態 | **用戶態** | 內核 3.10 偏移不匹配（TX=0）；安卓原廠就是用戶態直管 UART；用戶否決 vhci |
| 自寫 daemon vs 移植 Bluedroid | **自寫最小 daemon** | Alpine 無 Bluedroid 依賴鏈（庫/屬性服務/HAL），移植成本遠高於自寫 HCI 層 |
| 複用安卓原版 download/wcnd | **複用（chroot）** | 固件下載/上電序列是芯片秘而不宣的時序，原版二進制最可靠；自寫 download 風險高收益低 |
| pskey 是否單獨發 | **不發** | 證據鏈完整：download 已下發（configure.ini）+ Read Features 證實生效 |
| 黑盒引導序列 vs 對照機抓包 | **確認可行後收手** | 應用目標（掃描列表）已達成；引導序列是配對增強項，不阻塞主線 |
| 喚醒週期 1.5~2s | **比安卓 30s 更勤** | 用戶態無完整協議棧的節電協調，勤喚醒保證 HCI 穩定響應 |

---

## 5. 最終成果與沉澱

```
底層鏈路（每步已驗證）：
  殺淨殘留 → logdw → download(-i wlan0, 常駐) → SDIO 0x2331
  → chmod 666 mdbg → wcnd → bt_once(BT-OPEN OK)
  → bt_wake.sh(btwrite) → bt_user_daemon(H4 HCI) → socket

應用層：
  LVGL launcher "藍牙" 圖標 → 藍牙設置頁（開關/搜索/設備列表）
  開關=on/off，搜索=scan N（自動 Write Scan Enable + Inquiry）

開機自啟：
  /etc/local.d/wifi.start + /etc/init.d/bt_daemon（openrc）
  重啟後全鏈路自動拉起

已提交：
  git 973e3b5 新增藍牙設置應用（含藍牙頁 + 路徑統一）
```

---

## 6. 經驗教訓（可複用到其他模塊）

1. **先分層，再定位** —— 每層有明確驗證標準（BT-OPEN OK / HCI Reset 響應 / SPRD3 / Inquiry Result），不跨層瞎試。
2. **權限問題是移植頭號坑** —— chroot 內 proc 節點 600 權限導致 BT-OPEN 失敗，`chmod 666` 一分鐘解決，之前可能浪費了數小時。
3. **對照機是金礦** —— 安卓原版 init.rc / ueventd.rc / pskey_bt.txt / bt_vendor 庫提供了完整流程真相，反彙編 + 字符串提取把"不知道怎麼做"變成"照著做"。
4. **讀懂廠商固件特性** —— Write Scan Enable 前置是展訊固件的隱藏要求，這種"不說就不通"的行為只能靠對比實驗發現。
5. **不要戀戰死路** —— 內核驅動 TX=0 果斷放棄；黑盒引導序列不完整就不死磕，評估"當前成果已滿足用戶目標"後收手，把精力放應用層。
6. **進程衛生** —— 多實例搶 socket、ps|grep 誤殺自身、watchdog 自動拉起舊路徑，這些"運維細節"會反複製造"明明改好了又變回去"的假象。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
