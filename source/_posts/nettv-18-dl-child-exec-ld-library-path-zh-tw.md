---
title: nettv-18：子行程的 exec 為什麼會「莫名 127」——bionic 父行程 + musl 子行程的 LD_LIBRARY_PATH 陷阱
date: 2026-10-21 02:00:00
tags:
  - sprd
  - SC9832A
  - bionic
  - musl
  - LD_LIBRARY_PATH
  - exec
  - 排障
categories:
  - [嵌入式, 網路電視硬解]
  - [Linux, 動態連結]
  - [除錯, 方法論]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/21/nettv-18-dl-child-exec-ld-library-path/) · [繁體中文](https://whiteleibniz.github.io/2026/10/21/nettv-18-dl-child-exec-ld-library-path-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/21/nettv-18-dl-child-exec-ld-library-path-en/)

> 版權聲明：本文為筆者原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處連結和本聲明。

## 背景：一句話交代

播放器連續兩輪 A/B 都是**零影格**，日誌裡刷屏：

```
Error relocating /system/lib/libc++.so: __strlen_chk: symbol not found
Error relocating /system/lib/libc++.so: __errno: symbol not found
Error relocating /system/lib/libz.so.1: __register_atfork: symbol not found
  [http] reap status=0x7f00 (0=成功, 0x7f00=execl失败)
```

我上一輪把它記成了「libc++ 連結壞／映像檔版本不符」，準備去折騰系統函式庫。**這是錯的**，而且是個很典型的誤判。

## 現象

`nettv_player` 用 `fork()` + `execl("/usr/bin/curl", ...)` 下載 HLS 的 TS 分片。子行程結束碼 127（父行程只看到 `status=0x7f00`），TS 永遠拿不到 ⇒ 解碼器沒有輸入 ⇒ 零影格。

## 排查：先別急著下結論

關鍵在於**那些「找不到符號」是不是真的不存在**。我先在設備上確認：

```
$ grep __strlen_chk 的符號是否存在於 /mnt/android_sys/lib/libc.so
strings /mnt/android_sys/lib/libc.so | grep __strlen_chk    # 有，2 處
```

符號明明就在。那「symbol not found」就不是「缺符號」，而是**「從錯誤的 libc 裡找」**。

再看執行體：`/usr/bin/curl` 是 **Alpine musl** 程式，`readelf -d` 顯示它 NEEDED 三個函式庫：

```
libcurl.so.4  libz.so.1  libc.musl-armhf.so.1
```

而我們的 `nettv_player` 是 **bionic** 程式，執行環境裡帶著：

```
export LD_LIBRARY_PATH=/system/lib:/mnt/android_sys/lib    # 載入安卓廠商函式庫必需
```

`fork()` 會繼承整個 `environ`，`execl()` 不清理 ⇒ **musl 的動態連結器照著 `LD_LIBRARY_PATH` 去 `/system/lib` 找 `libz.so.1`，抓到的是 bionic 的 libz**。bionic 的 libz 又 NEEDED `libc++.so`，於是 musl 繼續去載入 bionic 的 `libc++.so`——它要的 `__strlen_chk` / `__errno` / `__memchr_chk` 在 **musl libc** 裡當然沒有，連結器直接 `exit(127)`。

一句話重現／一句話反證：

```
$ LD_LIBRARY_PATH=/system/lib curl -s -o /dev/null -w '%{http_code}' http://baidu.com
Error relocating /system/lib/libz.so.1: __register_atfork: symbol not found
...（一螢幕）
$ curl -s -o /dev/null -w '%{http_code}' http://baidu.com
301
```

## 修法：只摘子行程的環境變數

在 `fork()` 出來的孩子行程裡、exec 之前，把 `LD_*` 從 `environ` 摘掉（COW，不影響父行程）：

```c
static void musl_child_sanitize_env(void) {
    extern char **environ;
    if (!environ) return;
    int o = 0;
    for (int i = 0; environ[i]; i++) {
        const char *e = environ[i];
        if (e[0] == 'L' && e[1] == 'D' && e[2] == '_') continue;  /* LD_LIBRARY_PATH / LD_PRELOAD ... */
        environ[o++] = environ[i];
    }
    environ[o] = (char *)0;
}
```

在兩處 `fork` 子行程的 exec 前呼叫（curl 下載、mplayer 音訊，都是 musl 程式）。父行程自己的 `LD_LIBRARY_PATH` 保持不變——bionic 側還要靠它 dlopen 展訊的 VSP 廠商函式庫。

驗證：同樣帶著 `LD_LIBRARY_PATH=/system/lib` 跑一輪，`Error relocating` **0 次**、`reap status=0x7f00` **0 次**，解碼器正常吃到 TS 並推進到餵 IDR。

## 三條方法論（比這個 bug 本身值錢）

1. **「symbol not found」要先區分「沒有」還是「找錯地方」**。查一下符號在不在目標函式庫裡，就能立刻把「映像檔壞了」這種大結論否掉。
2. **錯誤現象發生在子行程，不要只看父行程的日誌**。`0x7f00` 是父行程轉述的，真相在子行程 stderr 的第一行。
3. ★ **A/B 兩組同時零影格 = 環境問題，不是被測項無效**。我一開始差點把它讀成「ION cached 無效」，實際上是**基線組也出不了影格**，對比根本不成立。**先證明基線能出影格，再談對比。**

## 順帶：跨 libc 的行程樹要特別小心

這台設備是一個很罕見的混合環境：Alpine/musl 的用戶態 + 安卓 bionic 的廠商函式庫。只要行程樹裡同時存在兩種 libc 的程式，任何「給連結器看的環境變數」（`LD_LIBRARY_PATH` / `LD_PRELOAD`）都會變成**單向污染**：bionic 需要的變數，對 musl 子行程是毒藥。

> 本文為原創，轉載請註明出處。
