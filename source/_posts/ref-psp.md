---
title: "ref_PSP模拟器"
date: 2026-09-24 14:18:10
lang: zh-CN
search: true
categories:
- 多媒体与模拟器
- PSP
tag:
- PPSSPP
- 模拟器
---


# PSP 模拟器（2026-09-24 起）

> 顶层 MEMORY.md §12 只留结论；本文是明细。

## A. 方案与可行性

- **沿用 GBA 架构**：miniretro 前端直写 `/dev/fb0` + libretro core。core = **PPSSPP**（v1.18.x，`-DLIBRETRO=ON`）
- **★ 关键：这台机器没有 GL/Vulkan**，所以必须让 PPSSPP 走纯 CPU 软渲染。  
  前端在 `env_cb(RETRO_ENVIRONMENT_GET_VARIABLE)` 里主动应答 **`ppsspp_backend=none`**  
  → 落到 `LibretroSoftwareContext`（源码 `libretro/LibretroGraphicsContext.cpp` 的软渲染兜底分支）。  
  不主动给的话它会依次试 GLCore→GL→Vulkan 三次全失败；更糟的是 .so 一旦链接了 libGL，  
  **dlopen 阶段就过不去**，连兜底机会都没有
- 其余注入的 core option：`cpu_core=JIT`（ARM32 dynarec，无它慢一个量级）、  
  `internal_resolution=480x272`、`frameskip=1`、`auto_frameskip=disabled`、  
  `gpu_hardware_transform=disabled`、`memstick_inserted=enabled`（不给→部分游戏拒绝存档）、  
  `io_timing_method=Fast`、`cache_iso=disabled`（内存仅 916MB，别整张 ISO 缓存）
- `RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY` → `/home/PSPgame/saves`

## B. 源码获取与编译

- **本机** `git clone --depth 1 --recurse-submodules -j 8 https://github.com/hrydgard/ppsspp.git`  
  （Makefile 路线硬性依赖 ffmpeg 头文件 → 必须走 CMake）
- 裁剪打包：排除 `.git / ffmpeg / ext/vulkan / assets / android / Qt / SDL / Windows / UWP / ios /
  macOS / headless / unittest / Tools / pspautotests / source_assets / icons / dx9sdk / gradle` → 55MB
- `assets` 后来发现是**必需的整份**（flash0 + 字体 atlas + meta），单独补传
- CMake：`-DLIBRETRO=ON -DUSE_FFMPEG=OFF -DVULKAN=OFF -DOPENGL=OFF -DUSE_SYSTEM_ZLIB=ON
  -DUSE_SYSTEM_LIBPNG=ON -DMOBILE_DEVICE=ON -DCMAKE_BUILD_TYPE=Release`
- **★ 编译 flags 必须显式给**：`-march=armv7-a -mtune=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard`  
  （不加则 gcc 默认编 armv6 → **没有 ARM32 动态重编译，直接慢一个量级**）
- **★ 坑：`-DVULKAN=OFF` 并不会停掉 `ext/vma` 目标**，它仍要 `ext/vulkan/vulkan.h`；  
  而在国内/这台机器上精简打包时最容易把它整目录排掉 → 报错 `fatal error: ext/vulkan/vulkan.h`。  
  解法：只传**头文件**（排除 iOS 26MB / macOS 12MB / libvulkan.so 3.3MB 后仅 177KB）
- 编译放后台 `setsid nohup make -j4 > /tmp/ppsspp_build3.log`（增量，已编 .o 全部保留）

## C. 派生（禁止手写第二*份*）

`ssh_tools/make_psp_from_gba.py` 一次性产出 4 个文件，`ssh_tools/deploy_psp.py` 部署+重编，  
`ssh_tools/finish_psp.py` 收尾（校验依赖 → 安装 .so → 可选加载自测）。

- 从 `miniretro_gba.c` 派生 `miniretro_psp.c`，只改 5 处：  
  `PSP_SRC_W/H=480x272`、`SR_ROT_MAX 256²→512²`（272×480 旋转画布塞不进 256²，否则黑屏）、  
  `temp32` 容量、**白名单从"枚举机种尺寸"改成"上限判定"**（`width>PSP_SRC_W` 才拒）、  
  env_cb 加 GET_VARIABLE + GET_SAVE_DIRECTORY。其余（双缓冲翻页/退出策略 v3/音频自适应重采样）全继承
- 页面从 `gba_game_page.c` 派生：后缀 `.iso/.cso/.pbp/.elf`；**Makefile 用 `wildcard lv_pages/*.c`**，  
  新页面丢进去自动进编译
- **★ 替换次序雷**：复合标识符（`mgba_libretro.so`、`miniretro_gba`）必须**排在通用规则  
  `gba_->psp_` 之前**替换，否则 `mgba_libretro.so` 会被先写成 `mpsp_libretro.so`，  
  后面的精确替换再也匹配不上（页面查不到 core）
- **★ 中文字体雷**：派生源的 label 一律没设字体 → 中文 ROM 名全是豆腐块。  
  脚本已对所有 `lv_label_create` 补 `lv_obj_set_style_text_font(x, &lv_font_cn_16, 0)`
  - `LV_FONT_DECLARE`，并给 list 容器兜一层

## D. ROM

目录 `/home/lvgl_demo/lvgl_demo/sdcard/game/psp/`（已放 5 个）

| 文件                                                          | 大小      | 来源                                          | 用途                   |
| ----------------------------------------------------------- | ------- | ------------------------------------------- | -------------------- |
| `Tetris 俄罗斯方块.pbp`                                          | 16KB    | github.com/zPSP-Dev/tetris-psp release v1.0 | **首选**：真游戏、极轻，软渲染扛得住 |
| `Beatbox.pbp`                                               | 1.0MB   | github.com/Babkock/Beatbox 仓库内 EBOOT.PBP    | 鼓机：验多键输入 + 音频        |
| `Cube 旋转立方体.pbp` / `Controller 按键测试.pbp` / `HelloWorld.pbp` | 40~76KB | PPSSPP 自带 `pspautotests/demos/`             | 帧率/按键/基础渲染探针         |

**★ 下载可用性（国内实测）**：`dlhb.gamebrew.org` **403**、`archive.org` 与 `raw.githubusercontent.com`  
**HTTP 000 不可达**、GitHub API/搜索容易 403 限流。  
→ **唯一可靠的是 `github.com` 本体**：`git clone --depth 1` 或 `github.com/<repo>/releases/download/<tag>/<文件>`。  
GameBrew 网页只用来 WebFetch 提取直链。

## E. 键盘 / 输入

- 设备上 `/dev/input/event0/1/2` 只有板载 3 个；**USB 键盘插入后热插拔自动生效** ——  
  `input_poll_cb()` 每次轮询都调 `input_scan()` 重扫 `/dev/input/eventN`
- `extern/miniretro/keymap_psp.conf` 映射（从 GBA 同源派生）：  
  WASD/方向键 = 方向；`Z`/`J`/空格 = B(○)；`X`/`K`/左Ctrl = A(×)；`Q`/`E` = Y(□)/X(△)；  
  `1`/`2` = L/R；回车 = START；左Shift/退格 = SELECT；**ESC = 退出**  
  板载 4 物理键沿用（点餐114=左、服务102=右、福利115=A、买单116=退出）
- 未按预期映射的键会在 stderr 打 `未映射按键 code=xxx`，照提示补进 conf

## F. 编制窜绸

| 动作            | 命令要点                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| 查编译状态         | `tail -1 /tmp/ppsspp_build3.log`；`grep -c 'error:'`                                                   |
| 改并行度（保留已完成目标） | 对 `ps -o pid,comm \| awk '$2=="make"'` 的 PID 发 **SIGTERM**（**禁用 `pkill -f`**），等 cc1 退出后 `make -jN` 续跑 |
| 观察实际并行        | `ps -o pid,comm \| awk '$2=="cc1"\|\|$2=="cc1plus"' \| wc -l`                                         |

- 4 并发时内存 used 224~294MB / 916MB total，**未 OOM**
- 中断后可能有半成品 `.o`（时间戳比源新 → make 认为不用重编 → 链接才炸）。  
  **★ BusyBox `find` 无 `-newermt`**，用 `-mmin N` / `-newer FILE`
- **别去写 `/sys/devices/system/cpu/cpuN/online`**（见 MEMORY §10 hotplug 雷）；  
  实测编译负载下 `sprd_hotplug` 会自动把 4 核全拉起来（`online=0-3`）

## ★ core 编译：并发上限 -j2（OOM 实锤）
- `-j4` 在 50% 被 OOM kill（`glslang_tab.cpp` 单文件峰值），整条 make 静默 Error 2 停死
- 正确启动方式（只编需要的 target，非 `all`）：
  `cd /home/PSPgame/ppsspp_git/build && nohup setsid make -j2 ppsspp_libretro > /tmp/ppsspp_build4.log 2>&1 &`
- 判断存活必须 grep 日志里的 `Killed` / `make.*Error 2`，**只看进程会误判**

## ★ 裁剪源码的坑：android/jni 头必须保留（至少 2 个）
- `Common/File/AndroidStorage.cpp` 等 **无条件** `#include "android/jni/app-android.h"`，整删 `android/` 会在 52% 炸掉
- 修复：原样放回真 `app-android.h`（libretro 下 `PPSSPP_PLATFORM(ANDROID)` 为假，且 `<jni.h>` 还包在
  `!defined(__LIBRETRO__)` 里 → 不需要 NDK）+ 真 `AndroidAudio.h`；**`OpenSLContext.h` 依赖 `SLES/*.h`，留占位头**
- 通用教训：裁剪前先 `grep -rn '#include "<目录>'` 排查非条件 include；补文件优先"原样放回真文件"，别手搓占位

## ★★ 冒烟测试铁律：必须 setsid
`./miniretro_psp ... &` 挂在脚本 sh 下时，**busybox sh 会立刻给后台作业发 SIGTERM**（si_pid=ppid 实锤），
表现为"启动 100ms 就退出"，极易误判成 core 崩溃。正确：
`setsid ./miniretro_psp <绝对路径 core> <rom> keymap_psp.conf > /tmp/x.log 2>&1 &`
（另：musl 的 dlopen 对不含斜杠的名字**不搜当前目录** → core 必须传绝对路径）

## ★ PPSSPP core 跑起来的 4 个要件
1. 实现 `RETRO_ENVIRONMENT_GET_LOG_INTERFACE`(cmd 27) —— 否则 core 报错全不可见；放行级别限 WARN 以上
2. assets 放 `<system_dir>/PPSSPP/`（22MB），不是 system 根目录
3. system dir 不能为 NULL（前端原默认 NULL，已改 `/home/PSPgame/system`）
4. `ppsspp_backend=none` → `Using Software backend`，480x270@59.94fps，JIT 走 ARM32

遗留：退出末尾 `terminate called without an active exception`（发生在 fb 复位之后，与 dlclose 无关，暂留）
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
