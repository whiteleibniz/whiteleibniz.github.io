---
title: "FM上电_脚本说明"
date: 2026-09-23 12:16:40
lang: zh-CN
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM 射频上电脚本

> 日期：2026-09-23　设备 <设备IP>（Alpine / SC9832A / Marlin2 combo）
> 背景：`zz_fm.start` 以前只把 `fm_user_daemon` 拉起来，**从来没发过 `on`**，
> 于是开机后呈现"daemon 在、`chipid=0x2341` 正常，但射频 `off`"的假可用状态。

---

## 1. 上电链（缺一不可）

```
01_wifi.start        download 烧 CP 固件 + SDIO 枚举 + insmod marlin_fm/sprdwl
   ↓
bt_bringup.start     重启 wcnd → 连 external_wcn → @wcnd 发 "wcn BT-OPEN"
   ↓
fm_user_daemon       向 @wcnd 发 "wcn FM-OPEN" 并【长期保持该连接】；常开 /dev/fm 的 fd
   ↓
fm_powerup.sh   ★    发 `on` → POWER_UP（本次新增的缺失环节）
```

任何一环缺失的表现都是 `ioctl -110`（`set_marlin_wakeup ack timeout`）。

## 2. 三个脚本

| 文件 | 作用 |
|---|---|
| `/root/fm_powerup.sh` | **射频上电**，幂等。用法 `sh /root/fm_powerup.sh [freq_kHz] [vol]`，默认 `97400 5` |
| `/etc/local.d/zz_fm.start` | 开机自启：起 daemon → 调 `fm_powerup.sh` → **拉起保活** |
| `/root/fm_watchdog.sh` | 每 5s 检查 daemon，掉了就重启 daemon **并异步补一次上电** |

### `fm_powerup.sh` 内部流程

1. 前置校验：`wcnd` 在跑、`/dev/fm` 存在（否则 FATAL 退出并提示先跑 bt_bringup）
2. daemon 不在则拉起；轮询等待 `/tmp/fm_ctl.sock` 出现（最多 30s）
3. 读 `state`，已是 `on` 则跳过；否则发 `on`，最多重试 3 次
   —— 失败时**重启 daemon 重建 @wcnd 的 FM-OPEN 长连接**再试（这是 -110 的标准治法）
4. 成功后置 `tune` / `vol` / `mute 0`，打印最终 `state`
5. 日志同时写 `/var/log/fm_boot.log`

**注意**：脚本刻意不调用 `rssi`——该 ioctl 每次固定阻塞约 4.2s 后超时。
socket 交互统一走带 `settimeout(6)` 的 python，避免把脚本挂死。

## 3. 实测结果（2026-09-23）

```
===== begin: freq=97400 vol=5 =====
前置 OK: wcnd=1140 /dev/fm 存在
socket ready, daemon pid=1228
上电前 state=off
on 返回(第 1 次): OK on
state -> on
tune 97400 -> OK tune 97400
vol 5 -> OK vol 5
mute 0 -> OK mute 0
最终 state: OK on freq=97400 vol=5 mute=0 chipid=0x2341 rds=1
===== end: OK =====
```

保活：`pid=30867`，再次执行脚本会自行 `exit 0`（pid 文件单实例生效）。

## 4. 顺带修掉的漏洞

**`fm_watchdog.sh` 以前没人负责拉起**（全盘 grep 只在它自己的文件里命中自身名字），
即 daemon 一旦挂掉就再不自愈。现由 `zz_fm.start` 末尾拉起，且重启后会异步补上电。

## 5. 踩到的坑

用 `ps -o pid,args | grep '[f]m_watchdog.sh'` 判活会**误判为"已在跑"**——
它命中了**承载这条命令的 `sh -c` 进程本身**（PID 29166）。
`[f]` 写法只能避开 `grep` 自己，避不开外壳的 `sh -c`。
**shell 脚本单实例一律用 pid 文件 + `kill -0` 判定。**

## 6. 已知副作用

FM 射频上电后内核会持续刷 `(FM_RDS)` / `FM_DRV` 日志并推高 load（约 9 行/秒），
调试其它内核问题时先 `python3 /root/fm_cli.py off` 关掉射频。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
