---
title: "Mali400_新应用接入操作手册"
date: 2026-09-30 17:52:17
lang: zh-CN
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# 展讯 SC9832A Mali-400 —— 新应用接入操作手册

> 适用范围：要让一个**新 App** 用上 Mali-400 GPU。
> 前提：Alpine/musl 根系统 + `mali.ko` 已加载 + `/system` 骨架就绪（由 `/etc/local.d/01_mali.start` 自动准备）。
> 校验时间：2026-09-30，实跑 `/root/mali_check` 全绿。

---

## 0. 一句话流程

**新 App 用 GPU = 编成 bionic 程序 → EGL pbuffer 拿上下文 → GLES2 画 → 按需要出图/回读 →（可选）加桌面图标。**

唯一要习惯的别扭点：必须用 **musl gcc 编出一个跑 bionic 动态链接器的 ELF**（详见 §2），因为 EGL/GLES 库是安卓的。

---

## 1. 前置检查（先看 GPU 是否就绪）

```bash
lsmod | grep mali                 # 应有 mali 模块
ls -l /dev/mali0                  # 设备节点要存在
ls -l /system/lib/libEGL.so /system/lib/libGLESv2.so /system/bin/linker
timeout -s TERM -k 2 10 /root/mali_check     # ★ 一键验收工具，全绿才算就绪
```

**必须看到（本机实测）**：

```
/dev/mali0 : 可打开 ✔  |  mali 内核模块 : 已加载 ✔
EGL_VENDOR : Android  | EGL_VERSION : 1.4 Android META-EGL
1280x720 pbuffer + ES2 context : 就绪 ✔
```

> 若缺 `mali.ko`：`insmod /lib/modules/mali.ko`；若缺 `/system` 骨架：由 `01_mali.start` 自动搭建（它还会造 `/dev/mali0` 等）。
> `WARNING: linker: unused DT entry / unsupported flags` 是**无害**警告，可忽略。

---

## 2. 唯一正确的编译方法（musl gcc → bionic）

```bash
gcc -O1 -march=armv7-a -mtune=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard -I/usr/include \
    -nostdlib -Wl,--entry=main -Wl,--dynamic-linker=/system/bin/linker -Wl,-rpath=/system/lib \
    <app>.c /root/bionic_shim.o -L/system/lib \
    -lEGL -lGLESv2 -lc -lm -ldl -lgcc -o <app>
```

**必须遵守**：
- `-Wl,--entry=main`：**缺了就崩**（无 crt 时 ld 默认入口 = `.text` 首字节）。
- `-nostdlib` + `--dynamic-linker=/system/bin/linker` + `-rpath=/system/lib`：整套桥接三件套，缺一不可。
- 链接 `/root/bionic_shim.o`（已存在，10592 B），补 musl↔bionic ABI 差异。

**编完自检（必须为空）**：

```bash
nm -D <app> | grep -E ' (mmap|munmap|lseek|fseeko|ftello|ftruncate|open|close)$'   # 应无输出
```
有输出 = exe 导出了 shim 符号 → 依赖库会绑走 musl-ABI 的 `mmap` 导致**死循环**。

---

## 3. 代码骨架（EGL + GLES2）

```c
#include <EGL/egl.h>
#include <GLES2/gl2.h>

EGLDisplay dpy; EGLSurface surf; EGLContext ctx;

EGLint cfg_attr[] = {
    EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,        /* ★ 必须 pbuffer */
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,     /* ★ ES2 */
    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
    EGL_DEPTH_SIZE, 16,                          /* 3D 场景才需要 */
    EGL_NONE
};

dpy  = eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(dpy, &major, &minor);              /* 实测 EGL 1.4 */
eglChooseConfig(dpy, cfg_attr, &cfg, 1, &n);
eglCreatePbufferSurface(dpy, cfg, (EGLint[]){EGL_WIDTH, RW, EGL_HEIGHT, RH, EGL_NONE});
eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, (EGLint[]){EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE});
eglMakeCurrent(dpy, surf, surf, ctx);
glViewport(0, 0, RW, RH);

/* ... 建 shader、上传顶点、每帧 draw ... */

glFinish();            /* 计时用；本帧 GPU 真正画完 */
```

**要点**
- 本机像素格式实测：**RGBA 8888**（`R8 G8 B8 A8`），带深度时 cfg 报 `depth=24 stencil=8 samples=0`。
- **内部分辨率尽量小**：`glReadPixels` 只有 **~55MB/s**，成本 ∝ 像素数（720p 约 68ms，480x272 约 9.3ms）。推荐内部 360x640、`scale_to_fb` 放大到 720x1280 —— 这是提帧率**最有效**的杠杆。
- 全屏四边形：`glDrawArrays(GL_TRIANGLE_STRIP,0,4)` 在本机**画不出东西**，必须用 `glDrawElements(GL_TRIANGLES,6,GL_UNSIGNED_SHORT,idx)`。

---

## 4. 三种出图模式（按需求选型）

| 模式 | 做法 | 适用 | 注意事项 |
|---|---|---|---|
| **A 离屏 / 跑分 / 滤镜** | pbuffer 渲染 → `glFinish()` 计时 →（可选）`glReadPixels` 存盘 | 评测、GPU 计算、不需要实时出图 | **评分不受回读影响**（计时只算 render+finish） |
| **B 全屏独占出图到屏幕** | 渲染 → 回读 → `scale`/`rotate90` → `mmap(/dev/fb0)` 写帧 → `FBIOPAN` 翻页；**退出无条件归位第 0 页** | 模拟器/播放器/全屏 App | ⚠️ 见下方"回读坑" |
| **C 软件备胎** | Mesa 软渲（不用 Mali） | 兜底/调试对照 | 非 GPU，性能差 1~2 个量级 |

**⚠️ 回读坑（本机最致命）**：pbuffer 的 `glReadPixels` **不可靠**——纯 clear 或普通 2D 四边形回读会变成**全黑/陈旧红**，只有带深度的大网格（TERRAIN）偶发正确。已验证**四种办法均无效**：改 FBO 离屏渲染 / 去掉 `glFinish` / 加 `eglSwapBuffers` / 全局开深度。根因是 Mali **TBDR 惰性解析** + pbuffer 回读路径缺陷。

**对策**：
- 要出图 → **照抄已成功出图的实现**：`_tmp/miniretro_psp_hw.c` 的显示段（pbuffer → 回读 → `scale_rotate90` → `FBIOPAN`，实测 **34~38fps 出图**）。它靠 PPSSPP 核心内部 flush 才触发解析，是目前本机**唯一真出过图**的路线。
- HUD / 文字 / 帧率：**CPU 直写 fb 必然可见**，不受回读影响 → 场景区用 GPU、文字叠加用 CPU，是当下**最稳的组合**。
- 若将来要彻底解决：见《Mali400_摆脱安卓可行性分析》方案①/②（换 Linux DDK 或 Mesa Lima + 补 DRM）。

---

## 5. 桌面图标集成（让 App 能被点开）

**关键事实**：外部 `app.ini` 机制**只有扫描、没有点击分支**；要能点，必须改 launcher 内置数组。

1. 编辑设备端 `/home/lvgl_demo/lvgl_demo/lv_pages/launcher_page.c` 的内置 **`s_apps[]`**，加入新条目（图标/名称/命令）。
2. 拉起全屏外部程序照抄 `psp_game_page.c` 的范式：**暂停 LVGL → 释放输入 grab → 拦截器 → wait 子线程 → 退出时无条件 `FBIOPAN` 归位第 0 页**（幂等，否则桌面回不来）。
3. 重新 `make` 部署 lvgl_demo。
4. **省事捷径**：现有的 `GPUTEST_BIN` 入口已硬编码为 `/usr/local/bin/gpu_test`，把它**软链**到你的 App 即可沿用现有图标入口（本次 gpu_bench 就是这么接上的）：
   ```bash
   ln -sf /usr/local/bin/<app> /usr/local/bin/gpu_test
   ```
5. ⚠️ **调试前先停 watchdog**（每 5s 拉起 lvgl_demo），否则改完被立刻覆盖。

---

## 6. 必守的坑（血泪清单）

| # | 坑 | 症状 | 规避 |
|---|---|---|---|
| 1 | 缺 `-Wl,--entry=main` | 一跑就崩 | 构建命令里必须有 |
| 2 | exe 导出 shim 符号 | `mmap` 被绑到 musl-ABI → **死循环** | shim 用 `-fvisibility=hidden` 编译（不能用 `#pragma`） |
| 3 | `__dlsym_time64` 自引用 | musl 把 `dlsym` 重定向回它 → `b .` 死循环 | 用 `__asm__("dlsym")` 绕过 |
| 4 | 用 `thread_local` | bionic 不认 TLS reloc | 去掉；已用 `_patchtls.py` 改过的 core 需重新打 patch |
| 5 | 全局构造器做重活 | 构造期崩溃；**清零构造 = 自杀**（RELATIVE 把 0 变 ELF 头 → 调魔数 SIGILL） | 构造指向无害函数；必要时源码级短路（如 ArmCPUDetect） |
| 6 | 用 `printf` 输出诊断 | abort 时缓冲区丢失，**看不到现场** | 用 `write(1,...)` |
| 7 | 用 `ps -o pid,comm` 判活 | PPSSPP 会把主线程名改成 `{Main}` → **必然漏判**（曾攒 7 个僵尸实例堆满 CPU） | 一律看 `/proc/<pid>/cmdline` |
| 8 | 重链后不打补丁 | core 崩溃 / TLS 错 | `ppsspp` 类 core 重链后需重打：`.py`(libpng/z) + TLS + ctor patch（地址随链接漂移，`nm` 复查） |
| 9 | libretro 前端漏调 `context_reset()` | `draw_=NULL` → DrawEngineGLES ctor 段错误 | 必须在 `av_info` 之后调用 |

---

## 7. 参考文件清单（照抄对象）

| 用途 | 文件 | 说明 |
|---|---|---|
| GPU 就绪自检 | `/root/mali_check`（源 `ssh_tools/mali_check.c`） | 一键验收，先跑它 |
| 跑分/多场景/HUD 完整骨架 | `/root/gpu_bench.c`（`ssh_tools/gpu_bench.c`） | 5 场景 + 实时 fps + 结果页 + `fb_restore()`，最适合当 App 模板 |
| **唯一真出图的全屏管线** | `_tmp/miniretro_psp_hw.c` | 回读→`scale_rotate90`→`FBIOPAN`，实测 34~38fps |
| bionic 桥 | `/root/bionic_shim.o`（源 `bionic_shim.cpp`） | 编译必须链接 |
| 部署/构建脚本 | `ssh_tools/deploy_bench2.py` | 上传→编译→原子替换→软链，照改即可 |
| 图标入口 | `ssh_tools/patch_launcher_gputest.py` | `GPUTEST_BIN` 入口 + fork/exec/等待/归位范式 |
| 故障排查 | `ssh_tools/mali400_docs/Mali400_故障排查手册.md` | 分层速查 |
| 摆脱安卓 | `ssh_tools/mali400_docs/Mali400_摆脱安卓可行性分析.md` | 回读坑的根因与出路 |
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
