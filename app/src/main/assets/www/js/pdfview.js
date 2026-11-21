/**
 * pdfview.js — PDF 原样阅读：按页渲染，不做文字重排
 *
 * 为什么需要它：PDF 里没有段落语义，只有字形坐标，任何「重排」都是推断，
 * 而排版规则是开放的，所以每换一本书就可能推翻一条假设。
 * 结构体检判定一本书抽不出字或顺序必乱（扫描件 / 竖排 / 多栏）时，
 * 把页面原样画出来反而永远正确——不会错字，不会串行，不会吞段落。
 *
 * 代价：不能改字号/主题，不能全文搜索。可读性优先于可定制性。
 */

import { db } from './db.js';

const $ = id => document.getElementById(id);

const ZOOMS = [1, 1.5, 2, 3];
const KEEP = 3;              // 当前页前后各保留几页画布，其余释放掉，避免 300 页占满内存

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

export const pdfview = {
  book: null,
  pdf: null,
  pageCount: 0,
  zoom: 1,
  cur: 1,
  els: {},
  io: null,
  onExit: null,          // 返回书架
  onSwitch: null,        // 切成重排阅读
  onToast: null,

  _ph: [],               // 每页的占位元素
  _tops: [],             // 占位元素相对滚动容器的纵坐标（供二分查当前页）
  _rendered: new Set(),
  _queue: [],
  _busy: false,
  _aspect: 1.414,        // 高/宽，先用 A4 比例占位
  _saveT: 0,
  _raf: 0,
  _lastTap: 0,
  _chrome: false,

  /* ---------------- 初始化 ---------------- */
  init() {
    this.els = {
      page: $('page-pv'),
      scroll: $('pv-scroll'),
      pages: $('pv-pages'),
      top: $('pv-top'),
      bottom: $('pv-bottom'),
      name: $('pv-book-name'),
      sub: $('pv-page-name'),
      idx: $('pv-idx'),
      total: $('pv-total'),
      range: $('pv-range'),
      toast: $('pv-toast'),
      zoomBtn: $('pv-zoom'),
      tocList: $('pvtoc-list'),
      tocSheet: $('sheet-pvtoc'),
    };

    $('pv-back').addEventListener('click', () => this.close());
    $('pv-zoom').addEventListener('click', () => this.cycleZoom());
    $('pv-toc').addEventListener('click', () => this.openToc());
    $('pv-mode').addEventListener('click', () => {
      if (this.onSwitch) this.onSwitch('text');
    });
    $('pv-toc-close').addEventListener('click', () => this.els.tocSheet.classList.remove('open'));
    this.els.tocSheet.querySelector('.sheet-mask').addEventListener('click', () => this.els.tocSheet.classList.remove('open'));

    this.els.range.addEventListener('input', () => this.gotoPage(+this.els.range.value, false));

    // 单击页面空白：显隐上下栏；300ms 内再次单击：切换缩放
    this.els.scroll.addEventListener('click', e => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      const now = Date.now();
      if (now - this._lastTap < 300) { this._lastTap = 0; this.cycleZoom(); return; }
      this._lastTap = now;
      setTimeout(() => {
        if (this._lastTap === now) { this._lastTap = 0; this.toggleChrome(); }
      }, 300);
    });

    this.els.scroll.addEventListener('scroll', () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.onScroll(); });
    }, { passive: true });

    window.addEventListener('pagehide', () => this.saveProgress());
    window.addEventListener('resize', () => {
      if (!this.pdf) return;
      this.rebuild();               // 横竖屏切换后宽度变了，占位高度得跟着重算
    });
  },

  /* ---------------- 打开 / 关闭 ---------------- */
  async open(book) {
    this.book = book;
    this.cur = 1;
    this.zoom = 1;
    this.chrome(false);
    this.els.name.textContent = book.title || '';
    this.els.sub.textContent = '正在打开…';
    this.els.zoomBtn.textContent = '1×';
    // 只有抽出了文字的书才有「重排」可选，扫描件给这个按钮只会误导
    $('pv-mode').style.display = book.chapterCount ? '' : 'none';

    try {
      const raw = await db.getRaw(book.id);
      if (!raw || !raw.file) throw new Error('原始文件已不存在，请重新导入');
      const lib = pdfLib();
      const buf = await raw.file.arrayBuffer();
      this.pdf = await lib.getDocument({
        data: new Uint8Array(buf),
        cMapUrl: lib.__qyBase + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: lib.__qyBase + 'standard_fonts/',
        isEvalSupported: false,
        verbosity: 0,
      }).promise;
    } catch (e) {
      this.els.sub.textContent = '打开失败';
      this.toast('打不开原文件：' + ((e && e.message) || '文件可能已损坏'));
      return false;
    }

    this.pageCount = this.pdf.numPages;
    try {
      const p1 = await this.pdf.getPage(1);
      const vp = p1.getViewport({ scale: 1 });
      this._aspect = vp.height / vp.width;
      p1.cleanup();
    } catch (e) { /* 首页取不到就按 A4 比例占位 */ }

    this.build();
    const p = this.readPos(book);
    this.gotoPage(p, false);
    this._syncBar();
    // 上下栏默认收起，第一次进来得告诉用户点一下就出来
    if (!this._hinted) {
      this._hinted = true;
      setTimeout(() => this.toast('点一下屏幕可调出目录与页码'), 700);
    }
    return true;
  },

  async close() {
    await this.saveProgress();
    this.unmount();
    if (this.onExit) this.onExit();
  },

  /** 释放 pdf 与画布，避免换书后旧文档占着内存 */
  unmount() {
    if (this.io) { this.io.disconnect(); this.io = null; }
    if (this.pdf) { try { this.pdf.destroy(); } catch (e) { /* ignore */ } this.pdf = null; }
    if (this.els.pages) this.els.pages.innerHTML = '';
    this._ph = []; this._tops = []; this._rendered.clear(); this._queue.length = 0;
    this.pageCount = 0;
    this.book = null;
    this.els.tocSheet.classList.remove('open');
  },

  /* ---------------- 构建页面骨架 ---------------- */
  build() {
    const pages = this.els.pages;
    pages.innerHTML = '';
    this._ph = []; this._tops = []; this._rendered.clear(); this._queue.length = 0;
    const w = this.cssWidth();
    const h = Math.round(w * this._aspect);
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= this.pageCount; i++) {
      const d = document.createElement('div');
      d.className = 'pv-page';
      d.dataset.i = i;
      d.style.width = w + 'px';
      d.style.height = h + 'px';
      frag.appendChild(d);
      this._ph.push(d);
    }
    pages.appendChild(frag);
    this.els.range.max = this.pageCount;
    this.els.total.textContent = this.pageCount;
    this.applyPad();
    this.observe();
    this.layout();
  },

  /** 缩放/转屏后重建：保留当前页 */
  rebuild() {
    const at = this.cur;
    this.build();
    this.gotoPage(at, false);
  },

  cssWidth() {
    const w = this.els.scroll.clientWidth || window.innerWidth;
    return Math.round(w * this.zoom);
  },

  observe() {
    if (this.io) this.io.disconnect();
    if (!('IntersectionObserver' in window)) { this._ph.forEach((_, k) => this.schedule(k + 1)); return; }
    this.io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) this.schedule(+e.target.dataset.i);
    }, { root: this.els.scroll, rootMargin: '120% 0px' });
    for (const d of this._ph) this.io.observe(d);
  },

  /** 记录每页起点，供滚动时二分定位当前页（避免每帧读 offsetTop 触发排版） */
  layout() {
    this._tops = this._ph.map(d => d.offsetTop);
  },

  /* ---------------- 渲染 ---------------- */
  schedule(i) {
    if (!this.pdf || i < 1 || i > this.pageCount) return;
    if (this._rendered.has(i) || this._queue.indexOf(i) >= 0) return;
    this._queue.push(i);
    // 拖滑杆时会瞬间排进几十页：只留离当前位置最近的，其余丢弃
    if (this._queue.length > 8) {
      const cur = this.cur;
      this._queue.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
      this._queue.length = 8;
    }
    this.pump();
  },

  async pump() {
    if (this._busy) return;
    this._busy = true;
    while (this._queue.length) {
      const i = this._queue.shift();
      try { await this.renderPage(i); } catch (e) { /* 单页失败不影响其他页 */ }
    }
    this._busy = false;
    this.layout();
    // 被队列上限丢掉的页在这里补回来
    this.schedule(this.cur - 1); this.schedule(this.cur); this.schedule(this.cur + 1);
  },

  async renderPage(i) {
    if (this._rendered.has(i) || !this.pdf) return;
    const ph = this._ph[i - 1];
    if (!ph) return;
    const page = await this.pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const cssW = this.cssWidth();
    const cssH = Math.round(cssW * base.height / base.width);
    // 高分辨率屏最多按 2 倍像素渲染：再高只会爆内存，看不出差别
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (cssW / base.width) * dpr });

    let cv = ph.querySelector('canvas');
    if (!cv) { cv = document.createElement('canvas'); ph.appendChild(cv); }
    cv.width = Math.floor(vp.width);
    cv.height = Math.floor(vp.height);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    ph.style.width = cssW + 'px';
    ph.style.height = cssH + 'px';

    await page.render({ canvasContext: cv.getContext('2d', { alpha: false }), viewport: vp }).promise;
    page.cleanup();
    this._rendered.add(i);
    if (Math.abs(this._aspect - base.height / base.width) > 0.01) {
      this._aspect = base.height / base.width;   // 首页比例不代表全书（混排插页），记下真实值
      this.layout();
    }
  },

  /** 释放离当前页太远的画布 */
  prune() {
    if (this._rendered.size <= KEEP * 2 + 3) return;
    for (const i of Array.from(this._rendered)) {
      if (Math.abs(i - this.cur) <= KEEP) continue;
      const ph = this._ph[i - 1];
      const cv = ph && ph.querySelector('canvas');
      if (cv) cv.remove();
      this._rendered.delete(i);
    }
  },

  /* ---------------- 滚动与进度 ---------------- */
  onScroll() {
    if (!this.pageCount) return;
    const sc = this.els.scroll;
    const top = sc.scrollTop + 8;
    // 滚到底时最后几页可能都挤在视口里，这时候「当前页」应该是最后一页
    const atBottom = sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 2;
    const idx = atBottom ? this.pageCount : this.findPage(top);
    if (idx !== this.cur) {
      this.cur = idx;
      this._syncBar();
      this.prune();
      this.saveLater();
    }
  },

  findPage(y) {
    const t = this._tops;
    if (!t.length) return 1;
    let lo = 0, hi = t.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans + 1;
  },

  gotoPage(n, smooth) {
    if (!this.pageCount) return;
    n = Math.min(Math.max(1, n), this.pageCount);
    const ph = this._ph[n - 1];
    if (!ph) return;
    const top = ph.offsetTop;
    if (smooth === false) this.els.scroll.scrollTop = top;
    else this.els.scroll.scrollTo({ top, behavior: 'smooth' });
    this.cur = n;
    this._syncBar();
    this.schedule(n);
    this.schedule(n + 1);
    this.saveLater();
  },

  _syncBar() {
    const e = this.els;
    e.idx.textContent = this.cur;
    if (e.range.value !== String(this.cur)) e.range.value = this.cur;
    e.sub.textContent = this.sectionAt(this.cur - 1) || ('第 ' + this.cur + ' / ' + this.pageCount + ' 页');
  },

  /** 当前页所属的书签小节（有目录时显示小节名，比页码有用） */
  sectionAt(pageIdx) {
    const toc = this.book && this.book.toc;
    if (!toc || !toc.length) return '';
    let name = '';
    for (const t of toc) { if (t.page <= pageIdx) name = t.title; else break; }
    return name;
  },

  saveLater() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveProgress(), 700);
  },

  async saveProgress() {
    if (!this.book || !this.pageCount) return;
    clearTimeout(this._saveT);
    const pct = this.pageCount > 1 ? (this.cur - 1) / (this.pageCount - 1) * 100 : 100;
    try {
      await db.patchBook(this.book.id, {
        lastReadAt: Date.now(),
        progress: { chapterIndex: this.cur - 1, blockIndex: 0, ratio: 0, percent: Math.min(100, pct) },
      });
    } catch (e) { /* 存进度失败不该打断阅读 */ }
  },

  readPos(book) {
    const p = (book && book.progress) || {};
    const n = Math.round((p.chapterIndex || 0)) + 1;
    return Math.min(Math.max(1, n), Math.max(1, this.pageCount));
  },

  /* ---------------- 缩放 ---------------- */
  cycleZoom() {
    const at = ZOOMS.indexOf(this.zoom);
    this.setZoom(ZOOMS[(at + 1) % ZOOMS.length]);
  },

  setZoom(z) {
    if (z === this.zoom) return;
    this.zoom = z;
    this.els.zoomBtn.textContent = (z === 1 ? '1×' : z + '×');
    this._rendered.clear();
    this._queue.length = 0;
    this.rebuild();
    this.toast(z === 1 ? '适配宽度' : `放大 ${z} 倍，可左右拖动`);
  },

  /* ---------------- 目录 ---------------- */
  openToc() {
    const list = this.els.tocList;
    const toc = (this.book && this.book.toc) || [];
    const rows = [];
    if (toc.length) {
      for (const t of toc) {
        rows.push(`<button class="cat-item" data-p="${t.page}">
          <span class="cat-t" style="padding-left:${Math.min(2, t.depth || 0) * 12}px">${escapeHtml(t.title)}</span>
          <span class="cat-idx">${t.page + 1}</span></button>`);
      }
    } else {
      // 没有书签就每 20 页给一个锚点：300 页的扫描件靠滑杆翻太慢
      const step = this.pageCount > 200 ? 20 : 10;
      for (let p = 1; p <= this.pageCount; p += step) {
        rows.push(`<button class="cat-item" data-p="${p - 1}">
          <span class="cat-t">第 ${p} 页</span></button>`);
      }
    }
    list.innerHTML = rows.join('') || '<div class="cat-empty">这本书没有书签，也没有可用的页码锚点</div>';
    list.querySelectorAll('.cat-item').forEach(el => {
      el.addEventListener('click', () => {
        this.els.tocSheet.classList.remove('open');
        this.gotoPage(+el.dataset.p + 1);
      });
    });
    this.els.tocSheet.classList.add('open');
  },

  /* ---------------- 外壳 ---------------- */
  toggleChrome() { this.chrome(!this._chrome); },

  chrome(on) {
    this._chrome = !!on;
    if (!this.els.top) return;
    this.els.top.classList.toggle('show', this._chrome);
    this.els.bottom.classList.toggle('show', this._chrome);
    const d = this.applyPad();
    if (d) this.els.scroll.scrollTop += d;   // 补上同样的差值，内容不会跳
    this.layout();
  },

  /** 展开工具栏时把页面往下推，避免顶栏压住正文首行；返回 padding-top 的变化量 */
  applyPad() {
    const pages = this.els.pages;
    if (!pages || !this.pageCount) return 0;
    const oldTop = parseFloat(pages.style.paddingTop) || 0;
    const newTop = this._chrome ? this.els.top.offsetHeight : 0;
    pages.style.paddingTop = newTop ? newTop + 'px' : '';
    pages.style.paddingBottom = this._chrome ? (this.els.bottom.offsetHeight + 8) + 'px' : '';
    return newTop - oldTop;
  },

  toast(msg) {
    if (this.onToast) { this.onToast(msg); return; }
    const t = this.els.toast;
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._tT);
    this._tT = setTimeout(() => t.classList.remove('show'), 2200);
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
