---
title: "Bugfix retrospective and archive notes"
date: 2026-09-24 16:17:57
lang: en
permalink: en/2026/09/24/bugfix-readme/
search: true
categories:
- 排障手记
- 综合
tag:
- 综合
- bugfix
---


# Bug Fix Archive

This directory archives **the documentation of every bug fix**. Rule: for each bug fixed, add a new
`bugfix_<date>_<number>_summary.md` to this directory, writing out "symptom → root cause → localization process → solution → verification".

## Privacy red line (mandatory)

Consistent with `AI工作流/README.md`: **documents, git notes, and archived files must not contain real SSH passwords, accounts, or real IP addresses**.
Always use placeholders: `<设备IP>` / `<密码>`.

## Naming conventions

```
bugfix/
├── README.md                              # 本文件（约定说明 + 索引）
├── bugfix_20260922_01_mplayer视频红蓝通道错乱.md
├── bugfix_20260922_02_xxx.md
└── ...
```

- File name format: `bugfix_<date>_<number>_summary.md`
  - **Date**: the day the fix was completed, `YYYYMMDD` eight digits (e.g. `20260922`).
  - **Number**: a two-digit incrementing number **within the day**, starting from `01` (e.g. `01`, `02`).
  - **Summary**: in Chinese, without spaces.
  - Example: `bugfix_20260922_01_mplayer视频红蓝通道错乱.md`
  This way file names sort naturally by time, making the order of fixes obvious at a glance, and it does not depend on the git commit SHA
  (the file name would change the commit's own SHA, creating a chicken-and-egg circular dependency, so it is not adopted).
- Once assigned, a number is never reused or reordered; even if a fix is rolled back, the document is kept, with 「已回退」 (rolled back) noted in the body.
- After adding a new file, a row **must** be added to the "Index" table at the end of this file.
- If the project has a git repository, it is **recommended** to fill in the short SHA of the commit that fixed the bug in the "Related commit" line at the top of the document
  (backfilled after committing, which does not affect the file name).

## Document structure (required in every article)

| Section | Content requirement |
|---|---|
| **Symptom** | The external manifestation seen by the user/tester. Only write visible facts, not speculation |
| **Scope of impact** | Which functions/pages/processes are affected; which are **not** affected (to avoid harming the innocent) |
| **Root cause** | Explain "why this happens" at the mechanism level. It must be able to answer "why exactly this byte/step" |
| **Localization process** | How the truth was approached step by step: **key experiments**, wrong directions ruled out, and **why previous judgments were wrong** |
| **Solution** | Specifically which files and lines were changed, and why. Include code snippets |
| **Verification** | Reproducible verification steps + actual results. **Color/display issues must be confirmed by human eyes** |
| **Lessons learned** | Transferable methodology or pitfalls encountered (this section is the easiest to omit, but has the most reuse value) |

## Writing discipline (inherited from existing lessons in this project)

1. **Distinguish "hypothesis" from "measurement"**: only conclusions measured by eye/log/probe are written as facts; reasoning is always labeled as reasoning.
2. **Self-referential loops do not count as verification**: capturing data → decoding it per the hypothesis → "looks right" is not evidence. Display issues must be closed with human eyes.
3. **Record failed directions**: write down the wrong paths taken as well, otherwise later comers will walk them again.
4. **Commands must be reproducible**: localization/verification commands must be directly paste-executable (remember to replace placeholders).
5. **Do not just write "fixed"**: the verification conditions and results must be written clearly, and anything not fully verified must be explicitly marked.

## Index

| File | Title | Layer involved | Date |
|---|---|---|---|
| [bugfix_20260922_01](bugfix_20260922_01_mplayer视频红蓝通道错乱.md) | mplayer plays video with red/blue channels swapped | framebuffer / external player | 2026-09-22 |
| [bugfix_20260922_02](bugfix_20260922_02_收音机刻度尺全挤在左侧.md) | All the radio page scale marks crowded on the left | LVGL layout / width API | 2026-09-22 |
| [bugfix_20260922_03](bugfix_20260922_03_FM_daemon因SIGPIPE静默退出.md) | FM daemon exits silently due to SIGPIPE; the page always shows "chip 0000" | user-space daemon / socket | 2026-09-22 |
| [bugfix_20260922_04](bugfix_20260922_04_桌面FM图标渲染成方框.md) | The desktop "radio" icon renders as a hollow box | font glyph / launcher | 2026-09-22 |
| [bugfix_20260923_01](bugfix_20260923_01_蓝牙显示已连接实际未连接.md) | Bluetooth shows "connected" but is actually not connected | user-space Bluetooth protocol stack / LVGL Bluetooth page | 2026-09-23 |
| [bugfix_20260923_02](bugfix_20260923_02_页面离场不清焦点组导致桌面焦点环消失.md) | The page leaves without clearing the focus group, causing the desktop focus ring to disappear | LVGL page framework / desktop navigation | 2026-09-23 |
| [bugfix_20260923_03](bugfix_20260923_03_GBA游戏点确认后无法打开.md) | GBA game cannot be opened after pressing confirm | emulator frontend selection / SDL2 video backend | 2026-09-23 |
| [bugfix_20260923_04](bugfix_20260923_04_GBA改用miniretro后仍黑屏.md) | GBA still shows a black screen after switching to miniretro | miniretro frame callback / rendering pipeline | 2026-09-23 |
| [bugfix_20260923_05](bugfix_20260923_05_GBA画面纵向条纹撕裂.md) | GBA picture has vertical stripes/tearing | miniretro frame callback / pitch addressing | 2026-09-23 |
| [bugfix_20260923_06](bugfix_20260923_06_GBA游戏音频滋滋爆音.md) | GBA audio crackles and pops | miniretro audio resampling / Bluetooth fifo | 2026-09-23 |
| [bugfix_20260923_07](bugfix_20260923_07_GBA退出游戏时画面卡顿僵住.md) | GBA picture stutters/freezes when exiting the game | miniretro exit path / fb page flipping | 2026-09-23 |
| [bugfix_20260923_08](bugfix_20260923_08_GBA画面红蓝互换(颜色回归).md) | GBA picture has red/blue swapped (color regression) | miniretro scaling/rotation / byte order | 2026-09-23 |
| [bugfix_20260923_09](bugfix_20260923_09_GBA退出游戏返回列表卡顿.md) | GBA stutters when exiting the game and returning to the list | exit path / kernel reclaiming input device fds | 2026-09-23 |
| [bugfix_20260923_10](bugfix_20260923_10_GBA退出直接卡死_回滚握手方案.md) | GBA freezes outright on exit (FC also affected); rolled back 09's handshake plan | exit path / child process reaping | 2026-09-23 |
| [bugfix_20260923_11](bugfix_20260923_11_GBA退出卡黑屏与FC被污染_前端分离.md) | GBA exit hangs on black, FC implicated; frontends fully separated | shared frontend isolation / exit wait logic | 2026-09-23 |
| [bugfix_20260923_12](bugfix_20260923_12_GBA退出逻辑对齐FC.md) | GBA exit logic changed to be line-by-line identical to FC; dedicated branches removed | exit path convergence / eliminating isomorphic differences | 2026-09-23 |
| [bugfix_20260923_13](bugfix_20260923_13_GBA退出卡黑屏_前端退出清屏.md) | GBA exit hangs on black: the frontend clears the screen itself on exit (the truth behind FC's "smoothness") | frontend exit path / picture handover | 2026-09-23 |
| [bugfix_20260923_14](bugfix_20260923_14_GBA退出后卡死_页翻转残留.md) | GBA hangs after exit: page-flip residue (LVGL only draws page 0; the screen stays frozen on the game picture) | framebuffer page flipping / return-home on exit | 2026-09-23 |
| [bugfix_20260923_15](bugfix_20260923_15_GBA退出偶发卡在游戏画面_买单键漏给UI层.md) | GBA exit intermittently hangs: the 买单 key leaked to the UI layer → this page was popped → nobody repainted | input event residue / cross-thread repaint requests | 2026-09-23 |
| [bugfix_20260923_16](bugfix_20260923_16_GBA游戏进不去_超时补刀误杀.md) | GBA games cannot be entered: putting the "timeout supplementary kill" in the reaping thread = giving the game a 600ms lifespan (a regression from 15) | child process reaping / wait criterion | 2026-09-23 |
| [bugfix_20260923_17](bugfix_20260923_17_GBA音画延迟1到2秒_音箱端缓冲定位.md) | GBA audio lags video by 1~2s: after chain segmentation quantification, located in the speaker-side buffer (device side only 0.25s, uncontrollable) | audio chain / latency budget localization | 2026-09-23 |
| [bugfix_20260923_18](bugfix_20260923_18_GBA退出偶发残留游戏画面_强制翻页.md) | GBA intermittently leaves the game picture on exit: the precondition check in the fallback page flip turned the idempotent operation into intermittently not executed; changed to unconditional forced page flip + same-beat repaint | framebuffer page flipping / return-home on exit | 2026-09-23 |
| [bugfix_20260924_01](bugfix_20260924_01_视频播放卡顿_CPU预算表定位与旋转替换缩放.md) | Video playback stuttering: CPU budget table measurements show decoding was never the bottleneck; replaced scale with rotate + converted the source to 30fps Baseline; real-time ratio 0.75× → 1.08× | performance budget table / video post-processing | 2026-09-24 |
| [bugfix_20260924_02](bugfix_20260924_02_切换桌面横屏菜单白屏_transform渲染路径不可用.md) | "Switch desktop" landscape menu white screen: this LVGL build's transform rendering path is unavailable; any object with transform is not drawn at all; switched to a zero-transform set_size animation | LVGL rendering capability determination / desktop menu | 2026-09-24 |
| [bugfix_20260924_03](bugfix_20260924_03_横屏桌面只显示一半_根因是pivot未设而非transform不可用.md) | **Overturns 02**: transform has always been available; 02's white-screen root cause was transform_pivot not being set (default top-left corner; the large canvas rotates out of the visible area); landscape switched to the same design as fc_game_page: 1280x720 canvas + pivot 50% | LVGL rendering capability determination / desktop menu | 2026-09-24 |

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
