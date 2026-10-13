---
title: "FM收音ioctl命令表_逆向還原"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-06-fm-ioctl-md/
---


# 展訊 SC9832A FM 收音機 —— ioctl 命令表逆向還原（含實測確認）

> **讀者對象**：負責 FM daemon / UI 的工程師；後續接其他外設時想複用本手法的工程師。
> **使用方式**：寫 `/dev/fm` 相關代碼時**直接查本文表格取命令號**，不要再猜、也不要再等原廠頭文件。
> **核心價值**：把此前的"頭號阻塞項"變成一張**可直接編碼的常量表**，並給出可複用的取證方法。

---

## 0. 一句話總結

> `marlin_fm.ko` **未被 strip**，命令號就寫在 `fm_ioctl()` 的機器碼裡。
> 全部命令統一編碼為 **`_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`**；
> 47 條命令中 **45 條已由設備實測（內核日誌打印出命令名）確認**，另 2 條為靜態反彙編推斷。
> **唯一的硬阻塞已解除，可以開始寫 daemon。**

---

## 0.1 ⚠️ 重要更正（2026-09-22 補充，用前必讀）

命令號表本身**仍然準確**，但下面三條**能力層面的結論已被後續實測推翻**，別再按舊結論設計：

| 舊結論（本文原稿） | 實測更正 |
|---|---|
| `SCAN 0x08` + `SCAN_GETRSSI 0x24` 可用，能畫頻譜/場強 | ❌ **兩者都是空殼**：調用返回 0 但**零 SDIO 流量**；`GETRSSI 0x07` 是唯一真發 SDIO 的信號類命令，但恆 `ETIMEDOUT` 耗 4.2s 且回值幾乎不變 → **本機拿不到可信場強** |
| `SEEK 0x03` 可"向上/下搜索下一個電臺" | ❌ **起點頻率被驅動截斷成 1 字節**（`freq & 0xFF` 進 AT 幀），帶內頻點傳不進去；實測只有 **92.5MHz / 103.1MHz 兩個固定回值**，與當前頻點無關 → **不能做搜臺** |
| 可用 `write(/dev/fm)` 寫 AT 文本繞開 ioctl | ❌ 恆定 `-1 / EINVAL(22)`，無任何 SDIO 流量 |

另外，`OVER_BT_ENABLE 0x1d` / `ANA_SWITCH 0x1e` / `I2S_SETTING 0x21` 等**音頻類命令全是空殼**
（反彙編 `fm_ioctl` 的 `R_ARM_CALL` 只調 7 個函數，無任何音頻通路函數）。

→ **詳細實測數據見 `FM收音_SEEK與場強_實測結論.md`。**

---

## 1. 結論表（可直接當 `fm_ioctl.h` 用）

編碼：`cmd = 0xC004F500 | nr`，即 `_IOWR(magic=0xF5, nr, size=4)`。

| nr | 命令號 | 命令名 | 確認方式 | 本機實測返回值 | 用途 |
|---|---|---|---|---|---|
| 0x00 | `0xC004F500` | `power up` | **實測** | 0 | 上電（**注意不是 `TUNE`**） |
| 0x01 | `0xC004F501` | `power down` | **實測** | 0 | 下電 |
| 0x02 | `0xC004F502` | `TUNE` | **實測** | -1 (`ETIMEDOUT`) | 調到指定頻率（參數 = 頻率） |
| 0x03 | `0xC004F503` | `SEEK` | **實測** | 0 | 向上/下搜索下一個電臺 |
| 0x04 | `0xC004F504` | `SETVOL` | **實測** | 0 | 設音量 |
| 0x05 | `0xC004F505` | `GETVOL` | **實測** | 0 | 讀音量 |
| 0x06 | `0xC004F506` | `MUTE` | **實測** | 0 | 靜音開關 |
| 0x07 | `0xC004F507` | `GETRSSI` | **實測** | 0 | **信號強度**（UI 信號條） |
| 0x08 | `0xC004F508` | `SCAN` | **實測** | 0 | 全頻段掃描 |
| 0x09 | `0xC004F509` | `STOP_SCAN` | 靜態推斷 | -1（未打印日誌） | 中斷掃描 |
| 0x0a | `0xC004F50A` | `GETCHIPID` | **實測** | 0 | 芯片 ID（本機返回 `0x2341`） |
| 0x0b | `0xC004F50B` | `EM_TEST` | **實測** | 0 | 工程模式 |
| 0x0c | `0xC004F50C` | `RW_REG` | **實測** | 0 | 寄存器讀寫（調試） |
| 0x0d | `0xC004F50D` | `GETMONOSTERO` | **實測** | 0 | 單聲道/立體聲狀態 |
| 0x0e | `0xC004F50E` | `GETCURPAMD` | **實測** | 0 | 當前 PAMD 值 |
| 0x0f | `0xC004F50F` | `GETGOODBCNT` | **實測** | 0 | 好塊計數（音質統計） |
| 0x10 | `0xC004F510` | `GETBADBNT` | **實測** | 0 | 壞塊計數 |
| 0x11 | `0xC004F511` | `GETBLERRATIO` | **實測** | 0 | 塊誤碼率 |
| 0x12 | `0xC004F512` | `RDS_ONOFF` | **實測** | -1 | RDS 開關 |
| 0x13 | `0xC004F513` | `RDS_SUPPORT` | **實測** | 0 | 是否支持 RDS |
| 0x17 | `0xC004F517` | `SIM_DATA` | **實測** | 0 | 仿真數據（產測） |
| 0x18 | `0xC004F518` | `IS_FM_POWERED_UP` | **實測** | 0 | **是否已上電**（daemon 啟動自檢用） |
| 0x1d | `0xC004F51D` | `OVER_BT_ENABLE` | **實測** | 0 | **FM 音頻走藍牙**（聲道仲裁關鍵） |
| 0x1e | `0xC004F51E` | `ANA_SWITCH` | **實測** | 0 | **模擬音頻通路切換** |
| 0x1f | `0xC004F51F` | `GETCAPARRAY` | **實測** | 0 | 容值陣列（硬件標定） |
| 0x21 | `0xC004F521` | `I2S_SETTING` | **實測** | 0 | **I2S 音頻通路設置** |
| 0x22 | `0xC004F522` | `RDS_GROUPCNT` | **實測** | 0 | RDS 組計數 |
| 0x23 | `0xC004F523` | `GET_LOG` | **實測** | 0 | 取驅動日誌 |
| 0x24 | `0xC004F524` | `SCAN_GETRSSI` | **實測** | 0 | **掃描中逐點取場強**（畫頻譜用） |
| 0x25 | `0xC004F525` | `SETMONOSTERO` | **實測** | 0 | 強制單聲道/立體聲 |
| 0x26 | `0xC004F526` | `RDS_BC_RST` | **實測** | 0 | RDS 廣播復位 |
| 0x27 | `0xC004F527` | `CQI_GET` | **實測** | 0 | 信道質量 |
| 0x28 | `0xC004F528` | `GET_HW_INFO` | **實測** | 0 | 硬件信息 |
| 0x29 | `0xC004F529` | `GET_I2S_INFO` | **實測** | 0 | I2S 當前狀態 |
| 0x2a | `0xC004F52A` | `IS_DESE_CHAN` | **實測** | 0 | 是否處於去敏信道 |
| 0x2b | `0xC004F52B` | `TOP_RDWR` | **實測** | 0 | 頂層寄存器讀寫 |
| 0x2c | `0xC004F52C` | `HOST_RDWR` | **實測** | 0 | 主機側讀寫 |
| 0x2d | `0xC004F52D` | `PRE_SEARCH` | **實測** | 0 | 預搜索 |
| 0x2e | `0xC004F52E` | `RESTORE_SEARCH` | **實測** | 0 | 恢復搜索 |
| 0x30 | `0xC004F530` | `GET_AUDIO_INFO` | **實測** | 0 | **當前音頻通路狀態** |
| 0x3c | `0xC004F53C` | `SCAN_NEW` | **實測** | 0 | 新版掃描 |
| 0x3d | `0xC004F53D` | `SEEK_NEW` | **實測** | 0 | 新版搜索 |
| 0x3e | `0xC004F53E` | `TUNE_NEW` | **實測** | 0 | 新版調諧 |
| 0x3f | `0xC004F53F` | `SOFT_MUTE_TUNE` | **實測** | 0 | **軟靜音調諧**（換臺不炸音） |
| 0x40 | `0xC004F540` | `DESENSE_CHECK` | **實測** | 0 | 去敏檢測 |
| 0x46 | `0xC004F546` | `FULL_CQI_LOG` | **實測** | 0 | 完整 CQI 日誌 |
| 0xff | `0xC004F5FF` | `DUMP_REG` | 靜態推斷 | -1（未打印日誌） | 轉儲寄存器 |

**統計**：47 條中 45 條**實測確認**（內核日誌打印出該命令名），2 條（`STOP_SCAN` / `DUMP_REG`）為靜態反彙編推斷，調用時返回 -1 且未打印日誌，**用前需再驗一次**。

### 未定義區間（調用返回 -1 且無日誌）

`nr = 0x14~0x16`、`0x19~0x1c`、`0x20`、`0x2f`、`0x31~0x3b`、`0x41~0x45`、`0x47~0xfe` 在驅動裡沒有對應分支，
`ioctl` 會走 "Unknown FM IOCTL!" 分支返回 `-EINVAL`。

---

## 2. 命令號是怎麼算出來的

### 2.1 編碼規則

拿到任意一個命令號，按 `_IOC` 宏解碼即可驗證：

```python
dir_ = (cmd >> 30) & 3        # 3 = READ|WRITE  => _IOWR
size = (cmd >> 16) & 0x3FFF   # 4
type = (cmd >>  8) & 0xFF     # 0xF5
nr   =  cmd        & 0xFF     # 命令序號
# 例：0xC004F509 -> _IOWR(0xF5, 9, 4)
```

**`type` 恆為 `0xF5`、`size` 恆為 `4`**，所以整套命令可以只用 `nr` 索引，
即 `#define FM_IOCTL(nr) (0xC004F500 | (nr))`。

### 2.2 靜態路線：從 `fm_ioctl()` 的機器碼讀常量

```sh
file /lib/modules/marlin_fm.ko          # -> not stripped  ← 前提
objdump -d --disassemble=fm_ioctl /lib/modules/marlin_fm.ko
```

`fm_ioctl()` 被編譯器編譯成**二分查找**，每個 case 形如：

```asm
     d48: ldr  r3, [pc, #1756] @ 142c    ; 從字面量池取 32bit 常量
     d50: cmp  r1, r3                    ; r1 = 用戶傳入的 cmd
     d64: beq  12e8                      ; 命中則跳 handler
     d6c: sub  r3, r3, #19               ; 編譯器用 add/sub 就近派生下一個比較點
     d70: cmp  r1, r3
```

**兩個必踩的坑（都實際踩過）**：

| 坑 | 現象 | 正解 |
|---|---|---|
| **`movw` 只改低 16 位** | 只按 `movw r3, #62729` 取值會得到 `0xf509` 這種"半截數" | 必須把高 16 位（`movt` 或上一條 `sub` 鏈的結果）一起算，真值是 `0xc004f509` |
| **打印串不在 `.rodata`** | 按 `.rodata` 偏移取字符串取不到 | `objdump -r` 讀重定位表：命令名的格式串在 **`.rodata.str1.1`** |

**命令名的取法**：每個 handler 塊的固定形態是

```asm
     11ac: movw r2, #112           @ __LINE__
     11b0: ldr  r0, [pc, #792] @ 14d0   ; ← 格式串，一定在前 6 條指令內
     11b4: ldr  r1, [pc, #632] @ 1434   ; ← __func__ "fm_ioctl"
     11b8: bl   printk
```

且格式串模板恆為 `"FM_DRV: %s-%d -- ----<命令名>----"`，用整串正則即可精確取出名字。

### 2.3 動態路線：把 dmesg 當"判真器"（最終判據）

驅動裡**每個 case 的第一件事就是打印自己的名字**，而且這行 `printk` **在真正 handler 之前**，
所以即使 handler 因參數非法失敗，名字照樣打得出來 —— 這是零成本、可判真的驗證：

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_ioctl-112 -- ----GETCHIPID----
```

探針極簡（`ssh_tools/fmprobe.c`）：

```c
int fd = open("/dev/fm", O_RDWR);
unsigned char arg[64] = {0};          /* 全零參數：多數 handler 會因參數非法提前返回 */
int r = ioctl(fd, 0xC004F502 /*TUNE*/, arg);
```

**取內核日誌的正確姿勢**：`dmesg | wc -l` 前後比對**不可靠** —— 本機 `SDIOTRAN` 子系統在
高頻刷屏，環形緩衝會迴繞導致漏讀（第一版掃描因此只認出 12/47）。
**必須先 `dmesg -c` 清空，再調用，再讀**：

```python
subprocess.run(["dmesg", "-c"])            # 清空
subprocess.run(["/root/fmprobe", hex(cmd)])# 調一次
time.sleep(0.25)
body = subprocess.run(["dmesg"], capture_output=True, text=True).stdout
```

改用這個姿勢後，**一次掃描就命名成功 45/47**。

### 2.4 交叉驗證：去 Android 庫裡搜同一個常量

原廠 Android 分區的 `libfmjni.so` 裡**存著同一批 `0xC004F5xx` 字面量**（裸字節搜到 18 處），
這從第三方獨立證實了編碼不是我們算錯的：

```python
raw = open("/mnt/android_sys/lib/libfmjni.so", "rb").read()
b = (0xC004F500 | 0x0a).to_bytes(4, "little")   # 0a f5 04 c0
print(b in raw)                                  # True
```

> ⚠️ **直接 grep objdump 文本里的 `0xc004f5xx` 搜不到** —— `movw`/`movt` 會把它拆成兩條指令。
> 要麼裸搜字節，要麼搜 `movt ... @ 0xc004`。

### 2.5 靜態與動態的交叉結論

靜態反彙編先行給出 47 個候選常量，其中 31 個直接解析出名字；
剩餘 16 個（`0x02/0x05/0x08/0x0c/0x0f/0x12/0x18/0x1d/0x1f/0x23/0x26/0x29/0x2c/0x30/0x3e/0x46`）
先按"命令名在 `.rodata` 中的排列順序 = `nr` 遞增順序"推斷，再**全部通過實測逐一確認，無一錯誤**。

---

## 3. 附帶發現：驅動其實是「AT 命令 + ioctl」雙接口

實測 TUNE 時抓到的完整內核日誌：

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_write-348 -- fm_write_completion done=0X0
FM_DRV: fm_write_buf-310 -- fm start wake marlin
FM_DRV: fm_write_buf-337 -- * fmdev->write_buf: at+fm=1,0 *
fm_sdio_write size: 11
FM_DRV: fm_write-356 -- fm_write_after_completion done=0X0
```

三個可確認的事實：

1. **驅動通過 SDIO 向芯片下發的是 AT 文本**，格式為 **`at+fm=<opcode>,<param>`**
   （`at+fm=1,0` 共 10 字符 + NUL = 11 字節，與 `fm_sdio_write size: 11` 吻合）。
2. **AT opcode ≠ ioctl nr**：`TUNE` 的 ioctl nr 是 `0x02`，但 AT opcode 是 `1`。
   兩者是兩套編號，**不要混用**。
3. 驅動裡有 `parse_at_fm_cmd` / `parse_at_fm_num`，說明 `/dev/fm` **也接受直接 `write()` AT 文本**
   —— 這是繞開 ioctl 的另一條路（`libengfm.so` 只導出一個 `fm_runcommand` 也印證了這一點）。

> ⚠️ **AT opcode 全表尚未標定**：目前只確認 `power up -> at+fm=0`、`TUNE -> at+fm=1,<freq>`。
> 且掃描中大量命令都打印出 `at+fm=12`，語義未確認（疑似通用查詢幀）。
> **在沒有把每個命令的 AT 幀都抓一遍之前，daemon 一律走 ioctl，不要走 AT 文本。**

### 3.1 一個重要行為：`TUNE` 會阻塞約 4 秒

`TUNE`（當時 arg=0，即頻率非法）返回 `-1 / ETIMEDOUT`，日誌時間戳跨度

```
[11448.618865] ----TUNE----      →  [11452.613128] fm_write_after_completion
```

即 **約 3.99 s**。對應驅動裡那句 `seek Timeout(%d sec), fm seek end !`。

**設計影響**：
- daemon 裡 TUNE/SEEK **必須放到獨立線程**，不能讓 UI 線程同步等；
- socket 接口要設超時（本項目藍牙頁踩過的坑：`SO_RCVTIMEO`）；
- UI 上要有"正在調諧"態與超時兜底。

---

## 4. 對下游設計的直接影響

| 之前的狀態 | 現在 |
|---|---|
| `操作手冊` Step 2 = "拿 ioctl 命令號（頭號阻塞）" | **該步已完結**，Step 3 起可開工 |
| daemon 無法編碼 | 可直接 `#define FM_IOCTL(nr) (0xC004F500 | (nr))` |
| `OVER_BT_ENABLE` / `ANA_SWITCH` 語義不明 | 命令號已確定（`0x1D` / `0x1E`），可開始 A/B 試聽確認通路 |
| 掃描/取場強無接口 | `SCAN 0x08` + `SCAN_GETRSSI 0x24` 可用，UI 頻譜圖可畫 |
| 換臺會炸音 | `SOFT_MUTE_TUNE 0x3F` 可用 |

**daemon 最小閉環（P0）只需要 8 個命令**：
`IS_FM_POWERED_UP(0x18)` → `power up(0x00)` → `TUNE(0x02)` / `TUNE_NEW(0x3E)` →
`GETRSSI(0x07)` → `SETVOL(0x04)` → `MUTE(0x06)` → `ANA_SWITCH(0x1E)` → `power down(0x01)`。

---

## 5. 已確認的硬事實（無需重新探查）

| 項 | 值 |
|---|---|
| 命令編碼 | `_IOWR(0xF5, nr, 4)` = `0xC004F500 \| nr` |
| 命令總數 | 47 個有分支（45 實測 + 2 推斷） |
| 命令名打印格式 | `FM_DRV: <func>-<line> -- ----<NAME>----` |
| 命令名打印時機 | **在真正 handler 之前**（故可當判真器） |
| 設備節點 | `/dev/fm`（misc 10:23） |
| 芯片通信 | SDIO，AT 文本 `at+fm=<opcode>,<param>` |
| `TUNE` 阻塞時長 | ≈ 3.99 s（失敗路徑，超時返回 `ETIMEDOUT`） |
| `GETCHIPID` 返回值 | `0x2341` |
| 靜態工具可用性 | 設備自帶 `objdump` / `readelf` / `nm` / `strings` / `gcc` / `python3` |
| Android 側 | `libfmjni.so` 含同批常量；`libFMHalSource.so` 負責 PCM（`/dev/snd/controlC%i`） |

## 6. 已驗證的死路（不要重試）

| 做法 | 結果 |
|---|---|
| 在設備上找 FM 驅動源碼 | ❌ 沒有；`/tmp/linux-3.10.65` 是 **vanilla 內核樹**，無展訊私有 FM 源碼 |
| 找 `fm.h` / `sprd_fm.h` 頭文件 | ❌ 全盤無（`find / -name '*.h' \| grep -i fm` 只命中無關文件） |
| 直接 grep objdump 文本找 `0xc004f5xx` | ❌ `movw`/`movt` 拆分導致搜不到，**必須裸搜字節或搜 `movt @ 0xc004`** |
| 按 `.rodata` 取命令名格式串 | ❌ 實際在 **`.rodata.str1.1`**，要讀重定位表 |
| 用 `dmesg \| wc -l` 前後比對取日誌 | ❌ 被 `SDIOTRAN` 刷屏迴繞，會靜默漏讀；**必須 `dmesg -c` 先清空** |
| 複用 Android FM 用戶態庫 | ❌ 依賴 Android 運行時（`libcutils`/`libutils`/`binder`），不可直接搬 |

## 7. 仍未確認（不要當事實用）

| 項 | 為什麼要等實測 |
|---|---|
| AT opcode 全表 | 只確認 2 個；`at+fm=12` 語義未知 |
| `STOP_SCAN` / `DUMP_REG` 的確切命令號 | 靜態推斷，未實測打印 |
| 各 ioctl 參數的結構/量綱 | 本次全部用零參數，未標定（如 TUNE 的頻率單位、步長） |
| `ANA_SWITCH` / `I2S_SETTING` / `OVER_BT_ENABLE` 的取值語義 | 需**人耳** A/B 試聽確認 |
| 是否依賴耳機當天線 | 需不插耳機 TUNE 強信號電臺實測 |
| RSSI 有效區間與閾值 | 必須實測標定，**不要照搬網上通用閾值** |

---

## 8. 復現用腳本（`AI工作流` 之外的工程腳本）

| 腳本 | 作用 |
|---|---|
| `ssh_tools/fm_ioctl_extract.py` | 靜態反彙編還原命令號↔命令名（含 movw 高位、`.rodata.str1.1` 兩個坑的修正） |
| `ssh_tools/fm_re_full.py` | 命令名完整性核對 + Android 庫裸字節交叉驗證 |
| `ssh_tools/pull_disasm.py` | 把 `fm_ioctl` 反彙編拉到本地人工閱讀 |
| `ssh_tools/fmprobe.c` | 設備端最小 ioctl 探針 |
| `ssh_tools/fmprobe_sweep.py` | 全量實測掃描（`dmesg -c` 清空法） |
| `ssh_tools/fm_any.c` | 通用 `/dev/fm` ioctl 探針（`fm_any --seq 30:0 29:0`） |
| `ssh_tools/fm_tune_probe.c` + `_run.py` | dump ioctl 回寫的 32 字節 arg 結構體（判斷驅動寫了什麼） |
| `ssh_tools/fm_seek_probe{,2}.c` + `_run.py` | SEEK 參數矩陣 / 起點與方向語義標定（**詳見 0.1 與專文**） |
| `ssh_tools/fm_at_probe.c` + `_run.py` | 驗證 `write(/dev/fm)` 寫 AT 文本（結論：EINVAL） |
| `ssh_tools/fm_sigcmd_trace.py` | 乾淨 dmesg 下測信號類命令，看有無 SDIO 流量 |
| `ssh_tools/fm_rssi_sweep.py` / `fm_rssi_trace.py` | 多頻點 RSSI 掃描 / 單次 tune+RSSI 完整驅動日誌 |

> 同一套手法可直接複用到 GPS / NFC / 傳感器等「有驅動、無源碼」的外設上。

---

> **一句話總結**：命令號沒丟，只是藏在 `.ko` 的機器碼裡；
> **靜態反彙編定位候選 + 全零參數單步實測 + `dmesg -c` 清空取日誌**，
> 三步就把 47 條命令全部落實 —— 唯一硬阻塞解除，可以開始寫 daemon 了。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
