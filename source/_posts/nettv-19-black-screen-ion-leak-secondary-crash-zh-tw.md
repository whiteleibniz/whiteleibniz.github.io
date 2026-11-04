---
title: nettv-19：黑畫面無反應？——當「必崩」結論撞上 ION 洩漏的次生崩潰（SC9832A 硬解排查實錄）
date: 2026-10-21 09:30:00
tags:
  - sprd
  - SC9832A
  - VSP
  - ION
  - carveout
  - SIGSEGV
categories:
  - [嵌入式, 網路電視硬解]
  - [除錯, 方法論]
  - [Linux, 記憶體管理]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-19-black-screen-ion-leak-secondary-crash-en/)

> 版權聲明：本文為筆者原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處連結和本聲明。

使用者推門進來就一句：「網路電視黑畫面無反應了。」

設備 ping 得通、SSH 正常、桌面行程 `lvgl_demo` 還活著——但播放器 `nettv_player` 的 monitor 看門狗正在無窮重啟迴圈，每一輪 worker 都以 `exit 11` 收場，螢幕自然永遠黑著。

這篇記錄這次排查，重點不是「修了什麼程式碼」，而是一個反覆咬人的教訓：**你盯了半個月的「必崩」結論，可能只是另一場崩潰的次生現象。**

## 一、現場：行程活著，影格數為零

先看三件套：行程樹、日誌尾部、dmesg。

```sh
ps | grep -E "[n]ettv|[l]vgl_demo"      # 桌面活著, 播放器在, 但零影格
tail /tmp/nettv.log                     # *** monitor: 重啟 (子行程 @0 影格) × 7 輪
dmesg | tail                            # 最後一條是 33 分鐘前的 CPU 熱插拔, 之後無新記錄
```

三個資訊拼出來一個判斷：

1. **不是核心崩**——dmesg 沒有新記錄，純用戶態問題；
2. **不是桌面死**——`lvgl_demo` 主行程健在，按鍵有回應；
3. **是播放器空轉**——monitor 每輪拉起 worker，worker 拿不到輸出 buffer，`_exit(11)`，monitor 再拉，無窮迴圈。ION/carveout 池被這個迴圈一口一口吃掉，越迴圈越搶不到。

`exit 11` 在程式碼裡對應得很清楚（`sprd_msg_np.c` 4673/4674 行）：

```c
} else { P("  alloc 崩潰\n"); which_lib(g_fault); _exit(11); }
if (!bhIn || !bhOut) { P(">>> buffer 配置失敗\n"); _exit(11); }
```

**恢復只需一步**：`pkill -f [n]ettv_player`（SIGTERM，讓行程走正常的退出路徑——退出前有 800ms 的 DMA 排空，異常退出才不回收 ION）。兩秒後行程清零，桌面立刻回來了。

## 二、插曲：一個「記憶體健康探針」

清完場順手探了一下編譯：

```sh
echo "int main(){return 0;}" > /tmp/t.c
gcc -O0 -o /tmp/t.out /tmp/t.c
```

凌晨這台設備的 gcc 還是壞的——`Error relocating /usr/lib/libisl.so.23: <亂碼符號>: symbol not found`，可檔案本身 md5 兩次一致、ELF 頭正常、readelf 能讀出真符號名。當時定的案：**不是檔案損壞，是記憶體被 VSP/ION 的 DMA 踩壞了頁面快取**。設備上午重啟後，同一條命令一次通過。

於是得到一個零成本探針，以後開工先跑它：

> **`gcc -O0` 編不過 + libisl 報亂碼符號 ⇒ 設備記憶體被 DMA 踩壞，該重啟，別硬修包。**

## 三、重跑基線，「必崩」結論塌了

清場、探針通過，那就把 UI 鏈路的真實場景復跑一遍——m3u8 直播流、不設任何調優 env、甚至故意帶上會觸發舊 bug 的毒環境變數，跑 40 秒：

```
[STAT] frames=125 elapsed=7219ms fps_x10=173
[dl] NAL 直方图: g_nau=297 | slice(1)=522 IDR(5)=18 SPS(7)=18 PPS(7)=18
```

**125 影格、17.3fps、18 個 IDR、0 次 SIGSEGV。**

這直接推翻了專案記憶裡掛了一個多月的定案——「1080p 直播流第一個 GOP 出 4 影格後，餵第二個 IDR 必 SIGSEGV（addr=0x747474）」。為了這條結論，先後試過 GOT patch、二分連投、UAF 補丁，全都白繞了。

真相是：那個 `0x747474`（ASCII 的 "ttt"，一看就像被 TS 碼流資料填進去的地址）從來不是 IDR 的問題，而是 **ION 池被 monitor 重啟迴圈洩漏吃乾之後，`alloc` 回傳壞指標的次生崩潰**。第一輪 init 時元件就要搶 2MB carveout，輸出 buffer 再要 3.2MB，池子總共才個位數 MB；worker 異常退出（`_exit(11)`／訊號打死）時 ION 不回收，於是每一輪重啟都從剩下的池子裡刮一層，刮到某一次 alloc 落到了髒記憶體上——恰好那次正在餵第二個 IDR。

**根因、次生、巧合，三者在時間線上排成了同一條直線，看起來就像因果。** 這是這次排查最貴的教訓。

順帶一提：凌晨想給播放器加「stdout 無緩衝」（崩潰前最後 4KB 日誌不再丟）兩次建置都失敗，當時也差點歸因成「程式碼問題」——實際是 gcc 已經被 DMA 踩壞，跟程式碼一毛錢關係沒有。**同一類「環境／連結」症狀，連續栽了兩次，可見這個反射弧有多難改。**

## 四、方法論沉澱

把這次的做法固化為三條，下次遇到「黑畫面／必崩」直接按這個走：

**1. 黑畫面三查（按順序，一步一結論）**
- `ps` 看桌面行程死沒死——死沒死決定是「救桌面」還是「救播放器」；
- 播放器日誌看是不是空轉迴圈——monitor 重啟計數是最刺眼的訊號；
- `dmesg` 看有沒有新的核心記錄——沒有，就老老實實在用戶態找，別往核心甩鍋。

**2. SIGTERM 才能回收 ION**

`pkill -f nettv_player` 而不是 `-9`。播放器退出路徑裡有 DMA 排空和 ION 釋放；被訊號硬殺等於把池子永久漏掉一塊，只能重啟設備。池子小（個位數 MB）的專案，**看門狗的每一輪重啟都是真金白銀的記憶體**——所以「無新影格就斬殺」這種看門狗策略在小記憶體池設備上要格外小心，段間隔（~10s）比斬殺閾值長的時候，看門狗殺的就是自己人。

**3. 「必崩」結論要過三關**

一條崩潰結論在寫進記憶之前，先問自己：

- 換過輸入嗎？（單 TS 直連 vs m3u8 直播，路徑不同）
- 換過資源狀態嗎？（ION 池滿 vs 被洩漏吃乾）
- 崩潰地址像什麼？（`0x747474` = "ttt" 這種像資料的地址，先懷疑 buffer 被踩，別先懷疑演算法）

三關有一關沒過的「必崩」，都只是「在當前這一堆前提下的必崩」。

## 五、下一步

- **空影格率 53%**：這次日誌裡 60 個真影格（`filled=3133440`）對 68 個空影格（`filled=0`）。解碼器在 EOS 之後還在被投餵空轉，與 `g_nout=1`（只搶到 1 路輸出，官方基線 5 路）的單佇列結構有關。砍掉空轉輪次約等於直接 +50% 有效吞吐量，比繼續摳 memcpy 划算。
- **UI 首輪失敗 vs 手動首輪成功的差異**：同樣條件，核心重啟後從 UI 點開就 exit 11，手動跑卻能出影格。懷疑桌面 `lvgl_demo` 先佔了一部分記憶體／ION，待復現確認。

---

> **版權聲明**：本文為原創技術筆記，作者保留所有權利。轉載請註明出處（whiteleibniz.github.io），禁止未授權商業用途。
> 文中涉及的設備、原始碼與結論來自個人嵌入式專案實戰記錄（展訊 SC9832A / Alpine Linux / LVGL），資料均為實測。
