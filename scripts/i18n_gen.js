'use strict';
// 多语言路由生成器(2026-10-13)
// 语言方案: 根站=简体中文(zh-CN, URL 不变), /en/=English, /zh-tw/=繁體中文
// 文章用 front-matter 区分: lang: zh-CN | en | zh-TW
// 译文 URL 与原文同构: 原文 /YYYY/MM/DD/slug/ → 译文 /en/YYYY/MM/DD/slug/ (仅加语言前缀),
// 前端语言切换器因此可以做纯前缀变换。
// 本脚本覆盖 hexo-generator-index/archive/category/tag:
// scripts/ 后于 npm 插件加载(load_plugins.js: loadModules→loadScripts),
// 同名 register 即覆盖(generator store 同名直接赋值)。
// 注意: loadPlugin 以包装函数注入 hexo 参数, 这里直接顶层使用, 不写 module.exports。
const pagination = require('hexo-pagination');

const DEF = 'zh-CN';
const LANGS = [
  { code: DEF, base: '' },        // 根站(简体)
  { code: 'en', base: 'en/' },
  { code: 'zh-TW', base: 'zh-tw/' }
];

function pick(lang) {
  return lang === DEF
    ? p => !p.lang || p.lang === DEF
    : p => p.lang === lang;
}

const cfg = hexo.config;
const fmt = (cfg.pagination_dir || 'page') + '/%d/';
const idxOrder = (cfg.index_generator && cfg.index_generator.order_by) || '-date';
const idxPer = (cfg.index_generator && cfg.index_generator.per_page) || 10;
const arcOrder = (cfg.archive_generator && cfg.archive_generator.order_by) || '-date';
const arcPer = (cfg.archive_generator && cfg.archive_generator.per_page) || 10;
const catPer = (cfg.category_generator && cfg.category_generator.per_page) || 10;
const tagPer = (cfg.tag_generator && cfg.tag_generator.per_page) || 10;

// ---- 首页: 每语言独立分页(根站仅简体) ----
hexo.extend.generator.register('index', locals => {
  const out = [];
  for (const L of LANGS) {
    const posts = locals.posts.sort(idxOrder).filter(pick(L.code));
    if (!posts.length) continue;
    posts.data.sort((a, b) => (b.sticky || 0) - (a.sticky || 0));
    out.push(...pagination(L.base, posts, {
      perPage: idxPer, layout: ['index', 'archive'], format: fmt,
      data: { __index: true, lang: L.code }
    }));
  }
  return out;
});

// ---- 归档: 每语言一套 ----
hexo.extend.generator.register('archive', locals => {
  const out = [];
  for (const L of LANGS) {
    const posts = locals.posts.sort(arcOrder).filter(pick(L.code));
    if (!posts.length) continue;
    out.push(...pagination(L.base + 'archives/', posts, {
      perPage: arcPer, layout: ['archive', 'index'], format: fmt,
      data: { archive: true, lang: L.code }
    }));
  }
  return out;
});

// ---- 分类: 每语言一套(分类名共享, 仅文章按语言过滤) ----
hexo.extend.generator.register('category', locals => {
  const out = [];
  for (const L of LANGS) {
    locals.categories.forEach(cat => {
      const posts = cat.posts.sort('-date').filter(pick(L.code));
      if (!posts.length) return;
      out.push(...pagination(L.base + cat.path, posts, {
        perPage: catPer, layout: ['category', 'archive', 'index'], format: fmt,
        data: { category: cat.name, lang: L.code }
      }));
    });
  }
  return out;
});

// ---- 标签: 每语言一套 ----
hexo.extend.generator.register('tag', locals => {
  const out = [];
  for (const L of LANGS) {
    locals.tags.forEach(tag => {
      const posts = tag.posts.sort('-date').filter(pick(L.code));
      if (!posts.length) return;
      out.push(...pagination(L.base + tag.path, posts, {
        perPage: tagPer, layout: ['tag', 'archive', 'index'], format: fmt,
        data: { tag: tag.name, lang: L.code }
      }));
    });
  }
  return out;
});

// ---- 搜索索引: 修正译文 URL 双斜杠 ----
// front-matter permalink 会被 hexo 规范化为带前导斜杠(/en/...), 而
// hexo-generator-search 的模板又拼了一次 config.root('/'), 产出 //en/...
// (协议相对 URL, 浏览器会解析成 https://en/... → 搜索结果链接全错)。
// 这里包装原 'xml' 生成器, 渲染后把 //en/ //zh-tw/ 修回 /en/ /zh-tw/。
const origXmlGen = hexo.extend.generator.get('xml');
if (origXmlGen) {
  hexo.extend.generator.register('xml', async function (locals) {
    // register 会把函数包进 bluebird.method, 原生成器返回 Promise, 必须 await
    const r = await origXmlGen.call(hexo, locals);
    if (r && typeof r.data === 'string') {
      r.data = r.data.replace(/(href="|>)\/\/(en|zh-tw)\//g, '$1/$2/');
    }
    return r;
  });
}
