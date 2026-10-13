---
title: "ref_模拟器_渲染与退出"
date: 2026-09-29 18:05:26
lang: zh-CN
search: true
categories:
- 多媒体与模拟器
- 模拟器通用
tag:
- 模拟器
- 渲染
---


# 参考（细节）— 游戏模拟器：渲染管线与退出策略

> 由 `MEMORY.md §11` 拆出，避免主笔记超限。结论级摘要仍在 MEMORY.md。
> 原始证据：`AI工作流/bugfix/bugfix_20260923_09~14*.md`、`outputs/bugfix_20260923/`、Skill `child-exit-hang-diagnosis`

## A. 渲染管线五坑（已实证；改 `video_cb` / `scale_rotate90` 前必读）

1. **必须放行 240×160**（原硬编码 256×240 过滤 → GBA 帧全丢 = 黑屏）；
   **必须按 pitch 逐行读**（mGBA pitch=512=256px/行，宽只 240，线性读 → 纵向条纹）
2. **双缓冲页翻转治撕裂**：整帧渲染到后台页再 `FBIOPAN_DISPLAY`；`FBIO_WAITFORVSYNC` 本机 EPERM 不可用
   → **这条正是"页翻转地雷"的来源**（见 MEMORY.md §3）
3. **★ R/B 交换全链路只能做一次**（内部 `0xAARRGGBB`，写前换一次）→ 换两次 = 红蓝反转
4. **音频真实速率 ≠ 核心上报**：mGBA 报 32768，实测每 `retro_run` 交付 1097 帧（≈65536Hz）→ 按上报换算超产一倍
   被截断 = 持续滋滋。正解 `s_fpc × s_fps_meas`；缓冲 ≥8192 int16；**开局 300ms 不发声**（首帧只 82 帧会算错比率灌爆 fifo）
5. **★ CPU 100% 打满，miniretro 上限 ≈56fps**（<59.73）→ 只能按实测帧率把音频拉伸到实时，音高低 ~6%

## B. 退出策略（定版 v3 + 无条件翻页 = bugfix 16 / 18）

- **判据只有一个硬事件：子进程真的消失**。两页一律**阻塞 `waitpid`，无上限、无标志位、无超时**
  （FC 的 `fc_wait_thread` 一直这么写，从没出过故障 —— 这才是基准）
- **顺序**：输入拦截器收到退出键 → `kill(SIGTERM)`（**立刻返回，绝不 sleep**）→ 创建**专职补刀线程**
  `gba_kill_later`（600ms 后仍在才 `SIGKILL`）→ 收尸线程阻塞 `waitpid` → `gba_reset_fb_page()` →
  `hardware_keys_set_grab(true)` → `app_runtime_set_lvgl_paused(false)` → `lv_async_call(整屏重绘)`
  → **最后**摘拦截器。`gba_on_destroy` 另走 `SIGTERM` + 300ms 保护 `.sav`
- **前端侧**：`on_quit_signal`(SIGTERM→quit=1) + `fb_restore()` + 正常 `return 0`。
  **`fb_restore()` 无条件 pan 回第 0 页，绝不清屏**（清屏 = 那 ~1s 变纯黑 = "卡黑屏"）；
  **也不再整页 `memcpy`**（bugfix 16 去掉：那等于把内容写进 LVGL 永远绘制的那页）
- **★★ 翻页一律【无条件】**（bugfix 18，页面侧 5 个调用点全部）：`FBIOPAN_DISPLAY(yoffset=0)` 幂等
  → **绝不加前置判断**；发完回读校验一次、不对就重发。且**翻页与整屏重绘必须同拍**
  （主线程重绘回调里紧挨着重绘再翻一次）→ 见 §C-7
- **实测**：发信号 → 子进程"真正消失"**两前端都 ~1015~1020ms**（内核回收 evdev/fb 的固有开销，前端无法影响；
  刻意接受的代价，别再想优化）；退出后**两前端都定格游戏最后一帧** = **黑屏窗口 0**
- **★ `yoffset` 回读的定位（三版结论，最终版）**：它**能反映**前端在不在翻页（当观测手段可用），
  但**不能当"要不要翻页"的门禁** —— 记账值不保证等于扫描输出(LCDC)正在读的那一页；
  两者一旦不一致，`if(yoffset != 0)` 就跳过翻页 = **偶发残留上一画面**（bugfix 18 的真凶）

## C. 已被证伪的路，别再走

1. **给等待循环设"跑满 N 秒就算退出"的上限** ← "卡黑屏"真凶：游戏正常跑满即被误判 → 摘掉按键拦截器
   （**退出键失效**）+ LVGL 抢回 fb0 与游戏互相覆盖。**FC 用无上限阻塞 waitpid，这是"FC 好/GBA 坏"的分水岭**
2. `_exit(0)` **省不掉**内核时间（只跳过用户态 close，进程**更久**不消失）
3. 把"等收尸"循环放在**互斥锁内** → UI 恢复被拖满
4. 用 `setenv` 做单子进程开关（**主进程级**，会跨页面残留）→ **一律在 `fork()` 后 `execl()` 前的子进程里设**
5. **前端退出时清屏**（"黑"由清屏造成、"卡"是两前端共有的 ~1s 开销 —— 别当同一个问题查）
6. **只归位自己那一层**：父进程补 SIGKILL 打断子进程"落存档 + 翻页" → **必须父子双层兜底**
7. **★「幂等操作 + 前置判断」**（bugfix 18）：`if(yoffset!=0) pan()` 这类写法把"**一定做**"变成
   "**偶发不做**" —— 因果链是「回读值 ≠ 真实状态 → 判断为假 → 后端复位整段被跳过」。
   幂等且成本可忽略的操作**直接做，不要问**。
   **偶发故障的第一侦查方向是"判断条件"，而不是时序**：先问"这段代码有没有可能在输入正确时选择不做"
8. **把"翻页"和"重绘"分处两个执行流**：它们是同一个视觉事务的两半，分开就留中间态（bugfix 18）

## D. 工具与探针

- 页翻转诊断 `fbpan`：`/tmp/fbpan [页号]`（源码 `ssh_tools/_tmp/fbpan.c`，设备 gcc 编）
- 抓当前可见页 `ssh_tools/grab_screen.py`；端到端复现 `ssh_tools/gba_repro.py`；
  冻住前端验证兜底 `verify_gba_guard.py`；完整流程 `verify_gba_final.py`
- 音频探针 `MINIRETRO_AUDIO_DEBUG=1 miniretro ...` 每秒打
  `peak/samples/out/drop/fps/calls/fpc/in_rate/out_rate/busy_ms`
- 已知限制：本机仅 4 物理键（左/右/A/退出），GBA 的 L/R/START/SELECT 需 USB 手柄或改 keymap

---

## E. 帧率预算与提速（2026-09-29，GBA）

### E.1 三个必知数字
1. **`FBIOPAN_DISPLAY` 阻塞 17.46ms/次（裸测 100 次）⇒ 面板刷新 57.3Hz**。
   它等下一个 vsync 才返回 ⇒ **只要每帧都翻页，帧率上限就是 57.3Hz**（GBA 标称 59.73 永远达不到）。
   别再去"优化到 60fps"——物理上限就在这。
2. **每帧真正做事 ≈ 10ms**：mGBA core_run 自身 ~5ms + conv 0.4ms + scale_rotate90 4.85ms；
   剩下 7ms 是 pan 在等 vsync（无事可做，但单线程下串行占用主循环）。
3. **掉帧机制**："顿一下"= 某帧做事超过当前 vsync 相位剩余预算 → 错过一班车 → 该帧 34.9ms（半速）。
   所以提速的正确目标是**加大余量**，不是提高峰值帧率。

### E.2 分段探针（怎么量）
`MINIRETRO_PERF=1 miniretro_gba <core> <rom> <keymap>` 每秒打印
`fps / core / conv / scale / pan (ms/帧) / 总 busy`；`vf` = 每秒 video_cb 次数。
（`MINIRETRO_AUDIO_DEBUG=1` 是音频那路的探针，两者独立。）

### E.3 已做的两处提速
- **scale_rotate90**：① 目标列 gather 查表 → **源列区间表 `sr_xstart[]` + 连续铺写**；
  ② 78 万次 4B uncached 写 → **cached 行缓冲 `sr_rowbuf` + `fb_store_row()` NEON 16B 宽写**（19.4 万次）。
  实测 6.7ms → 4.85ms。写显存是 uncached，**减少总线访问次数**才是关键（不是减少像素数）。
- **governor**：运行期 `performance`（768~900MHz → 1.3GHz），退出还原 `interactive`。
- **★ 编译**：GBA 必须 `-O2 -march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard`；
  本机 gcc `-dumpmachine` = `armv6-alpine-linux-musleabihf`、默认 `-mfpu=vfpv2`
  → 不显式指定时 `arm_neon.h` 报 `inlining failed ... target specific option mismatch`。
  SC9832A = Cortex-A7，显式开 armv7-a+NEON 实测可编译可运行。
- **未做（可选）**：关双缓冲（省掉 pan 的 4~7ms，但会撕裂）；mGBA 跳帧；GSP 硬件缩放/旋转。

### E.4 帧率显示
- 开关：设置页"游戏帧率" → `lv_conf/settings.conf` 的 `show_fps=1`；
  前端直接解析该文件（**不能 setenv**，见 §"setenv 污染"教训），
  环境变量 `MINIRETRO_SHOW_FPS=1/0` 可临时覆盖。
- 画法：5x7 点阵（0-9/F/P/S/:）放大 3 倍，**必须画在 `FBIOPAN_DISPLAY` 之前的后台页**，
  否则下一帧翻页就被顶掉；颜色用 `FBPIX(r,g,b)` 宏（fb 物理 [R,G,B,X]）。
- 位置：`x=12, y=fb_h-7*3-14`（左下角），带黑底衬。

### E.5 PSP 性能天花板 = 10fps（2026-09-29 实测定论）
- 分段（`MINIRETRO_PERF=1`）：core_run 96ms（其中我们出图 9.7ms）/ 10.2fps。
  **出图只占 10%**，其余是 PPSSPP 每帧固定成本；**与 ROM 负载无关**（Tetris 同速）。
- 已排除：分辨率（PPSSPP 只收 ≥480x272）、音频（MUTE 无差异）、CPU 限频（1.3GHz 实测 214M iter/s）、
  JIT vs IR（同速）。`frameskip=2` 最优，**=8 反而更慢**。
- ★ **core option 名/值必须用 GET_VARIABLE 回执实证**（写错的变量 core 静默忽略）；
  **同一 key 在表里写两条 → lookup 只回第一条**。
- ★ **绝不要 `MINIRETRO_NOAUDIO=1`（不注册音频回调）→ PPSSPP 段错误**。
- 帧率叠加/分段打印/调参环境变量：见 `2026-09-29.md`"PSP 卡顿定位与优化"。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
