---
title: "netTV 硬解（41）：先把「從沒上過機」的腳本測掉——造臂腳本的末行假設與可執行級自檢"
date: 2026-11-10 02:40:00
tags:
  - Embedded
  - Spreadtrum SC9832A
  - VSP
  - Hardware Decode
  - Debugging
categories:
  - [Project Notes, netTV HW Decode]
  - [Embedded, Spreadtrum Platform]
  - [Engineering Practice, Debugging Methods]
copyright: "Original works by whiteleibniz, licensed under CC BY-NC-SA 4.0. Reproduce with attribution to whiteleibniz.github.io"
---

> 🌐 語言：[简体中文](https://whiteleibniz.github.io/2026/11/10/nettv-41-shell-arm-env-anchor/) · [繁體中文](https://whiteleibniz.github.io/2026/11/10/zh-tw/nettv-41-shell-arm-env-anchor-zh-tw/) · [English](https://whiteleibniz.github.io/2026/11/10/nettv-41-shell-arm-env-anchor-en/)

> 系列第 41 篇。裝置離線第 13 輪，線上實驗繼續排隊。前兩輪已經把我們自己的程式碼
> 從「第二個 IDR 必崩」裡摘了出去（邊界審計全過），取證工具也備好了。這一輪不猜崩潰，
> 改成先給兩個**從沒上過機**的腳本做體檢——結果真挖出一個會讓 50 分鐘線上視窗白跑的缺陷。

## 一、這次為什麼不繼續猜崩潰

上一輪（40）把「第二 IDR SIGSEGV」的線上取證做成兩個工具：一個 PC 端符號對映器、
一個裝置端兩臂編排腳本。它們都還沒上過機。而裝置已經連續 13 輪不在線，離線能做的
靜態分析基本做完了，再往下就是拿沒有資料支撐的臆測去改程式碼——這是會寫進黑歷史的做法。

於是換了個角度：**線上視窗是這專案最貴的資源**（22~50 分鐘，還要人守著），
先保證那兩個腳本不會在視窗裡掉鏈子。

判斷標準不是「語法過不過」，而是這專案已經被咬過兩次的那類問題：

- 一次是探測源時只認 HTTP 200，帶 `Range` 的探針真實回傳 206，於是把三個活源判死；
- 一次是採 `SigBlk` 遮罩時用字串長度做守衛，而真實值是 32 位十六進位串，
  於是取樣恆為 0，報告卻寫「沒有執行緒遮罩 SIGSEGV」。

兩次都**不是語法錯**，都會把「量測工具自己的 bug」偽裝成「被測系統一切正常」。
所以這輪的驗收標準是：能不能用真實格式的樣本，把腳本裡最容易靜默失效的那幾段跑出來。

## 二、挖到的真缺陷：造臂腳本假設「wrapper 末行就是 exec」

線上實驗要做 A/B，靠的是「造臂」：複製播放器的 wrapper，把本臂要的 `export NETTV_xxx=...`
塞進去。舊實作長這樣（兩個腳本同源）：

```sh
mkarm() {
  tag=$1; k=$2
  { sed '$d' "$WRAP"            # 去掉末行（以為是 exec）
    echo "export NETTV_IDRREPLAY=$k"
    tail -1 "$WRAP"             # 再接回來
  } > /tmp/w_$$tag.sh
}
```

它成立的前提是：**wrapper 的最後一行就是那條 `exec`**。問題是這個前提沒人守。
wrapper 只要多一個尾隨空行（編輯器存檔、`echo >>` 追加、手改留白都會發生），
`sed '$d'` 刪掉的是那個空行，`tail -1` 接回來的也還是那個空行，於是：

```
#!/bin/sh
export LD_LIBRARY_PATH=...
exec /usr/local/bin/nettv_player.real "$@"   ← exec 在這裡
export NETTV_RPOOL=0                          ← 插到了 exec 之後
export NETTV_RPOOL_IDLE=1                     ← 永遠不會執行
```

`exec` 一執行，後面的行就再也不會被 shell 讀到。結果：

- 四條臂**全部跑成現網基線設定**，實驗等於沒做；
- 判讀腳本看到四臂資料一致，會給出「這個設定不崩」的結論——錯的是解讀，不是腳本報錯；
- 原有的 `WRAP_LASTLINE_BAD` 自檢只看末行是否含 `NETTV_`，末行是空行，查不出來；
- 唯一能兜住的是「生效 env 硬校驗」，但它兜住的代價是一個 `INVALID`——
  **50 分鐘線上視窗換來一句「這輪作廢」**。

這類缺陷的危險點在於：它不是崩潰、不是報錯，而是「資料看起來特別乾淨」。

## 三、修法：按 `exec` 行定位，而不是按行號猜

把「末行」換成「第一條 `exec` 行」，用 `awk` 在它前面插入：

```sh
awk -v k="$k" '
  /^[[:space:]]*export[[:space:]]+NETTV_IDRREPLAY=/ { next }   # 先刪舊的同名 export
  ins==0 && /^[[:space:]]*exec[[:space:]]/ { print "export NETTV_IDRREPLAY=" k; ins=1 }
  { print }
' "$WRAP" > "$out"
```

三個附帶好處：對尾隨空行與尾隨註解免疫；刪掉 wrapper 裡已有的同名 `export`，
保證「恰好一條」成立，也順手讓腳本可重跑（冪等）；萬一 wrapper 結構變了、根本沒有
`exec` 行，退回舊行為並在檔頭寫 `ARMK_FALLBACK=1`，讓人一眼看見，而不是靜默產生壞檔。

## 四、怎麼證明修好了：可執行級 + 變異自檢

光自己 `sh -n` 通過沒有意義（舊版也通過）。這輪給兩個腳本加了 `NTLIB=1` 庫模式：
置位後 `source` 只定義函式、不啟動實驗、不碰日誌。測試腳本因此可以**直接載入真檔**，
斷言的是線上要跑的那份程式碼，而不是抄一份副本——函式改了，測試自動跟隨。

| 用例組 | 測什麼 | 關鍵斷言 |
|---|---|---|
| `mkarm` | 尾隨空行 / 已有同名 export / 無 exec 行 | 四條 export **緊鄰 exec 之上且順序正確** |
| `env_key_ok` | 相符 / 值不符 / 重複兩條 / 空檔 / 缺檔 | 只有「恰好一條且值相等」才算生效 |
| H2 判據 | 直接從腳本抽出那 3 行真程式碼，餵 8 個真實 `SigBlk` | 大小寫、全 0、空字串、過短字串都不能誤判 |

第一條斷言特別值得說：最初寫成「exec 之前存在這條 export 就算過」，結果它對
「插到 exec 之後」也是綠的——因為 wrapper 體內那行被就地改寫後本身就在 exec 之前。
把斷言收緊成「**緊鄰 exec 上一行**」才真正測到落位。測試寫鬆了，比沒有測試更糟：
它會給你一個「已驗證」的錯覺。

接著是這套測試自己的靈敏度：故意把被測程式碼改壞，看用例抓不抓得到。

```
--mutcheck
  OK 造臂錨點變異被抓出（退化為舊版末行插入 ⇒ W1 必失敗）
  OK 大寫 SigBlk 變異被抓出（缺 tr 歸一 ⇒ 大寫漏採）
  OK bis35c 造臂錨點變異被抓出
MUTCHECK=PASS
```

## 五、測試自己踩的兩個坑

**坑 1：測試驅動自己會假通過。** 第一版驅動用命令替換收集輸出、統計 `✗FAIL` 行數。
但相位函式如果一進門就 `return`（例如 `source` 失敗），一行 `✗FAIL` 都不會產生，
計數為 0，於是印出 `LIBTEST_RESULT=PASS`——和上一輪「`maskedhit` 恆 0」一模一樣的形狀。
修法是：每個相位必須輸出 `PHASE_RESULT` 且退出碼為 0，缺一個就記失敗。
**「沒有失敗樣本」不等於「通過」，除非你明確驗過「該產生樣本的路徑確實走了」。**

**坑 2：`dash` 的 `.` 會走 PATH。** `. "_ntseg2.sh"` 在 bash 裡按目前目錄找，
在 `dash`/`ash` 裡對無斜線檔名做 PATH 查找，直接 not found。寫成 `. "./$SRC"` 才一致。
平時都在 bash 裡寫腳本，這類差異只有真拿嚴格 POSIX shell 跑才會露出來。

## 六、順手確認的兩件事

- 兩個腳本在 `dash`（真 POSIX）下 `-n` 通過，各自的判決自檢仍是 8 組 / 7 組 + 選源 5 組全對；
- 那個崩潰位址 `0x747474`（ASCII `ttt`）在原始碼裡查過：沒有對應填充常數、也沒有字元型
  `memset`，所以**不是我們自己的填充模式**——嫌疑仍在廠商庫或輸入 buffer 頭，
  等裝置回來用線上取證拿 pc 偏移，別在這裡繼續猜。

## 七、狀態與下一步

- 現網仍是上一版二進位，本輪未編譯、未部署、未動裝置倉庫；
- 裝置回來後順序不變：先過一遍離線自檢 → 開跑閘門（路由 + 源可播）→ 每臂 GATE 全 1
  → 最後才看 VERDICT；`INVALID` 整輪重跑，禁止據它改程式碼；
- 如果產生的 wrapper 頭一行出現 `ARMK_FALLBACK`，說明裝置上 wrapper 結構變了，
  先 `cat` 出來看一眼再跑。

裝置第 13 輪離線，這一輪就是把「下次開機不要浪費」這件事做扎實。
