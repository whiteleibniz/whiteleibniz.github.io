---
title: "LVGL桌面应用架构与第三方接入规范"
date: 2026-09-21 12:26:56
lang: zh-CN
search: true
categories:
- 应用框架
- LVGL桌面架构
tag:
- LVGL
- 架构
---


# LVGL 桌面应用架构与第三方接入规范

> 目标：把这个 LVGL 桌面做成"类安卓系统"——第三方开发者像写 APK 一样，拷模板、写 UI、丢进 apps/，重启自动出图标，**不用改桌面源码**。
> 适用：HT0（SC9832A / Alpine）及同架构 LVGL 桌面。

---

## 1. 设计目标

| 安卓 APK | 本桌面对应物 |
|---|---|
| AndroidManifest.xml | `app.ini` / 导出的 `lv_app_t` |
| Activity 生命周期 | `on_create` / `on_destroy` / `on_key` |
| 桌面自动扫描 APK 出图标 | 桌面启动扫 `apps/`，dlopen / 读 ini，自动注册 |
| SDK + 模板工程 | 一个 `app_template/`，拷了就能写 |
| `adb install` | `scp` 到 `apps/` 重启桌面 |

---

## 2. 应用六类（对号入座）

| 类型 | 例子 | 接入方式 |
|---|---|---|
| ① 内置 Page（轻量共享UI） | 设置/蓝牙/网络 | 编译进桌面（现状） |
| ② 独立进程（重资源/现成程序） | 模拟器/mplayer | **app.ini + start.sh**（第三方主力） |
| ③ 后台守护（无图标） | bt_user_daemon/wpa | 开机脚本管，不进桌面 |
| ④ 桌面内嵌组件 | 状态栏/音量/下拉菜单 | 桌面内部，非应用 |
| ⑤ 脚本/命令型 | LED/重启/截图 | app.ini type=script |
| ⑥ 混合桥接 | 音乐页(壳+mplayer进程) | 内置 page fork 独立进程 |

**第三方开发者主要用 ②（独立进程），轻量 UI 小应用用插件 .so。**

---

## 3. 两种第三方接入模型

### 模型 A：插件 .so（轻量、和桌面 UI 一致）

每个应用一个 `.so`，导出固定结构：

```c
// 统一头文件 lv_app_api.h（系统提供，第三方只 include 它）
typedef struct {
    const char*  name;          // 应用名，如 "计算器"
    const uint8_t* icon;       // 图标 C 数组（png/c 数组）
    int          icon_w, icon_h;

    void (*on_create)(lv_obj_t* parent);  // 进入：在 parent 上画 UI
    void (*on_destroy)(void);             // 退出：释放资源
    int  (*on_key)(uint32_t key);        // 按键返回 1=已处理
} lv_app_t;

// 每个 .so 导出这一个符号
extern lv_app_t g_app __attribute__((visibility("default")));
```

桌面启动扫描：
```c
void apps_scan(void) {
    DIR* d = opendir("/usr/local/lvgl/apps");
    struct dirent* e;
    while ((e = readdir(d))) {
        if (!strstr(e->d_name, ".so")) continue;
        void* h = dlopen(path, RTLD_NOW);
        lv_app_t* app = dlsym(h, "g_app");
        launcher_register(app->name, app->icon, APP_PLUGIN, h);
    }
}
```
点图标 → `app->on_create(lv_scr_act())`；退出 → `app->on_destroy()`。

### 模型 B：独立进程（重资源/现成二进制，推荐第三方主力）

每个应用一个目录：
```
apps/snes9x/
  ├── app.ini        ← 描述文件
  ├── snes9x         ← 二进制（现成的移植程序）
  ├── start.sh       ← 启动脚本
  └── roms/          ← 自带资源
```

`app.ini`：
```ini
name=我的游戏
icon=snes.png
type=process
exec=start.sh
```

桌面扫 `app.ini`，点图标：
```c
fork(); exec("/usr/local/lvgl/apps/snes9x/start.sh"); waitpid(...);
// start.sh 负责：抢 framebuffer、接管 /dev/input、跑程序、退出恢复
```

> **为什么第三方优先用 B**：不用懂 LVGL，现成的 C/汇编/任何语言程序都能接，崩溃不拖垮桌面。

---

## 4. 目录结构（目标态）

```
/home/lvgl_demo/lvgl_demo/
├── launcher/            桌面主程序（内置 page + 扫描器）
│   └── lv_pages/        内置：设置/蓝牙/网络/文件管理...
├── apps/                ★ 第三方应用安装目录（桌面自动扫）
│   ├── snes9x/          模型 B：app.ini + 二进制 + start.sh
│   ├── calculator.so    模型 A：插件
│   └── <新应用>/
├── include/lv_app_api.h ★ 给第三方的统一头文件
├── app_template/        ★ 第三方模板工程（拷了就能写）
├── extern/              系统自带的重程序（mplayer 等）
├── shell/               开机/启动脚本
└── AI工作流/
```

---

## 5. 系统服务 API（第三方怎么调系统能力）

第三方应用要调蓝牙/WiFi/音量，走**统一 socket**，别直接碰硬件：

| 能力 | 接口 | 例子 |
|---|---|---|
| 蓝牙 | `/tmp/bt_ctl.sock` | `scan 8` / `connect <mac>` / `on` / `off` |
| WiFi | `wpa_cli -i wlan0` | 标准命令 |
| 音量 | 写 mixer / alsa | 系统封装一个 `sndctl set 70` |
| Framebuffer | 独立进程自己 `open /dev/fb0` | start.sh 里 |
| 输入 | 独立进程自己读 `/dev/input/eventX` | start.sh 里 |

> 原则：**硬件细节封在系统层，第三方只调 socket/脚本**，换硬件不影响应用。

---

## 6. 第三方开发流程（和安卓一样简单）

```
1. cp -r app_template my_app        拷模板
2. 改 my_app/ 里的 name/icon + 写 on_create UI
3. make                             交叉编译成 .so（或打包二进制）
4. scp 到 设备:/usr/local/lvgl/apps/my_app/
5. 重启桌面（或桌面自动热扫）
   → 图标自动出现在桌面，点即用
```

---

## 7. helloworld 模板（模型 A）

```c
// my_app.c
#include "lv_app_api.h"
#include <lvgl/lvgl.h>

static void on_create(lv_obj_t* parent) {
    lv_obj_t* btn = lv_btn_create(parent);
    lv_obj_t* label = lv_label_create(btn);
    lv_label_set_text(label, "Hello!");
}
static void on_destroy(void) { /* 释放 */ }
static int  on_key(uint32_t k) { return 0; }

lv_app_t g_app = {
    .name = "Hello",
    .icon = my_icon, .icon_w=48, .icon_h=48,
    .on_create = on_create,
    .on_destroy = on_destroy,
    .on_key = on_key,
};
```
编译：`arm-linux-gcc -shared -fPIC my_app.c -o my_app.so -I$LVGL_INC -llvgl`

---

## 8. 落地路线图（先做哪步）

| 步骤 | 内容 | 价值 |
|---|---|---|
| 1 | 建 `apps/` 目录 + 桌面扫描器（先只支持模型 B 读 app.ini） | 重资源程序立刻能接 |
| 2 | 写 `app_template/` + 文档 | 第三方能上手 |
| 3 | 提供 `lv_app_api.h` + 插件 dlopen 支持 | 轻量 UI 应用能接 |
| 4 | 封装系统服务 socket API 文档 | 应用能调蓝牙/WiFi/音量 |
| 5 | 热加载（不用重启桌面，放进去就出图标） | 体验接近 APK |

---

## 9. 一句话总结

> **桌面 = 启动器 + 应用扫描器；第三方应用 = 一个目录（app.ini + 二进制/插件）。**
> 重资源程序用独立进程（B），轻量 UI 用插件 .so（A），两者桌面都自动发现、自动出图标。
> 硬件细节封在系统层，第三方只调统一 socket——这就是 LVGL 版的"APK 生态"。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
