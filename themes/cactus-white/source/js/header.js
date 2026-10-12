$(document).ready(function() {
  // 鼠标悬停导航项时展开二级下拉（article 分类）
  $('#nav ul > li.has-sub').hover(
    function() { $(this).children('ul.sub-nav').stop(true, true).slideDown(150); },
    function() { $(this).children('ul.sub-nav').stop(true, true).slideUp(150); }
  );
});
