---
title: 展訊 SC9832A 網路電視攻堅（二十三）：三次「執行緒必崩」同一病根——clone 不設 TLS，父子共用一個 errno
date: 2026-10-22 14:00:00
tags:
  - VSP
  - 硬解
  - SIGSEGV
  - clone
  - TLS
  - fork
  - 流水線
  - 展訊
  - 裸 clone 執行緒
categories:
  - [嵌入式, 展訊平台]
  - [嵌入式, 影音]
  - [除錯方法, A/B 實驗]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/22/nettv-23-clone-tls-alias-fork-render-pipeline/) · [繁體中文](https://whiteleibniz.github.io/2026/10/22/nettv-23-clone-tls-alias-fork-render-pipeline-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/22/nettv-23-clone-tls-alias-fork-render-pipeline-en/)

> 版權聲明：本文為筆者原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處連結和本聲明。

上一篇我們把「治殘影」的翻頁執行緒釘死之後（預設關掉，21.9fps 保平安），自然的問題就是：**影格率（fps）還有提升空間嗎？** 帳本擺在那兒——每影格 41.3ms = 廠商同步解碼 14.1ms（硬底線）+ 讀影格 2.7ms + 渲染 23.9ms。解碼側已經拆無可拆，唯一的便宜是把**渲染搬到第二個執行單元上、與解碼流水線化**：worker 側只要 16.8ms，渲染側 24.1ms，穩態影格率 = max(兩者) ≈ 24ms ≈ 理論上限 41fps。這篇講這個「檔 2」方案的第一版實作——**又是必崩**，以及這次挖出來的、能一口氣解釋三次歷史懸案的病根。

## 一、帳本與目標

10-21/22 定稿的影格率帳（瀘縣 1080p 來源，60s 取樣）：

| 階段 | 耗時 | 性質 |
|---|---|---|
| bsOnMsg（廠商同步解碼） | 14.1 ms | 硬底線，828 次取樣全是 14ms，拆不掉 |
| 讀影格（ION cached memcpy） | 2.7 ms | 已最佳化過（44.3→2.6） |
| 渲染（yuv2rgb + 幾何合成 + 落 fb） | 23.9 ms | 效能剖析過：訪存 10 / 算術 13 / 散寫≈0 / 拷貝 2，無便宜變數 |
| **合計** | **41.3 ms → 21.9 fps** | |

渲染那 24ms 是純 CPU 活（NEON 已經吃滿），但它跟解碼**沒有資料依賴之外的順序依賴**——解出第 n 影格再渲染第 n 影格，和第 n-1 影格的渲染完全可以同時進行。所以檔 2 的形態很明確：**雙緩衝 + 生產者/消費者**，worker 解出影格 memcpy 進 staging 就發布，渲染側慢慢渲。

## 二、第一版：裸 clone 起渲染執行緒——必崩

最初實作就是最直覺的那種：`clone()` 起一個渲染執行緒，雙緩衝 + 原子序號握手。邏輯跑通了，一上真機：

```
*** monitor: 子进程自退 st=0xb ***        （SIGSEGV，无限重启，0 帧）
```

phase.log（`O_APPEND|O_SYNC`，崩潰不丟）顯示每一代死法完全一樣：

```
t=... DRIVE empty(in) 喂 IDR+SPS+PPS (Annex-B 全序列, nFlags=0)
t=... mon-child-signal=11 st=0xb        （60~300ms 后）
```

**每一代 worker 都在「餵 IDR」之後猝死**——跟上一篇翻頁執行緒的現象一模一樣，連死亡相位都一致。

## 三、病根：clone 不傳 CLONE_SETTLS，父子共用一個 TLS

`clone()` 的 flags 裡沒有 `CLONE_SETTLS`，會發生一件很隱蔽的事：**子執行緒的 TPIDRURO 暫存器原樣繼承父執行緒的值**——也就是父子兩個執行緒**共用同一塊 TLS（執行緒本地儲存）**。

在裸 bionic（`nostdlib`）環境裡這意味著：

1. 子執行緒呼叫任何一個**失敗的系統呼叫**，glibc/bionic 的 `__errno_location()` 會去寫 errno——而 errno 就藏在 TLS 裡的固定偏移；
2. 這一寫，**父執行緒的 errno 被順手改掉了**；
3. 父執行緒緊接著的「餵 IDR」邏輯依賴 errno 做分支判斷 → 邏輯走錯 → 拿著錯的狀態繼續跑 → 野指標 SIGSEGV。

崩潰位址 `0x747474` = ASCII `"ttt"`，也符合「某塊串資料被當指標解參照」的特徵。

### 一口氣解釋三次懸案

把歷史筆記翻出來對表，全中：

| 歷史懸案 | 當時的歸因 | 真相 |
|---|---|---|
| 10-15「第二個 IDR 必崩」 | ION 池乾 → 次生崩潰 | clone 執行緒踩壞父執行緒 errno |
| 10-22「vsync 翻頁執行緒治殘影必崩」 | 未定論（已預設關） | 同一個病 |
| 本次 v16h/v16i 渲染執行緒必崩 | —— | 同一個病 |

專案記憶裡其實早就寫了一條「**禁裸 clone 子執行緒內用 libc**（TLS 踩壞）」——但一直停留在「子執行緒自己別呼叫 libc」的層面，**沒有把「errno 別名會反殺父執行緒」和崩潰現象連起來**，所以前兩次都去 ION 池裡找答案了。這就是筆記的代價：規則寫得太窄，下次換個姿勢踩進來還是不認識。

## 四、方案：fork 替代 clone

既然病根是「共享位址空間導致互相踩」，解法就乾脆做絕：**渲染側改用 `fork()` 子行程**。

```
worker(父行程)                        渲染子行程
─────────────                        ─────────────
DRIVE 解一影格
memcpy → g_st[wn & 1]   (MAP_SHARED)
g_ps->wn++  ───────────發布────────▶  看到 wn > rn
                                      取 g_st[rn & 1]
                                      fb_render()（判重已在父行程做過）
                                      g_ps->rn++
```

結構上的好處：

- **子行程有獨立位址空間**（私有 TLS、堆、堆疊），它愛怎麼出錯都出不到父行程頭上，父子只共享**顯式**的 MAP_SHARED 區域：一個 4KB 握手區（`wn/rn/rstop/rexited` 四個 volatile 欄位）+ 兩塊 3MB 雙 staging；
- 子行程把 SIGSEGV/SIGBUS/SIGILL **重置成預設動作**——真出了野指標，死自己一個，父行程 `waitpid(WNOHANG)` 發現後置 `g_pipe_on=0`，**自動回退單執行緒**，播放不中斷；
- 子行程設 `PR_SET_PDEATHSIG(SIGKILL)`，父行程猝死不會留下孤兒渲染行程抱著 fb 不放。

## 五、三個值得記的實作細節

**1. 判重必須留在父行程。** 去重判準 `g_filled`（廠商每解出真影格回呼遞增）是**父行程位址空間裡的量**；fork 之後子行程拿到的是 fork 那一刻的凍結副本，在子行程裡判重會永遠判「這是舊影格」，結果一影格都不渲。所以發布門放在父行程：`g_filled != filled_seen_p` 才 memcpy + `wn++`。

**2. 影格實寬 1920×1088×3/2 = 0x2FC400，staging 必須 ≥ 0x300000。** 舊程式碼按「寬×高×1.5 取整到 0x1000」算成 0x2FC000，memcpy 也只拷 0x2FC000——渲染側讀 chroma 平面時**越界 12KB**。malloc 後面有堆兜底所以從來不崩，但這是「畫面左緣色帶」的高度嫌疑；換成 mmap 定尺會直接 SIGBUS。修成 `ST_SIZE=0x300000` + 全影格拷貝。

**3. 收尾排空比 Kill 重要。** 退出時先 `rstop=1` 通知子行程「渲完手裡這影格就退」，等 ≤3s 看 `rexited`；超時才對渲染子行程 `SIGKILL`——**這是全專案唯一允許 KILL 的場景**，因為此時 VSP DMA 早已在 worker 側排空（`usleep(800ms)`），純 CPU 渲染過程被殺沒有任何硬體狀態風險。反過來，解碼進行中 KILL 播放器是會核心崩潰的（舊教訓，兩次實證）。

## 六、A/B 實測：fork 贏了穩定性，輸了影格率

v17 建置部署後（`NETTV_PIPE=1` 開啟、預設關），冒煙 45s：**signal=11 = 0**，`流水线: fork渲染子进程(v17)` + `已 fork(pid=19839, 双staging=MAP_SHARED 0x300000)` 確認生效。然後 ABBA 四組（瀘縣 1080p，各 60s，唯一變數 NETTV_PIPE）：

| 組 | env | signal=11 | 真影格 | fps | worker 牆鐘構成 |
|---|---|---|---|---|---|
| A1 | 預設（單執行緒） | 0 | 1154 | **21.8** | 41.5 = bsOnMsg 14.2 + 讀影格 2.6 + 渲染 24.2 |
| B1 | `NETTV_PIPE=1` | 0 | 929 | 17.5 | 36.6 = bsOnMsg 10.1 + 讀影格 3.1 + 10.2 + ~13ms 等 render |
| B2 | `NETTV_PIPE=1` | 0 | 918 | 17.4 | 同 B1 |
| A2 | 預設（單執行緒） | 0 | 1130 | **21.8** | 41.6 = 14.2 + 2.7 + 24.0 |

穩定性目標滿分（**fork 後 0 崩潰，渲染側執行緒必崩的病根真被拔掉了**），但影格率 **-20%**。查根因一句話就夠了：

```sh
cat /sys/devices/system/cpu/cpu1/online    # 1
cat /sys/devices/system/cpu/cpu2/online    # 0  ← 四個核 offline 了兩個
```

**線上 CPU 只有 2 個。** 流水線的前提是「渲染與解碼在兩個執行單元上真平行」，在只有 2 個線上核、還要分給 monitor/dl/mplayer 的機器上，worker 和渲染子行程大部分時間在**分時重用同一個核**，外加每影格 3MB 的 staging 在兩核間來回搬（L1 每核私有，cache line 透過 L2 遷移），記憶體匯流排和排程開銷全部變成淨損失。worker 牆鐘確實從 41.5 降到 36.6ms，但總吞吐量是 57ms/影格——**平行沒有發生**。

所以定案：**`NETTV_PIPE` 預設關保持不動**，v17 的單執行緒路徑零退化（A1/A2 與歷史基線逐項一致）。但這個方向並沒有被證偽到底——留了兩個便宜的後續：

- **taskset 親和性**：把渲染子行程釘在 cpu1、worker 留在 cpu0，排除排程分散因素再測一次；
- **online cpu2/cpu3**：四個核都在線的話，流水線的帳本就真的能算了（寫 `/sys` 熱插拔節點屬於改全局配置，要按專案鐵律先確認再動）。

## 七、真正的紅利：殘影有救了

回頭盤點，v17 最大的價值不是影格率，是**把「渲染側起執行緒」這個能力洗白了**。10-22 凌晨因為 clone 執行緒必崩而預設關掉的 vsync 翻頁執行緒（治殘影），當時的嫌疑方向是「ioctl 和 VSP 並發踩 fb 鎖」——**錯了，真兇是 TLS 別名**。翻頁執行緒本身只做 `WAITFORVSYNC` + `PAN_DRAW` + 等一小塊共享狀態，用 fork 子行程實作結構上不可能踩父行程，病根沒了，功能可以回來了。這是下一篇的事。

## 八、經驗

1. **`clone` 起執行緒在沒有 `CLONE_SETTLS` 時是父子 TLS 別名，不是「輕量行程」。** 凡是要跑 libc（尤其是碰 errno）的工作執行緒，要嘛規規矩矩傳 TLS，要嘛直接 fork——fork 的隔離性是結構保證，不依賴「記得傳哪個 flag」。
2. **「子執行緒自己出事」和「子執行緒把父執行緒搞死」是兩回事。** 後者防不住，因為犯罪現場不在自己身上；隔離邊界要畫在位址空間上，不是畫在「我覺得它不會碰」上。
3. **狀態判斷要放在狀態的所有者那一側。** 判重放在子行程看著挺自然（「誰消費誰判斷」），但狀態量在父行程——跨了 fork，判斷就必須留在父行程。
4. **尺寸常數要按「實寬」算，不要按「取整到好看」算。** 0x2FC000 和 0x2FC400 只差 1KB，換來 12KB 的越界讀；這種 bug 靠 malloc 兜底一輩子不暴露，換 allocator 就炸。
5. **平行化之前先數核。** 這次檔 2 的整份帳本（「渲染 24ms 和解碼 16.8ms 流水線化 ⇒ 上限 41fps」）在單核上是個笑話，在兩核上也是個慘案——`cat /sys/devices/system/cpu/cpu*/online` 只要三秒鐘，應該在寫第一行流水線程式碼之前就看。順帶記住：**「理論上限」四個字，前提是執行單元真實存在**。

---

**本文涉及的檔案**（裝置端儲存庫 `/home/lvgl_demo/lvgl_demo`）：`deploy/nettv_player/sprd_msg_np.c`（`render_child()` / `pipe_child_died()` / `struct pipe_sh` / worker 發布區塊），建置腳本 `deploy/nettv_player/build.sh`。本地除錯腳本：`outputs/_pipe_smoke_1022.sh`（冒煙）、`outputs/_pipe_ab3_1022.sh`（ABBA A/B）。
