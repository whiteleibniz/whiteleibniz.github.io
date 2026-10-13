---
title: "FM收音芯片打通_操作手冊"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-12-fm-md/
---


# 展訊 SC9832A FM 收音打通 —— 人工操作手冊

> **讀者對象**：在設備上實操的工程師
> **使用方式**：按順序 Step 0 → Step 6 執行；每步都有"期望輸出"，不符就停下查 `FM收音芯片打通_故障排查手冊.md`
> **核心價值**：把 AI 指導手冊裡的判斷變成可一條條敲的命令，保證不同人做出來的結果一致

---

## 0. 前置概念（30 秒建立直覺）

**FM 收音機在本機上不是"新加一個硬件"，而是"把一顆已經能用的芯片上的第三個功能接出來"。**

- Marlin2 是一顆 **WiFi + 藍牙 + FM 三合一**芯片，三者**共享 SDIO 總線**。
- WiFi 打通時，`download` 已經把**包含 FM 部分在內的整套 combo 固件**燒進芯片了 → **不需要再給 FM 燒固件**。
- `marlin_fm.ko` 驅動**已經加載**，`/dev/fm` 節點**已經存在**。
- 所以我們**不用碰固件和驅動**，只需要寫一層用戶態 daemon 去操作 `/dev/fm`，再畫一個 UI。

```
已就緒（不要重複做）            本手冊要做的（Step 3 起）
─────────────────────          ─────────────────────────
✓ SDIO 枚舉 0x2331              ✓ 探明 ioctl 命令號（47 條，見《FM收音ioctl命令表_逆向還原》）
✓ combo 固件已燒入              □ 寫 FM daemon（socket 封裝）
✓ marlin_fm.ko 已加載           □ 確認音頻通路並出聲
✓ /dev/fm 已註冊                □ LVGL 收音機頁
✓ RDS 解析能力已具備            □ 聲道仲裁 + 後臺播放
```

---

## 1. 環境準備

### 1.1 設備狀態確認

```sh
# SSH 登錄（IP 與密碼見環境記錄，勿寫進交付物）
ssh root@<設備IP>

# 確認內核與主機名
uname -a                 # 期望：Linux 3.10.65  armv7l
hostname                 # 期望：spd-box
```

### 1.2 一鍵狀態體檢

```sh
echo '--- 1. SDIO 是否枚舉 ---'
cat /sys/bus/sdio/devices/*/device          # 期望：0x2331

echo '--- 2. FM 驅動是否加載 ---'
lsmod | grep marlin_fm                      # 期望：marlin_fm ... Used by sprdwl

echo '--- 3. FM 設備節點 ---'
ls -l /dev/fm                               # 期望：crw-rw---- ... 10, 23
grep -w fm /proc/misc                       # 期望： 23 fm

echo '--- 4. Android 分區（對照樣本）---'
ls /mnt/android_sys/lib/libengfm.so         # 期望：文件存在

echo '--- 5. WiFi（FM 的前置）---'
ps | grep '[d]ownload' | head -2            # 期望：至少 1 行常駐
ip link show wlan0 | grep -o 'state [A-Z]*' # 期望：UP 或 DORMANT

echo '--- 6. 音頻環境 ---'
cat /proc/asound/pcm | grep -i fm           # 期望：01-04: Dfm sprd-codec-fm-4
ls /usr/lib/libasound.so.2                  # 期望：文件存在
command -v amixer                           # 期望：無輸出（本機沒有 amixer）
```

> ⚠️ 若第 1–3 項有缺失，說明**底層還沒就緒**，先按 `01_WiFi打通/docs/WiFi芯片打通操作手冊.md` 把 WiFi 拉起來，
> 不要在這裡硬做 FM——因為 FM 依賴同一份 combo 固件。

---

## 2. Step 1：提取驅動能力清單（已固化，可不跑）

```sh
# 命令名清單（AI 指導手冊 §2.2 的來源）
strings /lib/modules/marlin_fm.ko | grep -- '----' | sed 's/.*----//;s/----//' | sort

# RDS 函數清單（AI 指導手冊 §2.3 的來源）
nm /lib/modules/marlin_fm.ko | grep ' T ' | grep rds_

# 核心控制函數
nm /lib/modules/marlin_fm.ko | grep -E ' T fm_'

# 確認與 WiFi/BT 共享 SDIO 的官方描述
strings /lib/modules/marlin_fm.ko | grep description=
```

期望：得到 TUNE / SEEK / SCAN / GETRSSI / MUTE / SETVOL / ANA_SWITCH / I2S_SETTING / OVER_BT_ENABLE / RDS_* 等命令名，
以及 `rds_get_ps` / `rds_get_rt` / `rds_get_pty` / `rds_get_af` 等 RDS 函數。

> **注意**：這一步只拿到**命令名**。命令號見 Step 2，**已在本項目完成**，
> 結果直接查 [`FM收音ioctl命令表_逆向還原.md`](FM收音ioctl命令表_逆向還原.md)。

---

## 3. Step 2：拿到 ioctl 命令號 —— **已完成**（原頭號阻塞項）

> 結果見 [`FM收音ioctl命令表_逆向還原.md`](FM收音ioctl命令表_逆向還原.md)：統一編碼 `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`，
> 47 條中 45 條已實測確認。**下面的內容保留為方法論記錄**（換別的外設時可複用）。

三種手段，按推薦度：

### 路線 A（首選）：向原廠/方案商索取頭文件

索取目標：Marlin2 平臺的 FM 用戶態頭文件（`fm.h` / `sprd_fm.h`）與配套 lib。拿到後跳到 Step 3。

### 路線 B：從 Android 側二進制反推

```sh
# 看 engfm 導出了什麼（已知只有 fm_runcommand）
nm -D --defined-only /mnt/android_sys/lib/libengfm.so

# 看 FM HAL 用了哪些 pcm / 線程結構（推斷音頻架構）
nm -D --defined-only /mnt/android_sys/lib/libFMHalSource.so | grep -i 'read\|start\|stop\|pcm'

# 進階：在 Android chroot 內對原生 FM APK 做一次 strace（如環境具備）
# 目標：抓出 open("/dev/fm") 之後緊跟的一組 ioctl(fd, CMD, ...) 的第一個參數值
```

> ⚠️ 這條路得到的是**推斷值**，必須再上真機用 Step 3 的探針驗證：發對了才能在 `dmesg` 看到對應的 `----<命令名>----` 打印。

### 路線 C：受控試探

```sh
# 建議做法：寫一個小 C 程序，按候選編號逐個 ioctl，觀察返回值與內核打印
dmesg -c > /dev/null                 # 先清空，便於觀察新日誌
./fm_probe                           # 你的試探程序
dmesg | tail -40                     # 看是否出現 ----TUNE---- 之類打印
```

> 🔒 **鐵律**：
> 1. 試探前確保 WiFi/藍牙**不承載業務**（亂髮 ioctl 可能導致固件狀態異常）；
> 2. 每次只試探一個編號，不要循環狂發；
> 3. 異常立即 `rmmod`/`insmod` 復位 `marlin_fm`（注意它被 `sprdwl` 依賴，需一併處理）。

**產出物**：`fm_ioctl.h`，內含全部命令號與數據結構。這是後續所有工作的輸入。

---

## 4. Step 3：編譯並部署 FM daemon

```sh
# 上傳源碼（從本機到設備）
scp fm_radio_daemon.c root@<設備IP>:/tmp/
scp fm_ioctl.h        root@<設備IP>:/tmp/

# 設備端編譯
cd /tmp
gcc -O2 -Wall -o fm_radio_daemon fm_radio_daemon.c -lpthread

# 單實例啟動（先手動驗證，不自啟）
pkill -x fm_radio_daemon 2>/dev/null; sleep 0.3
./fm_radio_daemon > /tmp/fm_daemon.log 2>&1 &
sleep 1
ls -l /tmp/fm_ctl.sock        # 期望：srwxrwxrwx socket
```

### 4.1 socket 自測（設備端 python3，本機沒有 socat）

```python
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)                       # ★ 必須設超時
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c + "\n").encode()); time.sleep(0.2)
    return s.recv(4096).decode().strip()
for c in ["state", "open", "tune 97400", "rssi", "vol 8"]:
    print("%-12s -> %s" % (c, cmd(c)))
```

期望：`OK OFF` → `OK ON` → `OK 97400` → `OK <rssi值>` → `OK 8`。

---

## 5. Step 4：確認音頻通路（必須人耳確認）

```sh
# 先查當前音頻狀態（若 daemon 已封裝）
python3 -c "
import socket,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(5)
s.connect('/tmp/fm_ctl.sock')
s.sendall(b'audioinfo\n'); time.sleep(0.3); print(s.recv(4096).decode())
"
```

按三條路徑依次試，**每條都要用耳朵確認是否出聲**：

| # | 路徑 | 對應 ioctl | 適用 |
|---|---|---|---|
| 1 | 模擬/內部 codec 直通 | `ANA_SWITCH` | 揚聲器直出（默認候選） |
| 2 | I2S | `I2S_SETTING` / `GET_I2S_INFO` | 需外掛 codec 時用 |
| 3 | Over BT | `OVER_BT_ENABLE` | FM 聲音從藍牙設備出 |

```sh
# ALSA 側參照（本機沒有 amixer，只能看節點）
cat /proc/asound/pcm | grep -i fm       # 01-04: Dfm sprd-codec-fm-4（僅 playback）
cat /proc/asound/pcm | grep i2s         # card0 四路 i2s.x 雙向
```

> ⚠️ **這塊不許憑日誌判斷是否成功**：
> - TUNE 成功返回 OK **不等於**有聲音；
> - 必須實際聽。建議先盯住本地最強的那個電臺做基準測試。
> - 同時確認**要不要插耳機當天線**：不插耳機 TUNE 到強信號，若能出聲則不依賴耳機。

---

## 6. Step 5：部署 LVGL 收音機頁

```sh
cd /home/lvgl_demo/lvgl_demo

# 1) 新增文件
#    lv_pages/radio_page.c
#    lv_pages/radio_page.h

# 2) 修改 launcher_page.c 三處（詳見《FM收音機_LVGL界面設計與交互規格.md》§3.2）
#    a) include          : #include "lv_pages/radio_page.h"
#    b) s_apps[] 數組     : 在藍牙條目之後插入收音機項
#    c) open_app switch  : case LAUNCHER_APP_RADIO: lv_start_activity(&g_radio_page, ...)

# 3) 編譯部署
make -j2 > /tmp/mk.log 2>&1; echo "MAKE_RC=$?"
grep -E 'error:' /tmp/mk.log | head -20

cp -f build/lvgl_demo /usr/local/bin/lvgl_demo && sync
killall -9 lvgl_demo; sleep 0.5
cd /home/lvgl_demo/lvgl_demo && nohup /usr/local/bin/lvgl_demo > /tmp/lvgl_run.log 2>&1 &
```

> ⚠️ **編譯成敗不要靠 `make | tail` 的 `$?`**（那是 tail 的退出碼），必須 `make > log 2>&1; echo MAKE_RC=$?`。
> 另：`extern/miniretro/` 無 Makefile，用 `sh build.sh`（與本任務無關，別順手誤觸）。

---

## 7. Step 6：開機自啟（openrc）

```sh
cat > /etc/init.d/fm-radio <<'EOF'
#!/sbin/openrc-run
# FM 收音 daemon —— 必須晚於 WiFi 上電鏈
depend() {
    need localmount
    after bootmisc
    # ★ 關鍵：必須在 download/wcnd 之後，否則芯片未上電
}
start() {
    ebegin "Starting FM radio daemon"
    start-stop-daemon --start --background \
        --exec /usr/local/bin/fm_radio_daemon \
        --make-pidfile --pidfile /run/fm_radio.pid
    eend $?
}
stop() {
    ebegin "Stopping FM radio daemon"
    start-stop-daemon --stop --pidfile /run/fm_radio.pid
    eend $?
}
EOF

chmod +x /etc/init.d/fm-radio
rc-update add fm-radio default
rc-service fm-radio start
```

> ⚠️ 自啟順序是本銜接最容易翻車的地方：`download → wcnd → bt_once → bt_wake → bt_user_daemon → fm_radio_daemon`。
> 若重啟後 FM 失效，先查是不是起得太早（芯片還沒上電）。

---

## 8. 常用節點與參數速查

| 項目 | 值 |
|---|---|
| SDIO modalias | `sdio:c00v0000d2331` |
| SDIO 路徑 | `/sys/bus/sdio/devices/mmc2:8800:1` |
| 驅動模塊 | `/lib/modules/marlin_fm.ko`（`Used by sprdwl`） |
| 控制節點 | `/dev/fm`（misc 23） |
| 日誌節點 | `/dev/log_radio`（misc 35） |
| FM PCM | `hw:1,4` = `01-04 Dfm sprd-codec-fm-4`（playback） |
| I2S PCM | card0 `i2s.0`~`i2s.3`（playback + capture） |
| daemon socket | `/tmp/fm_ctl.sock`（`chmod 0666`） |
| daemon 日誌 | `/tmp/fm_daemon.log` |
| Android 對照庫 | `/mnt/android_sys/lib/{libengfm,libFMHalSource,libfmjni}.so` |
| RDS 主要字段 | PS(8 字臺名) / RT(64 字文本) / PTY / AF / CT / EWS |

---

## 9. 一句話總結

> 底層（①固件 ②上電 ③驅動）**全是現成的**，命令號也已逆向還原完畢（§3 / 另見《FM收音ioctl命令表_逆向還原》）。
> **本項目已無阻塞項**，從 Step 3 起按部就班推進即可。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
