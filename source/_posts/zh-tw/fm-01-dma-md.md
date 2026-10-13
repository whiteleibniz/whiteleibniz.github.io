---
title: "DMA支持與安卓移植可行性勘察"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-01-dma-md/
---


# DMA 支持情況 & 從安卓移植的可行性勘察

- **日期**：2026-09-23
- **問題**：本機 DMA 到底支不支持？能不能把安卓那套音頻搬過來？
- **結論**：**DMA 硬件與驅動都在，但內核層沒有可移植的東西（Alpine 跑的就是原廠安卓內核）**；
  用戶態能搬的都試了，全無效。堵點已定位到 **12 個音頻電源域全部 disabled、codec 數字部分寄存器讀出來全是 0**。

---

## 1. 先糾正一個前提：Alpine 跑的就是原廠安卓內核

```
$ uname -a
Linux spd-box 3.10.65 #13 SMP PREEMPT Fri Apr 27 13:23:49 CST 2018 armv7l Linux

$ cat /proc/cmdline
... androidboot.hardware=sc9832 lcd_id=ID9881 ... androidboot.mode=charger
```

內核版本、編譯時間、`androidboot.hardware=sc9832` 都指向**廠商原廠內核**，
boot 分區 `mmcblk0p16` 頭部是標準 `ANDROID!` boot.img 魔數。

> 所以「從安卓移植驅動」這個方向**不成立** —— 驅動本來就在這顆內核裡，而且全部是 **builtin**
> （Android 側 `/mnt/android_sys/lib/modules/` 裡只有 `sprdwl.ko / marlin_fm.ko / mali.ko /
> gator.ko / autotst.ko / mmc_test.ko`，**沒有任何音頻模塊**）。

## 2. DMA 支持情況：硬件和驅動都在

| 項 | 狀態 |
|----|------|
| `/sys/class/dma` | **不存在** —— 但這是正常的：sprd 用的是自家 DMA 驅動，**沒走內核 dmaengine 框架** |
| `0.dma-controller` / `0.dmac` | 存在（platform device） |
| `sprd_dma_copy.27` | 存在 |
| `i2s.38 / .39 / .40 / .41` | 存在 |
| `sprd-pcm-audio.42`、`sprd-codec.34` | 存在 |
| `vbc-r2p0.36`、`vaudio.37`、`saudio_lte.0`、`saudio_voip.1` | 存在 |
| `sprd-audio-power.1 ~ .12` | 12 個音頻電源域，均帶 `regulator` 子目錄 |
| regulator framework / `sc2723-regulator` | 正常，共 38 個 regulator |

**結論：DMA 不是缺驅動，也不是缺硬件。**

## 3. 從安卓搬了什麼、結果如何

| 可搬項 | 來源 | 結果 |
|--------|------|------|
| **`audio_para`** | `/mnt/android_sys/etc/audio_para`（485KB），HAL 字符串裡明確有 `/etc/audio_para` 和 `/data/local/media/audio_para` | ❌ **無效**。已放到 `/etc/audio_para` + `/lib/firmware/audio_para` 並**重啟**，codec 數字部分寄存器**仍全是 0** |
| **音頻 HAL** | `/mnt/android_sys/lib/hw/audio.primary.sc8830.so` | ❌ 它是 **bionic** 動態庫，本機是 musl，**跑不起來**。不過它裡面的控件序列我們早先已還原並實測過（見 §5） |
| **tinyplay / tinycap / tinymix** | `/mnt/android_sys/bin/` | ❌ 同樣是 bionic 二進制。等價功能已用自寫工具（`fm_cap_scan` / `fm_play_probe`）覆蓋 |
| **VBC 通路** | HAL 用 `/dev/vbpipe6`、`/dev/pipe/mmi.audio.ctrl` | ❌ **本機 `/dev/vbpipe*` 和 `/dev/pipe` 都不存在** |
| **AGDSP / 音頻 DSP** | — | ❌ **sipc 只有 `sipc-lte`(dst 0x5) 和 `sipc-pmsys`(dst 0x6)**，**沒有任何 audio DSP 通道**；`/sys/kernel/debug/sipc/` 下是 sblock/sbuf/seblock/sipx/smem/smsg，但 smsg 通道列表裡只有 lte/pmsys |

## 4. 堵點定位（本次最重要的發現）

### 4.1 codec 數字部分寄存器讀出來全是 0

`/proc/asound/sprdphone/sprd-codec` 可以直接 dump 寄存器：

```
sprd-codec.34 digital part
0x0000 | 0x0000 0x0000 0x0000 0x0000      ← 全 0
0x0010 | 0x0000 0x0000 0x0000 0x0000
0x0020 | 0x0000 0x0000 0x0000 0x0000
0x0030 | 0x0000 0x0000 0x0000 0x0000
sprd-codec.34 analog part
0x0000 | 0x0010 0x0081 0xb400 0x6d3c      ← 模擬部分有正常值
0x0010 | 0x1070 0xa000 0x0000 0x0000
```

模擬部分（走 SC2723 的 ADI 總線）正常，**數字部分是空的**。
放 `audio_para` + 重啟之後**依然全 0**。

### 4.2 12 個音頻電源域全部沒人用

```
sprd-audio-power.1 → regulator.26 = SRG_VREG      num_users=0
regulator.27 SRG_VB        regulator.28 SRG_BG
regulator.29 SRG_BG_IBIAS  regulator.30 SRG_VCOM
regulator.31 SRG_VCOM_BUF  regulator.32 SRG_VBO
regulator.33 SRG_VMICBIAS  regulator.34 SRG_MICBIAS
regulator.35 SRG_AUXMICBIAS regulator.36 SRG_HEADMICBIAS ...
```

全部 **disabled，users=0**。DAPM 裡 `Analog Power / DA Clk / AD Clk` 那批 Off 的 widget，
對應的就是這些電源域。

**`/sys/class/regulator/regulator.X/` 下只有 `device name num_users power subsystem
suspend_* type uevent`，沒有可寫的 `state`** → **用戶態無法強制 enable**，必須由內核 DAPM 去做。

### 4.3 完整因果鏈

```
sipc 無 audio DSP 通道 → VBC/AGDSP 類通路不可用（/dev/vbpipe 也不存在）
                       ↓
DAPM 需要 enable 的 12 個 SRG_* 電源域全部 disabled (users=0)
                       ↓
codec 數字部分上不了電 → 數字寄存器讀寫不到（全 0）
                       ↓
bias_level 永遠 Off，DAPM 不 power up
                       ↓
i2s / DMA 不搬運 → 播放 writei 寫一個 buffer 就 EAGAIN、採集 readi 直接 EIO
```

## 5. 已經試過、不要再重複的動作

- 按廠商 `tiny_hw.xml` 配齊 `digital-fm` + `speaker` 完整通路，並用 `fm_hold` 保持 `hw:1,4` running
  → `bias_level` 仍 Off、ON widget 數為 0
- 放 `audio_para` 到 `/etc` 和 `/lib/firmware` 並重啟 → 無效
- `unbind/bind` 重新 probe `sprd-codec.34` → **bind 失敗，codec 變成 `(null)`**，
  只能靠重啟恢復。**不要再對 `sprd-codec.34` 做 unbind**，會把音頻子系統搞壞

## 6. 還能做什麼

1. **需要廠商內核源碼**才能繼續：查 `sprd-codec` 的 probe / `set_bias_level` 為什麼沒把 bias 拉到
   STANDBY、數字寄存器為什麼訪問不到。本機 `/tmp/linux-3.10.65` 是 vanilla 樹，不含廠商代碼。
2. 次優：用 `dynamic_debug` 打開 `sprd-codec` / `snd_soc` 的 dapm 與 bias 相關打印，
   能看到 DAPM 決策過程（不需要源碼也能拿到一些信息）。
3. **不推薦**的方向：繼續在用戶態調 kcontrol —— 電源域 enable 不了，控件怎麼設都沒用。

## 7. 現場狀態（勘察後）

- 設備已重啟一次，一切正常：`lvgl_demo` / `bt_user_daemon`(1177) / `fm_user_daemon`(1228) / `lvgl_watchdog` 均在跑
- `/etc/audio_para` 與 `/lib/firmware/audio_para` 已部署（實測無效，留著無害）
- 重啟後 kcontrol 已回到默認值（此前配的 digital-fm / speaker 組合已清空）
- 新增工具：`/root/fm_cap_scan`（採集矩陣掃描）、`/root/fm_play_probe`（播放矩陣，非阻塞）、
  `/root/fm_hold`（保持 PCM running）
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
