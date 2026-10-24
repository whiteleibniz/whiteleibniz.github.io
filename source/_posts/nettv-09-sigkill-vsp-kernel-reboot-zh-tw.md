---
title: netTV 硬解攻堅(九)：一次 SIGKILL 把裝置打成重啟——VSP 解碼中斷的代價與兩個連帶坑
date: 2026-10-19 02:00:00
categories:
  - [嵌入式, 展訊平台]
  - [嵌入式, 影音]
  - [除錯技術, 核心與驅動程式]
tags: [VSP, 硬解, DMA, SIGKILL, 核心崩潰, OpenRC, stdio緩衝, 展訊, nettv]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot/) · [繁體中文](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot-en/)

> 版權聲明：本文為筆者原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處連結和本聲明。

前幾篇一直在跟「第二個 IDR 必卡死」死磕，日誌斷層、證據反覆丟失。這次本來只想加一個診斷開關跑 60 秒，結果**把裝置連著打成兩次重啟**。復盤下來，事故本身就是最有價值的結論：**解碼中用 `kill -9` 打斷 nettv_player，等於讓核心去收拾 VSP 沒排空的 DMA，直接崩**。順帶還清掉了兩個長期誤判。

## 一、事故現場

實驗腳本按老習慣寫的：起播放器，`( sleep 75; pkill -9 ... ) &` 兜底，`timeout -s KILL 90` 硬收尾。跑完一查：

```
$ uptime
 02:28:42 up 1 min,  0 users        ← 裝置重啟過
$ wc -c /tmp/v11.log
4096                                 ← 日誌只有 4KB，且大半是 NUL
```

不是 sshd 工作階段耗盡，也不是「卡死」——**裝置真的重啟了**。 ping 一直通（協定堆疊中斷驅動），SSH 不通（行程排程不起來），和 10-18 晚那次「ping 通但 sshd 無回應」是同一件事，當時判錯了方向。

## 二、根因：VSP 的 DMA 必須讓它自己排空

播放器的退出路徑裡一直有一句 `usleep(800000)`，註解寫著「排空 DMA，防核心崩」。這是 10-09 就踩過的坑：VSP 硬體還在往 ion 連續記憶體裡寫影格的時候，如果行程被外力掐掉，驅動程式側沒有機會收回這次 DMA，接下來就是核心崩。

關鍵在於：**`SIGKILL` 不會走任何使用者態退出路徑**。`_exit()` 也不會。所以

- `pkill -9 -f nettv_player` ✗
- `timeout -s KILL 90 ...` ✗
- SIGKILL 之後那 800ms 排空程式碼一行都不會執行 ✓（崩給你看）

正確的停法只有兩種：

1. **讓它自己退出**：播放器第二個參數是「總影格數上限」（`g_arg2`，0 = 無限），達到就走正常退出流程：
   ```sh
   /usr/local/bin/nettv_player <m3u8-url> 400 > /tmp/v12.log 2>&1
   ```
2. **只發 SIGTERM**：播放器裝了 SIGTERM 處理，會先停餵、排空 DMA 再退。SIGKILL 留作 3 秒後的兜底，但**正常情況下不該觸發**。

改完之後腳本長這樣（`outputs/r26.sh`）：全程沒有 `-9`，靠影格數上限自退。

## 三、連帶坑一：日誌是 4KB 全緩衝，「行緩衝」的註解騙了自己

排查過程中最迷惑人的一點：行程明明跑了 75 秒，日誌檔案永遠停在 4096 位元組，`grep` 什麼都搜不到。

原因很樸素：**stdout 重導向到檔案後是 4KB 全緩衝**，程式碼註解裡寫的「已開行緩衝（`setvbuf _IOLBF`）」在這條路徑上沒生效。行程被 SIGKILL → 緩衝區永遠不 flush → 你看到的日誌是若干個 4KB 塊，最後一截全丟。

所以：

- 實驗日誌**必須等行程自己正常退出**再看，別指望被殺的行程把尾部吐出來；
- 判定「程式是不是卡住了」，不能只看日誌大小（4KB 一跳），要看 `pgrep` 和 `/proc/<pid>/stat`。

## 四、連帶坑二：OpenRC 服務沒有 `start()` 會被靜默跳過

實驗一開始報了個很唬人的錯：

```
CANNOT LINK EXECUTABLE: library "libc.so" not found
```

查下去發現 `/system/lib/*.so` 全是懸空符號連結——它們指向 `/mnt/android_sys/lib/`，而 **android_sys 分割區根本沒掛載**。

固化腳本 `/etc/init.d/00_android_sys` 是存在的，`rc-update show` 也顯示在 default runlevel 裡，但開機就是不執行。原因：OpenRC 的 runscript **必須定義 `start()`**（或者用 `command=` / `start_stop_daemon`），裸的一段 shell 會被靜默跳過。改成標準 runscript 後立刻好了：

```sh
#!/sbin/openrc-run
depend() { need localmount; }
start() {
    mount | grep -q android_sys || mount -t ext4 -o ro /dev/mmcblk0p17 /mnt/android_sys
    printf 'nameserver 8.8.8.8\nnameserver 114.114.114.114\n' > /etc/resolv.conf
    ip route | grep -q default || route add default gw <RNDIS-GW>
}
```

`rc-service 00_android_sys start` → `mnt=304`，問題解決。以後看到 `library "libc.so" not found`，先查 `ls /mnt/android_sys/lib | wc -l`，別去動編譯參數。

## 五、本次真想做的實驗：給「第二個 IDR 卡死」做二分

事故歸事故，診斷開關已經加進原始碼了（`outputs/sprd_msg_np_v2.c`，環境變數 `NETTV_IDRREPLAY`，預設 0 關閉）：

**思路**：現在的現象是每代 worker 都活到 AU[36]（GOP#2 的 IDR）然後 DRIVE 卡死 5~10 秒。這有兩種可能——

- **A. 元件狀態說**：串流態下 *任何* IDR 都會卡，跟餵了多少輪無關 → 修法是 GOP 邊界做解碼器軟重置（flush + 重建緩衝區），不用重啟行程；
- **B. 累積漂移說**：前 35 輪消耗掉了某種資源（ion/CMA、偏移、參照計數），IDR 只是恰好撞在爆點上 → 修法完全不同，得去查 36 輪裡的洩漏。

**做法**：擷取第一個 IDR 之後，**緊接著連投 K 次同一份 IDR**（零累積、元件狀態與 AU[36] 時一致）。如果重投第 1 次就卡死，A 成立；如果連投 3 次全過、仍然要等到 36 輪才卡，B 成立。

判準就兩條：

```
grep -n "\[diag\]" /tmp/v12.log      # 擷取/重投的 IDR 行
grep -n "超时逃生\|alarm 超时" ...    # 緊跟其後有沒有掛
```

二進位檔已經編好部署（`nettv_player` 118788 位元組，舊版備份在 `.bak_1019`），但**實跑資料這次沒拿到**——就是被上面兩次重啟攔下來的。

## 六、下一次開工的三條紀律

1. 起實驗前先 `pgrep` 確認沒有別的播放行程；**收尾只用 SIGTERM 或影格數上限**，任何 `-9` 都等於讓裝置重啟。
2. 每次跑完先看 `uptime`，重啟過的資料一律作廢（日誌不全、現場沒了）。
3. 手動跑播放器前先停桌面（lvgl_demo 占著 fb，雙寫衝突），否則現象會被污染。

把這條放最後是因為它最貴：一次重啟，前面半小時的取證全清零。
