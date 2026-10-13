---
title: "个人技术博客三语言化（简体/English/繁體）架构与落地实录"
date: 2026-10-13 12:30:00
search: true
categories:
- 系统配置
tag:
- Hexo
- 多语言
- i18n
- 博客
---

# 个人技术博客三语言化（简体/English/繁體）架构与落地实录

## 一、需求与约束

博客（Hexo 7 + cactus-white 主题，GitHub Pages 托管）此前只有简体中文一个版本，共 85 篇文章。本次目标：

1. 全站 85 篇文章补齐英文版与繁体版；
2. 三种语言各自拥有独立的首页、归档、分类、标签页；
3. 读者能在任意页面一键切换语言，且切换到的是**同一篇文章**的对应语言版本；
4. 界面文案（导航、分页、搜索、分类下拉）跟随语言切换。

约束条件：分类体系是中文多级分类（此前用户明确要求中文命名），**不能**为了多语言把分类拆成中英两套；主题是第三方魔改，不能大改结构。

## 二、总体架构

### 2.1 URL 方案：语言前缀 + 同构路径

```
简体（默认）  /2026/10/12/foo/
English      /en/2026/10/12/foo/
繁體中文     /zh-tw/2026/10/12/foo/
```

译文与原文**只差一个语言前缀**，这是整个方案的地基：前端语言切换器因此可以做成纯字符串前缀变换，不需要任何映射表（唯一的例外是「关于」页，中英文 slug 不同，用一张四个条目的小表处理）。

文章用 front-matter 区分语言：`lang: zh-CN | en | zh-TW`；译文的 URL 用 front-matter `permalink` 显式指定（如 `permalink: en/2026/10/12/foo/`），不改动原文 URL，**老链接全部有效**。

### 2.2 目录结构

```
blog/
├── source/
│   ├── _posts/               # 简体原文（85 篇）
│   ├── _posts/en/            # 英文译文（85 篇，同名文件）
│   ├── _posts/zh-tw/         # 繁体译文（85 篇，OpenCC 转换）
│   ├── 关于/index.md         # 简体关于页
│   ├── en/about/index.md     # 英文关于页
│   ├── en/Search/ ...        # 英文搜索页
│   └── zh-tw/...             # 繁体关于页/搜索页
├── scripts/i18n_gen.js       # 多语言路由生成器（覆写核心生成器）
└── themes/cactus-white/
    ├── layout/_partial/header.ejs      # 导航 + 语言切换器 + 分类下拉
    ├── source/js/i18n.js               # 前端多语言层
    └── source/js/search.js             # 搜索（按语言过滤）
```

### 2.3 路由层：scripts/i18n_gen.js

Hexo 的 `scripts/` 目录在 npm 插件**之后**加载（`load_plugins.js`：先 `loadModules` 再 `loadScripts`），且 `generator.register(name, fn)` 同名直接覆盖，因此用一个本地脚本覆写 `index/archive/category/tag` 四个核心生成器，按语言过滤文章后各自生成一套路由（含分页）：

```js
const LANGS = [
  { code: 'zh-CN', base: '' },        // 根站
  { code: 'en', base: 'en/' },
  { code: 'zh-TW', base: 'zh-tw/' }
];
// 每个生成器: 按 lang 过滤 posts → pagination(base, posts, {...})
```

每个路由的 data 里注入 `lang`，模板因此能拿到当前语言（分类下拉的计数按语言过滤就用它）。

### 2.4 前端层：i18n.js

服务端只渲染当前语言的内容，「跨语言」的粘合全部在前端完成，一个约 200 行的 IIFE：

1. **语言切换器**：导航栏右侧 `简体 / 繁體 / EN`，按当前 URL 做前缀变换算出三个链接，当前语言高亮；
2. **站内链接本地化**：导航、分类下拉、正文内链（归档/分类/标签/关于/搜索/文章互链）统一加当前语言前缀；`/images/`、`/lib/` 等资源路径除外；
3. **界面文案**：模板里给需要翻译的元素打 `data-i18n` 标记，JS 用字典替换（导航、分页「第 X / Y 页」、搜索提示、无结果文案）；
4. **分类下拉**：`data-cat` 属性 + 字典翻译分类名（英文版显示 "Troubleshooting Notes" 等），href 加语言前缀；
5. **搜索按语言过滤**：`window.I18N.lang` 暴露给 search.js，只索引和展示当前语言的文章。

## 三、内容生产：255 篇文章怎么来

### 3.1 繁体版：OpenCC 自动转换

`make_tw.py` 用 OpenCC（`s2tw` 配置）逐篇转换：**只转 title/description/正文**；`categories`、`tag` 保持简体（分类体系统一，避免 `排障手记` 和 `排障手記` 裂成两个分类）；`lang: zh-CN` 改写为 `zh-TW`；按原日期路径追加 `permalink: zh-tw/YYYY/MM/DD/slug/`。

### 3.2 英文版：分批并行翻译

85 篇共 832KB，按体积均衡分 8 批，用 8 个并行子代理翻译，约定写死在 prompt 里：front-matter 只译 title、`lang` 改 `en`、分类标签保持中文；代码块/路径/URL/日志/十六进制地址/寄存器名原样保留；版权块换英文格式；禁止增删事实。

## 四、踩过的坑（按严重程度排序）

1. **`scripts/` 插件的写法**：`loadPlugin` 把 `hexo` 作为包装函数的参数注入脚本作用域，插件必须**顶层直接用 `hexo` 注册**；写成 `module.exports = function(hexo){}`（npm 插件的习惯写法）会静默不加载，不报任何错。
2. **YAML 标题冒号**：英文标题里的 `: `（如 "Mali-400 Working Principles: TBDR..."）必须加引号，否则 js-yaml 直接 `bad indentation` 整篇处理失败、文章凭空消失（构建日志里只有一行 ERROR，极易漏掉）。
3. **搜索索引双斜杠**：front-matter permalink 会被 hexo 规范化为带前导斜杠（`/en/...`），而 hexo-generator-search 的模板又拼了一次 `config.root('/')`，产出 `//en/...`——协议相对 URL，浏览器解析成 `https://en/...`，搜索结果链接全错。修法是在生成器里包装原 `xml` 生成器渲染后修正；注意 `register` 会把函数包进 `bluebird.method`，**原生成器返回 Promise，包装函数必须 await**。
4. **分类计数三语言串味**：导航下拉的 `cat.posts.length` 是三种语言的总数。靠路由 data 里注入的 `page.lang` 在模板侧按语言过滤解决。
5. **`hexo clean` 偶发挂死**：两次遇到 clean 进程不退出、占住输出管道把整个任务挂起；且挂起的 clean 会和后续 generate 抢 public/ 目录。对策：清理改用 `rm -rf public db.json`，不用 `hexo clean`。
6. **文章页没有语言切换器**：文章页走 `post/actions_*` 局部而非 `header`，切换器要补进文章页的两套导航（桌面顶部 + 移动底部菜单）。
7. 译文文件行尾风格要与源一致（CRLF），混用虽不致命但增加 diff 噪音。

## 五、验证结论

- 构建 690 个文件、0 错误；search.xml 255 条（简/英/繁各 85），无 `//` 异常 URL；
- 三个语言的首页/归档/分类/标签页均只含本语言文章；
- 语言切换器出现在全部页面类型（首页/归档/分类/标签/文章/关于/搜索）；
- 正文内链与导航链接经 JS 加前缀后指向对应语言页面；
- 原文 URL 全部未变，老链接有效。

## 六、遗留与后续

- 界面文案是**前端字典替换**（JS 运行时切换），查看网页源代码时看到的仍是简体文案；如追求 SSR 级本地化，需要按语言复制一套布局模板，成本较高，暂不值得。
- 分类名在英文站显示为字典翻译（URL 仍是中文百分号编码），可接受。
- 新增文章时：原文照旧，英文稿放 `source/_posts/en/`（加 `lang: en` + `permalink: en/日期/文件名/`），繁体稿跑 `make_tw.py`。

---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
