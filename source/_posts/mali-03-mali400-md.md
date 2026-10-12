---
title: "Mali400_故障排查手册"
date: 2026-09-30 16:44:04
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# 展讯 SC9832A Mali-400 GPU 故障排查手册 —— spd-box

> **用途**：Mali/GPU 程序起不来、RENDERER 不对、回读黑屏、bionic 程序崩溃时，按本手册定位根因。每一行命令均取自设备实测。
> **使用方式**：先看 §1 分层速查总表定位到层 → 跳到对应章节 → 用「定位命令」确认 → 按「修复」处理。
> **配套**：原理 Wiki（§3 概念）、工作过程总结（阶段 B/E 决策）为精简版；本文是全量版。

---

## 0. 排障纪律（先读，违反会浪费时间）

1. **分层定位，不跨层瞎试**：①内核(mali.ko→/dev/mali0) → ②bionic 环境(linker/lib/软链) → ③编译(musl gcc 编 bionic) → ④应用(gpu_bench/gpu_test/PSP前端) → ⑤回读/显示(glReadPixels/TBDR)。哪层不过只查该层及其上游。
2. **先看现象再看进程**：RENDERER 不对先跑 `/root/mali_check`；崩溃先看 `dmesg | tail`。
3. **杀进程一律按 `/proc/<pid>/cmdline` 匹配**，禁止 `ps -o pid,comm|awk`（PPSSPP 主线程名是 `{Main}`，必漏）。
4. **bionic 程序输出用 `write(1,...)` 不用 `printf`**（abort 时缓冲区丢失看不到现场）。

---

## 1. 分层故障速查总表（一页定位）

| 现象（症状） | 大概率根因 | 定位命令 | 章节 |
|---|---|---|---|
| `GL_RENDERER` 不是 Mali-400 MP / EGL 初始化 0x3001 | mali.ko 未 insmod 或 egl 软链缺失 | `ls -la /dev/mali0; ls -l /system/lib/egl/` | §2 |
| `insmod mali.ko` 失败 | vermagic 不符 / 模块不在 | `modinfo /lib/modules/mali.ko \| head` | §2 |
| bionic 程序一运行就崩（before main） | 缺 `-Wl,--entry=main` | `readelf -l <bin> \| grep interpreter` | §3 |
| 链接报错 `__clock_gettime64 undefined` | musl 64 位 time_t 重定向 | `nm <bin> \| grep clock_gettime` | §3 |
| dlopen 内死循环烧 CPU | exe 导出表含 mmap/lseek 等 | `nm -D <bin> \| grep -E ' mmap\|lseek'` | §3 |
| 屏幕场景发黑、只有 HUD 可见 | pbuffer glReadPixels 不可靠(TBDR) | 看 gpu_bench dump 日志中心像素 | §5 |
| 回读全黑/陈旧红 | 未触发 TBDR 解析 | 跑 `_gldump.c` 最小测试 | §5 |
| 桌面"GPU测试"图标拉起旧程序 | gpu_test 未软链 gpu_bench | `ls -l /usr/local/bin/gpu_test` | §4 |

---

## 2. 内核 / 驱动层（① mali.ko → /dev/mali0）

### 2.1 RENDERER 不是 Mali-400 / EGL_NOT_INITIALIZED

- **定位**：`ls -la /dev/mali0`；`ls -l /system/lib/egl/` 应有 `libGLES_mali.so` 软链；`/root/mali_check` 看第 1~2 项。
- **修复**：
  ```sh
  insmod /lib/modules/mali.ko            # rc=0 才继续
  ls -la /dev/mali0                      # crw-rw---- 10, 22
  mkdir -p /system/bin /system/lib/egl
  cp /tmp/aand/system/bin/linker /system/bin/linker
  for f in /tmp/aand/system/lib/*.so /mnt/android_sys/lib/*.so; do ln -sf "$f" /system/lib/; done
  ln -sf /mnt/android_sys/lib/egl/libGLES_mali.so /system/lib/egl/
  ```
- **注意**：不要手动 `/system/bin/linker xxx`——argv[0] 是 linker 会打印 helper 提示退出；让内核读 INTERP 自动加载 linker（直接执行程序）。

---

## 3. 用户态 bionic 编译层（③ musl gcc 编 bionic）

### 3.1 程序一运行就崩（before main）

- **根因**：`-nostdlib` 时 ld 默认入口 = .text 首字节。
- **修复**：编译加 `-Wl,--entry=main`。

### 3.2 `__clock_gettime64` undefined

- **根因**：musl 32 位 time_t 是 64 位、bionic 是 32 位，clock_gettime 被重定名。
- **修复**：自实现 `{long tv_sec; long tv_usec;}` + `syscall(78, &t, 0)`（见 `bionic_shim.cpp`）。

### 3.3 dlopen 内死循环（烧 CPU）

- **根因**：exe 的 `--version-script` 导出 `mmap/lseek/ftruncate/fseeko/ftello`，抢占 bionic 内部同名调用 → 参数错位死循环。
- **修复**：这几个符号只放 core 自己链的 shim，**exe 导出表绝不能含它们**（`nm -D <bin>` 自查）。

### 3.4 其他 shim 必补符号

`__dso_handle` / `__errno_location` / `__tls_get_addr` / `__nanosleep_time64` / `getentropy` / `secure_getenv`（设备 `bionic_shim.cpp` 已验证）。

---

## 4. 应用层（④ gpu_bench / gpu_test / PSP 前端）

### 4.1 桌面图标拉起旧程序

- **定位**：`ls -l /usr/local/bin/gpu_test`（应软链到 gpu_bench）。
- **修复**：`ln -sf /usr/local/bin/gpu_bench /usr/local/bin/gpu_test`。

### 4.2 评分异常低 / 帧率显示但场景黑

- 见 §5（回读问题，不影响评分计时）。

---

## 5. 回读 / 显示层（⑤ glReadPixels / TBDR）—— 已知无解，先认清

### 5.1 屏幕 3D/2D 场景发黑、只 HUD 可见

- **根因**：Mali TBDR 惰性解析 + pbuffer 回读路径缺陷，`glReadPixels` 拿不到当前帧（clear/2D 四边形全黑或陈旧红，仅带深度大网格偶发正确）。
- **已试四种办法均无效**：FBO 离屏再回读 / 去 glFinish 直接读 / eglSwapBuffers / 全局开深度。
- **对策（当前）**：评分与帧率基于 `render+glFinish` 计时，不受回读影响，跑分仍可用；屏幕画面待改"直渲 fb 的 EGL window surface"根治（`_winsurf` 探针在 bionic linker 阶段崩溃待排）。
- 退出时 `fb_restore()` 无条件翻回第 0 页，桌面可恢复。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
