---
title: "LVGL桌面應用架構與第三方接入規範"
date: 2026-09-21 12:26:56
lang: zh-TW
search: true
categories:
- 应用框架
- LVGL桌面架构
tag:
- LVGL
- 架构
permalink: zh-tw/2026/09/21/lvgl-arch-01-lvgl-md/
---


# LVGL 桌面應用架構與第三方接入規範

> 目標：把這個 LVGL 桌面做成"類安卓系統"——第三方開發者像寫 APK 一樣，拷模板、寫 UI、丟進 apps/，重啟自動出圖標，**不用改桌面源碼**。
> 適用：HT0（SC9832A / Alpine）及同架構 LVGL 桌面。

---

## 1. 設計目標

| 安卓 APK | 本桌面對應物 |
|---|---|
| AndroidManifest.xml | `app.ini` / 導出的 `lv_app_t` |
| Activity 生命週期 | `on_create` / `on_destroy` / `on_key` |
| 桌面自動掃描 APK 出圖標 | 桌面啟動掃 `apps/`，dlopen / 讀 ini，自動註冊 |
| SDK + 模板工程 | 一個 `app_template/`，拷了就能寫 |
| `adb install` | `scp` 到 `apps/` 重啟桌面 |

---

## 2. 應用六類（對號入座）

| 類型 | 例子 | 接入方式 |
|---|---|---|
| ① 內置 Page（輕量共享UI） | 設置/藍牙/網絡 | 編譯進桌面（現狀） |
| ② 獨立進程（重資源/現成程序） | 模擬器/mplayer | **app.ini + start.sh**（第三方主力） |
| ③ 後臺守護（無圖標） | bt_user_daemon/wpa | 開機腳本管，不進桌面 |
| ④ 桌面內嵌組件 | 狀態欄/音量/下拉菜單 | 桌面內部，非應用 |
| ⑤ 腳本/命令型 | LED/重啟/截圖 | app.ini type=script |
| ⑥ 混合橋接 | 音樂頁(殼+mplayer進程) | 內置 page fork 獨立進程 |

**第三方開發者主要用 ②（獨立進程），輕量 UI 小應用用插件 .so。**

---

## 3. 兩種第三方接入模型

### 模型 A：插件 .so（輕量、和桌面 UI 一致）

每個應用一個 `.so`，導出固定結構：

```c
// 統一頭文件 lv_app_api.h（系統提供，第三方只 include 它）
typedef struct {
    const char*  name;          // 應用名，如 "計算器"
    const uint8_t* icon;       // 圖標 C 數組（png/c 數組）
    int          icon_w, icon_h;

    void (*on_create)(lv_obj_t* parent);  // 進入：在 parent 上畫 UI
    void (*on_destroy)(void);             // 退出：釋放資源
    int  (*on_key)(uint32_t key);        // 按鍵返回 1=已處理
} lv_app_t;

// 每個 .so 導出這一個符號
extern lv_app_t g_app __attribute__((visibility("default")));
```

桌面啟動掃描：
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
點圖標 → `app->on_create(lv_scr_act())`；退出 → `app->on_destroy()`。

### 模型 B：獨立進程（重資源/現成二進制，推薦第三方主力）

每個應用一個目錄：
```
apps/snes9x/
  ├── app.ini        ← 描述文件
  ├── snes9x         ← 二進制（現成的移植程序）
  ├── start.sh       ← 啟動腳本
  └── roms/          ← 自帶資源
```

`app.ini`：
```ini
name=我的遊戲
icon=snes.png
type=process
exec=start.sh
```

桌面掃 `app.ini`，點圖標：
```c
fork(); exec("/usr/local/lvgl/apps/snes9x/start.sh"); waitpid(...);
// start.sh 負責：搶 framebuffer、接管 /dev/input、跑程序、退出恢復
```

> **為什麼第三方優先用 B**：不用懂 LVGL，現成的 C/彙編/任何語言程序都能接，崩潰不拖垮桌面。

---

## 4. 目錄結構（目標態）

```
/home/lvgl_demo/lvgl_demo/
├── launcher/            桌面主程序（內置 page + 掃描器）
│   └── lv_pages/        內置：設置/藍牙/網絡/文件管理...
├── apps/                ★ 第三方應用安裝目錄（桌面自動掃）
│   ├── snes9x/          模型 B：app.ini + 二進制 + start.sh
│   ├── calculator.so    模型 A：插件
│   └── <新應用>/
├── include/lv_app_api.h ★ 給第三方的統一頭文件
├── app_template/        ★ 第三方模板工程（拷了就能寫）
├── extern/              系統自帶的重程序（mplayer 等）
├── shell/               開機/啟動腳本
└── AI工作流/
```

---

## 5. 系統服務 API（第三方怎麼調系統能力）

第三方應用要調藍牙/WiFi/音量，走**統一 socket**，別直接碰硬件：

| 能力 | 接口 | 例子 |
|---|---|---|
| 藍牙 | `/tmp/bt_ctl.sock` | `scan 8` / `connect <mac>` / `on` / `off` |
| WiFi | `wpa_cli -i wlan0` | 標準命令 |
| 音量 | 寫 mixer / alsa | 系統封裝一個 `sndctl set 70` |
| Framebuffer | 獨立進程自己 `open /dev/fb0` | start.sh 裡 |
| 輸入 | 獨立進程自己讀 `/dev/input/eventX` | start.sh 裡 |

> 原則：**硬件細節封在系統層，第三方只調 socket/腳本**，換硬件不影響應用。

---

## 6. 第三方開發流程（和安卓一樣簡單）

```
1. cp -r app_template my_app        拷模板
2. 改 my_app/ 裡的 name/icon + 寫 on_create UI
3. make                             交叉編譯成 .so（或打包二進制）
4. scp 到 設備:/usr/local/lvgl/apps/my_app/
5. 重啟桌面（或桌面自動熱掃）
   → 圖標自動出現在桌面，點即用
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
static void on_destroy(void) { /* 釋放 */ }
static int  on_key(uint32_t k) { return 0; }

lv_app_t g_app = {
    .name = "Hello",
    .icon = my_icon, .icon_w=48, .icon_h=48,
    .on_create = on_create,
    .on_destroy = on_destroy,
    .on_key = on_key,
};
```
編譯：`arm-linux-gcc -shared -fPIC my_app.c -o my_app.so -I$LVGL_INC -llvgl`

---

## 8. 落地路線圖（先做哪步）

| 步驟 | 內容 | 價值 |
|---|---|---|
| 1 | 建 `apps/` 目錄 + 桌面掃描器（先只支持模型 B 讀 app.ini） | 重資源程序立刻能接 |
| 2 | 寫 `app_template/` + 文檔 | 第三方能上手 |
| 3 | 提供 `lv_app_api.h` + 插件 dlopen 支持 | 輕量 UI 應用能接 |
| 4 | 封裝系統服務 socket API 文檔 | 應用能調藍牙/WiFi/音量 |
| 5 | 熱加載（不用重啟桌面，放進去就出圖標） | 體驗接近 APK |

---

## 9. 一句話總結

> **桌面 = 啟動器 + 應用掃描器；第三方應用 = 一個目錄（app.ini + 二進制/插件）。**
> 重資源程序用獨立進程（B），輕量 UI 用插件 .so（A），兩者桌面都自動發現、自動出圖標。
> 硬件細節封在系統層，第三方只調統一 socket——這就是 LVGL 版的"APK 生態"。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
