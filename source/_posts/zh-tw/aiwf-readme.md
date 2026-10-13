---
title: "AI 工作流歸檔規範"
date: 2026-09-22 20:38:54
lang: zh-TW
search: true
categories:
- AI工作流
- 归档规范
tag:
- AI协作
- 归档
permalink: zh-tw/2026/09/22/aiwf-readme/
---


# AI 工作流歸檔

本目錄歸檔 AI 協作過程中每次任務的**最終可交付產物**，按業務目標拆分子目錄。
規則：只收"能直接部署運行、達到結果"的最終產物（交付文檔 / 最終服務源碼 / 設備實際運行的部署腳本）；
**過程用的臨時腳本（部署調試、測試、診斷、探索類）一律不歸檔**。

## 隱私紅線（強制）

- 項目公開：**文檔、git 備註、歸檔文件中禁止出現真實 SSH 密碼、賬號、真實 IP**。
- 一律使用佔位符：`<設備IP>` / `<WiFi-IP>` / `<密碼>`；真實憑據只在運行參數或環境變量中提供。

## 目錄規範

| 子目錄 | 內容 |
|---|---|
| 01_WiFi打通/ | docs: 操作手冊/流程對比/工作總結/AI指導手冊/故障排查手冊/部署交付文檔；deploy: wifi.start（開機部署腳本） |
| 02_藍牙打通/ | docs: 6份文檔（含故障排查手冊）；src: bt_user_daemon.c(最終服務源碼)+bluetooth_page.c/h(LVGL界面源碼)；deploy: bt_bringup.start/bt_daemon/bt_wake.sh(設備實際運行部署) |
| 03_HT0可複用資產/ | ht0-wcn-radio Skill 快照（SKILL.md + references + 可直接運行的運維腳本） |
| 04_桌面應用框架/ | docs: LVGL 桌面應用架構與第三方接入規範 |
| 05_收音機/ | docs: FM 收音機規劃與逆向文檔（LVGL界面設計規格 / AI指導手冊 / 操作手冊 / 故障排查手冊 / 原理與移植Wiki / 啟動流程對比 / 部署交付文檔 / 工作過程總結 / ioctl命令表逆向還原）；src: fmprobe.c（ioctl 實測探針，已驗證 45/47）；fm_user_daemon.c（待實裝） |
| bugfix/ | 每次 bug 修復的說明文檔（現象/根因/定位/解決/驗證），索引見 bugfix/README.md |

新增業務目標時按 `NN_業務名/` 遞增編號，docs / src / deploy 視需要拆分。

## 文檔同步協議（版本化，打 tag 時同步）

文檔**不隨每次迭代提交更新**，按**版本定版（打 tag）**統一同步：

1. 日常迭代：只提交代碼 / 腳本 / 配置改動，備註寫清改動內容；不動文檔。
2. 打 tag 定版（用戶確認功能完善 / 穩定）時，一次性同步：
   - 對應任務 docs/ 文檔族（操作手冊 / 故障排查手冊 / AI指導手冊 / 部署交付文檔 / 流程對比 / 工作總結）+ Skill 資產（SKILL.md、references/、scripts/）
   - 文件增刪改名時更新本 README 目錄規範
   - 校驗：文檔中命令 / 路徑 / 產物與設備實際運行狀態一致（改過的層須實測過）
   - 打 tag：`git tag <vX.Y.Z>`，備註中文，寫明「定版範圍 + 同步更新的文檔清單」
3. tag 提交包含或緊隨文檔更新，保證「一個 tag = 一份完整文檔快照」可回溯。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
