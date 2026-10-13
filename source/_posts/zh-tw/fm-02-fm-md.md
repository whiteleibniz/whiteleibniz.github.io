---
title: "FM上電_腳本說明"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-02-fm-md/
---


# FM 射頻上電腳本

> 日期：2026-09-23　設備 <設備IP>（Alpine / SC9832A / Marlin2 combo）
> 背景：`zz_fm.start` 以前只把 `fm_user_daemon` 拉起來，**從來沒發過 `on`**，
> 於是開機後呈現"daemon 在、`chipid=0x2341` 正常，但射頻 `off`"的假可用狀態。

---

## 1. 上電鏈（缺一不可）

```
01_wifi.start        download 燒 CP 固件 + SDIO 枚舉 + insmod marlin_fm/sprdwl
   ↓
bt_bringup.start     重啟 wcnd → 連 external_wcn → @wcnd 發 "wcn BT-OPEN"
   ↓
fm_user_daemon       向 @wcnd 發 "wcn FM-OPEN" 並【長期保持該連接】；常開 /dev/fm 的 fd
   ↓
fm_powerup.sh   ★    發 `on` → POWER_UP（本次新增的缺失環節）
```

任何一環缺失的表現都是 `ioctl -110`（`set_marlin_wakeup ack timeout`）。

## 2. 三個腳本

| 文件 | 作用 |
|---|---|
| `/root/fm_powerup.sh` | **射頻上電**，冪等。用法 `sh /root/fm_powerup.sh [freq_kHz] [vol]`，默認 `97400 5` |
| `/etc/local.d/zz_fm.start` | 開機自啟：起 daemon → 調 `fm_powerup.sh` → **拉起保活** |
| `/root/fm_watchdog.sh` | 每 5s 檢查 daemon，掉了就重啟 daemon **並異步補一次上電** |

### `fm_powerup.sh` 內部流程

1. 前置校驗：`wcnd` 在跑、`/dev/fm` 存在（否則 FATAL 退出並提示先跑 bt_bringup）
2. daemon 不在則拉起；輪詢等待 `/tmp/fm_ctl.sock` 出現（最多 30s）
3. 讀 `state`，已是 `on` 則跳過；否則發 `on`，最多重試 3 次
   —— 失敗時**重啟 daemon 重建 @wcnd 的 FM-OPEN 長連接**再試（這是 -110 的標準治法）
4. 成功後置 `tune` / `vol` / `mute 0`，打印最終 `state`
5. 日誌同時寫 `/var/log/fm_boot.log`

**注意**：腳本刻意不調用 `rssi`——該 ioctl 每次固定阻塞約 4.2s 後超時。
socket 交互統一走帶 `settimeout(6)` 的 python，避免把腳本掛死。

## 3. 實測結果（2026-09-23）

```
===== begin: freq=97400 vol=5 =====
前置 OK: wcnd=1140 /dev/fm 存在
socket ready, daemon pid=1228
上電前 state=off
on 返回(第 1 次): OK on
state -> on
tune 97400 -> OK tune 97400
vol 5 -> OK vol 5
mute 0 -> OK mute 0
最終 state: OK on freq=97400 vol=5 mute=0 chipid=0x2341 rds=1
===== end: OK =====
```

保活：`pid=30867`，再次執行腳本會自行 `exit 0`（pid 文件單實例生效）。

## 4. 順帶修掉的漏洞

**`fm_watchdog.sh` 以前沒人負責拉起**（全盤 grep 只在它自己的文件裡命中自身名字），
即 daemon 一旦掛掉就再不自愈。現由 `zz_fm.start` 末尾拉起，且重啟後會異步補上電。

## 5. 踩到的坑

用 `ps -o pid,args | grep '[f]m_watchdog.sh'` 判活會**誤判為"已在跑"**——
它命中了**承載這條命令的 `sh -c` 進程本身**（PID 29166）。
`[f]` 寫法只能避開 `grep` 自己，避不開外殼的 `sh -c`。
**shell 腳本單實例一律用 pid 文件 + `kill -0` 判定。**

## 6. 已知副作用

FM 射頻上電後內核會持續刷 `(FM_RDS)` / `FM_DRV` 日誌並推高 load（約 9 行/秒），
調試其它內核問題時先 `python3 /root/fm_cli.py off` 關掉射頻。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
