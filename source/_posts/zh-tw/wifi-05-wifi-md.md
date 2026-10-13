---
title: "WiFi芯片打通工作過程與思路總結"
date: 2026-09-13 15:27:33
lang: zh-TW
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
permalink: zh-tw/2026/09/13/wifi-05-wifi-md/
---


# WiFi 芯片打通 —— 工作過程與思路總結

> **主題**：從"Alpine 下 WiFi 完全失效"到"可掃描、可連接"的完整排查與解決過程覆盤。
> **文檔目標**：記錄我（執行者）的**分析思路、逐步拆解、關鍵決策與原因**，方便覆盤和遷移到類似問題。
> **文檔版本**：v1.0　|　2026-09

---

## 1. 問題定義（先做對題目）

**現象**：
- 設備 spd-box（SC9832A，Android 6 內核 3.10.65 + Alpine Linux 3.21 armhf）；
- WiFi/藍牙在 Android 下可用；
- switchroot 後 WiFi 失效：`dmesg` 反覆 `SDIO dev not ready`，GPIO94 READY 恆 0，內核枚舉不到芯片。

**我做的第一件事是"界定問題邊界"**：
- 硬件壞了嗎？→ 用戶明確說 Android 下可用，且有一臺同型號 H709 正常 → **排除硬件故障**。
- 內核錯了嗎？→ 內核還是 Android 3.10.65，沒換 → **內核大概率不是根因**。
- 那差異只剩兩個：**根文件系統（用戶態）** 和 **DTB/配置**。

這個"先排除不可能項"的界定，讓後續排查沒有走彎路去重編內核或懷疑硬件。

---

## 2. 第一階段：正面嘗試（約 6 類方案全部失敗）

在拿到對照機之前，我先嚐試在 Alpine 裡"手工模擬"上電，全部失敗，記錄如下：

| # | 嘗試方案 | 結果 | 失敗原因（事後歸因） |
|---|---|---|---|
| 1 | 手動 ioctl 組合（POWER_ON/POWER_RST 各種順序） | 無效 | 上電時序不是簡單 ioctl 能復刻的，需完整狀態機 |
| 2 | 往 DTB 注入電源屬性（vddwifipa/vddcon/always-on/runtime） | 無效 | 屬性本身不缺，缺的是"用戶態驅動固件下載"這個動作 |
| 3 | GPIO 採樣引導（跟蹤引腳電平找時機） | 無效 | READY 恆 0 說明芯片根本沒被激活 |
| 4 | /dev/mem mmap 直寫寄存器 | 無效 | 寄存器級操作無法替代芯片引導協議 |
| 5 | 設備上編內核模塊（想加驅動邏輯） | 失敗 | 設備無 kernel build 目錄，交叉編譯鏈不可用 |
| 6 | p21（recovery）dtb 修改 | 無效 | 非活動分區，改了不生效 |

**關鍵認知（為什麼我停下來了）**：
- 失敗 1-4 的共同點是"我在**模仿**一個我不知道完整細節的協議"；
- 芯片的上電+固件下載是**廠商私有協議**，逆向它成本極高、成功率低；
- **換思路**：既然 Android 裡有現成實現（download 服務），**與其模仿，不如複用**。

> 方法論一：遇到"協議未知"的問題，優先尋找"現成實現"而不是逆向協議。

---

## 3. 第二階段：對照機取證（用事實代替猜測）

用戶提出關鍵建議：有一臺**同型號、Android 正常**的設備，可以做對照實驗。這解決了"不知道正確行為是什麼"的問題。

### 3.1 連接與取證

通過 WatchTools adb（`AndroidWatch_ADB_ToolBox\adb\adb.exe`）連接 H709（root=Magisk）：

拿到的事實：

| 項目 | 值 |
|---|---|
| 分區映射 | boot=p16、wcnfdl=p14、wcnmodem=p15、system=p17、recovery=p21 |
| boot 鏡像 | `boot_p16_android.img`（20MB，`ANDROID!` 頭，FDT @0xB71800） |
| 原版 DTB | `android_orig.dtb`（53,967 字節） |
| 上電程序 | `/system/bin/download` + `/system/lib/libiwnpi.so` |
| 固件分區 | wcnfdl（p14）、wcnmodem（p15） |
| 用戶態配置 | `/etc/marlinba/*.ini` |

**為什麼這些是決定性的**：
- 分區映射告訴我"固件在哪、boot 在哪"；
- download 二進制告訴我"Android 是怎麼給芯片上電的"；
- 原版 DTB 告訴我"硬件應該被怎麼描述"。

> 方法論二：對照"已知正確的系統"取證，把猜測變成可驗證的事實。取證要拿**能跑的東西**（二進制、固件、配置），不只是看日誌。

### 3.2 關鍵決策：chroot 複用 Android 二進制

觀察 Android 的架構後我判斷：
- download 服務的硬件操作（寫 `/dev/power_ctl`、ttyS0 握手、SDIO 寫固件）**都通過內核驅動完成**；
- 它本身是**普通 ELF**，只要能加載進內存並找到設備節點/固件，就能驅動內核幹活；
- 它需要 Android 的庫和 linker → 用 **chroot** 提供迷你 Android 文件系統即可。

**於是方案定型**：
```
在 Alpine 裡搭 /tmp/aand/ 迷你 Android 環境
  → chroot 進去跑 download
  → 芯片上電 + 固件下載
  → 回到 Alpine 繼續
```

> 方法論三：遇到"用戶態組件依賴特定根文件系統"的問題，chroot 是低成本的隔離複用手段——不用改主系統，只搭最小依賴集。

---

## 4. 第三階段：逐個擊破 chroot 運行的障礙（strace 驅動）

`chroot` 後第一次運行 download 必然報錯。我採用 **strace 定位法**（不猜，看系統調用）：

| 報錯信號（strace 看到） | 根因 | 修復 |
|---|---|---|
| `open("/dev/power_ctl")` 失敗 | chroot 內 /dev 是空的 | `mount --bind /dev /tmp/aand/dev` |
| `open(...wcnfdl)` 失敗 | download 按 by-name 找固件分區 | 建鏈接 `wcnfdl → /dev/block/mmcblk0p14`、`wcnmodem → /dev/block/mmcblk0p15` |
| 缺 .so 庫 | 迷你環境不完整 | 從 `/mnt/android_sys/lib/` 複製全套 `.so` |

**關鍵突破點**：`mount --bind /dev` 後，download 能打開內核節點；鏈接 wcnfdl/wcnmodem 後它能找到固件。**跑通後 dmesg 出現決定性證據**：

```
mmc2: new high speed SDIO card at address 8800
mmc2:8800:1
device 0x2331
sprd_download_sdio_write ... 131080 ...   （大塊固件寫入）
```

**這一刻意味著**：
- 芯片被成功上電；
- 固件被成功寫入；
- GPIO94 READY 拉高；
- 內核枚舉出 SDIO 從設備。

> 方法論四：用 `strace` 看"它到底在找什麼"，每個 ENOENT 都是一條精確的修復指令。比讀文檔/猜配置高效得多。

---

## 5. 第四階段：DTB 修正（消除隱性變量）

**現象**：download 跑通有時仍不穩定。進一步核查發現 p16 的 dtb 曾有被改過的痕跡（早期嘗試注入電源屬性）。

**決策**：直接用 Android 原版 DTB 覆蓋 p16 中 dtb 段：

```sh
dd if=/tmp/android_orig.dtb of=/dev/block/mmcblk0p16 bs=512 seek=20008 conv=notrunc
```

- `seek=20008`（512B 塊）對應 boot 內 dtb 的字節偏移 `0x9C5000`；
- 換回原版後，電源/時鐘描述與 Android 一致，消除 DTB 這一隱性變量。

**為什麼必須做**：download 的上電時序設計時是**對著 Android 原版 DTB 的電源模型**來的；DTB 被改過之後，即使程序邏輯對，硬件描述也對不上。

> 方法論五：當"程序對但行為不對"時，檢查**環境描述層**（DTB/配置文件）是否被改過。先恢復原廠基線，再談優化。

---

## 6. 第五階段：驅動與用戶態 supplicant

芯片枚舉成功 ≠ WiFi 可用，還要走完數據通路：

### 6.1 驅動加載（順序敏感）

```sh
insmod /lib/modules/marlin_fm.ko   # 先：提供 fm_read 等符號
insmod /lib/modules/sprdwl.ko      # 後：主 WiFi 驅動
```

- 順序反了會報 `Unknown symbol`；
- 成功後出現 `wlan0`（MAC `a2:d2:f3:bf:8c:10`）→ 驅動綁定成功。

### 6.2 wpa_supplicant（踩過坑的決策）

**第一次嘗試**：直接在 Alpine chroot 裡跑 **Android 原版 wpa_supplicant 2.5**：
- 報 `CANNOT LINK`（缺庫）→ 複製 `/mnt/android_sys/lib/*.so` 後仍 `Aborted`；
- 根因：**Android Bionic libc 與 glibc/musl 環境不兼容**，linker 機制不同。

**決策轉向**：不再複用 Android 的 supplicant，改用 **Alpine armhf 原生包**：
- `wpa_supplicant-2.10-r11.apk` + `libnl3.apk` + `pcsc-lite-libs-2.2.3-r1.apk`；
- Alpine 官方/鏡像源當時不可用（證書/到期），從電腦端下載 apk 後 `apk add --allow-untrusted` 裝到設備。

**配置**：
```
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
```

**為什麼這個分工合理**：
- **底層固件下載**（廠商私有、內核相關）→ 複用 Android 二進制（chroot）；
- **用戶態 supplicant**（標準網絡協議、與 libc 相關）→ 用 Alpine 原生包。

> 方法論六：按"與內核/硬件的耦合度"切分複用邊界——硬件私有的複用原廠，標準化的用新系統原生實現。兩邊都不硬湊。

### 6.3 掃描成功

```sh
wpa_cli -i wlan0 scan
wpa_cli -i wlan0 scan_results
# CMCC-dtGM(-29) / CMCC-PcZt(-42) / CMCC-xxfS(-51) ... 共 6~11 個熱點
```

**至此 WiFi 芯片完全打通**：上電 → 固件 → 枚舉 → 驅動 → 掃描。

---

## 7. 時間線總覽

| 階段 | 關鍵動作 | 結果 |
|---|---|---|
| 界定問題 | 排除硬件/內核，鎖定用戶態+DTB | 方向正確 |
| 正面嘗試 | 6 類手工模擬上電 | 全部失敗（私有協議不可模仿） |
| 對照取證 | adb 連 H709，拿分區/固件/download/DTB | 拿到"正確行為的全套素材" |
| chroot 方案 | 搭 /tmp/aand 迷你 Android 環境 | 方案定型 |
| strace 排障 | bind /dev + 固件鏈接 + 補庫 | download 跑通，芯片枚舉 |
| DTB 修正 | 恢復 Android 原版 dtb | 消除隱性變量 |
| 驅動 | marlin_fm.ko → sprdwl.ko | wlan0 出現 |
| supplicant | Alpine armhf 原生包 | 掃描/連接可用 |
| UI 層 | launcher 網絡頁接線 | 用戶在界面上可操作 |

---

## 8. 方法論沉澱（可遷移到其他板子/芯片）

1. **先排除不可能項**（硬件/內核/系統），再集中火力在真實差異層；
2. **私有協議不要逆向，要複用**——找原系統的現成實現（二進制/服務）；
3. **對照機取證**：同型號正常設備是"正確行為"的最權威來源，儘量拿能跑的素材；
4. **chroot 隔離複用**：為第三方二進制搭最小依賴集，不汙染主系統；
5. **strace 驅動排障**：每個 open/ENOENT 都是精確修復指令，不靠猜；
6. **恢復原廠基線**：環境描述層（DTB/配置）被改過就先還原，再做新改動；
7. **按耦合度切分複用邊界**：硬件私有的複用原廠，標準化的用原生實現；
8. **單向依賴鏈思維**：上電→固件→枚舉→驅動→supplicant 逐級驗證，每級有 dmesg/日誌證據再進下一級。

---

## 9. 遺留事項與後續方向

- **開機自啟動固化**：download 上電 + 驅動加載 + wpa_supplicant 已通過 local 腳本/模塊配置固化（詳見《操作手冊》4.10）；
- **藍牙**：SC2331 是 Combo 芯片，藍牙同源同路，可參考同一套"chroot download + 驅動 + 用戶態"流程打通（尚未展開）；
- **連接穩定性**：掃描已穩定，連接/漫遊行為需實網長測；
- **UI 層**：launcher 網絡配置頁已能掃描、顯示列表、連接，後續可加"已保存網絡管理、信號強度排序優化"。

---

*本總結覆盤了從"現象"到"根因"再到"解決方案"的完整鏈路。核心一句話：芯片沒壞、內核沒壞，壞在"Alpine 缺了 Android 的芯片初始化服務"——用 chroot 把這一步借回來，鏈路即通。*
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
