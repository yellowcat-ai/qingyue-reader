/**
 * parser.js — 小说文件解析引擎
 * TXT：编码自动检测（UTF-8 / GB18030 / BIG5 / UTF-16）+ 广告行净化 + 章节智能切分
 * EPUB：container.xml → OPF → spine → 正文抽取 + NCX/NAV 目录标题 + 封面
 */

/* ---------------- 工具 ---------------- */

const CN_NUM = '0-9₀-₉零一二三四五六七八九十百千万两〇壹贰叁肆伍陆柒捌玖拾佰仟';

// 主章节模式：第一章 / 第123章 / 卷三 / Chapter 12 / 序章 / 番外 …
const RE_CHAPTER = new RegExp(
  '^[\\s\\u3000]{0,8}(?:' +
  '[第]\\s*[' + CN_NUM + ']{1,12}\\s*[章節节回卷篇集部话話幕]' +
  '|卷\\s*[' + CN_NUM + ']{1,12}' +
  '|[Cc]hapter\\s*\\d{1,5}' +
  '|[Vv]olume\\s*\\d{1,5}' +
  '|[Pp]art\\s*\\d{1,5}' +
  '|序章|序言|序|楔子|引子|引|前言|自序|后记|後記|尾声|尾聲|终章|終章|结局|結局|番外|外传|外傳|附录|附錄' +
  ')[\\s\\u3000]*(?:[：:、．.\\-—·|]?[\\s\\u3000]*)(.{0,60})$'
);

// 备选模式：1. 标题 / 001、标题 / 12 标题
const RE_NUM = /^[\s\u3000]{0,4}(\d{1,4})[\.、\s\u3000]{1,3}(\S.{0,50})$/;

// 广告 / 站点水印行
const RE_AD = /(?:https?:\/\/|www\.|m\.|\b(?:txt|epub)\s*(?:下载|电子书)|笔趣|顶点|八一中文|txt小说|小说下载|手机阅读|免费阅读|无弹窗|请大家|记住本站|本站地址|首发|最新网址|阅读请到|请到.*阅读|本章免费|.*小说网|看书网|落霞小说|下载.*zip)/i;
const RE_AD2 = /\.(?:com|cn|net|org|me|cc|xyz|top|info)\b/i;

function attr(tag, name) {
  const m = new RegExp('\\b' + name + '=["\']([^"\']*)["\']', 'i').exec(tag);
  return m ? m[1] : '';
}

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

export function normalizePath(p) {
  const parts = [];
  let s = String(p || '').split('#')[0];
  try { s = decodeURIComponent(s); } catch (e) { /* 保留原样 */ }
  s = s.replace(/\\/g, '/');
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

export function resolvePath(base, rel) {
  if (/^[a-z]+:/i.test(rel)) return rel;
  return normalizePath(base + rel);
}

/* ---------------- 编码检测 ---------------- */

export function decodeText(buf, forced) {
  const u8 = new Uint8Array(buf);
  if (forced && forced !== 'auto' && forced !== 'detect') {
    try { return { text: stripBom(new TextDecoder(forced).decode(buf)), encoding: forced }; }
    catch (e) { /* 不支持则回落自动 */ }
  }
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF)
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  if (u8[0] === 0xFF && u8[1] === 0xFE)
    return { text: stripBom(new TextDecoder('utf-16le').decode(buf)), encoding: 'utf-16le' };
  if (u8[0] === 0xFE && u8[1] === 0xFF)
    return { text: stripBom(new TextDecoder('utf-16be').decode(buf)), encoding: 'utf-16be' };

  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: stripBom(t), encoding: 'utf-8' };
  } catch (e) {
    for (const enc of ['gb18030', 'big5']) {
      try { return { text: stripBom(new TextDecoder(enc).decode(buf)), encoding: enc }; }
      catch (e2) { /* 继续 */ }
    }
    return { text: stripBom(new TextDecoder('utf-8').decode(buf)), encoding: 'utf-8' };
  }
}

/* ---------------- 文本净化 ---------------- */

export function cleanLine(line, chapterLike) {
  let s = String(line).replace(/\u3000/g, ' ').replace(/\s+$/g, '').replace(/^\s+/g, '');
  if (!s) return '';
  if (!chapterLike) {
    if (RE_AD.test(s)) return '';
    if (RE_AD2.test(s)) return '';
    if (/^[-=—*·•]{3,}$/.test(s)) return '';
    if (/^\d{1,4}$/.test(s)) return '';          // 孤立页码
    if (/^[（(【\[]?(?:全书完|未完待续|待续)[）)\]】]?[!！.。]?$/.test(s)) return '';
  }
  return s;
}

/* ---------------- 分章 ---------------- */

/**
 * 将纯文本切分为章节
 * @returns {{title:string, text:string}[]}
 */
export async function splitChapters(raw, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  const total = lines.length;

  let marks = [];   // {line, title}
  let last = '';
  let dupCount = 0;

  for (let i = 0; i < total; i++) {
    if (i % 4000 === 0) {
      onProgress(Math.round(i / total * 100));
      await new Promise(r => setTimeout(r, 0));
    }
    const rawLine = lines[i];
    const line = rawLine.replace(/\u3000/g, ' ').trim();
    if (line.length > 80) continue;

    const m = RE_CHAPTER.exec(line);
    if (m) {
      marks.push({ line: i, title: line.replace(/\s+/g, ' ').trim() });
      last = ''; dupCount = 0;
      continue;
    }
    // 连续重复行（盗版站常见）只保留一次
    if (line && line === last) { dupCount++; if (dupCount > 2) continue; }
    else { last = line; dupCount = 1; }
  }

  // 主模式命中太少 → 尝试纯数字编号模式
  if (marks.length < 3 && total > 30) {
    const cand = [];
    let expect = null;
    for (let i = 0; i < total; i++) {
      const line = lines[i].replace(/\u3000/g, ' ').trim();
      if (line.length > 60) continue;
      const m = RE_NUM.exec(line);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (expect === null) expect = n + 1;
      else {
        if (n < expect - 1 || n > expect + 40) continue;
        expect = n + 1;
      }
      cand.push({ line: i, title: line.replace(/\s+/g, ' ').trim() });
    }
    if (cand.length > marks.length && cand.length >= 5) marks = cand;
  }

  const chapters = [];
  if (marks.length >= 2) {
    for (let k = 0; k < marks.length; k++) {
      const start = marks[k].line;
      const end = k + 1 < marks.length ? marks[k + 1].line : total;
      const paras = [];
      for (let i = start + 1; i < end; i++) {
        const s = cleanLine(lines[i], false);
        if (s) paras.push(s);
      }
      const title = cleanLine(marks[k].title, true) || ('第 ' + (k + 1) + ' 章');
      if (paras.length || k === marks.length - 1) {
        chapters.push({ title, text: paras.join('\n') });
      }
    }
  }

  // 兜底：按字数等分
  if (chapters.length < 2) {
    const all = [];
    for (let i = 0; i < total; i++) {
      const s = cleanLine(lines[i], false);
      if (s) all.push(s);
    }
    const SIZE = opts.fallbackSize || 4000;
    let buf = [], len = 0, idx = 1;
    const push = () => {
      if (!buf.length) return;
      chapters.push({ title: '第 ' + idx + ' 节', text: buf.join('\n') });
      idx++; buf = []; len = 0;
    };
    for (const p of all) {
      buf.push(p); len += p.length;
      if (len >= SIZE) push();
    }
    push();
  }

  return capChapterSize(chapters, opts);
}

/**
 * 单章体积上限保护。
 *
 * 阅读页是把整章文本一次性写进 innerHTML 的，章节越大渲染进程的 DOM/排版内存越高。
 * TXT 里如果章节标记稀疏（只有「第X卷」、或全书只有两三个「第X章」），单章可能几十万字，
 * 一次渲染就会把 WebView 渲染进程顶到系统内存上限，表现为进程被回收（页面闪回首页/白屏）。
 * 这里把超长章节按段落再切成若干节，保证任何一节的渲染开销都在安全范围内。
 *
 * 阈值取 1.6 倍：略超上限的正常章节不去动它，避免无谓地打散篇章结构。
 */
function capChapterSize(chapters, opts = {}) {
  const MAX = opts.maxChapterChars || 6000;
  const LIMIT = Math.round(MAX * 1.6);
  const out = [];
  for (const c of chapters) {
    const text = c.text || '';
    if (text.length <= LIMIT) { out.push(c); continue; }
    const paras = text.split('\n');
    let buf = [], len = 0, part = 0;
    const flush = () => {
      if (!buf.length) return;
      part++;
      const title = part === 1
        ? c.title
        : c.title.replace(/[（(]\d+[）)]$/, '').slice(0, 60) + '（' + part + '）';
      out.push({ title, text: buf.join('\n') });
      buf = []; len = 0;
    };
    for (const p of paras) {
      // 单段本身超长时不再累加，先落盘已有内容，避免一节远大于 MAX
      if (len && len + p.length > MAX) flush();
      buf.push(p);
      len += p.length + 1;
    }
    flush();
  }
  return out.map(c => ({ title: String(c.title || '').slice(0, 80), text: c.text }));
}

/* ---------------- TXT ---------------- */

export async function parseTxt(file, opts = {}) {
  const buf = await file.arrayBuffer();
  const { text, encoding } = decodeText(buf, opts.encoding);
  const title = guessTitleFromName(file.name);
  const chapters = await splitChapters(text, opts);
  if (!chapters.length) throw new Error('未能解析出任何内容，请检查文件是否为空');
  return {
    title,
    author: '',
    encoding,
    format: 'txt',
    chapters,
    cover: null,
  };
}

export function guessTitleFromName(name) {
  let t = String(name || '').replace(/\.(txt|text|epub)$/i, '');
  t = t.replace(/[（(【\[][^）)】\]]{0,30}[）)】\]]/g, '')   // 去括号后缀
       .replace(/(?:作者|by)[:：]?\s*\S+/i, '')
       .replace(/[_—\-]+\s*(?:完本|全集|全本|最新|精校|无删减|校对版|txt)?\s*$/i, '')
       .replace(/\s*(?:完本|全集|全本|最新|精校版|无删减|校对版)$/i, '')
       .trim();
  return t || '未命名小说';
}

/* ---------------- EPUB ---------------- */

function findFile(zip, path) {
  if (zip.file(path)) return path;
  const target = normalizePath(path).toLowerCase();
  const keys = Object.keys(zip.files);
  for (const k of keys) if (normalizePath(k).toLowerCase() === target) return k;
  for (const k of keys) if (normalizePath(k).toLowerCase().endsWith('/' + target)) return k;
  return null;
}

function htmlToText(html, dropTitle) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,nav,head,sup,rt,rp,iframe,svg').forEach(n => n.remove());
  if (dropTitle) {
    doc.querySelectorAll('h1,h2,h3,h4').forEach(n => {
      if ((n.textContent || '').trim() === dropTitle) n.remove();
    });
  }
  doc.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
  const root = doc.body || doc.documentElement;
  if (!root) return '';

  let nodes = Array.from(root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td'));
  if (!nodes.length) nodes = Array.from(root.querySelectorAll('div'));
  if (!nodes.length) return (root.textContent || '').replace(/\n{3,}/g, '\n\n').trim();

  const out = [];
  for (const n of nodes) {
    const t = (n.textContent || '').replace(/[\u00a0\u3000]/g, ' ').replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out.join('\n');
}

function pickInnerTitle(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const h = doc.querySelector('h1,h2,h3,h4,title');
  if (h) {
    const t = (h.textContent || '').trim();
    if (t && t.length <= 60) return t;
  }
  return '';
}

export async function parseEpub(file, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  if (typeof JSZip === 'undefined') throw new Error('EPUB 解析组件未加载');
  const buf = await file.arrayBuffer();
  onProgress(5);
  const zip = await JSZip.loadAsync(buf);

  const containerPath = findFile(zip, 'META-INF/container.xml');
  if (!containerPath) throw new Error('不是有效的 EPUB 文件（缺少 container.xml）');
  const container = await zip.file(containerPath).async('string');
  const opfMatch = /full-path=["']([^"']+)["']/.exec(container);
  if (!opfMatch) throw new Error('EPUB 容器文件损坏');
  const opfPath = normalizePath(opfMatch[1]);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  onProgress(15);

  const opf = await zip.file(findFile(zip, opfPath)).async('string');

  // manifest
  const items = {};
  opf.replace(/<item\b[^>]*>/gi, tag => {
    const id = attr(tag, 'id');
    if (id) items[id] = { href: attr(tag, 'href'), media: attr(tag, 'media-type'), props: attr(tag, 'properties') };
    return tag;
  });

  // spine
  const spineMatch = /<spine\b([^>]*)>([\s\S]*?)<\/spine>/i.exec(opf);
  const idrefs = [];
  if (spineMatch) {
    spineMatch[2].replace(/<itemref\b[^>]*>/gi, t => {
      const id = attr(t, 'idref');
      const linear = attr(t, 'linear');
      if (id && items[id] && linear !== 'no') idrefs.push(id);
      return t;
    });
  }
  if (!idrefs.length) {
    for (const id of Object.keys(items)) {
      if (/x?html|xml/i.test(items[id].media || '')) idrefs.push(id);
    }
  }
  onProgress(25);

  // 元数据
  const title = (/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf) || [])[1]?.replace(/<[^>]+>/g, '').trim() || guessTitleFromName(file.name);
  const author = (/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf) || [])[1]?.replace(/<[^>]+>/g, '').trim() || '';

  // 目录（NCX / NAV）→ href => title
  const tocMap = {};
  const ncxId = spineMatch ? attr(spineMatch[1] || '', 'toc') : '';
  let tocPath = null;
  if (ncxId && items[ncxId]) tocPath = resolvePath(base, items[ncxId].href);
  else {
    for (const id of Object.keys(items)) {
      const it = items[id];
      if (/ncx/i.test(it.media || '') || /\.ncx$/i.test(it.href || '')) { tocPath = resolvePath(base, it.href); break; }
      if ((it.props || '').includes('nav')) { tocPath = resolvePath(base, it.href); break; }
    }
  }
  if (tocPath) {
    const p = findFile(zip, tocPath);
    if (p) {
      const tocXml = await zip.file(p).async('string');
      if (/\.ncx$/i.test(tocPath)) {
        tocXml.replace(/<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi, (_, block) => {
          const src = (/<content\b[^>]*src=["']([^"']+)["']/i.exec(block) || [])[1];
          const label = (/<text[^>]*>([\s\S]*?)<\/text>/i.exec(block) || [])[1];
          if (src && label) tocMap[resolvePath(base, src)] = label.replace(/<[^>]+>/g, '').trim();
          return block;
        });
      } else {
        tocXml.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
          const t = txt.replace(/<[^>]+>/g, '').trim();
          if (t) tocMap[resolvePath(base, href)] = t;
          return _;
        });
      }
    }
  }
  onProgress(35);

  // 封面
  let cover = null;
  const metaCover = (/<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i.exec(opf) || [])[1];
  let coverHref = metaCover && items[metaCover] ? items[metaCover].href : '';
  if (!coverHref) {
    for (const id of Object.keys(items)) {
      const it = items[id];
      if ((it.props || '').includes('cover-image') || /^cover/i.test(id)) { coverHref = it.href; break; }
    }
  }
  if (!coverHref) {
    const g = /<reference\b[^>]*type=["']cover["'][^>]*href=["']([^"']+)["']/i.exec(opf);
    if (g) coverHref = g[1];
  }
  if (coverHref) {
    const p = findFile(zip, resolvePath(base, coverHref));
    if (p) {
      try { cover = await zip.file(p).async('blob'); } catch (e) { cover = null; }
    }
  }

  // 正文
  const chapters = [];
  const seen = new Set();
  for (let i = 0; i < idrefs.length; i++) {
    const it = items[idrefs[i]];
    if (!it) continue;
    const path = resolvePath(base, it.href);
    if ((it.props || '').includes('nav')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const real = findFile(zip, path);
    if (!real || zip.files[real].dir) continue;
    let html;
    try { html = await zip.file(real).async('string'); } catch (e) { continue; }
    const inner = tocMap[path] || '';
    const text = htmlToText(html, inner);
    if (!text) continue;
    const t = (tocMap[path] || pickInnerTitle(html) || ('第 ' + (chapters.length + 1) + ' 章')).slice(0, 80);
    if (chapters.length && text.length < 40) {
      chapters[chapters.length - 1].text += '\n' + text;      // 过短片段并入上一章
    } else {
      chapters.push({ title: t, text });
    }
    if (i % 10 === 0) {
      onProgress(35 + Math.round(i / idrefs.length * 60));
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (!chapters.length) throw new Error('未能从 EPUB 中读取到正文');
  onProgress(100);
  return { title, author, format: 'epub', encoding: 'utf-8', chapters, cover };
}

/* ---------------- 统一入口 ---------------- */

export async function parseFile(file, opts = {}) {
  const name = (file.name || '').toLowerCase();
  if (/\.epub$/.test(name)) return parseEpub(file, opts);
  return parseTxt(file, opts);
}

/* ---------------- 句子切分（供听书使用） ---------------- */

export function splitSentences(text) {
  const out = [];
  const paras = String(text).split(/\n+/);
  for (const p of paras) {
    const s = p.trim();
    if (!s) continue;
    if (s.length <= 120) { out.push(s); continue; }
    let buf = '';
    for (const ch of s) {
      buf += ch;
      if ('。！？；…'.includes(ch) && buf.length >= 30) { out.push(buf); buf = ''; }
      else if (buf.length >= 100 && '，,、'.includes(ch)) { out.push(buf); buf = ''; }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}
