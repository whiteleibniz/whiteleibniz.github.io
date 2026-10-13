/* 多语言前端层(2026-10-13)
 * 语言方案: 根站=简体(zh-CN), /en/=English, /zh-tw/=繁體中文
 * 译文 URL 与原文同构(仅语言前缀不同), 因此切换器只需做前缀变换。
 * 功能: ①语言切换器 ②导航/页内站内链接加当前语言前缀 ③界面文案(data-i18n)
 *       ④分类下拉名称 ⑤搜索页消息(经 window.I18N 暴露给 search.js) */
(function () {
  'use strict';

  var PREFIX = { 'zh-CN': '', 'zh-TW': '/zh-tw', 'en': '/en' };

  var DICT = {
    'zh-CN': {
      nav: { home: '首页', about: '关于', article: '文章', Search: '搜索' },
      pag: { prev: '上一页', next: '下一页', total: '（第 %d / %d 页）' },
      search: {
        placeholder: '搜索…',
        noresult: '没有找到结果',
        found: '共找到 %d 篇文章',
        indexed: '已索引 %d 篇文章',
        failed: '索引加载失败，请刷新页面'
      }
      /* 分类名在简体站即源中文名, 无需翻译 */
    },
    'zh-TW': {
      nav: { home: '首頁', about: '關於', article: '文章', Search: '搜尋' },
      pag: { prev: '上一頁', next: '下一頁', total: '（第 %d / %d 頁）' },
      search: {
        placeholder: '搜尋…',
        noresult: '找不到結果',
        found: '共找到 %d 篇文章',
        indexed: '已索引 %d 篇文章',
        failed: '索引載入失敗，請重新整理'
      },
      cat: {
        'AI工作流': 'AI 工作流',
        '多媒体与模拟器': '多媒體與模擬器',
        '嵌入式硬件': '嵌入式硬體',
        '应用框架': '應用框架',
        '排障手记': '排障手記',
        '硬件模块打通': '硬體模組打通',
        '系统配置': '系統配置',
        '设备档案': '設備檔案'
      }
    },
    'en': {
      nav: { home: 'Home', about: 'About', article: 'Articles', Search: 'Search' },
      pag: { prev: 'Previous', next: 'Next', total: 'Page %d of %d' },
      search: {
        placeholder: 'Search…',
        noresult: 'No results found',
        found: 'Found %d posts',
        indexed: 'Indexed %d posts',
        failed: 'Failed to load the index, please refresh'
      },
      cat: {
        'AI工作流': 'AI Workflow',
        '多媒体与模拟器': 'Multimedia & Emulators',
        '嵌入式硬件': 'Embedded Hardware',
        '应用框架': 'Application Frameworks',
        '排障手记': 'Troubleshooting Notes',
        '硬件模块打通': 'Hardware Modules',
        '系统配置': 'System Configuration',
        '设备档案': 'Device Archives'
      }
    }
  };

  /* 兼容带/不带尾斜杠: /en 与 /en/ 都识别为 en */
  function detect(path) {
    if (/^\/en(\/|$)/.test(path)) return 'en';
    if (/^\/zh-tw(\/|$)/.test(path)) return 'zh-TW';
    return 'zh-CN';
  }

  /* 关于页各语言 slug 不同(中文站 /关于/, 英文站 /en/about/) */
  var ABOUT = { 'zh-CN': '/关于/', 'zh-TW': '/zh-tw/关于/', 'en': '/en/about/' };

  /* 兼容带/不带尾斜杠的前缀剥离 */
  function stripPrefix(path) {
    return path.replace(/^\/(en|zh-tw)(\/|$)/, '/');
  }

  function switchUrl(path, target) {
    var cur = detect(path);
    if (cur === target) return path;
    if (path === ABOUT[cur] || path === ABOUT[cur].replace(/\/$/, '')) return ABOUT[target];
    var base = stripPrefix(path);
    var pre = PREFIX[target];
    if (base === '/' || base === '') return pre === '' ? '/' : pre + '/';
    return pre + base;
  }

  var lang = detect(location.pathname);
  var dict = DICT[lang] || {};
  var pre = PREFIX[lang];

  function t(key) {
    var parts = key.split('.'), o = dict;
    for (var i = 0; i < parts.length && o; i++) o = o[parts[i]];
    return o || null;
  }

  function fmt(s) {
    var args = arguments;
    var i = 1;
    return s.replace(/%d/g, function () { return args[i++]; });
  }

  /* ① 语言切换器: 模板里的 a 初始为 javascript:void(0), 此处改写为真实目标 URL。
        即便 header.ejs 已服务端直出正确 href(双保险), 这里再设一次也是幂等;
        且对尚未部署服务端直出版本的旧页面(void(0))正是修复切换的关键。
        localizeLink 已对 .lang-switch 内链接做 closest 防御, 不会篡改本段结果。 */
  var switches = document.querySelectorAll('.lang-switch a[data-lang]');
  Array.prototype.forEach.call(switches, function (a) {
    var target = a.getAttribute('data-lang');
    a.setAttribute('href', switchUrl(location.pathname, target));
    if (target === lang) a.className = 'current';
  });

  /* ② 站内链接加语言前缀(导航/分类下拉/正文内链; 资源路径除外) */
  var ASSET = /^\/(images|lib|css|js|downloads|favicon[^/]*)/;
  function localizeLink(a) {
    /* 语言切换器链接由 header.ejs 服务端直出, 勿被 .content a 等本地化逻辑改写
       (header 被包在 .content 内, 否则会把 zh-CN 的 "/" 误加成 "/en/") */
    if (a.closest && a.closest('.lang-switch')) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) !== '/' || href.indexOf('//') === 0) return;
    if (ASSET.test(href)) return;
    if (href.indexOf('/en/') === 0 || href.indexOf('/zh-tw/') === 0) return;
    /* about 链接可能已被 url_for 编码为 /%E5%85%B3%E4%BA%8E/ , 需解码后匹配 */
    var dec = decodeURIComponent(href);
    if (dec === '/关于/' || dec.indexOf('/关于/') === 0) {
      if (lang === 'en') { a.setAttribute('href', '/en/about/'); return; }
      if (lang === 'zh-TW') { a.setAttribute('href', '/zh-tw/关于/'); return; }
      return;
    }
    if (pre === '') return;
    if (href === '/') { a.setAttribute('href', pre + '/'); return; }
    a.setAttribute('href', pre + href);
  }
  Array.prototype.forEach.call(document.querySelectorAll('a.navlink, a.catlink'), localizeLink);
  Array.prototype.forEach.call(
    document.querySelectorAll('.content a, .post-item a, #archive a, .pagination a'),
    localizeLink
  );

  /* ③ data-i18n 文案 / title / placeholder / 分页总数 */
  Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
    var v = t(el.getAttribute('data-i18n'));
    if (v) el.textContent = v;
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-title]'), function (el) {
    var v = t(el.getAttribute('data-i18n-title'));
    if (v) el.setAttribute('title', v);
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (el) {
    var v = t(el.getAttribute('data-i18n-ph'));
    if (v) el.setAttribute('placeholder', v);
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-total]'), function (el) {
    var parts = el.getAttribute('data-i18n-total').split('|');
    var v = t('pag.total');
    if (v && parts.length === 2) el.textContent = fmt(v, parts[0], parts[1]);
  });

  /* ④ 分类下拉: 名称翻译 + 计数括号风格 */
  Array.prototype.forEach.call(document.querySelectorAll('a.catlink'), function (a) {
    var name = a.getAttribute('data-cat');
    var nm = a.querySelector('.cat-name');
    if (nm && dict.cat && dict.cat[name]) nm.textContent = dict.cat[name];
    var cnt = a.querySelector('.cat-count');
    if (cnt && lang === 'en') cnt.textContent = cnt.textContent.replace(/（/g, '(').replace(/）/g, ')');
  });

  /* ⑤ 暴露给 search.js */
  window.I18N = {
    lang: lang,
    t: function (key) { return t(key); },
    fmt: fmt
  };
})();
