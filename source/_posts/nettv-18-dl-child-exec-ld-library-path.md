---
title: nettv-18：子进程的 exec 为什么会"莫名 127"——bionic 父进程 + musl 子进程的 LD_LIBRARY_PATH 陷阱
date: 2026-10-21 02:00:00
categories:
  - [嵌入式, 网络电视硬解]
  - [Linux, 动态链接]
  - [调试, 方法论]
tags:
  - sprd
  - SC9832A
  - bionic
  - musl
  - LD_LIBRARY_PATH
  - exec
  - 排障
---

## 背景：一句话交代

播放器连续两轮 A/B 都是 **零帧**，日志里刷屏：

```
Error relocating /system/lib/libc++.so: __strlen_chk: symbol not found
Error relocating /system/lib/libc++.so: __errno: symbol not found
Error relocating /system/lib/libz.so.1: __register_atfork: symbol not found
  [http] reap status=0x7f00 (0=成功, 0x7f00=execl失败)
```

我上一轮把它记成了"libc++ 链接坏 / 镜像版本不匹配"，准备去折腾系统库。**这是错的**，而且是个很典型的误判。

## 现象

`nettv_player` 用 `fork()` + `execl("/usr/bin/curl", ...)` 下载 HLS 的 TS 分片。子进程退出码 127（父进程只看到 `status=0x7f00`），TS 永远拿不到 ⇒ 解码器没有输入 ⇒ 零帧。

## 排查：先别急着下结论

关键在于**那些"找不到符号"是不是真的不存在**。我先在设备上确认：

```
$ grep __strlen_chk 的符号是否存在于 /mnt/android_sys/lib/libc.so
strings /mnt/android_sys/lib/libc.so | grep __strlen_chk    # 有，2 处
```

符号明明在。那"symbol not found"就不是"缺符号"，而是**"从错误的 libc 里找"**。

再看执行体：`/usr/bin/curl` 是 **Alpine musl** 程序，`readelf -d` 显示它 NEEDED 三个库：

```
libcurl.so.4  libz.so.1  libc.musl-armhf.so.1
```

而我们的 `nettv_player` 是 **bionic** 程序，运行环境里带着：

```
export LD_LIBRARY_PATH=/system/lib:/mnt/android_sys/lib    # 加载安卓厂商库必需
```

`fork()` 会继承整个 `environ`，`execl()` 不清理 ⇒ **musl 的动态链接器照着 `LD_LIBRARY_PATH` 去 `/system/lib` 找 `libz.so.1`，抓到的是 bionic 的 libz**。bionic 的 libz 又 NEEDED `libc++.so`，于是 musl 继续去加载 bionic 的 `libc++.so`——它要的 `__strlen_chk` / `__errno` / `__memchr_chk` 在 **musl libc** 里当然没有，链接器直接 `exit(127)`。

一句话复现 / 一句话反证：

```
$ LD_LIBRARY_PATH=/system/lib curl -s -o /dev/null -w '%{http_code}' http://baidu.com
Error relocating /system/lib/libz.so.1: __register_atfork: symbol not found
...（一屏）
$ curl -s -o /dev/null -w '%{http_code}' http://baidu.com
301
```

## 修法：只摘子进程的环境变量

在 `fork()` 出来的子进程里、exec 之前，把 `LD_*` 从 `environ` 摘掉（COW，不影响父进程）：

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

在两处 `fork` 子进程的 exec 前调用（curl 下载、mplayer 音频，都是 musl 程序）。父进程自己的 `LD_LIBRARY_PATH` 保持不变——bionic 侧还要靠它 dlopen 展讯的 VSP 厂商库。

验证：同样带着 `LD_LIBRARY_PATH=/system/lib` 跑一轮，`Error relocating` **0 次**、`reap status=0x7f00` **0 次**，解码器正常吃到 TS 并推进到喂 IDR。

## 三条方法论（比这个 bug 本身值钱）

1. **"symbol not found" 要先区分"没有"还是"找错了地方"**。查一下符号在不在目标库里，就能立刻把"镜像坏了"这种大结论否掉。
2. **错误现象发生在子进程，不要只看父进程的日志**。`0x7f00` 是父进程转述的，真相在子进程 stderr 的第一行。
3. ★ **A/B 两组同时零帧 = 环境问题，不是被测项无效**。我一开始差点把它读成"ION cached 无效"，实际上是**基线组也出不了帧**，对比根本不成立。**先证明基线能出帧，再谈对比。**

## 顺带：跨 libc 的进程树要特别小心

这台设备是一个很罕见的混合环境：Alpine/musl 的用户态 + 安卓 bionic 的厂商库。只要进程树里同时存在两种 libc 的程序，任何"给链接器看的环境变量"（`LD_LIBRARY_PATH` / `LD_PRELOAD`）都会变成**单向污染**：bionic 需要的变量，对 musl 子进程是毒药。

> 本文为原创，转载请注明出处。
