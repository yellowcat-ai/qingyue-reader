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

  return chapters.map(c => ({ title: c.title.slice(0, 80), text: c.text }));
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
  let t = String(name || '').replace(/\.(txt|text|epub|pdf)$/i, '');
  // 括号里的「精校版/全本/TXT」是噪声要删，但「（一）」「（上）」是卷次，删了书名就残了
  const KEEP_PAREN = /^[（(【\[]\s*(?:[上中下]|[一二三四五六七八九十]{1,3}|\d{1,2})(?:卷|册|部|集)?\s*[）)】\]]$/;
  t = t.replace(/[（(【\[][^）)】\]]{0,30}[）)】\]]/g, m => (KEEP_PAREN.test(m) ? m : ''))   // 去括号后缀
      .replace(/(?:作者|by)[:：]?\s*\S+/i, '')
      .replace(/[_—\-]+\s*(?:完本|全集|全本|最新|精校|无删减|校对版|txt)?\s*$/i, '')
      .replace(/\s*(?:完本|全集|全本|最新|精校版|无删减|校对版)$/i, '')
      .trim();
  return t || '未命名小说';
}

/** 从「书名-作者」型文件名里拆出作者（仅 2–3 字中文名，且书名不少于 2 字）
 *  只在元数据没有作者时兜底：三联版《倚天屠龙记(一)-金庸.pdf》实测书名会带上「-金庸」 */
export function guessAuthorFromName(name) {
  const t = String(name || '').replace(/\.(txt|text|epub|pdf)$/i, '').trim();
  const m = /^(.{2,}?)[\s_—–\-]+([\u4e00-\u9fa5]{2,3})$/.exec(t);
  return m ? m[2] : '';
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

/* ---------------- PDF ----------------
 * 走「文本层抽取」路线：pdf.js 取每页文字 → 按基线还原行/段落 → 书签切章（无书签走正则/按页兜底）
 * 结果与 TXT/EPUB 完全同构，分章、进度记忆、翻页、听书、跨章连播全部复用
 * 扫描件（图片型 PDF）没有文字层，直接给出明确报错，不做 OCR
 */

const RE_CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 懒取 pdf.js（index.html 已同步引入，缺失时给出可读错误） */
function pdfLib() {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('PDF 引擎未加载，请重启应用后再试');
  if (!lib.__qyReady) {
    const base = new URL('../vendor/pdfjs/', import.meta.url).href;
    lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
    lib.__qyBase = base;
    lib.__qyReady = true;
  }
  return lib;
}

function modeNum(arr) {
  const m = new Map();
  let best = 0, bestN = 0;
  for (const v of arr) {
    const k = Math.round(v);
    const n = (m.get(k) || 0) + 1;
    m.set(k, n);
    if (n > bestN) { bestN = n; best = k; }
  }
  return best;
}

function needSpace(a, b) {
  if (!a || !b) return false;
  return !RE_CJK.test(a[a.length - 1]) && !RE_CJK.test(b[0]);
}

/**
 * 单页文字块 → 段落数组（纯文本，对外接口）
 * 需要段落的版式信息（首行是否缩进、末行是否顶格）时用 layoutPageEx
 */
export function layoutPage(items) {
  return layoutPageEx(items).map(o => o.t);
}

/**
 * 单页文字块 → 段落数组，每项带版式标记：
 *   head = 该段首行右移（缩进），tail = 该段末行顶到右边界（未被软换行截断）
 * 跨页续段判定必须用这两个几何量：仅凭「上一段有无句末标点」会把
 * 「一句正好写到页末」的段落误判成已结束（《倚天屠龙记》实测 11 处）
 * 先按基线聚类成行，再按「首行缩进 / 行距突增 / 短行结尾」合并成段
 */
function pageRows(items) {
  const parts = [];
  for (const it of items) {
    if (it.type && it.type !== 'str') continue;
    const s = it.str;
    if (!s || !s.trim()) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const h = Math.abs(tr[3]) || it.height || 10;
    parts.push({ x: tr[4], y: tr[5], w: it.width || 0, h, s });
  }
  if (!parts.length) return null;

  parts.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  // 1) 聚类成行（同一基线 ± 一半字高）
  const lines = [];
  for (const p of parts) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - p.y) <= Math.max(2.5, Math.max(last.h, p.h) * 0.5)) {
      last.items.push(p);
      last.n++;
      last.y += (p.y - last.y) / last.n;
      if (p.h > last.h) last.h = p.h;
    } else {
      lines.push({ y: p.y, h: p.h, n: 1, items: [p] });
    }
  }

  // 2) 行内按 x 顺序拼接（英文按字距补空格，中文直接连）
  const rows = [];
  for (const L of lines) {
    const its = L.items.slice().sort((a, b) => a.x - b.x);
    let text = '', prev = null, minX = Infinity, maxX = 0;
    for (const it of its) {
      if (it.x < minX) minX = it.x;
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        if (gap > Math.max(1.2, L.h * 0.28) && needSpace(prev.s, it.s)) text += ' ';
      }
      text += it.s;
      if (it.x + it.w > maxX) maxX = it.x + it.w;
      prev = it;
    }
    text = text.replace(/[\s\u00a0]+/g, ' ').replace(/\u22ef/g, '\u2026').trim();
    if (text) rows.push({ y: L.y, h: L.h, x: minX === Infinity ? 0 : minX, right: maxX, text });
  }
  if (!rows.length) return null;

  // 页眉/页脚里的孤立页码必须在这里先剔除：它与正文行距相同，否则会在合并段落时
  // 被当成续行直接拼进正文（典型症状：「…光耀门」+「6」→「…光耀门6」）
  if (rows.length > 4) {
    for (let i = 0; i < rows.length; i++) {
      const edge = i <= 1 || i >= rows.length - 2;
      if (edge && rows[i].text.length <= 8 && isPageNoise(rows[i].text)) { rows.splice(i, 1); i--; }
    }
  }
  if (!rows.length) return null;

  const hMed = rows.map(r => r.h).sort((a, b) => a - b)[rows.length >> 1] || 10;
  return {
    rows, hMed,
    left: modeNum(rows.map(r => r.x)),
    right: modeNum(rows.map(r => r.right)),
  };
}

/**
 * 单页文字块 → 段落数组（带版式标记，内部使用）
 * gm = 全书版心估计 {left, right}，缺省时退回页内众数
 */
function layoutPageEx(items, gm) {
  const pr = pageRows(items);
  if (!pr) return [];
  const { rows, hMed } = pr;
  // 版心边界优先用全书估计：整页都是诗句/引文时，页内众数会把「诗行宽度」当成版心，
  // 短行判据集体失效（《唐诗三百首》整首诗并成一段）。仅当页内值更靠外时才回退
  const left = (gm && gm.left != null && gm.left <= pr.left) ? gm.left : pr.left;
  const right = Math.max(pr.right, (gm && gm.right) || 0);

  // 行距基准取页内相邻行间距的众数：段间空行必须相对于「本书的行距」判断，
  // 不能用字号的固定倍数——Word 导出的 1.5 倍行距可达字号的 2.2 倍，会被全页误判为段间空行
  const dys = [];
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i - 1].y - rows[i].y;
    if (d > hMed * 1.05 && d < hMed * 4) dys.push(d);           // 排掉同行残留与跨栏大跳
  }
  const pitch = dys.length ? modeNum(dys) : hMed * 1.4;
  const gapMin = Math.max(pitch * 1.45, hMed * 1.15);

  // 3) 合并为段落
  const paras = [];
  let buf = '', bufHead = false, bufTail = false, prev = null;
  for (const r of rows) {
    // 缩进判据取 1.8 字：中文首行缩进惯例是 2 字，而诗行/引文块的悬挂偏移多为 1.5 字
    const indented = r.x - left > hMed * 1.8;
    const fullLine = r.right >= right - hMed * 2.5;
    const gapBreak = prev ? (prev.y - r.y) > gapMin : false;
    const shortEnd = prev ? (prev.right < right - hMed * 2.5 &&
      /[。！？…；;：:]$/.test(prev.text.replace(/[”"』」’']+$/, ''))) : false;
    if (prev && !indented && !gapBreak && !shortEnd) {
      if (/-$/.test(buf) && /^[a-z]/.test(r.text)) buf = buf.slice(0, -1) + r.text;   // 英文连字符断词
      else buf += (needSpace(buf, r.text) ? ' ' : '') + r.text;
      bufTail = fullLine;
    } else {
      if (buf) paras.push({ t: buf, head: bufHead, tail: bufTail });
      buf = r.text;
      bufHead = indented;
      bufTail = fullLine;
    }
    prev = r;
  }
  if (buf) paras.push({ t: buf, head: bufHead, tail: bufTail });

  // 4) 页码 / 分隔线 / 站点水印清理（只过滤短行，避免误伤正文）
  return paras.filter(o => o.t && !isPageNoise(o.t) && !/^[-—–·=*_\s]{3,}$/.test(o.t) &&
    !(o.t.length < 60 && RE_AD.test(o.t)));
}

/** 页码类噪声：1 / 3 / 12 / IV / — 3 — / 第 3 页 / 3/120 共 10 页 */
function isPageNoise(t) {
  const s = t.replace(/^[\s—–\-·•=*_~]+|[\s—–\-·•=*_~]+$/g, '');
  if (!s) return true;
  if (/^\d{1,4}$/.test(s)) return true;
  if (/^[ivxlcIVXLC]{1,6}$/.test(s)) return true;
  if (/^第\s*\d{1,4}\s*页(\s*[/／|,，]?\s*共\s*\d{1,4}\s*页)?$/.test(s)) return true;
  if (/^\d{1,4}\s*[/／]\s*\d{1,4}$/.test(s)) return true;
  if (/^(page|p\.)\s*\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(s)) return true;
  return false;
}

/** 去掉页眉页脚：在多页重复出现的首/末行视为页眉页脚
 *  仅对短行生效——页眉页脚不会超过 40 字，正文段落即使重复也不能删 */
function stripRunning(pages) {
  const n = pages.length;
  if (n < 4) return pages;
  const MAX = 40;
  const counts = new Map();
  for (const ps of pages) {
    if (!ps.length) continue;
    const cands = new Set();
    if (ps[0].t.length <= MAX) cands.add('T' + ps[0].t);
    if (ps.length > 1 && ps[ps.length - 1].t.length <= MAX) cands.add('B' + ps[ps.length - 1].t);
    for (const c of cands) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const limit = Math.max(3, Math.ceil(n * 0.3));
  const drop = new Set();
  for (const [k, v] of counts) if (v >= limit) drop.add(k);
  if (!drop.size) return pages;
  return pages.map(ps => ps.filter((o, i) => {
    if (o.t.length > MAX) return true;
    if (i === 0 && drop.has('T' + o.t)) return false;
    if (i === ps.length - 1 && ps.length > 1 && drop.has('B' + o.t)) return false;
    return true;
  }));
}

/** 合并被分页切断的段落：上一段没有句末标点，且下一段不像新段开头
 *
 *  按「段落流」处理而不是按页配对：整页只产出一段时，该段会并入上一页，这一页随即变空。
 *  若按页配对，p[i+1] 为空后 `p[i+1]→p[i+2]` 的续段再也接不上，正文会被切成两半
 *  （实测《围城》表现为「…光耀门」与「楣，也是…」之间多出一个空段）。 */
function joinAcrossPages(pages, boundary) {
  const END = /[。！？…；;：:）)】》」』]$/;
  const QUOTE = /[”"』」’']+$/;
  const NEW_PARA = /^[\u3000\s]/;
  // 下一段若是章节标题，说明这里是分章点，不能跨页续段
  const HEADING = /^(第[〇零一二三四五六七八九十百千两0-9]{1,6}[回章节卷篇集部]|附录|附记|前言|序言|后记|楔子|尾声|尾聲|目录)/;

  const flat = [];
  pages.forEach((ps, pi) => { for (const t of ps) flat.push({ pi, o: t }); });
  if (!flat.length) return pages;

  // 本书是否用首行缩进来标记新段：缩进页占比低时缩进不可信，退回纯文本判据
  const heads = flat.filter(f => f.o.head).length;
  const indentBook = heads >= Math.max(8, flat.length * 0.2);

  // 两段之间若隔着章节起始页，就不许合并
  const crossed = (from, to) => {
    if (!boundary || !boundary.size) return false;
    for (let p = from + 1; p <= to; p++) if (boundary.has(p)) return true;
    return false;
  };

  const kept = [flat[0]];
  for (let k = 1; k < flat.length; k++) {
    const cur = flat[k], prev = kept[kept.length - 1];
    if (cur.pi !== prev.pi && !crossed(prev.pi, cur.pi)) {
      const last = prev.o.t, first = cur.o.t;
      const noEnd = !END.test(last.replace(QUOTE, ''));
      // 页末行顶到右边界 = 该段被分页硬切；下一页首行齐左 = 续段（新段必然缩进）
      const cutByPage = prev.o.tail === true;
      const contHead = !cur.o.head;
      const ok = last.length >= 8 &&
        !NEW_PARA.test(first) &&
        !HEADING.test(first.replace(/\s+/g, '')) &&
        (indentBook ? (contHead && (cutByPage || noEnd)) : noEnd);
      if (ok) {   // 段落仍归起始页，切章边界才不会漂移
        prev.o.t = last + first;
        prev.o.tail = cur.o.tail;
        continue;
      }
    }
    kept.push(cur);
  }

  const out = pages.map(() => []);
  for (const it of kept) out[it.pi].push(it.o);
  return out;
}

/** 最长公共子序列长度（短串用，标题比对） */
function lcsLen(a, b) {
  const n = b.length, dp = new Uint16Array(n + 1);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : (dp[j] > dp[j - 1] ? dp[j] : dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/** 书签切章时正文首行通常就是章节标题本身，去掉避免与 title 重复显示 */
function dropDupTitle(text, title) {
  const t = String(text || '');
  const nl = t.indexOf('\n');
  if (nl <= 0) return t;
  const norm = s => String(s)
    .replace(/[\u2460-\u2473]/g, '')        // ①-⑳ 脚注序号
    .replace(/[\s\u3000:：·•—–\-_.、,，]+/g, '')
    .toLowerCase();
  const a = norm(t.slice(0, nl)), b = norm(title);
  if (!a || !b) return t;
  let same = a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));
  // 书签标题与正文标题常有细微差异（多「同」字、脚注号位置不同），短串允许 20% 容错
  if (!same && a.length >= 6 && b.length >= 6 && Math.abs(a.length - b.length) <= 4) {
    same = lcsLen(a, b) >= Math.min(a.length, b.length) * 0.8;
  }
  return same ? t.slice(nl + 1).trim() : t;
}

/** 目录页不是正文：标题为「目录」且正文被虚线/省略号占满时跳过，
 *  否则听书会把「序·····1 第一章·····9」逐条念出来 */
function isTocChapter(title, text) {
  if (!/^目\s*录$/.test(String(title || '').trim())) return false;
  const dots = (String(text).match(/[·.．…]/g) || []).length;
  return dots >= String(text).length * 0.25;
}

/** 无书签、正文也没有「第 N 章」时，按页数分组兜底 */function chunkPages(pages) {
  const out = [];
  let buf = [], chars = 0, from = 0;
  for (let i = 0; i < pages.length; i++) {
    for (const o of pages[i]) { buf.push(o.t); chars += o.t.length; }
    if (chars >= 4000 || i === pages.length - 1) {
      const text = buf.join('\n').trim();
      if (text) out.push({ title: from === i ? `第 ${i + 1} 页` : `第 ${from + 1}–${i + 1} 页`, text });
      buf = []; chars = 0; from = i + 1;
    }
  }
  return out;
}

/** 抽样估计全书版心（左边界 / 右边界）
 *
 *  页内众数只对「正文占满版面」的书成立。诗集/注疏本里常有整页都是居中短行的情况，
 *  此时页内众数会把诗行宽度当版心，缩进与短行两个判据同时失效，整首诗并成一段。
 *  抽样 16 页取左边界 5 分位、右边界 98 分位作为本书版心，再交给每页复用。
 */
async function probeMargins(pdf, pageCount) {
  if (pageCount < 3) return null;
  const n = pageCount <= 24 ? 6 : 16;
  const lefts = [], rights = [];
  for (let k = 0; k < n; k++) {
    const i = Math.min(pageCount, 1 + Math.floor(k * pageCount / n));
    try {
      const page = await pdf.getPage(i);
      const pr = pageRows((await page.getTextContent()).items);
      page.cleanup();
      if (!pr) continue;
      for (const r of pr.rows) { lefts.push(r.x); rights.push(r.right); }
    } catch (e) { /* 抽样失败不影响主流程 */ }
  }
  if (lefts.length < 8) return null;
  lefts.sort((a, b) => a - b);
  rights.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))];
  return { left: q(lefts, 0.05), right: q(rights, 0.98) };
}

/* ==================== 导入前结构体检 ====================
 * 只做抽样只读检测：判断这本书属于「扫描件 / 竖排 / 多栏」中的哪一种。
 * 前两类注定抽不出字或顺序错乱，与其让用户导入一本排版乱掉的书，不如提前说清楚。
 * 阈值由 511 页真实横排书（倚天 + 唐诗）标定，正常书零误报。
 */

const BAND_MIN = 14;          // 栏间空白带的物理下限（pt）
const BAND_CROSS_RATIO = 0.12; // 允许横跨空白带的行数占比（跨栏大标题 / 页眉）
const BAND_SIDE_SHARE = 0.25;  // 空白带两侧各自至少要有的字符占比

/** 把一页的文字块摊成「准字符」序列：每个字符一个 x 区间 + 旋转标记
 *  pdf.js 只给整段的起止 x，按字符数等分即可用于间距统计（同一段字符本就连续） */
function charCells(items) {
  const cells = [];
  for (const it of items) {
    if (it.type && it.type !== 'str') continue;
    const s = (it.str || '').replace(/\s+/g, '');
    if (!s) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const h = Math.abs(tr[3]) || it.height || 10;
    // 文本空间 x 轴映射到页面的方向：偏离水平 55°–125° 即竖排/旋转字
    const ang = Math.abs(Math.atan2(tr[1], tr[0])) * 180 / Math.PI;
    const rot = ang > 55 && ang < 125;
    const step = (it.width || 0) / s.length;
    for (let k = 0; k < s.length; k++) {
      cells.push({ x0: tr[4] + k * step, x1: tr[4] + (k + 1) * step, y: tr[5], h, rot });
    }
  }
  return cells;
}

function medOf(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[a.length >> 1];
}

/** 单页结构判定 → {n, rot, band, upright} */
function pageStruct(items) {
  const cells = charCells(items);
  const n = cells.length;
  if (!n) return { n: 0, rot: 0, band: null, upright: false };
  const h = medOf(cells.map(c => c.h)) || 10;
  const rot = cells.filter(c => c.rot).length / n;

  // 行聚类（基线容差半个字高）
  const sorted = cells.slice().sort((a, b) => b.y - a.y);
  const rows = [];
  for (const c of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - c.y) <= Math.max(2, h * 0.5)) {
      last.cells.push(c);
      last.y += (c.y - last.y) / last.cells.length;
    } else rows.push({ y: c.y, cells: [c] });
  }
  for (const r of rows) r.cells.sort((a, b) => a.x0 - b.x0);

  // 旋转字过半已是竖排，几何量在旋转坐标系里没有意义，不再往下算
  if (rot >= 0.5) return { n, rot, band: null, upright: true };

  for (const r of rows) {
    const cs = r.cells, gaps = [];
    for (let i = 1; i < cs.length; i++) gaps.push(cs[i].x0 - cs[i - 1].x1);
    r.gap = gaps.length ? medOf(gaps) : -1;
  }

  // 竖排（直立字）：同一行内相邻字符普遍隔开一个字以上，且整页每行只有几个字
  const basis = rows.filter(r => r.cells.length >= 3);
  const gapOk = basis.filter(r => r.gap >= h).length;
  const upright = n >= 150 && basis.length >= 4 && gapOk >= basis.length * 0.6;

  // 多栏：版心中部找一条「几乎没有行穿过」的竖向空白带，两侧都有足量文字
  const xmin = Math.min(...cells.map(c => c.x0));
  const xmax = Math.max(...cells.map(c => c.x1));
  const w = Math.max(1e-6, xmax - xmin);
  const bw = Math.max(BAND_MIN, h * 1.3);
  let band = null, bestScore = -1;
  const maxCross = Math.max(1, Math.floor(rows.length * BAND_CROSS_RATIO));
  if (rows.length >= 4 && w > bw * 3) {
    for (let b0 = xmin + w * 0.2; b0 <= xmin + w * 0.8; b0 += 3) {
      const b1 = b0 + bw;
      let cross = 0;
      for (const r of rows) {
        if (r.cells.some(c => c.x0 < b1 && c.x1 > b0)) cross++;
      }
      if (cross > maxCross) continue;
      let lc = 0, rc = 0;
      for (const c of cells) {
        if (c.x1 <= b0) lc++;
        else if (c.x0 >= b1) rc++;
      }
      if (lc < n * BAND_SIDE_SHARE || rc < n * BAND_SIDE_SHARE) continue;
      const score = (rows.length - cross) * 1000 + lc + rc;
      if (score > bestScore) { bestScore = score; band = { x0: b0, x1: b1, lc, rc }; }
    }
  }
  return { n, rot, band, upright };
}

/** 数一下前几页有没有大图，用于把「抽不出字」说成扫描件而不是空的矢量 PDF */
async function hasImages(pdf, pageCount) {
  const lib = pdfLib();
  const OPS = (lib.OPS && lib.OPS.paintImageXObject && lib.OPS.paintJpegXObject)
    ? lib.OPS : lib.OPS || {};
  const codes = [OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImage]
    .filter(v => typeof v === 'number');
  const n = Math.min(3, pageCount);
  for (let i = 1; i <= n; i++) {
    try {
      const page = await pdf.getPage(i);
      const ops = await page.getOperatorList();
      for (const fn of (ops.fnArray || [])) if (codes.includes(fn)) { page.cleanup(); return true; }
      page.cleanup();
    } catch (e) { /* 取不到操作符就当没有图 */ }
  }
  return false;
}

/** 全书结构体检：抽样 12 页，按命中页占比给出结论 */
async function inspectLayout(pdf, pageCount) {
  const sampleN = pageCount <= 12 ? pageCount : 12;
  let textPages = 0, chars = 0, vertHits = 0, colHits = 0;
  for (let k = 0; k < sampleN; k++) {
    const i = Math.min(pageCount, 1 + Math.floor(k * pageCount / sampleN));
    let page = null;
    try {
      page = await pdf.getPage(i);
      const st = pageStruct((await page.getTextContent()).items);
      if (st.n >= 40) {
        textPages++;
        chars += st.n;
        if (st.upright) vertHits++;
        if (st.band) colHits++;
      }
    } catch (e) { /* 抽样失败不影响导入 */ }
    if (page) { try { page.cleanup(); } catch (e) { /* ignore */ } }
  }

  const avg = chars / Math.max(1, sampleN);
  const res = { sampled: sampleN, textPages, avg: Math.round(avg), kind: null };
  if (textPages === 0 || avg < 20) {
    res.kind = 'scanned';
    res.imageOnly = await hasImages(pdf, pageCount);
    return res;
  }
  if (textPages < 4) return res;          // 样本太少，不下结论
  const rv = vertHits / textPages, rc = colHits / textPages;
  if (rv >= 0.5) res.kind = 'vertical';
  else if (rc >= 0.4) res.kind = 'columns';
  res.vertRatio = Math.round(rv * 100);
  res.colRatio = Math.round(rc * 100);
  return res;
}

/** 读 PDF 书签（outline）→ [{page, title}]，同页只保留第一个 */
async function outlineMarks(pdf, pageCount) {
  let outline = null;
  try { outline = await pdf.getOutline(); } catch (e) { outline = null; }
  if (!outline || !outline.length) return [];

  const marks = [];
  const walk = async (items, depth) => {
    for (const it of items) {
      let p = -1;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          const ref = dest[0];
          p = (typeof ref === 'number') ? ref : await pdf.getPageIndex(ref);
        }
      } catch (e) { p = -1; }
      const title = String(it.title || '').replace(/\s+/g, ' ').trim();
      if (p >= 0 && p < pageCount && title) marks.push({ page: p, title, depth });
      if (it.items && it.items.length) await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 0);

  marks.sort((a, b) => a.page - b.page);
  const out = [];
  for (const m of marks) if (!out.length || m.page > out[out.length - 1].page) out.push(m);
  return out;
}

/** 渲染首页做封面（失败或超时都不影响导入） */
async function renderPdfCover(pdf, timeoutMs = 4000) {
  const job = (async () => {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 640 / (base.width || 640));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
    page.cleanup();
    return await new Promise(r => {
      try { canvas.toBlob(b => r(b || null), 'image/jpeg', 0.82); } catch (e) { r(null); }
    });
  })().catch(() => null);
  // 部分机型/无 GPU 环境下 render 可能永不 resolve，超时即放弃封面
  return await Promise.race([job, new Promise(r => setTimeout(() => r(null), timeoutMs))]);
}

/** 已归并好的段落流 → 章节：书签优先 → 正文正则 → 按页兜底 */
async function buildPdfChapters(pdf, cleaned, marks, pageCount, onProgress) {
  let chapters = [];
  if (marks.length >= 2) {
    const seq = marks[0].page > 0 ? [{ page: 0, title: '开篇' }].concat(marks) : marks;
    for (let k = 0; k < seq.length; k++) {
      const from = seq[k].page;
      const to = k + 1 < seq.length ? seq[k + 1].page : pageCount;
      // filter(Boolean)：书里夹的空白页/插图页提取不出段落，别在正文里留下空行
      const text = dropDupTitle(
        cleaned.slice(from, to).map(ps => ps.map(o => o.t).join('\n')).filter(Boolean).join('\n').trim(),
        seq[k].title
      );
      if (text && !isTocChapter(seq[k].title, text)) chapters.push({ title: seq[k].title, text });
    }
  }
  if (chapters.length < 2) {
    const full = cleaned.map(ps => ps.map(o => o.t).join('\n')).join('\n').trim();
    const byRe = await splitChapters(full, { onProgress: p => onProgress(88 + Math.round(p / 100 * 8)) });
    chapters = byRe.length >= 2 ? byRe : chunkPages(cleaned);
  }
  if (!chapters.length) throw new Error('未能从 PDF 中解析出正文');
  return chapters;
}

export async function parsePdf(file, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  if (file.size > 120 * 1048576) throw new Error('PDF 超过 120 MB，建议先压缩或拆分后再导入');

  const lib = pdfLib();
  onProgress(2);
  const buf = await file.arrayBuffer();

  let pdf;
  try {
    pdf = await lib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: lib.__qyBase + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: lib.__qyBase + 'standard_fonts/',
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
    }).promise;
  } catch (e) {
    if (e && (e.name === 'PasswordException' || /password/i.test(e.message || '')))
      throw new Error('PDF 有密码保护，无法导入');
    throw new Error('PDF 打开失败：' + ((e && e.message) || '文件可能已损坏'));
  }

  try {
    const pageCount = pdf.numPages;
    // 结构体检放在最前面：扫描件/竖排/多栏在这本 PDF 里是全局属性。
    // 结论直接决定阅读方式（readMode）——抽不出字或顺序必乱的，按页原样显示，
    // 而不是报错拒绝：扫描件当图片看是完全可读的，报错反而是最差的选择。
    const health = await inspectLayout(pdf, pageCount);
    onProgress(4);
    const scanned = health.kind === 'scanned';
    const weak = health.kind === 'vertical' || health.kind === 'columns';
    const warnings = [];
    if (scanned) {
      warnings.push('这是图片型扫描 PDF（没有文字层），已按原样显示页面：能看能翻，但无法重排、无法全文搜索' +
        (health.imageOnly ? '' : '。页面里也没找到图片，可能是纯图形文件'));
    } else if (health.kind === 'vertical') {
      warnings.push(`竖排旧版排式（${health.vertRatio}% 的抽查页为竖排），已默认原样显示页面；切换重排后文字顺序可能错乱`);
    } else if (health.kind === 'columns') {
      warnings.push(`多栏排版（${health.colRatio}% 的抽查页为多栏），已默认原样显示页面；切换重排后跨栏文字可能串行`);
    }

    // 书签先取：既用于切章/页内目录，也用于标记「不许跨页续段」的章节边界
    const marks = await outlineMarks(pdf, pageCount);
    const toc = marks.map(m => ({ page: m.page, title: m.title, depth: m.depth || 0 }));

    let chapters = [];
    let fallback = false;          // 抽出的字太少：退回按页显示
    if (!scanned) {
      const gm = await probeMargins(pdf, pageCount);   // 全书版心，判诗行/引文块必需
      const pages = [];
      for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        pages.push(layoutPageEx(tc.items, gm));
        page.cleanup();
        onProgress(2 + Math.round(i / pageCount * 86));
        if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
      }
      const boundary = new Set(marks.map(m => m.page));
      const cleaned = joinAcrossPages(stripRunning(pages), boundary);
      const chars = cleaned.reduce((a, ps) => a + ps.reduce((b, o) => b + o.t.length, 0), 0);
      if (chars < Math.max(200, pageCount * 12)) {
        fallback = true;
        warnings.push(`只抽到 ${chars} 字（${pageCount} 页），已按原样显示页面`);
      } else {
        chapters = await buildPdfChapters(pdf, cleaned, marks, pageCount, onProgress);
      }
    }

    let title = '', author = '';
    try {
      const md = await pdf.getMetadata();
      const info = (md && md.info) || {};
      title = String(info.Title || '').trim();
      author = String(info.Author || '').trim();
      if (/^(untitled|无标题|microsoft (word|powerpoint)|doc\d*)/i.test(title)) title = '';
      // 元数据里常被填成章节名/版式名（如「序」「目录」「正文」），这类不能当书名
      if (title.length <= 6 && /^(序|序言|序文|前言|引言|引子|楔子|目录|正文|后记|跋|附录|无题|未命名)$/.test(title)) title = '';
      if (/^第\s*[0-9一二三四五六七八九十百]{1,4}\s*[章回节卷篇]/.test(title)) title = '';
    } catch (e) { /* 元数据缺失不影响阅读 */ }
    if (!title) {
      title = guessTitleFromName(file.name);
      // 「书名-作者」型文件名：元数据没给作者时，把书名末尾的作者摘出来
      if (!author) {
        const a = guessAuthorFromName(file.name);
        if (a && title.endsWith(a)) {
          const head = title.slice(0, -a.length).replace(/[\s_—–\-]+$/, '').trim();
          if (head.length >= 2) { title = head; author = a; }
        }
      }
    }

    let cover = null;
    if (opts.cover !== false) {
      try { cover = await renderPdfCover(pdf); } catch (e) { cover = null; }
    }

    // 阅读方式：抽不出字 / 顺序必乱的，按页原样显示；其余走重排
    const readMode = (scanned || fallback || weak) ? 'page' : 'text';
    onProgress(100);
    return { title, author, format: 'pdf', encoding: '', chapters, cover, pageCount, warnings, readMode, toc };
  } finally {
    try { await pdf.destroy(); } catch (e) { /* 释放失败不阻塞导入 */ }
  }
}

/* ---------------- 统一入口 ---------------- */

export async function parseFile(file, opts = {}) {
  const name = (file.name || '').toLowerCase();
  if (/\.epub$/.test(name)) return parseEpub(file, opts);
  if (/\.pdf$/.test(name)) return parsePdf(file, opts);
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
