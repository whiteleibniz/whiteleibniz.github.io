---
title: "Requirement_Switch-Desktop Landscape Menu_20260924"
date: 2026-09-24 15:02:37
lang: en
permalink: en/2026/09/24/lvgl-landscape-req/
search: true
categories:
- 应用框架
- LVGL桌面架构
tag:
- LVGL
---


# Requirement: Change "Factory Desktop" to "Switch Desktop" + a Landscape Enlarged Sliding Menu

Date: 2026-09-24　Status: **coded and deployed to the device (pending manual verification by the user)**

> Decision record (2026-09-24 15:00): Q1 chooses **Option A (rotate the whole screen 90°)**;
> Q2/Q3/Q4 follow the defaults — remove the factory desktop entry / the menu contains all applications / the pay (买单) key returns to the portrait desktop.

---

## 1. Current State (Verified)

| Item | Fact |
|---|---|
| Desktop implementation | `lv_pages/launcher_page.c` (1255 lines), the `s_apps[]` static table with 19 entries + external applications `/usr/local/lvgl/apps/*/app.ini` |
| The "Factory Desktop" table entry | Line 118 `{ LAUNCHER_APP_FACTORY_DESKTOP, "原厂桌面", LV_SYMBOL_HOME, 0x16a085 }` |
| Current behavior | `launcher_restore_factory_launcher()` → unmounts upgtool's bind mount → `exec /usr/bin/launcher` (the factory Android desktop) |
| Reference implementation | `/home/lvgltest/wxbUI/my_launcher_img/my_launcher/launcher_ui.c` (256 lines, 1280x720 landscape, one large 520px card per page, left/right paging, JPEG icons) |
| Screen | 720x1280 portrait (32bpp); physical keys: order (点餐)=114(LEFT), service (服务)=102(RIGHT), benefits (福利)=115(ENTER), pay (买单)=116(BACK) |

---

## 2. Requirement Breakdown

**R1 Rename the table entry + change its behavior**
In `s_apps[]`, change "Factory Desktop" (原厂桌面) to "Switch Desktop" (切换桌面); after a click it no longer execs the factory launcher, but instead **switches to the landscape enlarged menu mode**.

**R2 Landscape enlarged menu (coverflow)**
- A row of cards logically: 1 selected in the middle (enlarged ~1.6x, opaque), 1 at normal size on each side (~1.0x, semi-transparent ~0.6), and anything farther is hidden.
- **With animation** during left/right key navigation: position + scale transition together, 400ms easing (`cubic-bezier(.22,.61,.36,1)`).
- Menu items = all applications currently on the desktop (including external applications), reusing the existing icon symbols + background colors; no new image resources are added.

**R3 Two-way switching (toggle)**
- Portrait grid desktop → click "Switch Desktop" (切换桌面) → landscape enlarged menu
- Landscape enlarged menu → click the same "Switch Desktop" (切换桌面) item → return to the portrait grid desktop

**R4 Key mapping**

| Key | In landscape menu mode |
|---|---|
| order (点餐) 114 / LEFT | select the previous item (with animation) |
| service (服务) 102 / RIGHT | select the next item (with animation) |
| benefits (福利) 115 / ENTER | launch the selected application |
| pay (买单) 116 / BACK | return to the portrait desktop (suggested, to be confirmed) |

**R5 What stays unchanged**
The layout, focus navigation, external application loading, and reboot/shutdown confirmation dialogs of the default portrait grid desktop all stay as they are.

---

## 3. Four Things That Need Your Decision

### Q1 (Most Critical) How Should the Landscape Mode Be Presented?

| | Option A: rotate the whole screen 90° | Option B: a horizontal enlarged band within the portrait screen |
|---|---|---|
| Approach | lay out the container at 1280x720 and rotate it to portrait with `transform_rotation=900` | no rotation; icons are arranged horizontally in the middle of the 720-wide screen |
| Card size | largest (300~520px) | medium (selected ~272px, sides 170px) |
| Left/right key semantics | the screen moves **up/down** (counterintuitive; the device must be turned sideways to view) | the screen moves **left/right** (intuitively consistent) |
| Performance | full-screen redraw every frame after rotation; risk of frame drops with 768MHz software rendering | only the middle band is redrawn; low overhead |
| Implementation effort | coordinate/focus/touch conversion after rotation must be handled | pure absolute positioning + animation |

**Recommendation: Option B** (the device is mounted in portrait, the key semantics are consistent, and performance is good; the enlargement effect is exactly the same).

### Q2 Should the Factory Desktop Entry Be Kept?

After the change to "Switch Desktop" (切换桌面), the factory Android launcher has no entry point.
- Option ①: remove it entirely (recommended; the factory desktop is basically useless on the LVGL desktop)
- Option ②: keep it, moving it to a "Launch Factory Desktop" button in the "Settings" page

### Q3 How Many Applications Should the Landscape Menu Contain?

- Option ①: all (19 entries + external applications); sliding is longer
- Option ②: only the N commonly used items (you specify)

### Q4 What Should the Pay (买单, BACK) Key Do in the Landscape Menu?

- Option ①: return directly to the portrait desktop (recommended)
- Option ②: no effect; the only way back is to select "Switch Desktop" (切换桌面)

---

## 4. Implementation Points (Code Accordingly After Confirmation; Do Not Create a New Page)

1. **Do not create a new page**; add mode states inside `launcher_page.c` (grid mode / landscape menu mode) to avoid the problem of unbalanced page-stack and focus-group entry/exit (an existing lesson: focus groups are shared, so entry and exit must be paired).
2. **Animation**: `lv_anim` drives `x` and the scale together; for scaling, prefer `lv_obj_set_style_transform_scale` (overall scaling; the icon symbols enlarge with it, so font sizes do not need to change); do not rely on flex reflow; use absolute positioning throughout.
3. **Performance**: create/display only 3 visible cards, and add `LV_OBJ_FLAG_HIDDEN` to the rest; do not trigger a full-screen redraw during animation.
4. **Rollback**: the grid desktop's objects are hidden rather than destroyed in landscape mode; they are not rebuilt when switching back, avoiding state loss.
5. After the changes, follow the existing deployment process (`make -j2` → atomic replacement → reboot), and **verification is done manually by you**.

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
