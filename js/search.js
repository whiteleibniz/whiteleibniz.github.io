// 本地搜索（hexo-generator-search / search.xml）
// 升级版：一次加载缓存、250ms 防抖、结果计数、无结果直接判定、Esc 清空
var searchFunc = function (path, search_id, content_id) {
  'use strict';
  var $input = document.getElementById(search_id);
  var $result = document.getElementById(content_id);
  var $noResult = document.querySelector('.search-no-result');
  var $count = document.getElementById('search-count');
  if (!$input || !$result) return;

  var datas = null;   // 缓存
  var timer = null;

  /* 只搜当前语言的文章(URL 前缀: 根站=简体, /en/=English, /zh-tw/=繁體) */
  var L = (window.I18N && window.I18N.lang) || 'zh-CN';
  function langOk(url) {
    if (L === 'en') return url.indexOf('/en/') === 0;
    if (L === 'zh-TW') return url.indexOf('/zh-tw/') === 0;
    return url.indexOf('/en/') !== 0 && url.indexOf('/zh-tw/') !== 0;
  }
  function msg(key, fallback) {
    var v = window.I18N && window.I18N.t ? window.I18N.t(key) : null;
    return v || fallback;
  }

  function esc(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function doSearch() {
    var raw = $input.value.trim();
    if (raw.length <= 0) {
      $result.innerHTML = '';
      if ($noResult) $noResult.style.display = 'none';
      if ($count) $count.textContent = '';
      return;
    }
    var keywords = raw.toLowerCase().split(/[\s\-]+/).filter(Boolean);
    var hits = [];

    datas.forEach(function (data) {
      var title = (data.title || 'Untitled').trim();
      var content = data.content.trim().replace(/<[^>]+>/g, '');
      var t = title.toLowerCase(), c = content.toLowerCase();
      var ok = keywords.every(function (k) { return t.indexOf(k) >= 0 || c.indexOf(k) >= 0; });
      if (ok) hits.push({ title: title, content: content, url: data.url, c: c });
    });

    var str = '<ul class="search-result-list">';
    hits.forEach(function (h) {
      str += '<li><a href="' + h.url + '" class="search-result-title">' + esc(h.title) + '</a>';
      // 摘要：取第一个关键词命中位置前后片段
      var pos = -1;
      for (var i = 0; i < keywords.length && pos < 0; i++) pos = h.c.indexOf(keywords[i]);
      if (pos >= 0) {
        var start = Math.max(0, pos - 20);
        var frag = h.content.substr(start, 100);
        keywords.forEach(function (k) {
          frag = frag.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
            '<em class="search-keyword">' + k + '</em>');
        });
        str += '<p class="search-result">' + frag + '…</p>';
      }
      str += '</li>';
    });
    str += '</ul>';

    $result.innerHTML = str;
    if ($noResult) $noResult.style.display = hits.length ? 'none' : 'block';
    if ($count) $count.textContent = window.I18N.fmt(msg('search.found', '共找到 %d 篇文章'), hits.length);
  }

  function load(cb) {
    $.ajax({
      url: path,
      dataType: 'xml',
      success: function (xmlResponse) {
        datas = $('entry', xmlResponse).map(function () {
          return {
            title: $('title', this).text(),
            content: $('content', this).text(),
            url: $('url', this).text()
          };
        }).get().filter(function (d) { return langOk(d.url); });
        if ($count) $count.textContent = window.I18N.fmt(msg('search.indexed', '已索引 %d 篇文章'), datas.length);
        cb();
      },
      error: function () {
        if ($count) $count.textContent = msg('search.failed', '索引加载失败，请刷新重试');
      }
    });
  }

  $input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (datas) { doSearch(); } else { load(doSearch); }
    }, 250);
  });

  $input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') e.preventDefault();
    if (e.key === 'Escape') { $input.value = ''; $input.dispatchEvent(new Event('input')); }
  });
};
