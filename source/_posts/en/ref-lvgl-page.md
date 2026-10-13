---
title: "ref_LVGL_Page Framework"
date: 2026-09-24 16:17:01
lang: en
permalink: en/2026/09/24/ref-lvgl-page/
search: true
categories:
- 应用框架
- LVGL桌面架构
tag:
- LVGL
---


# Reference · LVGL 9.6 / Page Framework Details (detail of MEMORY.md §5)

> The main note only keeps conclusions and iron rules; this is where the "details you only need when changing code" go.

## A. Basic Pitfalls
- **Chinese fonts**: `lv_font_cn_16` (`LV_FONT_DEFAULT` produces tofu). `line_height=31, base_line=9`
- **Rotation**: `lv_obj_set_style_transform_rotation(obj, 900, 0)` (0.1° units); **after rotation, coordinate/neighbor checks still use the unrotated logical coordinates**
- **★ `lv_obj_get_width/height/x()` reads the cached `obj->coords`** → **in onCreate, calling get immediately after `set_size` returns 0**;
  coordinates computed from widths must be cached yourself, or call `lv_obj_update_layout()` first
- **★ `lv_obj_clean(parent)` deletes all child objects** → persistent handles must not be hung under a container that gets cleaned

## B. Icons (measured data)
- `launcher_app_t` has only one **string** field, `symbol`; `create_app_icon()` uses `lv_label` + `lv_font_montserrat_24`
  to draw on a circular color block (**the struct has no image field**)
- **★ Glyphs must be verified empirically, never assumed**: `lv_font_cn_16` and `lv_font_montserrat_24` **both have only 60 code points, all from the LVGL symbol set**
  - No "radio/antenna" shape → the FM icon uses `LV_SYMBOL_VOLUME_MAX`(F028)
  - **No gamepad shape** → `F11B`(gamepad), `F26C`, `F12E` are all missing; FC/GBA both originally fell back to `LV_SYMBOL_FILE`(F15B)
  - Enumeration tool: `ssh_tools/_tmp/glyph_ic.sh` (scans 0xE000~0xFAFF on the device and prints the code points that actually exist)
- **Gamepad icon has landed**: `gamepad_icon_create()` in `launcher_page.c`, assembled from LVGL primitives (white capsule body + **using the background color** to cut out
  the D-pad and two round buttons, as if "hollowed out" from the body); other applications still use font glyphs
- **★ Self-drawn icons must use fixed pixels, not container percentages**: font glyph size is determined by the font size and **does not scale with `icon_box`**
  - Measured: most in-use icon glyph boxes are **24x24** (WIFI 30x23, EDIT 25x25, SETTINGS 24x24, DIRECTORY 24x18)
  - The first version of the gamepad used `88px × 70%` = **61x31**, two and a half times larger than its neighbors → changed to a **fixed 26x17**
  - Tool for measuring glyph dimensions: `ssh_tools/_tmp/font_metrics.sh` (prints box_w/box_h/adv)
  - Geometry pitfall: if the two round buttons' **offset exactly equals the diameter, they merge into a "gourd"** → a gap must be left (`off = dot*9/10`)
- **The game list page's covers are real images** (`lv_image` loads the same-named `.png`) → **PNG decoding is available on this machine**, so the image-type icon path is viable

## C. Status Bar / System Interfaces (`lv_pages/launcher_page.c`)
| Item | Interface |
|---|---|
| WiFi | `/sys/class/net/wlan0/operstate` |
| rfkill | `/sys/class/rfkill/rfkill0/soft` |
| Bluetooth | `/tmp/bt_ctl.sock` |
| Battery | `/sys/class/power_supply/battery/capacity` |

(Left side `time_label`, right side `launcher_battery_icon_create`)

## D. Page Framework
- `onDestroy`: release **your own** timers/callbacks; **do not delete `page->root`**
- `LV_PAGE_MAX_STACK_SIZE = 8`
- `lv_finish_activity` has a `PM_BUSY_TIMEOUT_MS = 2000` fallback → "page switching" is not a permanent freeze
- **★ the default focus group is shared globally; enter/exit must be paired**: already pushed down to the framework layer, where `lv_page_manager.cc`'s `pm_page_destroy` uniformly
  calls `pm_purge_group_objs_of(root)` → new pages do not need to handle it themselves; leftovers print `[pm] page 'x' exited, removing N ...`
- **★ determining "whether a widget can be selected" must be ancestor-aware**: `LV_OBJ_FLAG_HIDDEN` **only looks at itself**; what a hidden panel hides is the **outer container**
  → child widgets can be selected into "focus with no user_data" (symptom: the focus frame disappears). `group_find_neighbor` in `main.c` has been changed to `nav_obj_visible(o)`

## E. Adding an Application to the launcher
1. Add an enum
2. Add an `s_apps[]` entry (**array order = visual order**)
3. Add a switch branch to `open_app`
4. Jump: `lv_start_activity(&g_xxx_page, LV_PAGE_FLAG_DEFAULT, LV_PAGE_ANIM_SLIDE_LEFT, 220)`

**★ Two traps**:
- **The desktop's initial focus = index 8 of `s_apps[]`** (history: 0 File Manager … 7 Bluetooth **8 Radio** 9 Gallery 10 Task Manager 11 Stock Desktop;
  indices shift after adding GBA/FC) → **after changing `s_apps[]`, always re-check this line**
- **The desktop focus is retained along with the page stack** (you must restart the app to return to index 8); **left/right do not cross rows**

## ★★★ transform (rotation/scaling) **works** — the pivot must be explicitly set to 50% (2026-09-24, correcting bugfix_02)
- **Conclusion: it works**. The long-used `fc_game_page.c` is exactly「1280x720 canvas + `lv_obj_center` +
  `transform_rotation=900`」, and the landscape list has always worked correctly.
- **★★ Iron rule: `transform_pivot_x/y` must be explicitly set to `lv_pct(50)`**. This machine's style default pivot = **the object's top-left corner**;
  rotating a large canvas 90° around its top-left corner → the content rotates entirely out of the visible area → **"not a single pixel of the whole page is visible"** (looks like a white screen/half screen).
  This is the real root cause of item 02's erroneous conclusion that "transform is unusable".
- **Post-rotation coordinate system (measured): physical (px,py) = (720-ly, lx)
  → visual x ≡ logical x** (so when cards are arranged along the logical x-axis, **the direction keys need no conversion**, `app_runtime_set_ui_rotation(0)`)
  **→ visual y = 720 - logical y** ("visually up" = logical y **small**). Error-prone checklist:
  titles hug the cell **top**, the glass reflection strip hugs the box **bottom**, `shadow_ofs_y` takes a **negative** value, container gradients use `LV_GRAD_DIR_HOR`.
- **❌ Two deprecated wrong paths**: characterizing one white screen as "this machine's transform rendering path is unusable" (02),
  and consequently detouring to a full-screen framebuffer transpose `fb_rotate` (which then produced "only half is displayed"). **Both have been deleted.**
- **★ Lesson**: before concluding "the device/platform does not support X", **first grep this project for successful use cases of X and diff them one by one**;
  comments should be read by **scope** — `/* transform disabled */` only applies to that press animation of `launcher_start_zoom()`.
- For zoom/translation animations, still prefer `lv_obj_set_size` + `lv_obj_align` + `lv_anim` (no pivot needed, lower cost);
  fonts do not scale (enlarged icons need a separate larger-font glyph or an image-type icon).

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
