---
title: "ref_LVGL_頁面框架"
date: 2026-09-24 16:17:01
lang: zh-TW
search: true
categories:
- 应用框架
- LVGL桌面架构
tag:
- LVGL
permalink: zh-tw/2026/09/24/ref-lvgl-page/
---


# 參考 · LVGL 9.6 / 頁面框架細節（MEMORY.md §5 的明細）

> 主筆記只留結論與鐵律，這裡放"改代碼時才需要的細節"。

## A. 基礎坑
- **中文字體**：`lv_font_cn_16`（`LV_FONT_DEFAULT` 會出 tofu）。`line_height=31, base_line=9`
- **旋轉**：`lv_obj_set_style_transform_rotation(obj, 900, 0)`（0.1° 單位）；**旋轉後坐標/鄰居判斷仍用未旋轉的邏輯座標**
- **★ `lv_obj_get_width/height/x()` 讀的是緩存 `obj->coords`** → **onCreate 裡剛 `set_size` 完立刻 get 會返回 0**；
  靠寬度算座標必須自己緩存，或先 `lv_obj_update_layout()`
- **★ `lv_obj_clean(parent)` 會刪掉所有子對象** → 常駐句柄別掛在會被 clean 的容器下

## B. 圖標（實測數據）
- `launcher_app_t` 只有 `symbol` 一個**字符串**字段，`create_app_icon()` 用 `lv_label` + `lv_font_montserrat_24`
  畫在圓角色塊上（**結構體無圖片字段**）
- **★ 字形必須實證，不可假設**：`lv_font_cn_16` 與 `lv_font_montserrat_24` **都只有 60 個碼位、全是 LVGL 符號集**
  - 無"電臺/天線"形 → FM 圖標用 `LV_SYMBOL_VOLUME_MAX`(F028)
  - **無手柄形** → `F11B`(gamepad)、`F26C`、`F12E` 全缺；FC/GBA 原都退化成 `LV_SYMBOL_FILE`(F15B)
  - 枚舉工具：`ssh_tools/_tmp/glyph_ic.sh`（設備端掃 0xE000~0xFAFF 打印實際存在的碼位）
- **手柄圖標已落地**：`launcher_page.c` 的 `gamepad_icon_create()`，用 LVGL 圖元拼（白色膠囊機身 + **用底色**挖空
  十字鍵與雙圓鈕，如同從機身上"挖空"）；其餘應用仍走字體字形
- **★ 自繪圖標必須用固定像素，不能按容器百分比**：字體字形尺寸由字號決定、**不隨 `icon_box` 縮放**
  - 實測在用圖標字形 box 多為 **24×24**（WIFI 30×23、EDIT 25×25、SETTINGS 24×24、DIRECTORY 24×18）
  - 手柄初版按 `88px × 70%` = **61×31**，比旁邊大兩倍半 → 已改**固定 26×17**
  - 量字形尺寸的工具：`ssh_tools/_tmp/font_metrics.sh`（打印 box_w/box_h/adv）
  - 幾何避坑：兩個圓鈕的**偏移量若正好等於直徑會相切成"葫蘆"** → 需留縫（`off = dot*9/10`）
- **遊戲列表頁的封面是真圖片**（`lv_image` 載同名 `.png`）→ **本機 PNG 解碼可用**，圖片型圖標這條路可行

## C. 狀態欄 / 系統接口（`lv_pages/launcher_page.c`）
| 項 | 接口 |
|---|---|
| WiFi | `/sys/class/net/wlan0/operstate` |
| rfkill | `/sys/class/rfkill/rfkill0/soft` |
| 藍牙 | `/tmp/bt_ctl.sock` |
| 電池 | `/sys/class/power_supply/battery/capacity` |

（左側 `time_label`、右側 `launcher_battery_icon_create`）

## D. 頁面框架
- `onDestroy`：釋放**自己的**定時器/回調，**不能刪 `page->root`**
- `LV_PAGE_MAX_STACK_SIZE = 8`
- `lv_finish_activity` 帶 `PM_BUSY_TIMEOUT_MS = 2000` 兜底 → "頁面切換中"不是永久卡
- **★ 默認焦點組全局共享，進/出必須成對**：已下沉到框架層，`lv_page_manager.cc` 的 `pm_page_destroy` 統一
  `pm_purge_group_objs_of(root)` → 新頁不用自己管；殘留會打 `[pm] 頁面 'x' 離場，摘掉 N 個…`
- **★ 判定"控件能否被選中"必須祖先感知**：`LV_OBJ_FLAG_HIDDEN` **只看自己**；隱藏面板隱藏的是**外層容器**
  → 子控件會被選中成"無 user_data 焦點"（表現：焦點框消失）。`main.c` 的 `group_find_neighbor` 已改 `nav_obj_visible(o)`

## E. launcher 加應用
1. 加枚舉
2. 加 `s_apps[]` 條目（**數組順序 = 視覺順序**）
3. 加 `open_app` 的 switch 分支
4. 跳轉：`lv_start_activity(&g_xxx_page, LV_PAGE_FLAG_DEFAULT, LV_PAGE_ANIM_SLIDE_LEFT, 220)`

**★ 兩個陷阱**：
- **桌面初始焦點 = `s_apps[]` 索引 8**（歷史：0 文件管理 … 7 藍牙 **8 收音機** 9 圖庫 10 任務管理 11 原廠桌面；
  加 GBA/FC 後索引後移）→ **改完 `s_apps[]` 必須回看這一行**
- **桌面焦點隨頁面棧保留**（要重啟 app 才回索引 8）；**左右不跨行**

## ★★★ transform（旋轉/縮放）**可用** —— pivot 必須顯式設 50%（2026-09-24 糾正 bugfix_02）
- **結論：可用**。長期在用的 `fc_game_page.c` 就是「1280x720 畫布 + `lv_obj_center` +
  `transform_rotation=900`」，橫屏列表一直正常。
- **★★ 鐵律：`transform_pivot_x/y` 必須顯式設 `lv_pct(50)`**。本機 style 默認 pivot = **對象左上角**；
  大畫布繞左上角轉 90° → 內容整體轉出可視區 → **"整頁一個像素都看不到"**（觀感=白屏/半屏）。
  這是 02 那條"transform 不可用"錯誤結論的真實根因。
- **旋轉後座標系（實測）：物理 (px,py) = (720-ly, lx)
  → 視覺 x ≡ 邏輯 x**（所以卡片沿邏輯 x 排列時**方向鍵不需要換算**，`app_runtime_set_ui_rotation(0)`）
  **→ 視覺 y = 720 - 邏輯 y**（"視覺上方" = 邏輯 y **小**）。易錯清單：
  標題貼 cell **頂**、玻璃反光條貼 box **底**、`shadow_ofs_y` 取**負**、容器漸變用 `LV_GRAD_DIR_HOR`。
- **❌ 已廢棄的兩條錯路**：把一次白屏定性為"本機 transform 渲染路徑不可用"（02），
  並因此繞道做整屏 framebuffer 轉置 `fb_rotate`（又出"只顯示一半"）。**兩者均已刪除。**
- **★ 教訓**：下"設備/平臺不支持 X"的定性前，**先在本項目 grep X 的成功用例並逐項 diff**；
  註釋按**作用域**讀 —— `/* transform disabled */` 只針對 `launcher_start_zoom()` 那個按下動畫。
- 放大/位移動畫仍優先用 `lv_obj_set_size` + `lv_obj_align` + `lv_anim`（無需 pivot，成本更低）；
  字體不隨縮放變（圖標變大需另做大字號字形或圖片型圖標）。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
