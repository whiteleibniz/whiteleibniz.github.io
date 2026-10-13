---
title: "FM收音_SEEK與場強_實測結論"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-05-fm-seek-md/
---


# FM 收音 —— SEEK / 場強 / AT 文本直寫 實測結論

> 設備：展訊 SC9832A（Alpine Linux / armv7l），FM 芯片 Unisoc Marlin2 combo，
> 驅動 `marlin_fm.ko`，節點 `/dev/fm`，ioctl 統一 `_IOWR(0xF5, nr, 4) = 0xC004F500 | nr`。
> 實測時間：2026-09-22。**全部結論均為設備實測，判真器是驅動自己的 dmesg（`fm_write_buf` / `parse_at_fm_cmd`）。**

---

## 0. 一句話結論

| 想做的事 | 能不能 | 原因 |
|---|---|---|
| 上電 / 調臺 / 音量 / 靜音 | ✅ | `POWER_UP(0x00)` / `TUNE(0x02)` / `SETVOL(0x04)` / `MUTE(0x06)` 真發 SDIO |
| **搜臺（下一個電臺）** | ❌ | `SEEK(0x03)` 的起點頻率被驅動截斷成 1 字節，帶內頻點傳不進去；實測只有 2 個固定回值 |
| **讀信號場強** | ❌ | 唯一真發 SDIO 的 `GETRSSI(0x07)` 恆超時 4.2s 且回值幾乎不變；其餘信號類命令全是空殼 |
| **寫 AT 文本繞開 ioctl** | ❌ | `write(/dev/fm)` 恆定 `-1 / EINVAL(22)`，驅動不接收用戶態 AT 文本 |

---

## 1. `SEEK (0x03)` —— 參數被截斷，無法用來搜臺

### 1.1 參數結構（與 TUNE 相同）
```c
typedef struct {
    unsigned char  zero;   /* offset 0 */
    unsigned char  band;   /* offset 1 */
    unsigned char  one;    /* offset 2 */
    unsigned char  pad;    /* offset 3 */
    unsigned short freq;   /* offset 4-5  —— 單位 0.1MHz（974 = 97.4MHz） */
    unsigned char  tail[26]; /* offset 6 起 */
} fm_arg_t;
```

### 1.2 驅動實際發出的 AT 幀

驅動把 `freq`（u16）**只取低字節**拼進 AT 幀（這是驅動的 bug）：

| 我們傳 freq | 驅動實際發出 | 芯片回幀 | 驅動回寫到 `tail[0..1]` 的"找到頻點" |
|---|---|---|---|
| 974 (97.4MHz) | `at+fm=4,0,206` | `3,139,0,9250` | **925 = 92.5MHz** |
| 875 (87.5MHz) | `at+fm=4,0,107` | `3,139,0,9250` | **925** |
| 1080 (108.0MHz) | `at+fm=4,0,56` | `3,139,0,9250` | **925** |
| 900、1000 | `at+fm=4,0,132` / `,232` | `3,139,0,9250` | **925** |
| **0** | `at+fm=4,0,0` | `3,139,0,10310` | **1031 = 103.1MHz** |

- `at+fm=4,<p2>,<p3>` 的 **p2 恆為 0**：把 `zero/band/one/pad` 都改成 1/2 也不變。
- **p3 = `freq & 0xFF`**，所以帶內頻點（875~1080）永遠傳不進去。
- 結果與"當前頻點"**無關**：先 `TUNE` 到 87.5 / 97.4 / 100.0 / 103.1，再 `SEEK(0)`，
  四次都回 **103.1**。

### 1.3 行為模型
- `p3 == 0`  → 恆返回 **92.5MHz 區間的另一極**（103.1MHz）
- `p3 != 0`  → 恆返回 **92.5MHz**

也就是說 SEEK 退化成"兩個固定值二選一"，**不是"從當前頻點向上/向下找下一個電臺"**。
UI 上**不要**把它做成"搜臺"按鈕。

- 耗時：每次約 **1.43 s**（`at+fm=4` 發出 → `parse_at_fm_cmd: fm seek event have come freq=...`）。
- 驅動日誌裡那句 `FM seek freq =0` 裡的值**恆為 0**，與傳入的 freq 無關 → 別拿它當判據。
- `SEEK_NEW(0x3d)` 只打日誌後發 `at+fm=12`（通用查詢幀），`SCAN(0x08)` / `SCAN_NEW(0x3c)`
  返回 0 且**零 SDIO 流量** → 都是空殼/佔位。
- `STOP_SCAN(0x09)` 恆 `-1 / EINVAL(22)`。

### 1.4 探針
- `ssh_tools/fm_seek_probe.c` + `fm_seek_probe_run.py` —— 參數變體矩陣 + 回寫結構體 dump
- `ssh_tools/fm_seek_probe2.c` + `fm_seek_probe2_run.py` —— 起點/方向語義驗證（配合 TUNE）

---

## 2. `write(/dev/fm)` 寫 AT 文本 —— 被內核拒絕

驅動裡有 `parse_at_fm_cmd` / `parse_at_fm_num`，Android 側 `libengfm.so` 也只導出
一個 `fm_runcommand`，看起來像"可以直接寫 AT 文本繞開 ioctl"。**實測不行**：

```
write(fd, "at+fm=1,9250", 12)  -> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=4,0,9740", 15)-> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=4,1,9740", 15)-> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=12", 8)       -> rc=-1 errno=22 (EINVAL)
```
dmesg 中**沒有任何 `fm_write_buf` 記錄** → 請求在進入驅動前就被拒了，沒有 SDIO 流量。
**結論：此路不通，不要在這上面花時間。** 探針：`ssh_tools/fm_at_probe.c` + `fm_at_probe_run.py`。

---

## 3. 場強 / 信號類命令 —— 全部不可用

| 命令 | 命令號 | 實測判定 |
|---|---|---|
| `GETRSSI` | 0x07 | **唯一真發 SDIO**（`at+fm=13`），芯片回 123~125，但 ioctl **恆 `-1 / ETIMEDOUT(110)`，耗時恆 4.2s**；10 個頻點上回值幾乎不變 → 不能當場強表 |
| `SCAN_GETRSSI` | 0x24 | 空殼（只 printk） |
| `CQI_GET` | 0x27 | 空殼 |
| `GETMONOSTERO` | 0x0d | 空殼 |
| `GETGOODBCNT` / `GETBADBNT` | 0x0f / 0x10 | 空殼 |
| `GETBLERRATIO` | 0x11 | 空殼 |
| `IS_DESE_CHAN` | 0x2a | 空殼 |
| `SOFT_MUTE_TUNE` | 0x3f | 有作用（換臺消爆音），但**不回寫可用場強** |

**`TUNE` 應答裡的第 2 個字段不是場強**：`at+fm=1,9740` → `0,164,0,9740`；
同一頻點連調會得到 164 與 139 兩個不同值；不同頻點都在 139~140 附近；
**且驅動根本不把這個應答回寫給用戶態**（ioctl 返回後 arg 結構體沒變化）。
→ 判定：不是穩定的場強指標，不能當信號表。

**下游影響**：收音機頁**不應**再畫"信號柱"。
現版本已改為固定文案「本機不提供場強查詢」，並**移除**了每次調臺後的
`rssi` 輪詢（原來每次白等 4.2s）。

---

## 4. 相關：FM 音頻輸出也是死的

見 `FM收音ioctl命令表_逆向還原.md` 與 `outputs/FM收音機_進度快照_20260922.md`：
- FM 音頻類 ioctl（`OVER_BT_ENABLE 0x1d` / `ANA_SWITCH 0x1e` / `I2S_SETTING 0x21` …）
  在 `marlin_fm.ko` 裡**只 printk 就返回**（反彙編 `fm_ioctl` 的 `R_ARM_CALL` 只調 7 個函數，無音頻通路函數）。
- 整機 codec（`sprdphone` card1）DAPM **路由表缺 HPL/HPR/SPKL/SPKR**，
  唯一可達終點是 `EAR`，且從不給 `Analog/Digital Power` 上電（`bias_level=Off` 恆 Off）。
- 8 個 capture 設備**全部 `readi -5 (EIO)`**；`read(/dev/fm)` 只返回 688B RDS 數據塊。
→ **FM 音頻既不能出聲，也不能數字化進主機**。用戶態無解。

---

## 5. 對應用設計的約束（可直接抄）

1. **UI 不要提供"搜臺"按鈕** —— SEEK 不可控，會讓人以為搜到了電臺。
2. **UI 不要畫信號強度** —— 硬件不提供；畫了就是說謊。
3. **不要輪詢 `rssi`** —— 每次白等 4.2s。
4. **不要嘗試寫 AT 文本** —— EINVAL。
5. 可用且已驗證的功能集：`state / on / off / tune <kHz> / vol <0-15> / mute <0|1> / chipid / rds`。
6. 任何"要不要為此改內核"的決策，都先看本文第 4 節 —— 出聲的瓶頸在 codec 的 DAPM 路由，
   不在 FM 驅動。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
