---
title: nettv-20：點頻道黑畫面的第二張臉——bionic 不認 DT_RPATH，wrapper 一招救回 UI 鏈路
date: 2026-10-21 09:40:00
tags:
  - sprd
  - SC9832A
  - bionic
  - LD_LIBRARY_PATH
  - dlopen
  - 軟連結
categories:
  - [嵌入式, 網路電視硬解]
  - [Linux, 動態連結]
  - [除錯, 方法論]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-20-ui-execl-ld-library-path-wrapper/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-20-ui-execl-ld-library-path-wrapper-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-20-ui-execl-ld-library-path-wrapper-en/)

> 版權聲明：本文為筆者原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處連結和本聲明。

上午剛用「pkill 大法」把黑畫面的電視救回來，下午使用者又點了個頻道——**還是黑的**。後台行程明明活著。得，這台設備的黑畫面有兩張完全不同的臉。

這篇記錄第二張臉的抓捕過程：一個藏在動態連結器行為差異裡的真 bug。

## 一、現場：行程活著，日誌裡寫著「關鍵符號缺失」

抓行程樹和日誌，播放器 `nettv_player` 確實在跑，但 worker 子行程的日誌停在一行刺眼的話上：

```
=== 符号解析 ===
  create=0x0 onMsgRecv=0xb5340731 empty=0xb533f90d ...
>>> 关键符号缺失, 无法继续
```

`create` 是元件工廠函式 `createSprdOMXComponent` 的地址，`0x0` = 沒解析到。拿不到工廠函式就建不了解碼器元件，後面全免談。

第一反應是昨天（10-21 凌晨）剛修的那個坑：bionic 父行程 fork 出的 musl 子行程繼承 `LD_LIBRARY_PATH` 導致 curl exec 失敗。但這次症狀相反——**失敗的是父行程自己 dlopen**，而且日誌裡沒有任何 `Error relocating`。

## 二、A/B 一刀切出根因

同樣是 m3u8、同樣無調優 env，唯一變數是 `LD_LIBRARY_PATH`：

| 跑法 | LD_LIBRARY_PATH | 結果 |
|---|---|---|
| 手動 + 帶 env | `/system/lib:/mnt/android_sys/lib` | ✅ 89 影格，正常自退 |
| 手動 + 無 env | （空） | ❌ create=0x0，exit(1) |
| UI 點頻道 | （空） | ❌ create=0x0，exit(1) |

一刀下去，根因現形：**UI 的 `execl` 不給播放器傳 `LD_LIBRARY_PATH`**（`lv_pages/nettv_page.c:315`）。

```
pid = fork();
if (pid == 0) {
    setpgid(0, 0);
    execl(NT_PLAYER_BIN, "nettv_player", url, NULL);   /* 環境原樣繼承桌面, 沒有 LD_LIBRARY_PATH */
    _exit(127);
}
```

為什麼一個環境變數能讓 `dlopen` 一個**絕對路徑**失敗？順著線索查：

1. 程式碼裡是 `dlopen("/system/lib/libstagefright_sprd_h264dec.so", RTLD_GLOBAL)`——絕對路徑，穩；
2. 但 `/system/lib/libstagefright_sprd_h264dec.so` 是個 **51 位元組的符號連結**，實體在 `/mnt/android_sys/lib/`（桌面啟動時由 `gpu_env_ensure()` 把整個安卓 lib 目錄軟連結到 `/system/lib`，這是這個專案的 bionic 執行環境搭建方式）；
3. 符號連結本身沒問題，`ls /mnt/android_sys/lib` 304 個檔案齊全；
4. 但 **h264dec 依賴鏈裡（直接或間接）有只在 `/mnt/android_sys/lib` 才存在的函式庫**——bionic linker 解析這些 NEEDED 時按順序搜：`LD_LIBRARY_PATH` → `DT_RUNPATH` → 預設系統路徑。沒有 `LD_LIBRARY_PATH` 時，預設路徑裡翻不到安卓私有函式庫，dlopen 整個失敗，`create` 符號自然取不到。

也就是說：`/system/lib` 的軟連結只覆蓋了「直接 dlopen 的那幾個」，**依賴鏈是軟的**。

## 三、第一個修復嘗試：rpath，死得很難看

既然嫌 `LD_LIBRARY_PATH` 是執行時期變數，那編譯期焊死總行吧？給 `build.sh` 的連結參數加上：

```diff
-    -Wl,-rpath,/system/lib -Wl,--export-dynamic \
+    -Wl,-rpath,/system/lib:/mnt/android_sys/lib -Wl,--export-dynamic \
```

重新建置、部署、跑——**`create=0x0` 原樣重現**。

原因：**bionic 的動態連結器不實作 DT_RPATH 語意**。這是 bionic 和 glibc/musl 的一個經典差異——glibc 下這招早就修好了，在安卓的 linker 上，`DT_RPATH` 基本被無視，搜尋路徑只認 `LD_LIBRARY_PATH` 和系統配置（`ld.config.txt` 那套）。

> **教訓又攢了一條：跨 libc 搬經驗，先確認對方認不認這套語意。** 這個專案裸 bionic 程式踩的坑（`-nostdlib` 的 `_exit`、musl/bionic 混跑、現在是 DT_RPATH），幾乎全是「拿 musl/glibc 的常識往 bionic 上套」踩出來的。

## 四、真正的修復：一層 sh wrapper

UI 程式碼（`nettv_page.c`）在設備儲存庫裡，改它要重編 `lvgl_demo` 桌面 + 重啟桌面，動靜大。最快且零侵入的辦法：**把 `/usr/local/bin/nettv_player` 換成一個 wrapper**，真身挪到 `.real`：

```sh
#!/bin/sh
# /usr/local/bin/nettv_player
export LD_LIBRARY_PATH=/system/lib:/mnt/android_sys/lib
exec /usr/local/bin/nettv_player.real "$@"
```

UI 的 `execl("/usr/local/bin/nettv_player", ...)` 原封不動，wrapper 補上環境變數再 exec 真身，參數 `"$@"` 原樣透傳。和 10-21 凌晨那個 `musl_child_sanitize_env()`（播放器內部在 fork curl/mplayer 前摘掉 `LD_*`）也不衝突——一個在門口加，一個在裡屋摘，各管一段。

無 env 實跑驗證全綠：

```
create=0xb3ce99fc onMsgRecv=0xb3d3f731 ...     /* 符號解析通過 */
[http] reap status=0x0 (0=成功, 0x7f00=execl失败)  /* curl 子行程正常 */
*** monitor: 重启 (子进程 @89 帧)                /* 89 影格, 正常 */
```

**順手堵了個未來的坑**：`build.sh` 的部署邏輯是 `mv $OUT /usr/local/bin/nettv_player`——下次誰再跑建置，wrapper 就被二進位覆蓋沒了。已把部署目標改成 `nettv_player.real`，wrapper 不動。

## 五、方法論：這次排掉的三個「假根因」

記錄一下排查中被證據逐一排掉的猜測，這種「排除記錄」和「定位記錄」一樣值錢：

1. **「ION 池又被洩漏吃乾了」**——`/sys/kernel/debug/ion` 顯示 `total 0 / orphaned 0`，池子是乾淨的，且 `free` 有 744MB 閒置；
2. **「設備又在反覆休眠把記憶體搞壞了」**——`dmesg | grep -c "CPU1: shutdown"` 只有 1 次，且 `gcc -O0` 探針一次通過，記憶體健康；
3. **「worker 莫名暴斃」**——`monitor: 重启 (子进程 @89 帧)` 不是崩潰，是 worker 播滿 90 影格上限後的**設計內自退**，monitor 迴圈重啟也是設計行為。日誌尾部「戛然而止」只是最後一輪剛起來就被外層 `timeout` 截斷。

三個猜測都有當時的「證據」（黑畫面、空轉、dmesg 尾部熱插拔記錄），但都經不起針對性驗證。**黑畫面類問題的麻煩之處在於：現象全都長一個樣，根因卻各不相同**——所以每次都要重新取證，不能拿上次的結論套。

## 六、待辦

- **遼寧移動源本身也播不了**：使用者點的這個源（`zteottcdn.ln.chinamobile.com`）IDR 影格約 319KB，超過 VSP 輸入 port 的 256KB 上限，屬已知黑畫面源。修完環境也要換臺才能看到畫面——**驗證時請換四川／瀘縣類源**。
- 根治候選：`nettv_page.c` 的 child 裡 `setenv("LD_LIBRARY_PATH", ...)` 後再 `execl`（本地已備份 `outputs/nettv_page_ui.c`），列入下次 git 提交清單。

---

> **版權聲明**：本文為原創技術筆記，作者保留所有權利。轉載請註明出處（whiteleibniz.github.io），禁止未授權商業用途。
> 文中涉及的設備、原始碼與結論來自個人嵌入式專案實戰記錄（展訊 SC9832A / Alpine Linux / LVGL），資料均為實測。
