---
title: "handoff_doubao_2026-10-10"
date: 2026-10-10 17:10:35
lang: zh-CN
search: true
categories:
- AI工作流
- 方法论与资产
tag:
- AI协作
- 交接
---


# 交接文档 — SC9832A 设备 PSP 硬渲恢复（2026-10-10）

> 交接对象：豆包。读完本文档即可继续干活。设备=展讯 SC9832A armv7l，Alpine chroot，720x1280 竖屏 fb，LVGL 9.6 桌面 + 模拟器/网络电视。

## 1. 连接与工具（必读）

- 设备经 PC ICS NAT 上网：USB RNDIS(192.168.137.x) → PC → WiFi。环境变量 `DEV_IP`（当前 192.168.137.100）。
- **SSH 一律走工程里的 `ssh_tools/dev.py`**（paramiko）：`DEV_IP=192.168.137.100 python dev.py "<cmd>"`；跑本地脚本 `python dev.py --run <script> [timeout]`；传文件 `MSYS_NO_PATHCONV=1 python devput.py <local> <remote>`（**必须带 MSYS_NO_PATHCONV=1**，否则 Git Bash 吃掉远端路径）。裸 `ssh` 会被拒（非密钥登录）。
- ★ 本机 sandbox 会 SIGTERM 跑久的命令 → **SSH 命令一律 <20s 完成**；长任务用 `--run` 后台跑。被杀的 SSH 会话泄漏会耗尽 dropbear（症状：TCP22 通但 banner 立即断，只能设备断电重启）。
- ★ 设备 SFTP 损坏 → 不要用 dev.py --get 拉大文件；文本/小文件用 devput（inline base64）。
- 设备有 python3.12、GNU ld 2.43.1（无 gold/lld）、gcc14（apk 升级过，新工具链产物老 bionic linker 不认，见 §3）。
- 截图：`ssh_tools/grab_screen.py <out.png>`（读 /dev/fb0）。
- 抓屏黑≠没画面：先 `python3` pread /dev/fb0 各页统计非零像素再下结论。

## 2. 今日主线成果：PSP 硬渲恢复，实测 33fps

背景：PSP = `extern/miniretro/miniretro_psp_hw`（前端）+ ppsspp_libretro core。此前软渲只有 20fps（cpu2/3 拉不起来，只有 2xA7）。今天把硬渲（Mali-400）修通，抓屏实证 FPS:33。

### 三层根因（按排查顺序）

1. **reloc type 17 = R_ARM_TLS_DTPMOD32**：新 binutils 2.43 链接老 .o 时不再做 TLS GD→LE 静态收敛 → 老 bionic linker dlopen 直接拒。已尝试源头消灭 TLS（call_once→atomic、sol.hpp 去 thread_local、非 TLS `__cxa_get_globals` shim `/root/eh_shim.cpp`——**shim 必须放在 libstdc++.a 之前链接**），动态 TLS reloc 清零，但新 core 仍 dlopen 崩在构造函数（二分定位 init_array[0] = libstdc++ globals_io.cc 的 std::ios_base::Init；老 core 同一个 ctor 却能跑，新工具链 ctor 链问题未解）。**结论：放弃新 core，回退老 core**（git HEAD 0af7630 时代那份 = 当年 34-38fps 的原件，dlopen 实证 OK）。现部署的 `extern/miniretro/ppsspp_libretro_hw.so` 就是老 core；新 core 产物在 `/home/PSPgame/ppsspp_git/build_bionic/lib/ppsspp_libretro.so`（备份 .bak_ctor0），TLS 补丁源码已落盘留档。
2. **黑屏真因（最大反转）**：这颗 Mali DDK **FBO(glReadPixels from FBO) 读回全空**（glClear 特殊通路也坏），只有**默认帧缓冲（pbuffer）真实 draw 后读回正常**。此前前端改成了"自建 FBO → 渲到 FBO → 读回"路径 = 黑屏主因。已恢复 0af7630 已验证路径：`hw_get_current_framebuffer()` 返回 0、`hw_present()` 直接 glReadPixels 默认面、EGL_SURFACE_TYPE 只留 EGL_PBUFFER_BIT、删掉 fbo_setup/prog_make/窗口面实验（egl_setup 对齐历史版）。
3. **PPSSPP useEmuThread**：GL 后端激活时 PPSSPP 会在自己线程跑 GL，上下文 current 在前端线程 → 全部 GL 调用无效。core 源码 `libretro/libretro.cpp` ~1492 行已补 `useEmuThread = false;`（备份 .bak_emuthread）。老 core 是补丁前编译的？——注意：**老 core 能跑说明当年那份已含等价逻辑或前端线程模型兼容，实测 33fps 为准，勿再动**。

### 前端改动文件（设备端，未提交 git）

- `extern/miniretro/miniretro_psp_hw.c`：恢复 fb0 直读路径 + egl_setup 精简。备份链：`.bak_fb0`（FBO 路径改前）、`.bak_egl2`/`.bak_egl3`（egl 精简前后）。
- 编译：`cd extern/miniretro && sh build_hw.sh`（bionic 配方：-nostdlib + /root/bionic_shim.o + -L/system/lib -lEGL -lGLESv2）。
- 源文件以 LF 为主、混少量 CRLF → **改代码用 python 字节级锚点替换，别按行号**（会炸）。
- 调试环境变量：`MINIRETRO_SHOW_FPS=1`（屏上 fps overlay）、`MINIRETRO_DUMP=1`（第 N 帧落盘 /tmp/fbo.raw 与 /tmp/fb_dst.raw）。

### 启动命令（测试用）

```
cd /home/lvgl_demo/lvgl_demo/extern/miniretro
MINIRETRO_SHOW_FPS=1 timeout -k 3 30 ./miniretro_psp_hw ./ppsspp_libretro_hw.so /home/lvgl_demo/lvgl_demo/sdcard/game/psp/9100053.iso
```
游戏目录 `/home/lvgl_demo/lvgl_demo/sdcard/game/psp/`（9100053.iso、Cube 旋转立方体.pbp 等）。

## 3. ★★ 重启后必做清单（不做全是坑）

1. **默认路由**：设备跑 `route add default gw 192.168.137.1`（否则上不了外网）。
2. **PC 侧 ICS 重绑**：RNDIS 重新枚举后 PC 跑 `outputs/_ics_rebind.ps1`。判据：GW_OK+EXT_FAIL=ICS 掉了。
3. **mount p17**：`mount -r /dev/mmcblk0p17 /mnt/android_sys`（重启后 gpu_env_ensure 的 stamp 兜底**不生效**；不挂 → /system/lib/libEGL.so 断链 → EGL 失败静默退软渲 20fps）。
4. **insmod mali**：`insmod /lib/modules/mali.ko`（硬件加速默认关、app 不拉驱动；不加载同样静默退软渲）。
5. 判别硬渲/软渲：屏上 FPS overlay 硬渲 ~33、软渲 ~20+frameskip；日志里 `video_cb pitch=0` = 硬渲、pitch=1920 = 软渲。

## 4. 本日新踩的坑（高复用价值）

- **fb mmap 断连**：fb 驱动被多次 FBIOPAN/FBIOPUT 实验折腾后，**新进程 mmap /dev/fb0 的写入到不了真实显存**（pread 全 0、memset 也无效）。**重启恢复**。诊断法：python `os.pwrite/pread` 走文件路径验证读写一致性，再对比进程自己 mmap 的 dump。
- FBIOPAN 用**真 fb_var_screeninfo**（yoffset 在 struct 偏移 20、yres@4、yres_virtual@12）；假短结构体会内核崩（老坑重申）。
- bionic 裸探针三件套：`_start`（`exit(main())`）+ /root/bionic_shim.o + 正确 sigaction（**bionic sigset_t 只有 16 字节**，按 glibc 128B 排会截胡）。参考 /tmp/dlprobeA.c。
- bionic 裸 main 没有 libc_init → dlopen libEGL 可以，但链接器后续初始化可能 fault 0x30——探针结论要在"先 dlopen libGLESv2 再 dlopen core"的环境下验证（/tmp/dlprobe9.c 模式）。
- `pidof` 会匹配僵尸进程（busybox 看 comm）；服务健康判断一律用功能真值（socket/文件/数据），老坑 10-10 已大修过一轮。
- 前端进程会被 `timeout` 的 TERM 吞掉不退 → 一律 `timeout -k 2 <N>`。
- pgrep/stale 进程记得先清场（`kill -9` 遗留 miniretro）再测，否则抓屏抓到旧帧。

## 5. 设备其他现状（10-10 已定案部分，勿重复踩）

- WiFi/蓝牙开关式上电已提交推送（`eb755bd`）。marlinba 必须真实目录（软链=RF fail 发不出帧）。修 wifi=`outputs/_fixwifi.sh`。
- Mali 去脚本化已实现未提交：01_mali.start 已删，bionic 环境 = `lv_hardware/gpu_env.c gpu_env_ensure()` + deploy.sh 第 7 节；mali.ko = 设置页「硬件加速」开关（默认关）。**PSP 前端测硬渲时要手动 insmod（见 §3.4）**。
- PSP 硬渲黑屏旧结论（_winsurf 直渲待做）作废一半：pbuffer 读回这条路今天已实测可用，窗口面（fbdev_window 喂 eglCreateWindowSurface）仍段错误（DDK 是 ANativeWindow 变体）。
- 触摸：本机无触摸（内核无驱动、i2c 没绑定），只有 3 个按键。
- git：唯一仓库在设备 /home/lvgl_demo/lvgl_demo（gitee javaren/wxb_lvgl，master），推送走 push_via_bundle.py + GITEE_TOKEN。提交须「文件清单+中文说明」征得用户同意。

## 6. 待办（按优先级）

1. **Cube 旋转立方体.pbp 黑屏 20fps**：日志显示 pitch=0（硬渲在跑）但读回黑 + fps 掉到 20。怀疑该 demo 的渲染目标/深度用法踩了 DDK 的 FBO 黑洞。可先试 `MINIRETRO_DUMP=1` 看它读回的是 FBO 还是默认面。
2. **前端偶发静默退出（RC=0，~10-30s 不定）**：今天多次出现，无 tombstone、非崩溃。怀疑方向：retro_run 主循环某条件 break / EGL surface 丢失回调。加日志抓退出路径。
3. **git 提交**：确认稳定后提交 miniretro_psp_hw.c（fb0 路径恢复）+ 源码 TLS 补丁留档说明。提交前列文件清单征用户同意。
4. deploy 包一致性：确认 deploy/ 里 miniretro_psp_hw.c 是否要同步更新。
5. （远期）新 core 的 ctor 崩溃若想再攻：对比新老 .so 的 .init_array 项对应 TU、逐个 -fno- 剪；性价比不高。

## 7. 关键路径速查

| 项 | 路径 |
|---|---|
| 前端源码/编译 | 设备 /home/lvgl_demo/lvgl_demo/extern/miniretro/（build_hw.sh） |
| PPSSPP 源码/构建树 | /home/PSPgame/ppsspp_git（build_bionic/，增量） |
| 老 core 原件 | git HEAD 的 extern/miniretro/ppsspp_libretro_hw.so |
| 当前部署 core 备份 | extern/miniretro/ppsspp_libretro_hw.so.bak_tls |
| bionic shim | /root/bionic_shim.cpp/.o、/root/eh_shim.cpp（非 TLS __cxa_get_globals） |
| dlopen 探针 | /tmp/dlprobe{2..A}.c（dlprobe9=先载 GLES 的正确姿势） |
| 修 wifi 脚本 | 本地 outputs/_fixwifi.sh；ICS 重绑 outputs/_ics_rebind.ps1 |
| 今日完整日志 | 本地 .workbuddy/memory/2026-10-10.md |
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
