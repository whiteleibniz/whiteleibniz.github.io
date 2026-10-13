---
title: "FM Radio_LVGL UI Design and Interaction Specification"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-11-fm-lvgl-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# Unisoc SC9832A (spd-box) FM Radio —— LVGL UI Design and Interaction Specification

> **Audience**: Engineers / AI assistants implementing the radio app
> **How to use**: Read §1–§2 first to get the screen and hardware constraints → arrange icons per §3 → draw pages per §4 → break down feature priorities per §5
> **Core value**: All dimensions are computed from measured on-device parameters (720×1280 portrait screen, `lv_font_cn_16` line height 31px), avoiding line-height rework after drawing; every feature item is annotated with its corresponding driver ioctl, avoiding the design of interactions that cannot be implemented

---

## 1. Design Constraints (Fix Them First, Then Draw Pages)

### 1.1 Screen and Font Hard Parameters

| Item | Value | Source / Impact |
|---|---|---|
| Resolution | **720 × 1280** (portrait) | Measured from the framebuffer; all coordinates are based on this |
| LVGL version | 9.6.0 | Use 9.x APIs such as `lv_obj_set_style_transform_rotation` |
| Default Chinese font | `lv_font_cn_16` | **Forbidden** to use `LV_FONT_DEFAULT` (Montserrat-14 has no CJK glyphs and renders tofu blocks) |
| `lv_font_cn_16` metrics | **line_height = 31px, base_line = 9px** | **Critical**: the nominal font size is 16px, but each line actually occupies 31px. Any layout estimated at 16px will inevitably clip Chinese text |
| Icon font | FontAwesome codepoint coverage **61441 ~ 63650** (0xF001–0xF8A2) | Icon selection must fall within this range |
| Physical buttons | Order (点餐) = 114 (LEFT), Service (服务) = 102 (RIGHT), Benefits (福利) = 115 (ENTER), Checkout (买单) = 116 (BACK) | Navigation/back goes through buttons; without a touchscreen, blind operation must be possible |

> ⚠️ **Historical lesson for this project**: Rework has already occurred because line heights (36/60px) were hardcoded according to the old font, which clipped Chinese text.
> All y coordinates in this specification have been recomputed on a **31px grid**; during implementation, do not "visually fine-tune" them into a 16px grid.

### 1.2 Hardware Capability Boundaries (What the UI Can Display)

The following capabilities have been **verified by measurement** via driver symbols (see `FM收音打通_AI指导手册.md` §2); the UI design makes trade-offs accordingly:

| Driver capability | Corresponding UI element | Notes |
|---|---|---|
| `TUNE` / `TUNE_NEW` | Manual tuning, list frequency jump | Direct frequency setting, fast response |
| `SEEK` / `SEEK_NEW` | ◀◀ / ▶▶ station search | Finds the **next strong signal**; it is not a step-by-step frequency increment |
| `SCAN` / `SCAN_NEW` / `STOP_SCAN` / `SCAN_GETRSSI` | Automatic full-band scan + progress bar + **interruptible** | The four commands work as a set: `SCAN` initiates the full scan, `SCAN_GETRSSI` samples the field strength point by point to drive progress and noise filtering, `STOP_SCAN` cancels midway |
| `GETRSSI` | Signal strength indicator bar | Real-time query of a single frequency point |
| `MUTE` / `SETVOL` / `GETVOL` | Mute toggle, volume slider | Note: `SETVOL` **still exists**, but the main output volume may go through ALSA separately; see the arbitration table in §5 |
| `RDS_SUPPORT` / `RDS_ONOFF` | RDS switch (turned on/off by the upper layer) | Recommended to keep on |
| `rds_get_ps()` | **Station name PS (8 characters)** → the station name under the current frequency | The most valuable RDS field |
| `rds_get_rt()` | **Radio text RT (64 characters)** → scrolling subtitles | Used for second-line scrolling |
| `rds_get_pty()` | Program type (news/music/traffic…) | Can be displayed as a small label |
| `rds_get_af()` | Alternative frequencies AF → **can automatically switch to a better-signal frequency of the same program** | High-value enhancement, not P0 |
| `rds_get_ct()` | Station clock | Can serve as an optional source for the status bar time |
| `rds_get_ews()` | Emergency broadcast | Has compliance significance; reserve a notification slot |
| `GETMONOSTERO` / `SETMONOSTERO` | Stereo ST indicator light | Mono/stereo indication |
| `OVER_BT_ENABLE` | **Route FM audio over Bluetooth** | The core switch for channel arbitration in §5.4 |
| `ANA_SWITCH` / `I2S_SETTING` / `GET_I2S_INFO` | Analog cntl vs I2S: selection between two audio paths | Implementing either one is sufficient; see §5.4 |

> ⚠️ **Must be verified by measurement (currently pending items; do not treat them as fact)**
>
> 1. **Whether headphones must be plugged in to serve as the FM antenna**. A common approach for the chip-side FM RF input is to reuse the headphone cable; this device's ALSA topology contains a dedicated FM device
>    (`01-04: Dfm sprd-codec-fm-4`), which suggests headphones may not be required. **The approach must not be decided until the §5.4 audio path experiment is complete**;
>    if headphones turn out to be required, the UI must show a full-screen illustration prompting "please insert headphones" when no headphones are present (see state Z2 in §4.1).
> 2. Although the RDS parsing functions exist in the driver, there is **no header file evidence that user space has been provided with data structures**; `Struct number` is undetermined.
> 3. The relationship between the `SETVOL` volume and the actual main output volume: it may only be the internal gain of the FM module, with the main volume elsewhere in ALSA.

---

## 2. System Positioning: Where the Radio Sits in the Overall App

```
桌面 launcher（g_launcher_page）
   ├── 状态栏：左=时间  右=电池 / WiFi / 蓝牙图标
   │
   └── 应用网格 s_apps[]（第 3 行第 2 个）
         ├── … 网络（LV_SYMBOL_WIFI,  0x56ccf2）
         ├── 蓝牙（LV_SYMBOL_BLUETOOTH, 0x1e88e5）   ← 索引 7
         ├── 收音机（新）                            ← 索引 8 ★ 紧跟蓝牙
         ├── 图库
         └── …
                 │ 点击
                 ▼
        收音机页 g_radio_page（新增）
                 │ 后台常驻播放、返回桌面不停台
                 ▼
        FM daemon（新增，/tmp/fm_ctl.sock）
                 │ ioctl / AT → /dev/fm
                 ▼
        Marlin2 芯片 FM 部件（与 WiFi/蓝牙共享 SDIO）
```

**Relationship with existing pages**:

| Page | Relationship | Interaction |
|---|---|---|
| Network page `g_network_page` | **Prerequisite dependency** | The FM firmware is downloaded once together with WiFi; if WiFi is not up ⇒ FM is unavailable (the icon must be grayed out or a prompt shown) |
| Bluetooth page `g_bluetooth_page` | **Channel mutual exclusion** | Opening FM during A2DP playback ⇒ requires upper-layer arbitration; see §5.4 |
| Music/video pages | **Channel mutual exclusion** | Local playback and FM are mutually exclusive |
| Launcher `g_launcher_page` | Return relationship | Returning does not stop playback; see §5.5 |

---

## 3. Entry Design and Icon (Requirement ①)

### 3.1 Desktop Grid Layout

Current `s_apps[]` order (starting at line 94 of `lv_pages/launcher_page.c`):

| Index | Name | symbol | Background color |
|---|---|---|---|
| 6 | Network | `LV_SYMBOL_WIFI` | `0x56ccf2` |
| **7** | **Bluetooth** | `LV_SYMBOL_BLUETOOTH` | `0x1e88e5` |
| **8** | **Radio (new)** | See §3.2 | `0xe6614f` (recommended) |
| 9 (formerly 8) | Gallery | … | … |

> **The visual order is determined by the `s_apps[]` array order** (grid traversal uses `sizeof(s_apps)/sizeof(s_apps[0])`, see `launcher_page.c:985` and `:1055`),
> so as long as it is placed after the Bluetooth entry in the array, it is automatically rendered after Bluetooth.

### 3.2 Three Code Changes (All Mandatory; None Can Be Skipped)

**(1) Enum** — the enum near line 40 of `launcher_page.c`:

```c
    LAUNCHER_APP_BLUETOOTH,
    LAUNCHER_APP_RADIO,             /* ★ 新增 */
    LAUNCHER_APP_GALLERY,
```

> ⚠️ **It is recommended not to insert the enum in the middle of implicitly consecutive values**: the style above shifts the numeric values of `GALLERY` and all following entries by +1.
> If you are worried that some state has persisted old numeric values, the safer approach is to **append it at the end of the enum** (before `LAUNCHER_APP_EXTERN = 1000`),
> and the visual order is still controlled by the `s_apps[]` array. Choose one of the two approaches and apply it consistently across the whole project.

**(2) Array** — `s_apps[]`:

```c
    { LAUNCHER_APP_BLUETOOTH, "蓝牙",   LV_SYMBOL_BLUETOOTH, 0x1e88e5 },
    { LAUNCHER_APP_RADIO,     "收音机", RADIO_SYMBOL,       0xe6614f },  /* ★ 新增 */
```

**(3) Jump branch** — the switch in `open_app`:

```c
        case LAUNCHER_APP_RADIO:
            lv_start_activity(&g_radio_page, LV_PAGE_FLAG_DEFAULT, LV_PAGE_ANIM_SLIDE_LEFT, 220);
            break;
```

The standard jump pattern is identical to other pages (`lv_start_activity(&g_xxx_page, LV_PAGE_FLAG_DEFAULT, LV_PAGE_ANIM_SLIDE_LEFT, 220)`).

### 3.3 Icon Selection

LVGL's built-in symbols contain **no dedicated radio symbol**. There are three candidates:

| Candidate | Codepoint | Decimal | Within the confirmed coverage range | Assessment |
|---|---|---|---|---|
| **broadcast-tower** | `U+F519` | 62745 | ✅ Within 61441–63650 | **Recommended first choice**: tower shape, high recognizability |
| podcast | `U+F2CE` | 62158 | ✅ | Alternative, leans toward "podcast" semantics |
| satellite-dish | `U+F7C0` | 63424 | ✅ | Alternative, leans toward "satellite" semantics |
| ~~radio~~ | `U+F8CE` | 63702 | ❌ **Exceeds 63650** | **Forbidden to use**; it renders as a tofu block |

```c
/* 建议放在 radio_page.h 或公共 symbols 头里 */
#define RADIO_SYMBOL "\uF519"   /* broadcast-tower，待 §3.4 验证后固化 */
```

The **background color** is recommended to be `0xe6614f` (warm brick red): in the desktop's existing palette, blues are already heavily used by Network/Gallery/Bluetooth, and the red family is used only by Power Off (`0xe74c3c`) and Music (`0xeb5757`); warm brick red clashes with none of these three, and a warm tone matches the conventional psychological association of "radio/broadcast".

### 3.4 Icon Verification (**Mandatory Before Delivery; Without This Step the Work Is Not Complete**)

Range coverage is indirect evidence; **whether a codepoint has an actual glyph must be verified by measurement**:

```sh
# 方法：写个最小 LVGL 测试页渲染该码位，截图看是字形还是豆腐块
# 参考本项目既有验证思路：写已知值 → 出图 → 人眼确认
```

> ⚠️ **Self-certification by "it looks right when rendered" is forbidden**: this is consistent with this project's troubleshooting discipline for display issues
> ("capture data → decode per hypothesis → looks correct" is not evidence). It must be **confirmed by human eyes on the physical screen** that the glyph is a tower pattern rather than a box.
>
> If `U+F519` lacks a glyph → fallback options: use a 32×32 PNG resource, or fall back further to `LV_SYMBOL_AUDIO` (semantically conflicting with "Music"; not recommended).

### 3.5 Settings Page Layout

**Two new items are recommended** in the settings page `g_settings_page` (placed after the Bluetooth item):

| Control | Purpose |
|---|---|
| Toggle "Radio boot autostart" | Controls whether `fm_radio.start` starts with the system (off by default; see §5.5) |
| Entry "Radio region and band" | China 87.5–108.0 MHz / 100 kHz step; leave room for Japan 76–90 MHz and the European 50 kHz step |

> These two items belong to **P2** and can be added after P0/P1 are complete.

---

## 4. Page Layout (Requirement ②)

### 4.1 Zone Overview (720 × 1280)

Typeset on a 31px line-height grid, with 8 vertical zones:

| # | Zone | y range | Height | Content |
|---|---|---|---|---|
| A | Title bar | 0 – 72 | 72 | Back button, title "Radio", headphone/channel status mini-icons |
| B | Band mode bar | 80 – 111 | 31 | `FM` + `87.5 – 108.0 MHz` + `100 kHz` + ST stereo badge |
| C | Current frequency | 120 – 232 | 112 | **Large font** `97.4` + `MHz`; RDS station name PS below |
| D | Ruler | 244 – 340 | 96 | Frequency scale + **tuning pointer** + favorite frequency markers |
| E | Signal and RDS | 352 – 413 | 61 | RSSI five-bar signal bar + RT scrolling text |
| F | Control area | 430 – 590 | 160 | ◀◀ / seek / mute / seek / ▶▶ |
| G | Favorites list | 606 – 1110 | 504 | Scrollable ListView: frequency + station name + delete |
| H | Volume and channel | 1128 – 1264 | 136 | Volume slider + mute + output channel indicator (speaker/headphone/Bluetooth) |

A 16px margin serves as the divider between zones (`○ padding = 16`).

```
┌────────────────────────────────────┐ y=0
│ ◀   收音机                    🎧 蓝 │ A  标题栏 72
├────────────────────────────────────┤ 
│ FM  87.5-108.0 MHz  100kHz   [ST]  │ B  模式条 31
│                                    │
│            97.4 MHz                │ C  主频点 112
│        北京音乐广播                 │    (PS 台名)
│                                    │
│ 87.5  ▏┴┴┴┴┴┼┴┴┴┴★┴┴┴┴┴┼┴  108.0 │ D  刻度尺 96
│                ▲                   │    指针 + 收藏星
│                                    │
│ ▮▮▮▯▯  正在恶化 RT 文本滚动…        │ E  信号 + RT 61
│                                    │
│    ◀◀      ⟲搜索      🔇      ▶▶    │ F  控制区 160
│                                    │
│ ☆ 97.4  北京音乐广播          🗑     │ G  收藏列表
│ ☆ 90.0  Music Radio          🗑     │    504 (可滚)
│ ☆ 106.6 文艺之声             🗑     │
│                                    │
│ 🔈 ▬▬▬▬▬▬▬▯▯▯    输出: 扬声器       │ H  音量声道 136
└────────────────────────────────────┘ y=1280
```

### 4.2 Zone Detailed Specifications

#### A. Title Bar (0–72)

| Element | Position / size | Description |
|---|---|---|
| Back button | x=0, 56×56, `LV_SYMBOL_LEFT` | Click → return to the desktop but **do not stop playback** (see §5.5) |
| Title | Centered, `lv_font_cn_16` | "Radio" |
| Headphone status | x = 720-56 | Show 🎧 crossed out when no headphones are present; hidden when headphones are present. Depends on pending item 1 in §1.2 |
| Channel indicator | Immediately adjacent on the left | Small badge "Headphone / Speaker / Bluetooth", linked with zone H; clicking can pop up the channel switch window (P2) |

#### B. Band Mode Bar (80–111)

A single 31px row carries four pieces of information: `[FM] [87.5 - 108.0 MHz] [100 kHz] [ST]`.
The ST stereo badge lights up only when `GETMONOSTERO` reports stereo, serving as an indirect indicator of RDS availability.

#### C. Current Frequency (120–232) — **Visual Focus**

| Element | Specification |
|---|---|
| Frequency digits | **48px bold** (needs to be introduced or use the largest existing size; if `lv_font_cn_16` has no such size, use an LVGL scale transform or add a new bitmap font size) |
| Unit `MHz` | 16px, right-aligned with the digits |
| RDS station name | 16px single line, taken from `rds_get_ps()`; show blank or "—" when there is no RDS |
| Font-size reminder | The zone height is 112px, accommodating one 48px line (62px line area) + one 16px line (31px) + adjustment slack |

> ⚠️ The 48px Chinese font size **must first be verified against reality** (`lv_font_cn_16` is a 16px bitmap font).
> If that font size is unavailable, there are two alternatives:
> the first is to enlarge the digits using LVGL's `lv_obj_set_style_transform_scale()` (enlarged bitmap fonts show jagged edges, so the effect is mediocre);
> the second is to add a new 48px Chinese/digit bitmap font (best effect, but it increases firmware size). This item is a P1 dependency and must be decided after measurement.

#### D. Ruler and Tuning Pointer (244–340) — **Core Interactive Component**

- **Scale generation**: computed from the current band bounds and step (default 87.5–108.0 MHz / 100 kHz); draw major ticks (every 1 MHz) + minor ticks (every 0.5 MHz).
- **Pointer**: an inverted triangle whose x is linearly mapped from the current frequency; update it with `lv_obj_set_x()`, with a 200ms ANIM on switching.
- **Favorite markers**: draw small ★-shaped markers at the x positions of the corresponding frequencies; marker positions update in real time as favorites are added or removed.
- **Interaction**:
  - Drag / swipe left or right → **fine frequency adjustment** (every 10px of movement ≈ 100 kHz), with a real-time `TUNE` updating the zone C digits.
  - Tap a position on the scale → `TUNE` directly to that frequency.
  - Physical LEFT/RIGHT keys (114/102) → ±100 kHz fine adjustment (essential for accessibility without a touchscreen).

#### E. Signal Strength and RDS Text (352–413)

| Element | Source | Specification |
|---|---|---|
| RSSI five-bar signal bar | `GETRSSI` | Polling period recommended at 500ms; the strong/weak thresholds **must be calibrated by measurement** (no samples currently; during implementation, use `/tmp/fmtest` to print the raw values and find the boundaries) |
| RT scrolling text | `rds_get_rt()` | 64 characters; scroll when too wide; hide when there is no RDS |

> ⚠️ RSSI thresholds **must be calibrated by measurement**; do not copy generic values such as `-85dBm` from the internet — this device's `GETRSSI` returns raw driver values whose units are unknown.

#### F. Control Area (430–590)

Five button slots in 3 categories of buttons (96×96 round buttons are recommended, vertically centered in one ribbon):

| Button | Icon | Behavior | Driver call |
|---|---|---|---|
| Previous frequency ◀◀ | `LV_SYMBOL_PREV` | `SEEK` down (find the next strong signal) | `SEEK(dir=0)` |
| Search ⟲ | `LV_SYMBOL_REFRESH` | Short press = single seek; **long press = automatic full-band scan** | `SEEK` / `SCAN` |
| Mute 🔇 | `LV_SYMBOL_MUTE` | Toggle FM mute | `MUTE` |
| Next frequency ▶▶ | `LV_SYMBOL_NEXT` | `SEEK` up | `SEEK(dir=1)` |

> Automatic scan: triggered by **long-pressing ⟲ for ≥ 800ms**; during scanning the button becomes "Stop", and `STOP_SCAN` can interrupt it.
> During scanning it is also recommended to disable the remaining buttons to avoid state machine confusion.

#### G. Favorites Channel List (606–1110)

Implemented with `lv_list`, each row **62px** high (two lines of text at 31px each):

```
┌───────────────────────────────────┐
│ ★  97.4 MHz                  [✕]  │
│    北京音乐广播 / α PS             │
└───────────────────────────────────┘
```

- Frequency on the left + station name (left blank when there is no RDS station name)
- Delete button `LV_SYMBOL_CLOSE` on the right (or long-press a row to pop up a delete confirmation, preventing accidental taps)
- Tap a row → `TUNE` to that frequency and scroll the list to the top
- For data persistence, see §5.6

#### H. Volume and Channel (1128–1264)

| Element | Description |
|---|---|
| Volume slider | `lv_slider`, with its range bound to `SETVOL/GETVOL` (the value range is yet to be determined; see pending item 3 in §1.2) |
| Mute button | Linked with the mute in zone F (same state, bidirectionally synchronized) |
| Output channel indicator | Text control showing the channel currently held by the winning contender: speaker / headphone / Bluetooth A2DP |

### 4.3 Page Interaction Flow (State Machine)

```
         ┌────────────┐
         │  Z1 未启动  │ ← 首次进入 / daemon 未拉起
         └─────┬──────┘
               │ 调用 open
               ▼
         ┌────────────┐
    ┌───▶│  Z2 就绪    │ 无合适音频通路 → 提示插入耳机 / 弹声道窗
    │    └─────┬──────┘
    │          │ TUNE 到上次频点
    │          ▼
    │    ┌────────────┐
    └────│  Z3 播放中  │◀── TUNE / SEEK / 列表点击 / 刻度微调
         └──┬──┬──┬───┘
    静音 ───┘  │  └─── 长按 ⟲ → Z4
               │
            返回键 → 后台（见 §5.5）不改大学出版社 Z3
               │
               ▼
         ┌────────────┐
         │  Z4 扫描中  │ 进度条百分比 + 已发现台数；STOP_SCAN 或完成 → Z3
         └────────────┘
```

### 4.4 Page Registration Pattern (Strictly Follow Existing Conventions)

Add `lv_pages/radio_page.c` / `radio_page.h`:

```c
/* radio_page.h */
extern lv_page_t g_radio_page;

/* radio_page.c —— 结构与 bluetooth_page.c:1118 完全一致 */
lv_page_t g_radio_page = {
    .root = NULL,
    .page_name = "radio",
    .onCreate  = radio_page_on_create,
    .onResume  = radio_page_on_resume,   /* 恢复时会重新拉 UI 状态：现在的频点、RSSI */
    .onPause   = radio_page_on_pause,    /* 必须停掉所有 lv_timer，但【不停播放】 */
    .onDestroy = radio_page_on_destroy,
    .onActivityResult = NULL,
    .user_data = NULL,
    .request_code = -1,
    .result_code = 0,
    .result_data = NULL,
    .launch_flags = LV_PAGE_FLAG_DEFAULT,
};
```

> ⚠️ Two red lines (verbatim from the comments in `lv_pm/lv_page_manager.h`):
> 1. In `onDestroy` you **must** release your own timers and callbacks and null out self-built global UI pointers;
> 2. In `onDestroy` **do not** delete `page->root`; the root node is deleted uniformly by the page manager.
>
> Also: the SIM page stack has a maximum depth of 8; the favorites list page can use flags such as `LV_PAGE_FLAG_NO_HISTORY` as needed.

---

## 5. Feature List (Requirement ③)

### 5.1 Priority Overview Table

| ID | Feature | Priority | Dependency | Driver call |
|---|---|---|---|---|
| F01 | **Turn FM on/off** | **P0** | WiFi is up (firmware downloaded) | `fm_powerup` / `fm_powerdown` |
| F02 | **Manual tuning Tune** | **P0** | F01 | `TUNE` / `TUNE_NEW` |
| F03 | **Automatic station search Seek (next strong signal)** | **P0** | F01 | `SEEK` / `SEEK_NEW` |
| F04 | **Full-band scan Scan + progress + interruptible** | **P0** | F01 | `SCAN` / `SCAN_GETRSSI` / `STOP_SCAN` |
| F05 | **Signal strength display RSSI** | **P0** | F02/F03 | `GETRSSI` |
| F06 | **Mute / unmute** | **P0** | F01 | `MUTE` |
| F07 | **Volume adjustment** | **P0** | F01 | `SETVOL` / `GETVOL` |
| F08 | **FM daemon + socket interface** | **P0** | F01 (the daemon is the sole entry point for all UI operations) | `/tmp/fm_ctl.sock` |
| F09 | **LVGL radio page** (§4 layout) | **P0** | F08 | — |
| F10 | **Boot autostart + firmware dependency check** | **P1** | The WiFi autostart chain is ready | openrc service |
| F11 | **Favorites channel list (add/delete/jump)** | **P1** | F02 | — |
| F12 | **State persistence** (last frequency/volume/favorites) | **P1** | F11 | — |
| F13 | **RDS station name PS display** | **P1** | F02, `RDS_ONOFF` on | `rds_get_ps` |
| F14 | **RDS text RT scrolling** | **P1** | F13 | `rds_get_rt` |
| F15 | **Stereo ST indication** | **P1** | F02 | `GETMONOSTERO` |
| F16 | **Background playback + screen-off persistence** | **P1** | F08, page lifecycle | — |
| F17 | **Channel arbitration (FM / A2DP / local mutual exclusion)** | **P0** | F08, Bluetooth daemon | §5.4 |
| F18 | RDS program type PTY label | P2 | F13 | `rds_get_pty` |
| F19 | RDS alternative frequency AF automatic switching | P2 | F13 | `rds_get_af` |
| F20 | Settings page: region/band switching | P2 | — | — |
| F21 | RDS emergency broadcast EWS notification | P2 | F13 | `rds_get_ews` |
| F22 | RDS station clock CT | P2 | F13 | `rds_get_ct` |

> **Why F17 is P0**: FM, Bluetooth A2DP, and local music all share one audio output.
> Without arbitration, the most typical failures are "FM and A2DP making sound at the same time" or "the Bluetooth speaker still making sound after FM is turned off" — problems users are bound to encounter.

### 5.2 Dependency Order (Implementation Path)

```
第 0 步  驱动能力确认（§1.2 三个待验证项出结果）
   ↓
第 1 步  F08  FM daemon（/dev/fm open + ioctl 封装 + socket）
   ↓
第 2 步  F01/F02/F03/F05  命令行/ socket 可手测：open/tune/seek/rssi
   ↓
第 3 步  F09  收音机页（先做 A/C/D/F 四区，能听能调）
   ↓
第 4 步  F17  声道仲裁（与蓝牙 daemon 联动）
   ↓
第 5 步  F04/F11/F12  扫描 + 收藏 + 持久化
   ↓
第 6 步  F13/F14/F15/F16  RDS 显示 + 后台播放
   ↓
第 7 步  P2 项（PTY / AF / EWS / 地区）
```

### 5.3 FM Daemon Interface (Mirroring the Existing Pattern of `bt_user_daemon`)

The Bluetooth daemon uses a unix socket + plain-text commands (send `state` / `on` / `off`, receive `OK ...\n`); FM is advised to copy this pattern exactly:

| Item | Bluetooth (existing, reference) | FM (new, recommended) |
|---|---|---|
| socket path | `/tmp/bt_ctl.sock` | **`/tmp/fm_ctl.sock`** |
| Permissions | `chmod(SOCK_PATH, 0666)` | Same |
| Protocol | Text command + `\n` terminator, replying `OK <payload>\n` | Same |
| Typical commands | `state` / `on` / `off` / scan-related | `state`, `open`, `close`, `tune <freq_khz>`, `seek <0|1>`, `scan`, `stopscan`, `rssi`, `vol <n>`, `mute <0|1>`, `rds` |

> 🔒 **Timeouts are mandatory**: LVGL timer callbacks that perform socket I/O **must** set `SO_RCVTIMEO` / `SO_SNDTIMEO` (200ms recommended),
> otherwise a stuck daemon will freeze the UI thread directly. This is a hard lesson already learned on this project's Bluetooth page.

### 5.4 Channel Arbitration (FM / A2DP / Local Playback Mutual Exclusion) — Key Design

The driver exposes three FM audio output paths:

| Path | Switch | Applicable scenario | Priority recommendation |
|---|---|---|---|
| **Analog/internal codec** | `ANA_SWITCH` | Direct output to this device's speaker / headphone | Default |
| **I2S** | `I2S_SETTING` / `GET_I2S_INFO` | When an external codec is needed | Alternative (**needs measurement to confirm availability**) |
| **Over BT** | `OVER_BT_ENABLE` | FM sound output from a Bluetooth headphone/speaker | Optional when Bluetooth is connected |

**Recommended arbitration rules** (implement a single "audio focus" module in the LVGL main process; the daemon only manages devices):

| Current holder | New requester | Handling |
|---|---|---|
| Idle | FM | Acquire directly; select the default path per the §5.4 table (headphone inserted → headphone, otherwise speaker) |
| Idle | A2DP | Acquire directly |
| FM | A2DP | **FM mutes automatically (not close)**; after A2DP ends, ask whether to resume FM |
| A2DP | FM | Pop up a confirmation dialog: "Bluetooth is playing. Switch to the radio?" → if agreed, pause/disconnect A2DP and then FM takes over |
| Local playback (music/video) | FM | Stop local playback → FM takes over |
| FM | Local playback | FM mutes → local playback takes over |

> ⚠️ `OVER_BT_ENABLE` is the **key uncertainty** of this design: whether it actually "sends FM audio to a connected Bluetooth device",
> or "allows FM and BT to coexist", has not been confirmed by reading the code.
> **Before implementation, its behavior must first be probed with a minimal program**, and only then should the arbitration logic be written. Starting without confirming this will very likely lead to wrong measurements.

### 5.5 Background Playback and Screen-Off Persistence

| Requirement | Implementation points |
|---|---|
| Keep playing when returning to the desktop | `onPause` only stops UI timers/callbacks and **does not call close or mute**; the playback state is held by the daemon, decoupled from the page lifecycle |
| Page fully destroyed | `onDestroy` likewise does not stop playback (same reason); only an explicit user press of close or shutdown stops it |
| Keep playing with the screen off | Screen-off is managed by the system backlight; FM is played by the daemon and does not depend on LVGL heartbeats. **Needs measurement**: confirm that screen-off does not trigger `fm_suspend` (the driver contains `fm_suspend` / `fm_resume`, which are the entry points for PM suspension; be sure to verify whether FM drops the station when the system suspends) |
| Boot autostart | Follow the existing openrc autostart pattern of `bt_user_daemon`; before autostart, the WiFi chain must be confirmed up (firmware dependency; see step 0 in §5.2) |

> ⚠️ The driver symbol table contains two **static** functions `fm_suspend` / `fm_resume` (`t` rather than `T`), indicating that the driver implements dev_pm_ops.
> When the system suspends, FM is very likely to be suspended along with it. If the product requires continued listening with the screen off, extra handling is needed (wakelock or forbidding suspend); this item **must be verified by measurement** and cannot be assumed.

### 5.6 State Persistence

Recommended path `/etc/fm_radio.conf` (or follow the project's existing configuration storage convention); choose either JSON or INI:

| Field | Description |
|---|---|
| `last_freq` | Last listened frequency (kHz); restore to this frequency on boot |
| `volume` | Last volume |
| `muted` | Mute state |
| `rds_on` | RDS switch (recommended to keep on) |
| `band/region` | Region/band (P2) |
| `favorites[]` | Favorites list: `{freq, name}` |

Write timing: on program exit, 1s debounce after frequency switching, and immediately when favorites are added or removed.

---

## 6. One-Sentence Summary

> **The radio is not a job of "writing an FM protocol stack from scratch"**:
> On this device the **Marlin2 chip's FM component + the `marlin_fm.ko` driver are already running out of the box** (`/dev/fm` is also already registered in `/proc/misc`),
> so the real work is concentrated in **three things** — writing an FM daemon mirroring the `bt_user_daemon` pattern that wraps ioctls into socket commands,
> drawing the radio page on the 31px line-height grid, and doing a good job on the **FM / A2DP / local playback channel arbitration**.
> Before starting, complete the three pending verification items marked in §1.2, especially "whether headphones must be plugged in as the antenna" and the true semantics of `OVER_BT_ENABLE`.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
