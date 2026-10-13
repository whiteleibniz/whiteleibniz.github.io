---
title: "AI Workflow Archiving Standards"
date: 2026-09-22 20:38:54
lang: en
permalink: en/2026/09/22/aiwf-readme/
search: true
categories:
- AI工作流
- 归档规范
tag:
- AI协作
- 归档
---


# AI 工作流归档 (AI Workflow Archiving)

This directory archives the **final deliverables** of each task in AI collaboration, split into subdirectories by business objective.
Rule: only final deliverables that "can be deployed and run directly and achieve the result" are collected (delivery documents / final service source code / deployment scripts actually running on the device);
**temporary scripts used in the process (deployment debugging, testing, diagnostics, exploration) are never archived**.

## Privacy Red Lines (mandatory)

- Public projects: **real SSH passwords, accounts, and real IP addresses are forbidden in documents, git commit messages, and archived files**.
- Always use placeholders: `<设备IP>` / `<WiFi-IP>` / `<密码>`; real credentials are provided only through runtime parameters or environment variables.

## Directory Specifications

| Subdirectory | Contents |
|---|---|
| 01_WiFi打通/ | docs: operation manual / process comparison / work summary / AI guidance manual / troubleshooting manual / deployment delivery document; deploy: wifi.start (boot deployment script) |
| 02_蓝牙打通/ | docs: 6 documents (including the troubleshooting manual); src: bt_user_daemon.c (final service source code) + bluetooth_page.c/h (LVGL UI source code); deploy: bt_bringup.start/bt_daemon/bt_wake.sh (deployment actually running on the device) |
| 03_HT0可复用资产/ | ht0-wcn-radio Skill snapshot (SKILL.md + references + directly runnable ops scripts) |
| 04_桌面应用框架/ | docs: LVGL desktop application architecture and third-party integration specifications |
| 05_收音机/ | docs: FM radio planning and reverse-engineering documents (LVGL UI design specification / AI guidance manual / operation manual / troubleshooting manual / principles and porting Wiki / boot process comparison / deployment delivery document / work process summary / ioctl command table reverse-engineered reconstruction); src: fmprobe.c (ioctl live probe, 45/47 verified); fm_user_daemon.c (to be implemented) |
| bugfix/ | explanation document for each bug fix (symptom/root cause/localization/solution/verification); see bugfix/README.md for the index |

When adding a new business objective, number it incrementally as `NN_业务名/`, and split docs / src / deploy as needed.

## Document Synchronization Protocol (versioned, synced when tagging)

Documents are **not updated with every iteration commit**; they are synced uniformly at **version freeze (tag)**:

1. Daily iteration: commit only code / script / configuration changes, with commit messages describing the changes; do not touch documents.
2. At version freeze (when the user confirms the feature is complete / stable), sync all at once:
   - the corresponding task's docs/ document family (operation manual / troubleshooting manual / AI guidance manual / deployment delivery document / process comparison / work summary) + Skill assets (SKILL.md, references/, scripts/)
   - when files are added, deleted, or renamed, update this README's directory specifications
   - Verification: commands / paths / artifacts in the documents match the device's actual running state (changed layers must have been tested live)
   - Tag: `git tag <vX.Y.Z>`, with the commit note in Chinese, stating "freeze scope + list of synced documents"
3. The tag commit includes or immediately follows the document updates, ensuring that "one tag = one complete document snapshot" is traceable.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
