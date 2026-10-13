---
title: "FM出聲_藍牙路線實測驗證結論"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-04-fm-md/
---


# FM 出聲 —— 藍牙（A2DP）路線實測驗證結論

- **日期**：2026-09-23
- **目標**：本機無耳機孔，把 FM 音頻數字化後寫進 `/tmp/bt_audio.fifo`，經藍牙 A2DP 送到小愛音箱
- **結論**：**用戶態不可行**。三條子路線全部實測封死，且**根因不在 FM，而在整個 AP 音頻子系統不上電**
- **驗證方式**：全部由我上機實跑（用戶要求「你直接幫我驗證」），證據見 §3

---

## 1. 路線拆解

要讓小愛音箱出 FM 的聲音，必須湊齊兩個條件：

```
條件 A：拿到 FM 的 PCM 數據（數字化）
條件 B：把 PCM 寫進 /tmp/bt_audio.fifo，由 bt_user_daemon 走 A2DP 發出
```

**條件 B 已經通了**（09-23 上午驗證過：灌 8.6MB 靜音 PCM，鏈路 49s 不掉、HCI credit 持續變化）。
**條件 A 是死結**，本文驗證的就是它，以及它的三條候選實現。

| 路線 | 做法 | 結果 |
|------|------|------|
| A1 | codec 模擬輸入（AIL/AIR）→ capture PCM 讀出來 | ❌ `readi` 恆 `-5 (EIO)` |
| A2 | 數字 FM（`AD IISMUX=DIGFM`）→ capture PCM 讀出來 | ❌ 同上，且配與不配結果完全一致 |
| A3 | combo 芯片內部 FM→BT 直通（用戶選的 b 路線） | ❌ 見 §3.4，驅動與協議棧兩側都沒這個能力 |

---

## 2. 本次新寫/新編的工具

| 工具 | 作用 |
|------|------|
| `ssh_tools/fm_cap_scan.c` → `/root/fm_cap_scan` | 一次掃完所有 capture 設備 × 採樣率 × 聲道，報告 `nonzero / rms / peak` |
| `ssh_tools/fm_play_probe.c` → `/root/fm_play_probe` | 同樣方式掃 playback，判定 DMA 到底動不動 |
| `ssh_tools/fm_hold.c` → `/root/fm_hold` | 保持某個 playback PCM 處於 running，用來觸發 DAPM 上電 |

**★ 編譯坑（必記）**：本機**沒有 alsa 頭文件**（`/usr/include/alsa` 不存在），
`#include <alsa/asoundlib.h>` 直接編不過。必須照 `fm_ctl.c` 的套路走 `dlopen("libasound.so.2")`
取符號，命令是 `gcc -O2 -o xxx xxx.c -ldl -lm`（**不是** `-lasound`）。
我之前寫 `fm_pcm.c` 時踩過一次，這次三個工具全部改用 dlopen 版。

**★ 第二個坑**：playback 必須用 **非阻塞** 打開。第一次用阻塞模式跑矩陣，`hw:1,4`
的 `writei` 永久卡死，整個矩陣被第一個組合拖到超時，什麼數據都沒拿到。

---

## 3. 實測證據

### 3.1 所有 capture PCM 一律 EIO（配控件前後都一樣）

不配任何控件、配數字 FM 通路、配 line-in 通路，三種情況下跑 `fm_cap_scan`，結果**完全相同**：

```
hw:1,0  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,1  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,2  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
hw:1,3  48000/2  open=0  params=0  read=-5  frames=0  nonzero=0  rms=0.0  peak=0
plughw:1,0 ...   同上
（44100 / 16000 / 8000，1ch / 2ch 全部如此）
```

**關鍵對照**：`card0` 是 `i2s.X null-codec-dai`（跟 FM 毫無關係的空 codec），
它的 capture **同樣是 `-5 EIO`**。

> 這一條推翻了「FM 音頻進不了主機」的說法 ——
> 不是 FM 的問題，是**整個 AP 音頻採集通路都不工作**。

### 3.2 播放側：DMA 啟動一下就停，硬件指針不前進

`fm_play_probe`（非阻塞）結果：

```
hw:1,4  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
hw:1,0  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
hw:1,1  48000/2  open=0  params=0  write=-11  frames=9600   Resource temporarily unavailable
```

讀法很重要：**`frames=9600` 說明 writei 一開始是成功的**（9600 幀 = 200ms 緩衝，
正好填滿整個 ring buffer），之後才 `-11 (EAGAIN)`。

即：PCM start 了，數據進了 ring buffer，但 **DMA 從不搬運，硬件指針不前進**。
這與 capture 側 EIO 是同一個根因的兩面。

### 3.3 DAPM 永遠不上電（決定性證據）

用 `fm_hold` 保持 `hw:1,4` running，同時按廠商 `tiny_hw.xml` 配齊完整通路：

```
Digital FM Function=1  DA0 ADDST MUX=0  DA1 ADDST MUX=0
AD IISMUX=2            AD23 IISMUX=1
Speaker Function=1     SPKL Mixer DACLSPKL=1  SPKR Mixer DACRSPKR=1
```

然後查 DAPM：

```
$ cat /sys/kernel/debug/asoc/sprdphone/sprd-codec.34/dapm/bias_level
Off

$ dapm_dump.sh | sed -n '/彙總/,$p'
----- 彙總 -----          ← 空的，一個 On 的 widget 都沒有

DFM-OUT                 Off  in=1  out=0     ← 鏈路"連上了"
DFM-Output               Off  in=1  out=0
ADie Digital DACL Switch Off  in=1  out=0
Analog Power             Off  in=0  out=0    ← 模擬電源沒開
DA Clk                   Off  in=0  out=0    ← 時鐘沒開
AD Clk                   Off  in=0  out=0
```

**這是最硬的一條證據**：`in=1` 說明 DAPM 的**連接關係**是通的（正如此前"路由通了"的觀察），
但 `bias_level=Off`、所有 widget 全 Off —— **codec 從頭到尾沒上過電**。
沒有上電，DAC 不出聲、ADC 不採樣，capture 自然 EIO。

### 3.4 藍牙直通（b 路線）也是死的

- **驅動側**：`marlin_fm.ko` 裡 `OVER_BT_ENABLE(0x1d)` / `ANA_SWITCH(0x1e)` /
  `I2S_SETTING(0x21)` / `GET_AUDIO_INFO(0x30)` 全是空殼（進 case 只 printk 名字）。
  更硬的證據是上游同源驅動（LKML 2017 展訊 `marlin2_fm` 補丁）裡這幾個 case 寫的就是
  `ret = 0; break;` —— **展訊壓根沒實現**，不是我們這版被裁掉。
- **協議棧側**：`strings /usr/local/bin/bt_user_daemon | grep -i 'fm'` **一個 FM 相關串都沒有**，
  只有 `[TX] opcode=0x%04x ...`。自研協議棧不認識 FM，沒有 FM 直通入口。
- **繞過驅動的口子也不存在**：dmesg 裡能看到內核自己發 `mdbg_proc->write_buf:at+loopcheck`，
  但 `/dev/mdbg*` **不存在**，那是內核內部通道，用戶態夠不著；
  `write(/dev/fm, "at+fm=...")` 恆 `EINVAL`。

### 3.5 順帶排除的假設

| 假設 | 排查結果 |
|------|----------|
| 缺 `audio_para` 導致 codec 初始化不全 | Android 分區裡有 `/etc/audio_para`（485KB），但 codec kcontrol 全部正常註冊（120 個），說明 probe 是成功的，不是參數缺失 |
| AGDSP 固件沒加載 | **sipc 只暴露了 `spipe_lte0~14`（LTE modem 通道）**，沒有任何音頻 DSP 通道；sysfs 裡只有 `saudio_lte.0` / `saudio_voip.1`（都是給 LTE/voip 的共享內存音頻），**沒有 AGDSP 的 saudio 通道**。固件就算有也無從加載 |
| 固件裡有隱藏的 FM 音頻路由 AT 命令 | wcnmodem 分區 dump 裡只有 `marlin_fm_ctrl.c`、`Handle_FM_RX_CMD_ENABLE`、`fm_cfg 0x%x,%x,%x`、`marlin_fm_seek_*` 等少量串，沒有 `at+fm` 命令族、沒有 `over_bt` 相關串 |

---

## 4. 根因判斷

```
內核側 sipc 沒有音頻 DSP 通道（只有 LTE）
   → AGDSP 無從加載 / 無通信
   → codec 驅動的 set_bias_level 依賴的電源與時鐘起不來
   → DAPM bias_level 永遠 Off，Analog Power / DA Clk / AD Clk 全 Off
   → DAC 不出聲、ADC 不採樣、DMA 不搬運
   → 播放 EAGAIN、採集 EIO、FM 拿不到 PCM
```

**所以：這不是"FM 音頻沒接進來"，而是"這臺機器在 Alpine 下整個音頻子系統是死的"。**
這也解釋了此前所有"路由通了但就是沒聲音"的觀察。

## 5. 結論與剩餘選項

**用戶態（當前內核）**：FM 經藍牙出聲 —— **不可行**，三條子路線已全部實測封死。

要走通只剩**動內核**（原方案 a），且要動的地方比預想的多：

1. 設備樹 / sipc 配置裡補上 AGDSP 音頻通道（當前只有 LTE 通道）；
2. 把 AGDSP 固件加載起來（需先確認固件在哪個分區，當前 `/proc/partitions` 裡沒有明確命名的 dsp 分區）；
3. 確認 codec 的 `set_bias_level` 具體卡在哪一步（可用 `dynamic_debug` 打開 sprd-codec 的
   `dapm` / `bias` 相關打印來定位）。

這三項都需要**內核源碼**（本機 `/tmp/linux-3.10.65` 是 vanilla 樹，不含廠商代碼），
且重新編譯內核後要能刷機。**請確認手上有沒有廠商內核源碼樹**，沒有的話這條路也走不動。

**可以立刻做的、不需要內核的退路**：FM 功能保留為 UI 可演示（調頻、RDS、搜臺的替代交互），
出聲這塊如實標註"本機音頻子系統不可用"。

## 6. 現場狀態（驗證後留在設備上的）

- 控件目前配置在「數字 FM + Speaker 輸出」狀態（`Digital FM Function=1`、`AD IISMUX=2`、
  `Speaker Function=1`、`SPKL Mixer DACLSPKL=1`、`SPKR Mixer DACRSPKR=1`）
- FM daemon 已上電、TUNE 在 97.4MHz、`mute=0`
- `/root/fm_hold` 可能仍在後臺佔著 `hw:1,4`（最多 170s 後自行退出）。
  要再跑一次 `fm_cap_scan` / `fm_play_probe`，先 `kill` 掉它，否則會 `Resource busy`
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
