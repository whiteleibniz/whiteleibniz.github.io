---
title: "LVGL Desktop Application Architecture and Third-Party Integration Specification"
date: 2026-09-21 12:26:56
lang: en
permalink: en/2026/09/21/lvgl-arch-01-lvgl-md/
search: true
categories:
- 应用框架
- LVGL桌面架构
tag:
- LVGL
- 架构
---


# LVGL Desktop Application Architecture and Third-Party Integration Specification

> Goal: make this LVGL desktop an "Android-like system" — third-party developers copy a template, write UI, drop it into apps/, and after a restart the icon appears automatically, **with no need to modify the desktop source code**.
> Applies to: HT0 (SC9832A / Alpine) and LVGL desktops with the same architecture.

---

## 1. Design Goals

| Android APK | Desktop counterpart |
|---|---|
| AndroidManifest.xml | `app.ini` / the exported `lv_app_t` |
| Activity lifecycle | `on_create` / `on_destroy` / `on_key` |
| The desktop automatically scans APKs to produce icons | The desktop scans `apps/` at startup, dlopens / reads the ini, and registers automatically |
| SDK + template project | A single `app_template/`; copy it and you can start writing |
| `adb install` | `scp` to `apps/` and restart the desktop |

---

## 2. Six Application Categories (Take Your Seat)

| Type | Examples | Integration method |
|---|---|---|
| ① Built-in Page (lightweight shared UI) | Settings/Bluetooth/Network | compiled into the desktop (current state) |
| ② Standalone process (heavy resources/existing programs) | emulator/mplayer | **app.ini + start.sh** (the main route for third parties) |
| ③ Background daemon (no icon) | bt_user_daemon/wpa | managed by the boot script; does not enter the desktop |
| ④ Desktop embedded components | status bar/volume/dropdown menu | inside the desktop; not applications |
| ⑤ Script/command type | LED/reboot/screenshot | app.ini type=script |
| ⑥ Hybrid bridging | music page (shell + mplayer process) | a built-in page forks a standalone process |

**Third-party developers mainly use ② (standalone process), while lightweight UI mini-applications use the plugin .so.**

---

## 3. Two Third-Party Integration Models

### Model A: Plugin .so (Lightweight, Consistent with the Desktop UI)

Each application is one `.so` that exports a fixed structure:

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

Desktop startup scan:
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

Clicking the icon → `app->on_create(lv_scr_act())`; exiting → `app->on_destroy()`.

### Model B: Standalone Process (Heavy Resources/Existing Binaries; the Recommended Main Route for Third Parties)

Each application is one directory:
```
apps/snes9x/
  ├── app.ini        ← 描述文件
  ├── snes9x         ← 二进制（现成的移植程序）
  ├── start.sh       ← 启动脚本
  └── roms/          ← 自带资源
```

`app.ini`:
```ini
name=我的游戏
icon=snes.png
type=process
exec=start.sh
```

The desktop scans `app.ini`; clicking the icon:
```c
fork(); exec("/usr/local/lvgl/apps/snes9x/start.sh"); waitpid(...);
// start.sh 负责：抢 framebuffer、接管 /dev/input、跑程序、退出恢复
```

> **Why third parties should prefer B**: no need to understand LVGL; existing C/assembly/programs in any language can be integrated, and a crash does not take the desktop down with it.

---

## 4. Directory Structure (Target State)

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

## 5. System Service APIs (How Third Parties Invoke System Capabilities)

Third-party applications that need Bluetooth/WiFi/volume go through the **unified socket**; do not touch the hardware directly:

| Capability | Interface | Example |
|---|---|---|
| Bluetooth | `/tmp/bt_ctl.sock` | `scan 8` / `connect <mac>` / `on` / `off` |
| WiFi | `wpa_cli -i wlan0` | standard commands |
| Volume | write mixer / alsa | the system wraps it as `sndctl set 70` |
| Framebuffer | the standalone process opens `/dev/fb0` itself | in start.sh |
| Input | the standalone process reads `/dev/input/eventX` itself | in start.sh |

> Principle: **hardware details are encapsulated in the system layer, and third parties only call sockets/scripts**; changing the hardware does not affect applications.

---

## 6. Third-Party Development Process (As Simple as Android)

```
1. cp -r app_template my_app        拷模板
2. 改 my_app/ 里的 name/icon + 写 on_create UI
3. make                             交叉编译成 .so（或打包二进制）
4. scp 到 设备:/usr/local/lvgl/apps/my_app/
5. 重启桌面（或桌面自动热扫）
   → 图标自动出现在桌面，点即用
```

---

## 7. helloworld Template (Model A)

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

Build: `arm-linux-gcc -shared -fPIC my_app.c -o my_app.so -I$LVGL_INC -llvgl`

---

## 8. Implementation Roadmap (Which Step First)

| Step | Content | Value |
|---|---|---|
| 1 | Create the `apps/` directory + the desktop scanner (initially supporting only model B reading app.ini) | heavy-resource programs can be integrated immediately |
| 2 | Write `app_template/` + documentation | third parties can get started |
| 3 | Provide `lv_app_api.h` + plugin dlopen support | lightweight UI applications can be integrated |
| 4 | Write the system service socket API documentation | applications can call Bluetooth/WiFi/volume |
| 5 | Hot loading (no desktop restart needed; the icon appears as soon as it is dropped in) | the experience approaches that of an APK |

---

## 9. One-Sentence Summary

> **Desktop = launcher + application scanner; a third-party application = one directory (app.ini + binary/plugin).**
> Heavy-resource programs use a standalone process (B), and lightweight UI uses the plugin .so (A); the desktop discovers both automatically and produces icons automatically.
> Hardware details are encapsulated in the system layer, and third parties only call the unified socket — this is the LVGL version of the "APK ecosystem".
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
