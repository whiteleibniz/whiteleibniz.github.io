---
title: "Trilingual Blog Architecture (Simplified Chinese / English / Traditional Chinese): Design and Implementation Log"
date: 2026-10-13 12:30:00
lang: en
permalink: en/2026/10/13/blog-i18n-architecture/
search: true
categories:
- 系统配置
tag:
- Hexo
- 多语言
- i18n
- 博客
---

# Trilingual Blog Architecture (Simplified Chinese / English / Traditional Chinese): Design and Implementation Log

## 1. Requirements and Constraints

The blog (Hexo 7 + the cactus-white theme, hosted on GitHub Pages) previously had a single Simplified Chinese version with 85 articles. The goals of this project were:

1. Add English and Traditional Chinese versions for all 85 articles;
2. Give each of the three languages its own home page, archive, category pages, and tag pages;
3. Let readers switch languages from any page, landing on **the same article** in the target language;
4. Make the interface text (navigation, pagination, search, category dropdown) follow the language.

Constraints: the category taxonomy uses Chinese multi-level categories (an earlier explicit user requirement), so the categories must **not** be split into Chinese/English sets; the theme is a third-party modification, so its structure must not be reworked heavily.

## 2. Overall Architecture

### 2.1 URL Scheme: Language Prefix + Isomorphic Paths

```
Simplified Chinese (default)  /2026/10/12/foo/
English                       /en/2026/10/12/foo/
Traditional Chinese           /zh-tw/2026/10/12/foo/
```

A translation differs from its original **only by the language prefix**. This is the foundation of the whole design: the frontend language switcher becomes a pure string prefix transform, with no lookup table needed (the only exception is the About page, whose Chinese and English slugs differ; a four-entry table handles it).

Posts are distinguished by front-matter: `lang: zh-CN | en | zh-TW`. A translation's URL is set explicitly through front-matter `permalink` (e.g. `permalink: en/2026/10/12/foo/`), leaving the original URL untouched, so **all old links remain valid**.

### 2.2 Directory Structure

```
blog/
├── source/
│   ├── _posts/               # Simplified Chinese originals (85 posts)
│   ├── _posts/en/            # English translations (85 posts, same filenames)
│   ├── _posts/zh-tw/         # Traditional Chinese translations (85 posts, OpenCC)
│   ├── 关于/index.md         # Simplified Chinese About page
│   ├── en/about/index.md     # English About page
│   ├── en/Search/ ...        # English search page
│   └── zh-tw/...             # Traditional Chinese About/search pages
├── scripts/i18n_gen.js       # Multi-language route generator (overrides core generators)
└── themes/cactus-white/
    ├── layout/_partial/header.ejs      # Navigation + language switcher + category dropdown
    ├── source/js/i18n.js               # Frontend i18n layer
    └── source/js/search.js             # Search (filtered by language)
```

### 2.3 Route Layer: scripts/i18n_gen.js

Hexo loads the `scripts/` directory **after** npm plugins (`load_plugins.js`: `loadModules` first, then `loadScripts`), and `generator.register(name, fn)` overwrites same-named entries directly. A local script therefore overrides the four core generators `index/archive/category/tag`, filtering posts by language and generating one route set per language (including pagination):

```js
const LANGS = [
  { code: 'zh-CN', base: '' },        // root site
  { code: 'en', base: 'en/' },
  { code: 'zh-TW', base: 'zh-tw/' }
];
// each generator: filter posts by lang -> pagination(base, posts, {...})
```

Each route's data carries an injected `lang`, so templates can read the current language (this is what the category dropdown uses to filter its counts).

### 2.4 Frontend Layer: i18n.js

The server only renders content in the current language; all cross-language glue happens in the frontend, in one ~200-line IIFE:

1. **Language switcher**: `简体 / 繁體 / EN` on the right of the navigation bar; the three links are computed from the current URL by prefix transform, with the current language highlighted;
2. **Internal link localization**: navigation, category dropdown, and in-content links (archive/category/tag/about/search/post cross-links) all get the current language prefix; asset paths such as `/images/` and `/lib/` are excluded;
3. **Interface text**: templates mark translatable elements with `data-i18n` attributes, and JS replaces them from a dictionary (navigation, the pagination "Page X of Y", search hints, the no-results message);
4. **Category dropdown**: `data-cat` attributes plus a dictionary translate category names (the English site shows "Troubleshooting Notes" etc.), and hrefs get the language prefix;
5. **Language-filtered search**: `window.I18N.lang` is exposed to search.js so only the current language's posts are indexed and shown.

## 3. Content Production: Where 255 Posts Come From

### 3.1 Traditional Chinese: Automated OpenCC Conversion

`make_tw.py` converts each post with OpenCC (`s2tw` configuration): **only title/description/body are converted**; `categories` and `tag` stay in Simplified Chinese (a unified taxonomy, so that 排障手记 and 排障手記 do not split into two categories); `lang: zh-CN` becomes `zh-TW`; a `permalink: zh-tw/YYYY/MM/DD/slug/` is appended based on the original date path.

### 3.2 English: Batched Parallel Translation

The 85 posts total 832KB. They were split into 8 size-balanced batches and translated by 8 parallel subagents, with the conventions hard-wired into the prompt: front-matter translates only `title` and changes `lang` to `en`; categories and tags stay in Chinese; code blocks, paths, URLs, logs, and hex addresses are preserved verbatim; the copyright block switches to the English format; no facts may be added or removed.

## 4. Pitfalls Hit (Ordered by Severity)

1. **How to write a `scripts/` plugin**: `loadPlugin` injects `hexo` as an argument of the wrapper function's scope, so a plugin must register **directly at top level using `hexo`**; writing `module.exports = function(hexo){}` (the npm-plugin habit) fails to load silently, with no error at all.
2. **Colons in YAML titles**: a `: ` inside an English title (e.g. "Mali-400 Working Principles: TBDR...") must be quoted, otherwise js-yaml throws `bad indentation`, the whole post fails to process, and the article silently disappears (the build log shows only one ERROR line, very easy to miss).
3. **Double slashes in the search index**: front-matter permalinks get normalized by Hexo to carry a leading slash (`/en/...`), while hexo-generator-search's template concatenates `config.root('/')` once more, producing `//en/...` — a protocol-relative URL that browsers resolve to `https://en/...`, breaking every search result link. The fix wraps the original `xml` generator and corrects the rendered output; note that `register` wraps functions in `bluebird.method`, so **the original generator returns a Promise and the wrapper must await it**.
4. **Category counts mixing all three languages**: the navigation dropdown's `cat.posts.length` counts all three languages. The fix uses the `page.lang` injected into route data to filter counts per language on the template side.
5. **`hexo clean` occasionally hangs**: twice the clean process failed to exit and held the output pipe, stalling the whole task; the stalled clean also raced with the subsequent generate over the `public/` directory. Countermeasure: clean with `rm -rf public db.json` instead of `hexo clean`.
6. **Post pages had no language switcher**: post pages use the `post/actions_*` partials instead of `header`, so the switcher had to be added to both navigation sets on post pages (desktop top bar and mobile bottom menu).
7. Translation files should match the source line-ending style (CRLF); mixing is not fatal but adds diff noise.

## 5. Verification Results

- The build produces 690 files with 0 errors; search.xml holds 255 entries (85 per language), with no abnormal `//` URLs;
- The home/archive/category/tag pages of all three languages contain only their own language's posts;
- The language switcher appears on every page type (home/archive/category/tag/post/about/search);
- After JS prefixes navigation links and in-content links, they point to the corresponding language pages;
- All original URLs are unchanged, so old links remain valid.

## 6. Follow-ups

- Interface text is swapped by a **frontend dictionary at runtime**; viewing the page source still shows Simplified Chinese. SSR-grade localization would require duplicating the layout templates per language — high cost, not worth it for now.
- Category names on the English site come from dictionary translation (URLs remain percent-encoded Chinese), which is acceptable.
- When adding new articles: keep the original as-is, put the English draft in `source/_posts/en/` (with `lang: en` + `permalink: en/<date>/<filename>/`), and run `make_tw.py` for the Traditional Chinese draft.

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
