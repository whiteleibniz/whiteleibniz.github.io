---
title: "FM出聲_廠商官方音頻通路與實操步驟"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-03-fm-md/
---


# FM 出聲：廠商官方音頻通路（2026-09-23）

> 背景：本機 FM「應用層已通」（TUNE / RDS / 音量都有），唯獨**沒有聲音**。
> 先前結論是「FM 音頻在用戶態不可行」，理由是：card1 DAPM 路由不完整、8 個 capture 全 EIO、
> `codec_reg` 是空文件。
> 本次**推翻該結論的一半**：FM 音頻並非只能靠 `marlin_fm.ko` 裡的那幾個音頻 ioctl ——
> **廠商其實已經把 FM 音頻通路寫進了 Android 分區的配置文件裡**，而且
> **本機 card1 上這些 kcontrol 全部存在**。
> 之前沒出來，是因為從來沒人按那份配置去設過。
>
> 狀態：**待你在設備上手動驗證**（我不再跑驗證）。本文檔給出控件名、順序、命令、排錯要點。

---

## 1. 先說結論

| 項 | 結論 |
|---|---|
| `OVER_BT_ENABLE(0x1d)` / `I2S_SETTING(0x21)` / `ANA_SWITCH(0x1e)` / `GET_AUDIO_INFO(0x30)` | 本機 `marlin_fm.ko` 裡**是空殼**：`fm_ioctl` 進 case 只 printk 一行名字就返回，不發任何 SDIO 命令（反彙編已確認）。**不要再指望用 FM ioctl 切音頻通路**。 |
| 上游開源驅動（同一份 `marlin2_fm`） | 同樣把這幾個 case 寫成 `ret = 0; break;`——**廠商從來沒在這條鏈路上實現**。這是 `OVER_BT_ENABLE` 這條路已死的權威證據。 |
| **真正的通路在哪** | 在 **AP codec 側**，廠商在 Android system 分區 `/etc/tiny_hw.xml` 裡給了完整定義。FM 芯片出來的音頻（數字 DIGFM 或模擬 AIL/AIR line-in）→ codec → SPK/耳機，**AP 不需要搬音頻數據**。 |
| 本機是否具備 | **具備**。card1（`sprdphone`）裡 `Digital FM Function`、`AD IISMUX`（enum 含 `DIGFM`）、`Line Function`、`ADCL/ADCR Mixer AILADCL/AIRADCR`、`SPKL Mixer ADCLSPKL`、`HPL Mixer ADCRHPL` 等控件**全部存在**。 |
| 為什麼之前沒出來 | 先前只設了 `Speaker Function`（把 DACL→EAR 打通），**沒設 FM 側的任何一個控件**，也**沒有打開 `hw:1,4`(`Dfm`) PCM 去觸發 DAPM 上電**。兩件事都沒做，自然沒聲。 |

---

## 2. 廠商官方 path 定義（原文）

來源：設備 Android system 分區 `/etc/tiny_hw.xml`（只讀掛載在 `/mnt/android_sys`）。

### 2.1 數字 FM —— `<device name="digital-fm">`

```xml
<device name="digital-fm">
  <path name="on">
     <ctl name="Digital FM Function" val="1" />
     <ctl name="DA0 ADDST MUX" val="0" />
     <ctl name="DA1 ADDST MUX" val="0" />
     <ctl name="AD IISMUX" val="2" />        <!-- 2 = DIGFM -->
  </path>
  <path name="off">
     <ctl name="Digital FM Function" val="0" />
     <ctl name="DA0 ADDST MUX" val="0" />
     <ctl name="DA1 ADDST MUX" val="0" />
     <ctl name="DA0 ADDFM MUX" val="0" />
     <ctl name="DA1 ADDFM MUX" val="0" />
     <ctl name="AD IISMUX" val="0" />
  </path>
</device>
```

`AD IISMUX` 的 enum 選項（本機 card1 實測）：
`[0]=AUDIIS0  [1]=DIGFM  [2]=EXTDIGFM  [3]=EXTIIS6  [4]=AUDIIS1`

⚠️ **注意**：本機 dump 出來的 enum 順序是 `(AUDIIS0/DIGFM/EXTDIGFM/EXTIIS6/AUDIIS1)`，
`val="2"` 在這個順序裡落在 **EXTDIGFM** 而不是 DIGFM。XML 是給另一份 kernel/codec 版本寫的，
**兩個值都要試**（建議先 2，再 1）。這是本方案裡最可能需要現場調的一個值。

### 2.2 模擬 FM（line-in → codec loop）

```xml
<device name="line">                      <!-- 模擬輸入側 -->
  <path name="on">
     <ctl name="HeadPhone Mute" val="1" />      <!-- 先 mute，防 pop -->
     <ctl name="ADCL Mixer AILADCL Switch" val="1" />
     <ctl name="ADCR Mixer AIRADCR Switch" val="1" />
     <ctl name="Line Function" val="1" />
     <ctl name="HeadPhone Mute" val="0" />      <!-- 再放開 -->
  </path>
  <path name="off">
     <ctl name="Line Function" val="0" />
     <ctl name="ADCL Mixer AILADCL Switch" val="0" />
     <ctl name="ADCR Mixer AIRADCR Switch" val="0" />
  </path>
</device>

<device name="line-speaker">              <!-- 模擬 → 揚聲器 -->
  <path name="on">
     <ctl name="SPKL Mixer ADCLSPKL Switch" val="1" />
     <ctl name="SPKL Mixer ADCRSPKL Switch" val="1" />
  </path>
</device>

<device name="line-headphone">            <!-- 模擬 → 耳機 -->
  <path name="on">
     <ctl name="HPL Mixer ADCRHPL Switch" val="1" />
     <ctl name="HPR Mixer ADCLHPR Switch" val="1" />
  </path>
</device>
```

### 2.3 輸出側（數字 FM 也要配一個）

```xml
<device name="speaker">
  <path name="on">
     <ctl name="SPKL Mixer DACLSPKL Switch" val="1" />
     <ctl name="SPKL Mixer DACRSPKL Switch" val="1" />
     <ctl name="Speaker Function" val="1" />
  </path>
</device>

<device name="headphone">
  <path name="on">
     <ctl name="HPL Mixer DACLHPL Switch" val="1" />
     <ctl name="HPR Mixer DACRHPR Switch" val="1" />
     <ctl name="HeadPhone Function" val="1" />
  </path>
</device>
```

參考：SC9832A 平臺同款 SoC 的公開分析確認 FM 音頻從 codec 的 **AIL/AIR**（類似 MIC 的 line-in）進
codec，再「FM playback patch」直出，或經 VBC 給主控錄音——與上面的配置文件完全對得上。

---

## 3. 你怎麼跑（手動驗證步驟）

### 3.0 準備

1. FM 上電鏈先起來：WiFi 固件下載 → `bt_bringup.start`（含 wcn BT-OPEN）→ 向 `@wcnd` 發 `wcn FM-OPEN`
   並**長期保持連接**。
2. `fm_user_daemon` 常開 `/dev/fm`（socket `/tmp/fm_ctl.sock`），TUNE 到一個本地強信號電臺。
3. 通過 `/tmp/fm_ctl.sock` 執行 `mute 0`，確認 FM 未處於靜音（socket 命令寫法見
   `AI工作流/*/docs/` 與 `lv_pages/radio_page.c`）。
4. 沒有 `amixer`/`tinymix`，用已有的 `/root/fm_ctl`：`fm_ctl <op> <card> ...`

### 3.1 先確認控件真名（非常重要）

之前 dump 出來的名字**不一定等於 ALSA 全名**（例如 dump 裡是 `ADCL Mixer AILADCL`，
XML 裡是 `ADCL Mixer AILADCL Switch`）。先 grep 一次拿真名：

```sh
/root/fm_ctl grep card1 AIL
/root/fm_ctl grep card1 IISMUX
/root/fm_ctl grep card1 "Digital FM"
/root/fm_ctl grep card1 SPKL
/root/fm_ctl grep card1 Function
```

### 3.2 方案 A：數字 FM → 揚聲器（推薦先試）

```sh
# 1) 輸出側 speaker（先鋪好輸出）
/root/fm_ctl set card1 "Speaker Function" 1
/root/fm_ctl set card1 "SPKL Mixer DACLSPKL Switch" 1
/root/fm_ctl set card1 "SPKL Mixer DACRSPKL Switch" 1

# 2) 數字 FM 通路
/root/fm_ctl set card1 "Digital FM Function" 1
/root/fm_ctl set card1 "DA0 ADDST MUX" 0
/root/fm_ctl set card1 "DA1 ADDST MUX" 0
/root/fm_ctl set card1 "AD IISMUX" 2        # 無聲再試 1 / 3

# 3) 打開 FM PCM 觸發 DAPM 上電（關鍵！本機 card1 的 01-04 就是 Dfm）
#    編譯：gcc -O2 -o /root/fm_pcm fm_pcm.c -lasound
/root/fm_pcm "hw:1,4" 60 &                  # 保持寫 60 秒
```

> **第 3 步是最容易漏的一步**：`Dfm` 這個 PCM 設備存在的意義就是「開流把 DAPM 拉起來」，
> 只設 kcontrol 而 stream 沒起來，`bias_level` 會一直停在 `Off`（這正是之前觀察到的現象）。

### 3.3 方案 B：模擬 line-in → 揚聲器 / 耳機

```sh
/root/fm_ctl set card1 "Line Function" 1
/root/fm_ctl set card1 "ADCL Mixer AILADCL Switch" 1
/root/fm_ctl set card1 "ADCR Mixer AIRADCR Switch" 1

# 出到揚聲器
/root/fm_ctl set card1 "SPKL Mixer ADCLSPKL Switch" 1
/root/fm_ctl set card1 "SPKL Mixer ADCRSPKL Switch" 1

# 或出到耳機
/root/fm_ctl set card1 "HPL Mixer ADCRHPL Switch" 1
/root/fm_ctl set card1 "HPR Mixer ADCLHPR Switch" 1
/root/fm_ctl set card1 "HeadPhone Function" 1
```

### 3.4 關 / 復位

```sh
/root/fm_ctl set card1 "Digital FM Function" 0
/root/fm_ctl set card1 "AD IISMUX" 0
/root/fm_ctl set card1 "Line Function" 0
/root/fm_ctl set card1 "Speaker Function" 0
```

---

## 4. 排錯要點

| 現象 | 可能原因 | 處理 |
|---|---|---|
| 完全無聲，`bias_level` 仍 Off | `hw:1,4` 沒被打開/寫入 | 確認 `fm_pcm` 進程在跑且 `writei` 沒返回錯誤 |
| 有聲但很小 / 失真 | 走的是 line-in 模擬通路，增益沒配 | 只保留一條 route（兩條同時開會互相串擾），並換另一個 `AD IISMUX` 取值再試 |
| `AD IISMUX` 設不動 | enum 值範圍不同 | 先 `fm_ctl get card1 "AD IISMUX"` 看允許的取值範圍 |
| 需要插耳機 | FM 天線可能掛在耳機線上 | 不插耳機 TUNE 到最強臺再試；若必須插，UI 要有提示 |
| 數字 FM 一直不成 | 本機固件可能沒把 FM 數字口接到 VBC | 退回方案 B（模擬 line-in），這條路最好 route 完整 |

沿用「末端證據」原則：**判斷標準是人耳聽到電臺聲**，不是 ioctl 返回 0。

---

## 5. 待確認清單（驗證後回填）

- [ ] `AD IISMUX` 正確取值（1 / 2 / 3 哪個是 `DIGFM`）
- [ ] 數字 FM 與模擬 line-in 哪條在本機真的通
- [ ] 是否需要插耳機當天線
- [ ] 音量到底歸 `SETVOL`(0x04) 管還是歸 codec 的 pga（`codec_pga.xml` 裡 `digital-fm` profile 用 `VBC STL DG Set` / `VBC STR DG Set`）
- [ ] FM 與 A2DP 同時開時的串擾情況（決定聲道仲裁怎麼寫）

---

## 6. 附：證據來源

| 文件 | 內容 |
|---|---|
| `/mnt/android_sys/etc/tiny_hw.xml` | 廠商 mixer path 全量定義（本文 §2 原文出處） |
| `/mnt/android_sys/etc/codec_pga.xml` | `digital-fm` profile → `VBC STL DG Set`(bit 0) / `VBC STR DG Set`(bit 16) |
| `radio_docs/mixer_card1.txt` | 本機 card1 全部 kcontrol dump（確認控件存在） |
| LKML `[PATCH 2/2] misc: added Spreadtrum's radio driver`（Chunyan Zhang, 2017） | 驅動上游源碼：`FM_IOCTL_*` 全表、chip 側 `FM_*_CMD` 編號、以及 I2S/AudioInfo case 是空實現 |
| 公開分析《Sprd 9832A Android6.0 FM 模式下的幾種 Audio 路徑》 | AIL/AIR 輸入、三種模式（Line_in-Codec / Line_in-VBC-Codec / Digital FM-VBC-Codec）的信號流 |
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
