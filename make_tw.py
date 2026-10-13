# -*- coding: utf-8 -*-
"""简体文章 -> 繁体(zh-TW)版转换: OpenCC s2tw, 仅转 title/description/正文,
分类与标签保持简体(全站分类体系统一), lang 改 zh-TW, 追加 zh-tw 前缀 permalink。"""
import os, re
from opencc import OpenCC

cc = OpenCC('s2tw')
BASE = os.path.dirname(os.path.abspath(__file__))


def convert_file(src, dst, url_prefix=None):
    raw = open(src, encoding='utf-8').read()
    s = raw.replace('\r\n', '\n')
    m = re.match(r'^---\n(.*?)\n---\n', s, re.S)
    assert m, src
    fm, body = m.group(1), s[m.end():]
    out, date_v = [], None
    for ln in fm.split('\n'):
        if re.match(r'^(title|description):', ln):
            k, v = ln.split(':', 1)
            ln = k + ':' + cc.convert(v)
        elif re.match(r'^lang:\s*zh-CN\s*$', ln):
            ln = 'lang: zh-TW'
        if re.match(r'^date:', ln):
            date_v = ln.split(':', 1)[1].strip()
        out.append(ln)
    fm2 = '\n'.join(out)
    if url_prefix and date_v:
        dm = re.match(r'(\d{4})-(\d{2})-(\d{2})', date_v)
        if dm:
            slug = os.path.splitext(os.path.basename(src))[0]
            fm2 += '\npermalink: %s/%s/%s/%s/%s/' % (url_prefix, dm.group(1), dm.group(2), dm.group(3), slug)
    open(dst, 'w', encoding='utf-8', newline='').write('---\n' + fm2 + '\n---\n' + cc.convert(body))


def main():
    src_dir = os.path.join(BASE, 'source', '_posts')
    dst_dir = os.path.join(src_dir, 'zh-tw')
    os.makedirs(dst_dir, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(src_dir)):
        if f.endswith('.md'):
            convert_file(os.path.join(src_dir, f), os.path.join(dst_dir, f), 'zh-tw')
            n += 1
    print('tw posts:', n)
    # 关于页
    about_src = os.path.join(BASE, 'source', '关于', 'index.md')
    about_dst_dir = os.path.join(BASE, 'source', 'zh-tw', '关于')
    os.makedirs(about_dst_dir, exist_ok=True)
    convert_file(about_src, os.path.join(about_dst_dir, 'index.md'))
    print('tw about page: ok')


if __name__ == '__main__':
    main()
