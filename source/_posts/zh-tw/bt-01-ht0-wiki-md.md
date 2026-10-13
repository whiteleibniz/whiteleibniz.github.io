---
title: "HT0藍牙原理與移植學習Wiki"
date: 2026-09-21 11:57:09
lang: zh-TW
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
permalink: zh-tw/2026/09/21/bt-01-ht0-wiki-md/
---


# HT0 藍牙原理與移植學習 Wiki

> 這份文檔不是操作手冊，而是**原理課**：講清楚這顆藍牙芯片為什麼這麼啟動、安卓原來怎麼做、我們為什麼改成現在這樣、每一行關鍵代碼在幹什麼。
> 讀完你應該能：面對一臺"安卓內核 + 別的用戶態"的 combo 藍牙設備，自己分析出該怎麼把藍牙拉起來。

---

## 0. 一句話先建立直覺

> 藍牙不是一個"軟件開關"，而是一顆**需要按特定時序上電、喚醒、喂固件、再講 HCI 協議**的小處理器。
> 安卓用一整套服務（init + download + wcnd + libbt-vendor + Bluedroid）替你把這套時序做了；
> 我們把這套時序**用最少的代碼重寫了一遍**，跑在 Alpine 用戶態上。

---

## 1. 硬件長什麼樣

這顆芯片叫 **Marlin combo WCN**（展訊 SC9832A 平臺），"combo"= 一顆芯片同時做 WiFi 和藍牙：

```
                ┌──────────────────────────────┐
                │      Marlin combo WCN        │
                │  ┌─────────┐   ┌───────────┐ │
                │  │ WiFi     │   │ Bluetooth │ │
                │  │ (wlan0)  │   │ (HCI 引擎)│ │
                │  └─────────┘   └───────────┘ │
                └────┬──────────────────┬──────┘
                     │ SDIO             │ UART
                     │ (數據/固件)       │ ttyS0 (HCI 控制)
              mmc2:8800:1         /proc/bluetooth/sleep/btwrite
              (設備ID 0x2331)      (寫1=喚醒藍牙引擎)
```

兩條通道，分工完全不同，這是理解一切的基礎：

| 通道 | 走什麼 | 幹什麼用 |
|---|---|---|
| **SDIO** | 高速數據總線 | 燒固件（WiFi+藍牙一體的固件鏡像大塊寫進去）、WiFi 數據 |
| **UART ttyS0** | 3M 波特率 + 硬件流控(CRTSCTS) | 藍牙的 **HCI 命令/事件通道**（發命令、收事件、傳音頻包） |
| **btwrite 節點** | 一個 proc 文件 | 寫 `1` = 把藍牙引擎從低功耗叫醒 |

**關鍵認知**：WiFi 和藍牙**共用同一份固件**。所以"把 WiFi 拉起來"的同時，藍牙固件也已經燒進芯片了——藍牙缺的不是固件，而是**上電、喚醒、有人跟它說話**。

---

## 2. 藍牙能用的五層模型（最重要的分析框架）

任何藍牙設備能用，都要五層全通。**每一層都有明確的"驗通標準"**，不通就停在那一層查，別跨層瞎試。

```
① 物理/固件層   固件燒進去了嗎？芯片上電了嗎？
                驗通：SDIO 枚舉出 0x2331；BT-OPEN 返回 OK
② 通道層        HCI 串口能讀寫嗎？
                驗通：往 ttyS0 發 Reset，能收到固件回的事件
③ 引擎層        藍牙引擎醒著嗎？跑起來了嗎？
                驗通：btwrite 喚醒後，固件回 "SPRD3" 身份幀
④ 協議層        標準 HCI 命令它認嗎？
                驗通：Read Version / Read BD_ADDR / Read Features 都回正常
⑤ 應用層        UI 怎麼調用？音頻怎麼流？
                驗通：掃描出設備、能連接、A2DP 能出聲
```

我們這次幾乎每踩一個坑，都是"誤以為在上層，其實卡在下層"。比如：
- 掃描不出設備 → 不是協議問題，是**沒先開掃描使能**（第④層的廠商隱藏要求）；
- 發命令沒反應 → 不是命令錯，是**沒喚醒引擎**（第③層）；
- BT-OPEN 失敗 → 不是命令錯，是**chroot 裡 proc 節點權限 600**（第①層的權限問題）。

---

## 3. 關鍵概念逐個講透

### 3.1 HCI 和 H4 是什麼

**HCI**（Host Controller Interface）= 主機（CPU）和藍牙控制器（芯片）之間的標準對話協議。
**H4** = 在 UART 上傳 HCI 的"打包格式"。每一包第一個字節是包類型：

| 首字節 | 含義 |
|---|---|
| `0x01` | Command（主機→芯片，命令） |
| `0x02` | ACL Data（雙向，連接數據/音頻） |
| `0x04` | Event（芯片→主機，事件/響應） |

所以我們的 daemon 乾的事，本質就是：**往 ttyS0 寫 `0x01 + 命令碼 + 參數`，再從 ttyS0 讀 `0x04 + 事件碼 + 數據`**。

### 3.2 命令怎麼編碼

一個 HCI 命令 = 類型(1) + Opcode(2) + 參數長度(1) + 參數。
Opcode 拆成 OGF（組，高 6 位）和 OCF（命令，低 10 位）：

```c
opcode = (OGF << 10) | OCF
// 例如 Inquiry(掃描)：OGF=0x01(鏈路控制), OCF=0x0001
// → opcode = (0x01<<10)|0x0001 = 0x0401
```

源碼裡 `send_cmd()` 就是把這個拼出來：

```c
pkt[0] = H4_CMD;              // 0x01
pkt[1] = opcode & 0xff;       // opcode 低字節
pkt[2] = (opcode>>8) & 0xff;  // opcode 高字節
pkt[3] = plen;                // 參數長度
memcpy(pkt+4, params, plen);  // 參數
write(fd, pkt, 4+plen);
```

### 3.3 SPRD3 身份幀——"引擎活了"的信號

喚醒後，固件會主動吐出一串：
```
55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e
                  └──── "SPRD3" = 展訊芯片的 ASCII 標識
```
看到 `SPRD3` 就說明：藍牙引擎已經從引導狀態跑起來了，HCI 通道是活的，可以開始發標準命令了。**這是第③層的驗收標誌。**

### 3.4 btwrite——為什麼要反覆寫

藍牙引擎有**低功耗睡眠**。空閒時它會睡，這時候你發命令它根本不理。
`/proc/bluetooth/sleep/btwrite` 寫 `1` = 踹它一腳醒來。

- 安卓是每 30 秒週期性踹一次（libbt-vendor 乾的）；
- 我們沒有 libbt-vendor，所以自寫腳本 **每 1.5~2 秒踹一次**，比安卓還勤，保證掃描/連接期間它別睡過去。

> 教訓：早期所有"發命令沒反應"的測試，根因都是**缺這一腳**。

### 3.5 pskey——藍牙的"出廠個性化參數"

pskey 是芯片的個性化配置（藍牙地址、功能位、UART 參數、發射功率等），結構是廠商定義的一大坨字段。
**關鍵認知**：我們沒單獨發 pskey，因為——

- `connectivity_configure.ini` 文件裡的 `[SETCTION 6]` 就是這份 pskey；
- `download` 在燒固件時**自己讀這個文件，已經把 pskey 下發了**；
- 實測 `Read Features` 返回的功能位和 pskey 文件裡的完全一致 → **證明它已經生效了**。

所以"要不要補 pskey"是個偽問題。**用證據驗證，別憑感覺死磕。**

### 3.6 一個廠商隱藏要求：Write Scan Enable 前置

標準藍牙邏輯裡，發 Inquiry 就能掃設備。但這顆展訊固件**不聽話**：
直接發 Inquiry，它回"收到了"（CMD_STATUS=0），然後**永遠不返回掃描結果**。

排查發現：必須**先發 `Write Scan Enable (0x0c1a)` 設成 `0x03`**（同時打開"可發現"+"可連接"），Inquiry 才會真正出結果。

> 這就是"廠商固件特性"——規範上沒寫，只能靠**對照實驗**（哪次成功的那次多做了什麼）反推出來。

---

## 4. 安卓原生是怎麼幹的（對照樣本）

安卓開機時，`init` 按 `init.board.rc` 自動拉起這一串：

```
init
 ├─ download        燒 combo 固件（讀 configure.ini，含 pskey）
 ├─ wcnd           藍牙子系統上電（BT-OPEN 命令）
 ├─ btld / bt_rm   低功耗管理、射頻管理
 └─ Bluedroid 協議棧
      ├─ libbt-vendor: 週期 btwrite 喚醒、發 pskey、管 UART 波特率
      └─ bluetooth.default.so: 完整 HCI/ATT/A2DP/RFCOMM 協議棧
           └─ BluetoothCtrl（你看到的設置界面）
```

**為什麼安卓不用內核 hci_uart 驅動？** 因為展訊定製方案裡，`libbt-vendor` 直接打開 UART 自己管 HCI，是"用戶態直連"。這給了我們靈感。

---

## 5. 我們的 Alpine 方案：用最少代碼替換一整套

### 5.1 啟動鏈（開機自動跑）

```
開機
 ├─ wifi.start          ① chroot 安卓環境 + download 燒固件 + SDIO 0x2331 + WiFi 驅動
 ├─ bt_bringup.start   ② chmod 666 mdbg → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite 週期喚醒)
 ├─ bt_daemon(openrc)   ③ 自寫用戶態 daemon 打開 ttyS0，監聽 unix socket
 └─ LVGL 桌面            ④ 藍牙設置頁通過 socket 發命令
```

### 5.2 三個關鍵決策（為什麼這麼選）

| 決策 | 我們選了 | 為什麼 |
|---|---|---|
| 內核 hci_uart.ko vs 用戶態直連 | **用戶態直連** | 這內核是安卓定製 3.10.65，hci_uart.ko 裡寫死的 tty_struct 偏移對不上，`hciconfig up` 超時、TX=0（一個字節都發不出去）。用戶態直接 `open("/dev/ttyS0")` 繞開內核協議棧，反而最穩——安卓 vendor 本來就這麼幹 |
| 移植 Bluedroid vs 自寫最小 daemon | **自寫 daemon** | Alpine 沒有 Bluedroid 那一大串依賴（HAL、屬性服務、共享庫），完整移植成本遠高於"只實現需要的幾個 HCI 命令" |
| 自寫 download vs 複用安卓原版 | **複用原版（chroot 裡跑）** | download 的上電時序、握手、分區讀取是芯片的"黑魔法"，自寫風險極高。把安卓二進制連同它需要的庫/節點/分區軟鏈一起，在 chroot 裡原樣跑 |

> 核心思想：**能借就借（download/wcnd 直接用原版），要重寫的只寫最小必要部分（HCI 命令集）。**

### 5.3 那個"權限坑"

移植最容易踩的不是技術，是**權限**：
`wcnd` 在 chroot 裡以 system 用戶跑，要讀 `/tmp/aand/proc/mdbg/*`，但那節點是 `600`（只有 root 能讀）→ BT-OPEN 一直 FAIL。
`chmod 666` 一秒解決。這種"移植後權限模型變了"的問題，會反覆出現。

---

## 6. 源碼解讀：daemon 在幹什麼

核心就三件事：**配串口、發命令、讀事件**。

### 6.1 配串口（3M + 硬件流控）

```c
t.c_cflag = B3000000 | CS8 | CREAD | CLOCAL | CRTSCTS;
```
- `B3000000`：300 萬波特率（藍牙引擎初始化後切到這個高速檔）
- `CRTSCTS`：開硬件流控（UART 兩根線做流量控制，高速下不開會丟包）
- `VMIN=1`：阻塞讀，讀到至少 1 字節才返回——**這是早期幀截斷 bug 的修復關鍵**

### 6.2 讀一幀完整 H4 包

不能瞎 read，要按幀頭長度讀全：

```c
read(fd, buf, 1);              // 先讀類型字節
if(buf[0] == H4_EVT) {         // 0x04 = 事件
    read(fd, buf+1, 2);        // 讀 事件碼(1) + 長度(1)
    plen = buf[2];
    while(沒讀夠 plen) read(...); // 把參數讀完
}
```

> 早期 bug：用非阻塞讀，一次只讀到 7 字節就返回，導致命令響應解析錯亂。改成"按幀頭長度讀全"才穩。

### 6.3 掃描的完整流程

```c
send_cmd(0x0c1a, 0x03);        // ① 先開掃描使能（廠商隱藏要求！）
send_cmd(OGF_INQUIRY, inq);     // ② 發 Inquiry
while(沒到超時) {
    read_pkt(...);
    if(事件是 Inquiry Result)  解析出 BD_ADDR / 設備類 / RSSI
    if(事件是 Inquiry Complete) break;
}
send_cmd(OCF_INQUIRY_CANCEL);   // ③ 取消掃描
```

### 6.4 對外接口：unix socket

daemon 不起復雜協議，就開一個 `/tmp/bt_ctl.sock`，GUI 連上來發一行文本命令：

```
state            → 返回 ON/OFF
on / off         → 開關
scan 8           → 掃 8 秒，返回 OK + 設備列表(BD_ADDR 設備類 RSSI)
connect <mac>    → 連接指定設備
```

GUI（LVGL 頁面）只管發字符串、收字符串，**完全不用懂藍牙**。這就是分層的價值。

---

## 7. A2DP 真實音頻播放（v1.0.3 新增）

前面只是"能連接"。要真出聲，得走 **A2DP**（高級音頻分發協議）。

### 7.1 音頻管線

```
屏幕點歌
  → mplayer -ao pcm:file=/tmp/bt_audio.fifo -format s16le
  → /tmp/bt_audio.fifo (命名管道)
  → daemon 讀 PCM → SBC 編碼 → 打成 ACL 數據包
  → UART → 藍牙音箱 → 喇叭出聲
```

為什麼用**命名管道(fifo)**？因為 Alpine 沒有 PulseAudio 這種音頻服務器。最樸素的辦法：
mplayer 把解碼後的 PCM 不送聲卡，而是寫進一個文件（fifo），daemon 從這個文件裡讀 PCM，編碼後發給音箱。

### 7.2 三個踩出來的關鍵參數

| 問題 | 現象 | 真相 |
|---|---|---|
| **字節序** | 能聽出旋律，但全是雪花噪音 | mplayer 默認輸出 **big-endian** PCM，daemon 按本機 **little-endian** int16 讀 → 數據全亂。加 `-format s16le`（強制小端）就清晰了 |
| **判斷時機** | 點歌沒聲，mplayer 走了 `-ao null` | 藍牙狀態判斷 `bt_audio_connected()` 寫在了 fork 子進程裡、stdout 被 dup2 重定向之後，導致連 socket 失敗。必須挪到 **fork 之前的父進程**裡判斷 |
| **幀參數** | 播幾秒就斷 | 按安卓金標準：SBC bitpool=35、每包 7 幀、20ms 單發、淺發送窗口、Start 前退出 Sniff 模式——照抄安卓才穩定 |

> 方法論：**"能出聲但不對"要先懷疑數據格式（字節序/採樣率/聲道），不是協議錯。**

---

## 8. 排障方法論（遷移時照這個查）

```
沒反應/連不上
  ├─ 第①層：SDIO 枚舉了嗎？BT-OPEN OK 嗎？權限夠嗎？
  ├─ 第②層：往 ttyS0 發 Reset，收得到事件嗎？(收不到=串口/波特率/流控錯)
  ├─ 第③層：btwrite 喚醒了嗎？回 SPRD3 了嗎？
  ├─ 第④層：標準命令 Read Version 正常嗎？掃描前開 Scan Enable 了嗎？
  └─ 第⑤層：UI 命令發對了嗎？socket 連上 daemon 了嗎？

有聲不對
  ├─ 字節序(s16le)、採樣率(44100)、聲道(2)
  └─ SBC 參數(bitpool/每包幀數)

莫名復位
  └─ 看串口有沒有回引導器幀(7e...7e)= 引擎崩了，多半是喚醒/發送時序問題
```

**對照機是金礦**：這臺設備同款有一臺跑原生安卓的機器。把它接上 ADB，抓它開機/開藍牙時 ttyS0 的真實流量，比黑盒猜快十倍。我們的 `btwrite`、`Scan Enable`、SBC 參數，全是這麼對照出來的。

---

## 9. 遷移到類似設備的通用清單

下次遇到"安卓內核 + 別的用戶態，藍牙要重拉"，照這個順序：

1. **認芯片**：查是不是 combo 芯片，數據走 SDIO 還是別的，HCI 走 UART 還是 SDIO。
2. **找原廠時序**：讀原廠 `init.*.rc` / `ueventd.rc`，找 download、上電、喚醒、HCI 節點。**能複用的二進制（download/wcnd）直接在 chroot 裡複用。**
3. **驗分層**：每層按 §2 的驗收標準，一層一層驗，不跳層。
4. **解決權限**：chroot 裡 proc/sys 節點權限、屬主，是移植頭號坑。
5. **寫最小 daemon**：只實現你要用的命令（開關/掃描/連接/音頻），別上來就移植整套協議棧。
6. **抓對照包**：有同型號原廠機，ADB 抓真實流量重放，省無數黑盒時間。
7. **固化開機**：把整個鏈路寫成開機腳本，重啟自動拉起。

---

## 10. 這份 wiki 想讓你記住的

- **藍牙 = 一顆需要時序伺候的小處理器**，不是軟件開關。
- **combo 芯片的固件是 WiFi+BT 一體的**，拉起 WiFi 常等於藍牙固件已就位。
- **分層驗證**是萬能鑰匙：每層一個驗收標準，不通不跳層。
- **廠商隱藏要求**（Scan Enable、btwrite 週期喚醒、SBC 參數）只能靠**對照實驗**和**原廠對照機**發現，規範書上沒有。
- **移植 = 能借就借，重寫最小**：原版二進制時序直接複用，只重寫最必要的 HCI 層。
- **"沒反應"先懷疑下層/權限/喚醒；"有聲不對"先懷疑數據格式。**

---

> 配套文檔：
> - `HT0藍牙拉起_部署交付文檔.md` —— 怎麼在新設備上部署（操作層）
> - `藍牙芯片打通_操作手冊.md` —— 手工排障步驟
> - `藍牙打通_工作過程總結.md` —— 這次踩坑的完整時間線
> - `藍牙啟動流程_安卓vsAlpine對比.md` —— 逐環節對照
> - 本文 —— 為什麼這麼做（原理層）
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
