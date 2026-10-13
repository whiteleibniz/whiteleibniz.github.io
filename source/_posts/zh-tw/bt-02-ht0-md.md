---
title: "HT0藍牙拉起_部署交付文檔"
date: 2026-09-21 11:47:29
lang: zh-TW
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
permalink: zh-tw/2026/09/21/bt-02-ht0-md/
---


# HT0 設備藍牙拉起 —— 部署交付文檔

> 目的：回答"整個藍牙流程到底涉及哪些腳本/程序？在新設備上怎麼部署才能拉起藍牙？"
> 內容：① 鏈路全景 → ② 產物清單（設備端/本機/Git）→ ③ 新設備部署步驟 → ④ 驗證 → ⑤ 常見問題
> 適用：同型號設備（HT0 / 展訊 SC9832A，安卓內核 + Alpine 用戶態）

---

## 1. 藍牙鏈路全景（誰拉起誰）

```
開機
 ├─ /etc/local.d/wifi.start       ① 掛載安卓 system + 搭 chroot + download 燒固件 + 驅動 + wlan0
 ├─ /etc/local.d/bt_bringup.start  ② mdbg 權限 + wcnd + bt_once(BT-OPEN) + bt_wake.sh(btwrite 喚醒)
 ├─ /etc/init.d/bt_daemon          ③ 用戶態 HCI daemon（openrc 自啟）
 └─ LVGL 桌面                     ④ 藍牙設置頁（socket 與 daemon 通信）
```

**依賴關係**：① 是 ②③④ 的前提（download 燒的 combo 固件含藍牙部分）；② 是 ③ 的前提（上電 + 喚醒後 HCI 才響應）。

---

## 2. 產物清單

### 2.1 設備端已部署（HT0 現狀，實測核對）

| 類別 | 路徑 | 說明 |
|---|---|---|
| 固件下載鏈 | `/tmp/logdw` | download 日誌守護（安卓原版拷貝） |
| | `/tmp/aand/bin/download` | 固件下載引導器（chroot 內） |
| | `/tmp/aand/bin/wcnd` | WiFi/藍牙上電守護（chroot 內） |
| | `/tmp/aand/etc/marlinba/*.ini` | 固件配置（含藍牙 pskey） |
| 藍牙上電/喚醒 | `/tmp/bt_once` | BT-OPEN 觸發（源碼 /tmp/bt_once.c） |
| | `/tmp/bt_wake.sh` | btwrite 週期喚醒（每 2s 寫 1） |
| HCI 診斷 | `/tmp/bt_probe_full` | HCI 六步探針（源碼 /tmp/bt_probe_full.c） |
| | `/tmp/hci_3m` | 3M 波特率 HCI 原始測試（早期診斷） |
| **核心服務** | `/usr/local/bin/bt_user_daemon` | **用戶態 HCI daemon（生產）**，源碼 `/tmp/bt_user_daemon.c` |
| 自啟配置 | `/etc/local.d/wifi.start` | 開機 WiFi 鏈（4991B，含 chroot 搭建） |
| | `/etc/local.d/bt_bringup.start` | 開機藍牙上電鏈（mdbg+wcnd+bt_once+bt_wake） |
| | `/etc/init.d/bt_daemon` | daemon openrc 自啟（已 `rc-update add default`） |
| | `/etc/local.d/lvgl_demo.start` | LVGL 桌面自啟（指向 /usr/local/bin/lvgl_demo） |
| | `/root/lvgl_watchdog.sh` | 桌面看門狗（掛了自動拉起） |

### 2.2 本機（Windows 工作目錄 `new-chat\`）源碼與部署腳本

| 文件 | 用途 |
|---|---|
| `bt_user_daemon.c` | **daemon 源碼（核心交付物）**——設備 /tmp 有同副本 |
| `bt_probe_full.c` / `bt_probe_inquiry.c` | HCI 探針源碼 |
| `bt_deploy_v4.py` / `bt_deploy_all.py` / `bt_full_sequence_test.py` | paramiko 一鍵部署/測試腳本 |
| `bt_verify_scan.py` / `bt_sock_test.py` | 掃描/socket 驗證腳本 |
| `bt_ssh_wait_8h.py` / `bt_auto_resume.py` | SSH 輪詢重連 |
| `bluetooth_page.c` / `bluetooth_page.h` | **LVGL 藍牙設置頁（launcher 已註冊）** |
| 四份文檔 | 操作手冊 / 流程對比 / 工作總結 / AI 指導手冊 |

### 2.3 Git 提交（設備項目 /home/lvgl_demo/lvgl_demo）

```
973e3b5 新增藍牙設置應用：launcher 註冊藍牙圖標，藍牙頁含開關/搜索/設備列表，
        通過 unix socket 與 bt_user_daemon 通信；開機腳本與看門狗統一使用 /usr/local/bin/lvgl_demo
```
涉及：`lv_pages/bluetooth_page.c`、`lv_pages/bluetooth_page.h`、`lv_pages/launcher_page.c`（3 處註冊）、`shell/wifi.start`

### 2.4 Skill 封裝（可移植）

`workspace\.user_skills\ht0-wcn-radio\` —— 含 SKILL.md + references（WiFi/藍牙手冊）+ scripts（wifi_bringup/bt_status/ssh_wait），任何 AI 加載後可直接操作同型設備。

---

## 3. 新設備部署步驟（從零拉起藍牙）

> 前提：同型號設備（HT0/SC9832A）、已 switchroot Alpine、SSH root 可用、WiFi 鏈路能起（`/tmp/aand` 環境存在或 wifi.start 能自動搭）。

### Step 0 確認基礎環境（WiFi 前提）

```sh
ssh root@<設備IP>
# 確認安卓 system 可掛載、chroot 可搭（wifi.start 自動做）
sh /etc/local.d/wifi.start 2>&1 | tail -5    # 期望: SDIO ready 0x2331 + wlan0 UP
cat /sys/bus/sdio/devices/mmc2:8800:1/device  # 0x2331
```
> 若 wifi.start 不存在：先把 `/mnt/android_sys`（mmcblk0p17）掛載，從 `wifi.start` 內容重建 chroot（見 references/wifi.md）。

### Step 1 上傳並部署基礎工具

```sh
# 從本機 scp 到設備 /tmp/
scp bt_once bt_wake.sh bt_probe_full logdw root@<設備IP>:/tmp/
chmod +x /tmp/bt_once /tmp/bt_wake.sh /tmp/bt_probe_full /tmp/logdw

# logdw 也可從安卓 system 拷：
# cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw
```

### Step 2 編譯部署 HCI daemon（核心）

```sh
# 上傳源碼
scp bt_user_daemon.c root@<設備IP>:/tmp/
# 設備端編譯
gcc -O2 -o /usr/local/bin/bt_user_daemon /tmp/bt_user_daemon.c -lpthread
# 單實例啟動
pkill -9 -x bt_user_daemon 2>/dev/null; sleep 1
setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
```
> 若設備無 gcc：本機交叉編譯（armv7 靜態）或從已部署設備拷貝二進制（`/usr/local/bin/bt_user_daemon` 24KB，架構一致可直接用）。

### Step 3 配置開機自啟

```sh
# 3a. 藍牙上電鏈腳本
cat > /etc/local.d/bt_bringup.start << 'EOF'
#!/bin/sh
# 藍牙上電鏈：mdbg 權限 -> wcnd -> bt_once(BT-OPEN) -> bt_wake(btwrite)
sleep 8
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null
ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_once' || setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_wake' || setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &
EOF
chmod +x /etc/local.d/bt_bringup.start

# 3b. daemon openrc 自啟
cat > /etc/init.d/bt_daemon << 'EOF'
#!/sbin/openrc-run
command="/usr/local/bin/bt_user_daemon"
command_background=yes
pidfile="/run/bt_daemon.pid"
EOF
chmod +x /etc/init.d/bt_daemon
rc-update add bt_daemon default
rc-service bt_daemon start
```

### Step 4（可選）LVGL 藍牙設置頁

```sh
# 上傳頁面文件到項目
scp bluetooth_page.c bluetooth_page.h root@<設備IP>:/home/lvgl_demo/lvgl_demo/lv_pages/
# 修改 launcher_page.c 三處：include / 枚舉 LAUNCHER_APP_BLUETOOTH / s_apps 數組 / open_app switch
# 編譯部署（4 線程）
cd /home/lvgl_demo/lvgl_demo && make -j4
install -m 755 build/lvgl_demo /usr/local/bin/lvgl_demo
pkill -9 -x lvgl_demo; setsid /usr/local/bin/lvgl_demo >/tmp/lvgl_demo.log 2>&1 </dev/null &
```
> 若新設備沒有 LVGL 項目：先部署 wifi/藍牙底層（Step 0–3），頁面是最後的應用層。

### Step 5 驗證

```sh
# 分層狀態
cat /sys/bus/sdio/devices/mmc2:8800:1/device          # 0x2331
grep 'CMD OK' /tmp/bt_once.log                        # WCNBTWIFI-CMD OK
ps -eo comm | grep -c '[b]t_user_daemon'              # ≥1
# socket 查詢（設備端 python3）
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"                          # OK ON
# 掃描
printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"                                     # OK N + 設備行
```
> 也可以直接用 Skill 的腳本：`python scripts/bt_status.py --host <IP> --password <pwd> --scan 8`（本機跑，需 paramiko）。

---

## 4. 驗證標準（全部滿足 = 部署成功）

| # | 檢查 | 期望 |
|---|---|---|
| 1 | SDIO device | `0x2331` |
| 2 | /tmp/bt_once.log | 含 `WCNBTWIFI-CMD OK` |
| 3 | btwrite | 可寫（bt_wake.sh 在跑） |
| 4 | daemon 進程 | ≥1（單實例） |
| 5 | socket state | `OK ON` |
| 6 | socket scan | `OK N` + 設備行（N=0 不算失敗，環境無設備） |
| 7 | LVGL 藍牙頁（如有） | 開關/搜索/列表正常 |
| 8 | 重啟後 | ①②③ 全自動拉起（不用手動） |

---

## 5. 常見問題（新設備部署時最可能踩的坑）

| 現象 | 原因 | 處理 |
|---|---|---|
| `BT-OPEN FAIL` | mdbg 權限 600 | `chmod 666 /tmp/aand/proc/mdbg/*`（bt_bringup.start 已含） |
| `SDIO not enumerated` | download 環境不全 | 確認 /tmp/aand 完整（bin/lib/marlinba/節點/軟鏈），重跑 wifi.start |
| `bind logdw failed` | /tmp/logdw 缺失 | 從 /mnt/android_sys/bin/ 拷 |
| daemon 起不來（Not a tty） | tty ldisc 被佔 | `python3 -c "import fcntl; f=open('/dev/ttyS0',2); fcntl.ioctl(f,0x5421,b'\0'*4)"` |
| 掃描無結果 | 未先 Write Scan Enable | 用 daemon scan（內部已處理），勿裸發 Inquiry |
| socket connect 失敗 | daemon 多實例 | `pkill -9 -x bt_user_daemon` 後單實例 |
| gcc 不存在 | Alpine 精簡安裝 | `apk add build-base`，或直接拷貝已部署設備的二進制 |

---

## 6. 一句話總結部署路徑

```
環境就緒(wifi.start) → 傳 4 個工具(bt_once/bt_wake.sh/bt_probe_full/logdw)
→ 編譯部署 daemon(bt_user_daemon.c) → 兩條自啟(bt_bringup.start + bt_daemon)
→ 驗證(0x2331 + CMD OK + socket OK ON + scan)
→ 可選: LVGL 藍牙頁(bluetooth_page.c/h + launcher 註冊 + make -j4)
```

所有產物都有本機副本（`new-chat\` 目錄）和 Skill 封裝（`ht0-wcn-radio`），新設備部署全程可複用。


---

## 6. A2DP 真實音頻播放（v1.0.3 藍牙音箱支持版新增）

> 目的：連上藍牙音箱後，在桌面音樂/視頻應用點歌，聲音直接從藍牙音箱出（不再是演示蜂鳴音）。

### 6.1 音頻鏈路

```
桌面點歌(music/video_page)
  → 判斷藍牙已連(AF_UNIX socket /tmp/bt_ctl.sock 發 "conn")
  → mplayer -ao pcm:nowaveheader:fast:file=/tmp/bt_audio.fifo -srate 44100 -channels 2 -format s16le
  → /tmp/bt_audio.fifo (命名管道, 512字節/幀)
  → bt_user_daemon 媒體循環讀 PCM → SBC 編碼(bp35/7幀/20ms)
  → A2DP → 藍牙音箱出聲
```

### 6.2 關鍵部署點

| 項 | 值 | 說明 |
|---|---|---|
| fifo 管道 | `/tmp/bt_audio.fifo` | 開機腳本 `bt_bringup.start` 裡 `mkfifo` 創建，重啟後自動存在 |
| mplayer 音頻參數 | `-ao pcm:nowaveheader:fast:file=/tmp/bt_audio.fifo -srate 44100 -channels 2 -format s16le` | **必須 `-format s16le`**，否則 big-endian 導致雪花噪音 |
| 藍牙判斷 | `bt_audio_connected()` | **必須在 fork 子進程之前(父進程)調用**；寫在 fork 後 dup2 重定向 stdio 的子進程裡會 connect 失敗，退化成 `-ao null` |
| 未連藍牙 | 保持 `-ao null` | 不影響進度/暫停/切歌控制 |

### 6.3 排查要點

- **點歌無聲**：`ps | grep mplayer` 看起的參數是 `-ao null` 還是 fifo。若是 null → `bt_audio_connected()` 在父進程判斷失敗，確認 daemon 在跑、socket `/tmp/bt_ctl.sock` 存在。
- **能聽出旋律但全是雪花噪音**：mplayer 缺 `-format s16le`（默認 big-endian PCM，daemon 按 little-endian int16 讀）。
- **切歌/暫停/退出無聲異常**：確認舊 mplayer 已被殺（新起時先 pkill mplayer），fifo 沒被佔。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
