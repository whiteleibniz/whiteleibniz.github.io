---
title: "ref_LVGL_页面框架"
date: 2026-09-24 16:17:01
lang: zh-CN
search: true
categories:
- 应用框架
- LVGL桌面架构
tag:
- LVGL
---


# 参考 · LVGL 9.6 / 页面框架细节（MEMORY.md §5 的明细）

> 主笔记只留结论与铁律，这里放"改代码时才需要的细节"。

## A. 基础坑
- **中文字体**：`lv_font_cn_16`（`LV_FONT_DEFAULT` 会出 tofu）。`line_height=31, base_line=9`
- **旋转**：`lv_obj_set_style_transform_rotation(obj, 900, 0)`（0.1° 单位）；**旋转后坐标/邻居判断仍用未旋转的逻辑坐标**
- **★ `lv_obj_get_width/height/x()` 读的是缓存 `obj->coords`** → **onCreate 里刚 `set_size` 完立刻 get 会返回 0**；
  靠宽度算坐标必须自己缓存，或先 `lv_obj_update_layout()`
- **★ `lv_obj_clean(parent)` 会删掉所有子对象** → 常驻句柄别挂在会被 clean 的容器下

## B. 图标（实测数据）
- `launcher_app_t` 只有 `symbol` 一个**字符串**字段，`create_app_icon()` 用 `lv_label` + `lv_font_montserrat_24`
  画在圆角色块上（**结构体无图片字段**）
- **★ 字形必须实证，不可假设**：`lv_font_cn_16` 与 `lv_font_montserrat_24` **都只有 60 个码位、全是 LVGL 符号集**
  - 无"电台/天线"形 → FM 图标用 `LV_SYMBOL_VOLUME_MAX`(F028)
  - **无手柄形** → `F11B`(gamepad)、`F26C`、`F12E` 全缺；FC/GBA 原都退化成 `LV_SYMBOL_FILE`(F15B)
  - 枚举工具：`ssh_tools/_tmp/glyph_ic.sh`（设备端扫 0xE000~0xFAFF 打印实际存在的码位）
- **手柄图标已落地**：`launcher_page.c` 的 `gamepad_icon_create()`，用 LVGL 图元拼（白色胶囊机身 + **用底色**挖空
  十字键与双圆钮，如同从机身上"挖空"）；其余应用仍走字体字形
- **★ 自绘图标必须用固定像素，不能按容器百分比**：字体字形尺寸由字号决定、**不随 `icon_box` 缩放**
  - 实测在用图标字形 box 多为 **24×24**（WIFI 30×23、EDIT 25×25、SETTINGS 24×24、DIRECTORY 24×18）
  - 手柄初版按 `88px × 70%` = **61×31**，比旁边大两倍半 → 已改**固定 26×17**
  - 量字形尺寸的工具：`ssh_tools/_tmp/font_metrics.sh`（打印 box_w/box_h/adv）
  - 几何避坑：两个圆钮的**偏移量若正好等于直径会相切成"葫芦"** → 需留缝（`off = dot*9/10`）
- **游戏列表页的封面是真图片**（`lv_image` 载同名 `.png`）→ **本机 PNG 解码可用**，图片型图标这条路可行

## C. 状态栏 / 系统接口（`lv_pages/launcher_page.c`）
| 项 | 接口 |
|---|---|
| WiFi | `/sys/class/net/wlan0/operstate` |
| rfkill | `/sys/class/rfkill/rfkill0/soft` |
| 蓝牙 | `/tmp/bt_ctl.sock` |
| 电池 | `/sys/class/power_supply/battery/capacity` |

（左侧 `time_label`、右侧 `launcher_battery_icon_create`）

## D. 页面框架
- `onDestroy`：释放**自己的**定时器/回调，**不能删 `page->root`**
- `LV_PAGE_MAX_STACK_SIZE = 8`
- `lv_finish_activity` 带 `PM_BUSY_TIMEOUT_MS = 2000` 兜底 → "页面切换中"不是永久卡
- **★ 默认焦点组全局共享，进/出必须成对**：已下沉到框架层，`lv_page_manager.cc` 的 `pm_page_destroy` 统一
  `pm_purge_group_objs_of(root)` → 新页不用自己管；残留会打 `[pm] 页面 'x' 离场，摘掉 N 个…`
- **★ 判定"控件能否被选中"必须祖先感知**：`LV_OBJ_FLAG_HIDDEN` **只看自己**；隐藏面板隐藏的是**外层容器**
  → 子控件会被选中成"无 user_data 焦点"（表现：焦点框消失）。`main.c` 的 `group_find_neighbor` 已改 `nav_obj_visible(o)`

## E. launcher 加应用
1. 加枚举
2. 加 `s_apps[]` 条目（**数组顺序 = 视觉顺序**）
3. 加 `open_app` 的 switch 分支
4. 跳转：`lv_start_activity(&g_xxx_page, LV_PAGE_FLAG_DEFAULT, LV_PAGE_ANIM_SLIDE_LEFT, 220)`

**★ 两个陷阱**：
- **桌面初始焦点 = `s_apps[]` 索引 8**（历史：0 文件管理 … 7 蓝牙 **8 收音机** 9 图库 10 任务管理 11 原厂桌面；
  加 GBA/FC 后索引后移）→ **改完 `s_apps[]` 必须回看这一行**
- **桌面焦点随页面栈保留**（要重启 app 才回索引 8）；**左右不跨行**

## ★★★ transform（旋转/缩放）**可用** —— pivot 必须显式设 50%（2026-09-24 纠正 bugfix_02）
- **结论：可用**。长期在用的 `fc_game_page.c` 就是「1280x720 画布 + `lv_obj_center` +
  `transform_rotation=900`」，横屏列表一直正常。
- **★★ 铁律：`transform_pivot_x/y` 必须显式设 `lv_pct(50)`**。本机 style 默认 pivot = **对象左上角**；
  大画布绕左上角转 90° → 内容整体转出可视区 → **"整页一个像素都看不到"**（观感=白屏/半屏）。
  这是 02 那条"transform 不可用"错误结论的真实根因。
- **旋转后坐标系（实测）：物理 (px,py) = (720-ly, lx)
  → 视觉 x ≡ 逻辑 x**（所以卡片沿逻辑 x 排列时**方向键不需要换算**，`app_runtime_set_ui_rotation(0)`）
  **→ 视觉 y = 720 - 逻辑 y**（"视觉上方" = 逻辑 y **小**）。易错清单：
  标题贴 cell **顶**、玻璃反光条贴 box **底**、`shadow_ofs_y` 取**负**、容器渐变用 `LV_GRAD_DIR_HOR`。
- **❌ 已废弃的两条错路**：把一次白屏定性为"本机 transform 渲染路径不可用"（02），
  并因此绕道做整屏 framebuffer 转置 `fb_rotate`（又出"只显示一半"）。**两者均已删除。**
- **★ 教训**：下"设备/平台不支持 X"的定性前，**先在本项目 grep X 的成功用例并逐项 diff**；
  注释按**作用域**读 —— `/* transform disabled */` 只针对 `launcher_start_zoom()` 那个按下动画。
- 放大/位移动画仍优先用 `lv_obj_set_size` + `lv_obj_align` + `lv_anim`（无需 pivot，成本更低）；
  字体不随缩放变（图标变大需另做大字号字形或图片型图标）。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
