---
title: "個人技術博客三語言化（簡體/English/繁體）架構與落地實錄"
date: 2026-10-13 12:30:00
search: true
categories:
- 系统配置
tag:
- Hexo
- 多语言
- i18n
- 博客
permalink: zh-tw/2026/10/13/blog-i18n-architecture/
---

# 個人技術博客三語言化（簡體/English/繁體）架構與落地實錄

## 一、需求與約束

博客（Hexo 7 + cactus-white 主題，GitHub Pages 託管）此前只有簡體中文一個版本，共 85 篇文章。本次目標：

1. 全站 85 篇文章補齊英文版與繁體版；
2. 三種語言各自擁有獨立的首頁、歸檔、分類、標籤頁；
3. 讀者能在任意頁面一鍵切換語言，且切換到的是**同一篇文章**的對應語言版本；
4. 界面文案（導航、分頁、搜索、分類下拉）跟隨語言切換。

約束條件：分類體系是中文多級分類（此前用戶明確要求中文命名），**不能**為了多語言把分類拆成中英兩套；主題是第三方魔改，不能大改結構。

## 二、總體架構

### 2.1 URL 方案：語言前綴 + 同構路徑

```
簡體（默認）  /2026/10/12/foo/
English      /en/2026/10/12/foo/
繁體中文     /zh-tw/2026/10/12/foo/
```

譯文與原文**只差一個語言前綴**，這是整個方案的地基：前端語言切換器因此可以做成純字符串前綴變換，不需要任何映射表（唯一的例外是「關於」頁，中英文 slug 不同，用一張四個條目的小表處理）。

文章用 front-matter 區分語言：`lang: zh-CN | en | zh-TW`；譯文的 URL 用 front-matter `permalink` 顯式指定（如 `permalink: en/2026/10/12/foo/`），不改動原文 URL，**老鏈接全部有效**。

### 2.2 目錄結構

```
blog/
├── source/
│   ├── _posts/               # 簡體原文（85 篇）
│   ├── _posts/en/            # 英文譯文（85 篇，同名文件）
│   ├── _posts/zh-tw/         # 繁體譯文（85 篇，OpenCC 轉換）
│   ├── 關於/index.md         # 簡體關於頁
│   ├── en/about/index.md     # 英文關於頁
│   ├── en/Search/ ...        # 英文搜索頁
│   └── zh-tw/...             # 繁體關於頁/搜索頁
├── scripts/i18n_gen.js       # 多語言路由生成器（覆寫核心生成器）
└── themes/cactus-white/
    ├── layout/_partial/header.ejs      # 導航 + 語言切換器 + 分類下拉
    ├── source/js/i18n.js               # 前端多語言層
    └── source/js/search.js             # 搜索（按語言過濾）
```

### 2.3 路由層：scripts/i18n_gen.js

Hexo 的 `scripts/` 目錄在 npm 插件**之後**加載（`load_plugins.js`：先 `loadModules` 再 `loadScripts`），且 `generator.register(name, fn)` 同名直接覆蓋，因此用一個本地腳本覆寫 `index/archive/category/tag` 四個核心生成器，按語言過濾文章後各自生成一套路由（含分頁）：

```js
const LANGS = [
  { code: 'zh-CN', base: '' },        // 根站
  { code: 'en', base: 'en/' },
  { code: 'zh-TW', base: 'zh-tw/' }
];
// 每個生成器: 按 lang 過濾 posts → pagination(base, posts, {...})
```

每個路由的 data 裡注入 `lang`，模板因此能拿到當前語言（分類下拉的計數按語言過濾就用它）。

### 2.4 前端層：i18n.js

服務端只渲染當前語言的內容，「跨語言」的粘合全部在前端完成，一個約 200 行的 IIFE：

1. **語言切換器**：導航欄右側 `簡體 / 繁體 / EN`，按當前 URL 做前綴變換算出三個鏈接，當前語言高亮；
2. **站內鏈接本地化**：導航、分類下拉、正文內鏈（歸檔/分類/標籤/關於/搜索/文章互鏈）統一加當前語言前綴；`/images/`、`/lib/` 等資源路徑除外；
3. **界面文案**：模板裡給需要翻譯的元素打 `data-i18n` 標記，JS 用字典替換（導航、分頁「第 X / Y 頁」、搜索提示、無結果文案）；
4. **分類下拉**：`data-cat` 屬性 + 字典翻譯分類名（英文版顯示 "Troubleshooting Notes" 等），href 加語言前綴；
5. **搜索按語言過濾**：`window.I18N.lang` 暴露給 search.js，只索引和展示當前語言的文章。

## 三、內容生產：255 篇文章怎麼來

### 3.1 繁體版：OpenCC 自動轉換

`make_tw.py` 用 OpenCC（`s2tw` 配置）逐篇轉換：**只轉 title/description/正文**；`categories`、`tag` 保持簡體（分類體系統一，避免 `排障手記` 和 `排障手記` 裂成兩個分類）；`lang: zh-CN` 改寫為 `zh-TW`；按原日期路徑追加 `permalink: zh-tw/YYYY/MM/DD/slug/`。

### 3.2 英文版：分批並行翻譯

85 篇共 832KB，按體積均衡分 8 批，用 8 個並行子代理翻譯，約定寫死在 prompt 裡：front-matter 只譯 title、`lang` 改 `en`、分類標籤保持中文；代碼塊/路徑/URL/日誌/十六進制地址/寄存器名原樣保留；版權塊換英文格式；禁止增刪事實。

## 四、踩過的坑（按嚴重程度排序）

1. **`scripts/` 插件的寫法**：`loadPlugin` 把 `hexo` 作為包裝函數的參數注入腳本作用域，插件必須**頂層直接用 `hexo` 註冊**；寫成 `module.exports = function(hexo){}`（npm 插件的習慣寫法）會靜默不加載，不報任何錯。
2. **YAML 標題冒號**：英文標題裡的 `: `（如 "Mali-400 Working Principles: TBDR..."）必須加引號，否則 js-yaml 直接 `bad indentation` 整篇處理失敗、文章憑空消失（構建日誌裡只有一行 ERROR，極易漏掉）。
3. **搜索索引雙斜槓**：front-matter permalink 會被 hexo 規範化為帶前導斜槓（`/en/...`），而 hexo-generator-search 的模板又拼了一次 `config.root('/')`，產出 `//en/...`——協議相對 URL，瀏覽器解析成 `https://en/...`，搜索結果鏈接全錯。修法是在生成器裡包裝原 `xml` 生成器渲染後修正；注意 `register` 會把函數包進 `bluebird.method`，**原生成器返回 Promise，包裝函數必須 await**。
4. **分類計數三語言串味**：導航下拉的 `cat.posts.length` 是三種語言的總數。靠路由 data 裡注入的 `page.lang` 在模板側按語言過濾解決。
5. **`hexo clean` 偶發掛死**：兩次遇到 clean 進程不退出、佔住輸出管道把整個任務掛起；且掛起的 clean 會和後續 generate 搶 public/ 目錄。對策：清理改用 `rm -rf public db.json`，不用 `hexo clean`。
6. **文章頁沒有語言切換器**：文章頁走 `post/actions_*` 局部而非 `header`，切換器要補進文章頁的兩套導航（桌面頂部 + 移動底部菜單）。
7. 譯文文件行尾風格要與源一致（CRLF），混用雖不致命但增加 diff 噪音。

## 五、驗證結論

- 構建 690 個文件、0 錯誤；search.xml 255 條（簡/英/繁各 85），無 `//` 異常 URL；
- 三個語言的首頁/歸檔/分類/標籤頁均只含本語言文章；
- 語言切換器出現在全部頁面類型（首頁/歸檔/分類/標籤/文章/關於/搜索）；
- 正文內鏈與導航鏈接經 JS 加前綴後指向對應語言頁面；
- 原文 URL 全部未變，老鏈接有效。

## 六、遺留與後續

- 界面文案是**前端字典替換**（JS 運行時切換），查看網頁源代碼時看到的仍是簡體文案；如追求 SSR 級本地化，需要按語言複製一套佈局模板，成本較高，暫不值得。
- 分類名在英文站顯示為字典翻譯（URL 仍是中文百分號編碼），可接受。
- 新增文章時：原文照舊，英文稿放 `source/_posts/en/`（加 `lang: en` + `permalink: en/日期/文件名/`），繁體稿跑 `make_tw.py`。

---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
