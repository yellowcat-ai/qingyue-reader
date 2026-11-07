/**
 * reader.js — 阅读器核心：章节渲染、进度记录与恢复、目录跳转、朗读联动
 */

import { db, newId } from './db.js?v=1.36';
import { settings, saveSettings } from './settings.js?v=1.36';
import { splitSentences } from './parser.js?v=1.36';
import { Speaker } from './tts.js?v=1.36';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const reader = {
  book: null,
  titles: [],
  charsBefore: [],
  chapterIndex: 0,
  chapter: null,
  sentences: [],
  spans: [],
  speaker: new Speaker(),
  page: 0,
  pages: 1,
  step: 0,
  chromeOn: false,
  onExit: null,
  onTtsState: null,
  onToast: null,

  /* ---------------- 初始化 ---------------- */
  init() {
    this.el = {
      page: $('page-reader'),
      scroll: $('rd-scroll'),
      content: $('rd-content'),
      text: $('rd-text'),
      title: $('rd-chapter-title'),
      bookName: $('rd-book-name'),
      chapName: $('rd-chap-name'),
      top: $('rd-top'),
      bottom: $('rd-bottom'),
      fill: $('rd-progress-fill'),
      endInfo: $('rd-end-info'),
      toast: $('rd-toast'),
    };

    this.speaker.on({
      getSentences: () => this.sentences,
      getMeta: () => ({
        book: this.book ? this.book.title : '',
        bookId: this.book ? this.book.id : '',
        chapter: this.titles[this.chapterIndex] ? this.titles[this.chapterIndex].title : '',
        chapterIndex: this.chapterIndex,
      }),
      collectChapters: (from, count) => this.collectChapters(from, count),
      onRemoteChapter: (i, t) => this.onRemoteChapter(i, t),
      highlight: i => this.highlight(i),
      onChapterEnd: async () => {
        if (this.chapterIndex + 1 < this.titles.length) {
          await this.loadChapter(this.chapterIndex + 1, { toTop: true, auto: true });
          return true;
        }
        return false;
      },
      onState: s => { if (this.onTtsState) this.onTtsState(s); },
      onError: m => { if (this.onToast) this.onToast(m); },
      onSlowNet: () => {
        // 连续多段的实际吞吐都追不上音频码率：再加深缓冲也没用，只能换不吃网络的音色
        if (this._slowNetTold) return;      // 一次会话只提示一次，避免反复骚扰
        this._slowNetTold = true;
        if (this.onToast) {
          this.onToast('网速偏慢，朗读容易卡顿。可在音色里选择「系统语音」离线朗读');
        }
      },
    });

    // 点击正文切换顶/底栏；翻页模式下左右翻页
    this.el.scroll.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      // 刚划过一页：浏览器随后补发的 click 别再翻一次
      if (this._swipedAt && Date.now() - this._swipedAt < 400) return;
      if (settings.scrollMode === 'page') {
        const x = e.clientX, w = window.innerWidth;
        if (x < w * 0.3) return this.goPage(this.page - 1);
        if (x > w * 0.7) return this.goPage(this.page + 1);
      }
      this.toggleChrome();
    });

    // 翻页模式下真正的手势：左右一划翻一页（跟点击相比更接近纸质书的手感）
    let tx = 0, ty = 0, tt = 0;
    this.el.scroll.addEventListener('touchstart', e => {
      if (settings.scrollMode !== 'page' || e.touches.length !== 1) { tt = 0; return; }
      const t = e.touches[0];
      tx = t.clientX; ty = t.clientY; tt = Date.now();
    }, { passive: true });
    this.el.scroll.addEventListener('touchend', e => {
      if (settings.scrollMode !== 'page' || !tt) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - tx, dy = t.clientY - ty, dt = Date.now() - tt;
      tt = 0;
      // 只认「横向为主、够长、够快」的滑动；竖着划是误会，交还给滚动
      if (dt > 700 || Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      this._swipedAt = Date.now();
      this.goPage(this.page + (dx < 0 ? 1 : -1));
    }, { passive: true });

    let timer = null;
    this.el.scroll.addEventListener('scroll', () => {
      if (settings.scrollMode === 'page') return;
      this.updateProgressBar();
      clearTimeout(timer);
      timer = setTimeout(() => this.saveProgress(), 350);
    }, { passive: true });

    // 用户自己动手了就放弃自动定位，避免"回位"跟用户抢滚动条
    const markUser = () => { this._userScrolled = true; this._hold = null; };
    ['touchstart', 'wheel', 'mousedown', 'keydown'].forEach(ev =>
      this.el.scroll.addEventListener(ev, markUser, { passive: true }));

    window.addEventListener('resize', () => {
      if (settings.scrollMode === 'page') this.measurePages();
    });

    // 退出/切后台/被系统杀掉前都存一次
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.saveProgress(true);
      else this.retryRestore();          // 页面真正可见后，若还没回到位就再补一次
    });
    window.addEventListener('pagehide', () => this.saveProgress(true));
    window.addEventListener('beforeunload', () => this.saveProgress(true));
    window.addEventListener('pageshow', () => this.retryRestore());

    // 连点章节标题 3 次 → 阅读位置诊断（真机排查用）
    let taps = 0, tapT = 0;
    this.el.title.addEventListener('click', () => {
      const now = Date.now();
      taps = now - tapT < 900 ? taps + 1 : 1;
      tapT = now;
      if (taps >= 3) { taps = 0; this.showDiag(); }
    });
  },

  /* ---------------- 位置持久化（双写：IndexedDB + localStorage） ---------------- */
  posKey() { return 'nr.pos.' + (this.book ? this.book.id : ''); },

  savePosLocal(p) {
    try {
      localStorage.setItem(this.posKey(), JSON.stringify({
        chapterIndex: p.chapterIndex, blockIndex: p.blockIndex,
        ratio: p.ratio, percent: p.percent, ts: Date.now(),
      }));
    } catch (e) {}
  },

  /** 取较新的那份：localStorage 比数据库新（数据库写失败时）就用它 */
  readPos(book) {
    const p = (book && book.progress) || {};
    const dbTs = (book && book.lastReadAt) || 0;
    let ls = null;
    try { ls = JSON.parse(localStorage.getItem('nr.pos.' + book.id) || 'null'); } catch (e) {}
    // 数据库被写成「第1章开头」但本地备份还留着真实位置：备份优先（重置进度时会 clearPos，不会误伤）
    const dbZero = !p.chapterIndex && !p.blockIndex && !(p.ratio > 0.02);
    if (ls && ls.chapterIndex > 0 && dbZero) {
      this._diagPush('库里是 0,0,0，用本地备份 第' + (ls.chapterIndex + 1) + '章');
      return ls;
    }
    if (ls && ls.ts > dbTs + 500) {
      this._diagPush('用本地备份位置 ts=' + ls.ts + ' > 库 ' + dbTs);
      return ls;
    }
    return p;
  },

  _diagPush(s) {
    this._diag = this._diag || [];
    this._diag.push(s);
    if (this._diag.length > 12) this._diag.shift();
  },

  /** 手动重置进度/重新解析时，本地备份也要一起清掉 */
  clearPos(id) {
    try { localStorage.removeItem('nr.pos.' + id); } catch (e) {}
    // 原生那边落盘的朗读位置同样作废，否则下次又被旧位置顶回去
    try {
      const n = this.speaker && this.speaker.native;
      if (n && n.clearLastPos) n.clearLastPos();
    } catch (e) {}
    this._baseChapter = 0;
  },

  /* ---------------- 打开书籍 ---------------- */
  async open(book) {
    this.book = book;
    // 换书时上一本还在朗读：声音会继续念旧书，页面却已经是新书，停下来更符合预期。
    // nativeState() 已按 bookId 过滤——同书重进会返回状态，不会被误停。
    if (this.speaker && this.speaker.playing) {
      const same = this.speaker.nativeState ? this.speaker.nativeState() : null;
      if (!same) this.speaker.stop();
    }
    this.titles = await db.getTitles(book.id);
    if (!this.titles.length) { this.toast('这本书没有章节数据'); return false; }
    this.charsBefore = [0];
    let acc = 0;
    for (const t of this.titles) { acc += t.len || 0; this.charsBefore.push(acc); }

    this.el.bookName.textContent = book.title;
    this.applyStyle();
    const p = this.readPos(book);
    let idx = Math.min(Math.max(0, p.chapterIndex || 0), this.titles.length - 1);
    let rblock = p.blockIndex || 0;
    let rratio = p.ratio || 0;
    this._baseChapter = idx;
    // 记一份「可用的上次位置」：之后版面量不到时用它兜底，不会被假数据覆盖
    this._lastPos = { chapterIndex: idx, blockIndex: rblock, ratio: rratio };

    // 原生队列还活着（App 重进、或网页被系统重载但朗读没停）：
    // 这时朗读进度才是真的，网页里存的那份是冻结前的旧位置。
    const ns = this.speaker && this.speaker.nativeState ? this.speaker.nativeState() : null;
    const live = ns && (ns.playing || ns.paused)
      && ns.chapter >= 0 && ns.chapter < this.titles.length
      && (ns.chapter > idx || (ns.chapter === idx && (ns.index || 0) > rblock));
    if (live) {
      idx = ns.chapter;
      rblock = ns.index || 0;
      rratio = ns.total > 0 ? Math.min(0.999, rblock / ns.total) : 0;
      this._diagPush('用原生朗读位置：第' + (ns.chapter + 1) + '章 ' + (rblock + 1) + '/' + ns.total);
    } else {
      // 队列已经停了（App 被杀过）：原生上次落盘的位置也可能比库里的新
      const lp = this.lastNativePos(book.id);
      if (lp && lp.chapter > idx && lp.chapter < this.titles.length) {
        idx = lp.chapter;
        rblock = lp.index || 0;
        rratio = lp.total > 0 ? Math.min(0.999, rblock / lp.total) : 0;
        this._diagPush('用原生落盘位置：第' + (lp.chapter + 1) + '章 ' + (rblock + 1) + '/' + lp.total);
      }
    }

    await this.loadChapter(idx, { block: rblock, ratio: rratio, restore: true });

    if (live) {
      // 把高亮和播放状态接上，避免页面显示第一句而声音在读别处
      this._ttsBlock = rblock;
      this.speaker.chapter = ns.chapter;
      this.speaker.index = rblock;
      this.speaker.total = ns.total || 0;
      this.speaker.playing = true;
      this.speaker.paused = !!ns.paused;
      this.speaker.sentences = this.sentences;
      this.highlight(rblock);
      this.speaker.emit();
    }
    return true;
  },

  /**
   * 收集 fromChapter 起的 count 章句子，交给原生连续播放（锁屏/后台跨章的核心）。
   * 当前章直接用已切好的 this.sentences，其余章现读现切。
   */
  async collectChapters(fromChapter, count) {
    if (!this.book) return '[]';
    const out = [];
    const end = Math.min(fromChapter + (count || 8), this.titles.length);
    for (let i = fromChapter; i < end; i++) {
      let sents = null;
      if (i === this.chapterIndex && this.sentences.length) {
        sents = this.sentences.slice();
      } else {
        const ch = await db.getChapter(this.book.id, i);
        if (!ch) break;
        sents = [];
        String(ch.text || '').split(/\n+/).map(s => s.trim()).filter(Boolean)
          .forEach(p => { for (const s of splitSentences(p)) sents.push(s); });
      }
      if (!sents.length) break;   // 遇到空章就停，避免章节序号错位
      out.push({
        t: (this.titles[i] && this.titles[i].title) || ('第 ' + (i + 1) + ' 章'),
        s: sents,
      });
    }
    return JSON.stringify(out);
  },

  /** 原生已读到别的章：网页跟随切换（后台期间冻结，回到前台时由 syncFromNative 补） */
  onRemoteChapter(chapter) {
    if (!this.book) return;
    if (chapter === this.chapterIndex) return;
    if (!(chapter >= 0 && chapter < this.titles.length)) return;
    this.loadChapter(chapter, { toTop: true, auto: true, keepIndex: true });
  },

  async loadChapter(index, opt = {}) {
    if (!this.book) return;
    // 手动翻章/跳转时停掉朗读；自动跨章续播（opt.auto）则保持播放
    if (!opt.auto && this.speaker && this.speaker.playing) this.speaker.stop();
    index = Math.max(0, Math.min(index, this.titles.length - 1));
    this.chapterIndex = index;
    this._hold = null;
    clearInterval(this._holdTimer);
    this._holdTimer = null;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;

    // 换章窗口里 pages 和 translateX 都还是旧章的，这期间的翻页请求全部忽略，
    // 否则会被算成「新章第 2 页」——用户看到的就是第 1 页被跳过。
    this._navLockUntil = Date.now() + 400;

    const ch = await db.getChapter(this.book.id, index);
    if (!ch) { this._navLockUntil = 0; return; }
    this.chapter = ch;
    this.sentences = [];
    this.spans = [];

    this.el.title.textContent = ch.title || ('第 ' + (index + 1) + ' 章');
    this.el.chapName.textContent = ch.title || ('第 ' + (index + 1) + ' 章');

    // 逐段、逐句渲染（句子 span 用于朗读高亮与位置记忆）
    let idx = 0;
    const paras = String(ch.text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
    const html = paras.map(p => {
      const sents = splitSentences(p);
      const inner = sents.map(s => {
        this.sentences.push(s);
        return `<span class="sent" data-i="${idx++}">${esc(s)}</span>`;
      }).join('');
      return `<p>${inner}</p>`;
    }).join('');
    this.el.text.innerHTML = html || '<p style="text-indent:0">（本章无内容）</p>';
    this.spans = Array.from(this.el.text.querySelectorAll('.sent'));

    // 章末信息
    const rest = this.titles.length - index - 1;
    this.el.endInfo.textContent = rest > 0
      ? `本章 ${ch.len || 0} 字 · 还有 ${rest} 章`
      : `本章 ${ch.len || 0} 字 · 已到全书结尾`;

    this.el.scroll.scrollTop = 0;
    this.page = 0;
    this._userScrolled = false;
    // 多列翻页的 translateX 是「绝对页码」，不会随章节内容自动归零：
    // 上一章末页的偏移留着，往后翻就像跳过了新章第 1 页；
    // 往前翻则因为偏移恰好是 0，直接停在上一章第 1 页而不是最后一页。
    if (settings.scrollMode === 'page') {
      this.el.content.style.transition = 'none';
      this.el.content.style.transform = 'translateX(0px)';
    }

    const wantBlock = opt.block > 0 ? opt.block : 0;
    const wantRatio = opt.ratio > 0 ? opt.ratio : 0;
    // opt.toEnd：跨章往回翻时停在上一章最后一页。
    // 这里用「比例 1」定位而不是最后一句的 offsetLeft ——
    // 末句可能是跨页的，按它的起点算会停到倒数第二页。
    const toEnd = !!opt.toEnd && this.spans.length > 0;
    const needRestore = wantBlock > 0 || wantRatio > 0.02 || opt.restore || toEnd;
    this._want = needRestore
      ? (toEnd ? { block: 0, ratio: 1 } : { block: wantBlock, ratio: wantRatio })
      : null;
    this._restoreTries = 0;
    this._restoreDone = false;

    if (needRestore) {
      if (toEnd) this.restoreTo(0, 1, false);
      else this.restoreTo(wantBlock, wantRatio);
    } else {
      requestAnimationFrame(() => { requestAnimationFrame(async () => {
        // 换章后必须重测页数：goPage 的越界判断若沿用上一章的 pages，
        // 点击一次就会直接落到第 2 页（新章第 1 页从没显示过）
        if (settings.scrollMode === 'page') this.measurePages(true);
        this._navLockUntil = 0;
        this.afterRender();
        // 字体晚到会改变每页容量，就绪后再校一次页数（不动当前页）
        if (document.fonts && document.fonts.ready) {
          try { await document.fonts.ready; } catch (e) {}
          if (this.chapterIndex === index && settings.scrollMode === 'page') this.measurePages(true);
        }
      }); });
    }

    if (this.speaker.playing) {
      // 句子表更新为当前显示章；index 由原生进度回调驱动，这里不重置
      this.speaker.sentences = this.sentences;
    }
  },

  /**
   * 回到上次位置。
   * 真机上章节内容长、字体/布局可能还没稳定，一次 scrollTop 赋值会被夹回 0；
   * 部分安卓 WebView 甚至会忽略程序化 scrollTop。所以：
   *   1) 分多轮重试；2) 赋值不生效时让浏览器自己 scrollIntoView；3) 用比例兜底。
   */
  async restoreTo(block, ratio, hold = true) {
    const sc = this.el.scroll;
    const pm = settings.scrollMode === 'page';
    // 每次回位带上「代次」：快速连续切章时，上一章还在 await 的循环必须立刻放手，
    // 否则它会把新章的位置顶到旧章的目标上（表现为"跳章后位置乱跑"）。
    const seq = this._restoreSeq = (this._restoreSeq || 0) + 1;
    this._restoring = true;
    const delays = [0, 60, 150, 320, 650];
    let ok = false;

    for (let k = 0; k < delays.length && !ok; k++) {
      if (delays[k]) await new Promise(r => setTimeout(r, delays[k]));
      if (seq !== this._restoreSeq) { this._restoring = false; return; }   // 已被更新的回位取代
      // 回位没落定之前页码不可信，期间的翻页请求先压住（循环结束即释放）
      this._navLockUntil = Date.now() + 400;
      if (this._userScrolled) { this._diagPush('k' + k + ' 用户已滚动，放弃'); break; }
      if (k === 3 && document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch (e) {}
      }

      if (pm) {
        this.measurePages(true);
        if (this.pages <= 1) {
          // 整章一屏能放下：本来就该停在第 1 页；多等两轮就接受，别白耗时间
          this._diagPush('k' + k + ' 页数未测出 p=' + this.pages);
          if (k >= 2) ok = true;
          continue;
        }
        const el = block > 0 ? this.spans[block] : null;
        let p = el ? Math.round(el.offsetLeft / (this.step || 1)) : 0;
        // offsetLeft 在多列布局里不一定可靠，block 定位失败就用比例
        if ((p <= 0 || p >= this.pages) && ratio > 0.02) p = Math.round(ratio * (this.pages - 1));
        p = Math.max(0, Math.min(this.pages - 1, p));
        this.page = p;
        this.el.content.style.transition = 'none';
        this.el.content.style.transform = `translateX(${-p * this.step}px)`;
        ok = true;                       // 算出了页码并应用，就算成功（p=0 就是本来在开头）
        this._diagPush('k' + k + ' 翻页 p=' + p + '/' + this.pages);
        if (ok) requestAnimationFrame(() => { this.el.content.style.transition = ''; });
      } else {
        const max = sc.scrollHeight - sc.clientHeight;
        if (max <= 0) { this._diagPush('k' + k + ' 高度未就绪'); continue; }
        const el = block > 0 ? this.spans[block] : null;
        let y = 0;
        if (el) {
          const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
          y = r.top - sr.top + sc.scrollTop - 8;
        } else if (ratio > 0.02) {
          y = ratio * max;
        }
        y = Math.max(0, Math.min(max, Math.round(y)));
        sc.scrollTop = y;
        let got = sc.scrollTop;
        if (Math.abs(got - y) > 24) {
          // scrollTop 被忽略：让浏览器自己把目标元素滚到顶部
          if (el) {
            try { el.scrollIntoView({ block: 'start' }); } catch (e) { try { el.scrollIntoView(true); } catch (e2) {} }
            if (sc.scrollTop > 8) sc.scrollTop -= 8;
          } else {
            sc.scrollTop = y;
          }
          got = sc.scrollTop;
        }
        this._diagPush('k' + k + ' 目标=' + y + ' 实到=' + got + ' max=' + Math.round(max));
        ok = y === 0 || Math.abs(got - y) <= 48;
      }
    }

    this._restoring = false;
    this._userScrolled = false;
    this._restoreDone = ok;
    this._navLockUntil = 0;      // 回位落定，放开翻页
    this._diagPush('恢复' + (ok ? '成功' : '失败') + ' 目标block=' + block + ' ratio=' + (ratio || 0).toFixed(3));
    if (ok && hold !== false) this._holdPos(block, ratio);
    this.afterRender();

    // 兜底：过 800ms 还没到位，再补一次（真机布局可能更慢）
    if (!ok && (this._restoreTries || 0) < 2) {
      this._restoreTries = (this._restoreTries || 0) + 1;
      clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => {
        if (!this._restoreDone && !this._userScrolled) this.restoreTo(block, ratio);
      }, 800);
    }
  },

  /** 主动翻页/跳章后，取消还在排队的「回位重试」，别把用户的操作顶回去 */
  cancelRestore() {
    this._want = null;
    this._restoreDone = true;
    this._navLockUntil = 0;      // 主动操作优先，立刻放开翻页
    this._restoreSeq = (this._restoreSeq || 0) + 1;   // 让正在 await 的回位循环立刻退出
    this._restoring = false;
    this._hold = null;
    clearTimeout(this._retryTimer);
    clearInterval(this._holdTimer);
    this._retryTimer = null;
    this._holdTimer = null;
  },

  /**
   * 回位之后把目标位置「按住」几秒。
   * 真机上字体/图片/WebView 首帧常晚于我们恢复，一次到位后又被顶回章首；
   * 这几秒里只要用户没动手，就继续把位置按回去。
   */
  _holdPos(block, ratio) {
    this._hold = { block, ratio, until: Date.now() + 4000 };
    clearInterval(this._holdTimer);
    this._holdTimer = setInterval(() => this._applyHold(), 150);
    setTimeout(() => { clearInterval(this._holdTimer); this._holdTimer = null; }, 4300);
  },

  _applyHold() {
    const h = this._hold;
    if (!h || Date.now() > h.until || this._userScrolled) { this._hold = null; clearInterval(this._holdTimer); this._holdTimer = null; return; }
    if (!this.hasLayout()) return;

    if (settings.scrollMode === 'page') {
      // 翻页模式：版面（行高/字号/字体）晚到会让每页的偏移量变，按句/比例重算一次页码
      this.measurePages(true);
      if (this.pages <= 1) return;
      const el = h.block > 0 ? this.spans[h.block] : null;
      let p = el ? Math.round(el.offsetLeft / (this.step || 1)) : 0;
      if ((p <= 0 || p >= this.pages) && h.ratio > 0.02) p = Math.round(h.ratio * (this.pages - 1));
      p = Math.max(0, Math.min(this.pages - 1, p));
      if (p !== this.page && p > 0) {
        this.page = p;
        this.el.content.style.transition = 'none';
        this.el.content.style.transform = `translateX(${-p * this.step}px)`;
        this._diagPush('锁定翻页 p=' + p + '/' + this.pages);
      }
      return;
    }

    const sc = this.el.scroll;
    const max = sc.scrollHeight - sc.clientHeight;
    if (max <= 0) return;
    let y = null;
    const el = h.block > 0 ? this.spans[h.block] : null;
    if (el) {
      const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      y = r.top - sr.top + sc.scrollTop - 8;
    } else if (h.ratio > 0.02) {
      y = h.ratio * max;
    }
    if (y == null) return;
    y = Math.max(0, Math.min(max, Math.round(y)));
    if (Math.abs(sc.scrollTop - y) > 24) {
      sc.scrollTop = y;
      this._diagPush('锁定回位 目标=' + y + ' 实到=' + Math.round(sc.scrollTop));
    }
  },

  /** 页面重新可见时，若上次没回到位就再补一次 */  retryRestore() {
    if (!this._want || this._restoreDone || this._userScrolled) return;
    if ((this._restoreTries || 0) >= 2) return;
    this._restoreTries = (this._restoreTries || 0) + 1;
    this._diagPush('可见后补一次：' + this._restoreTries);
    this.restoreTo(this._want.block, this._want.ratio);
  },

  /** 连点章节标题 3 次触发：把位置相关的数据摊开，方便截图排查 */
  async showDiag() {
    let saved = '读取失败';
    try {
      const b = await db.getBook(this.book.id);
      saved = JSON.stringify(b && b.progress);
    } catch (e) { saved = 'err ' + e.message; }
    let ls = '无';
    try { ls = localStorage.getItem(this.posKey()) || '无'; } catch (e) {}
    const ns = this.speaker && this.speaker.nativeState ? this.speaker.nativeState() : null;
    let wlog = [];
    try { wlog = JSON.parse(localStorage.getItem('nr.wlog') || '[]'); } catch (e) {}
    const sc = this.el.scroll;
    const lines = [
      '【阅读位置诊断 v1.29】',
      '书: ' + (this.book ? this.book.title : '-'),
      '当前: 第' + (this.chapterIndex + 1) + '章 block=' + this.currentBlock(),
      '滚动: top=' + Math.round(sc.scrollTop) + ' / max=' + Math.round(sc.scrollHeight - sc.clientHeight),
      '屏高=' + sc.clientHeight + ' 屏宽=' + sc.clientWidth + ' 模式=' + settings.scrollMode,
      '版面可量=' + this.hasLayout() + ' 页面active=' + this.el.page.classList.contains('active'),
      '上次有效位置: ' + (this._lastPos ? JSON.stringify(this._lastPos) : '无'),
      '听书: playing=' + (this.speaker && this.speaker.playing) + ' 读到句=' + (this._ttsBlock == null ? '-' : this._ttsBlock),
      '原生: ' + (ns ? ('第' + (ns.chapter + 1) + '章 ' + ((ns.index || 0) + 1) + '/' + ns.total + ' playing=' + ns.playing + ' paused=' + ns.paused) : '无'),
      '库里存的: ' + saved,
      '本地备份: ' + ls,
      '写进度流水(时间|章|块|来源): ' + (wlog.length ? wlog.slice(-6).join('  ') : '空'),
    ].concat(this._diag || ['（无可重试）']);
    const txt = lines.join('\n');
    try { alert(txt); } catch (e) { this.toast(txt.slice(0, 90)); }
    if (this.onToast) this.onToast('诊断已弹出，可截图');
  },

  afterRender() {
    this.updateProgressBar();
    const w = this._want;
    if (w && (w.block > 0 || w.ratio > 0.02)) {
      const atTop = settings.scrollMode === 'page'
        ? this.page === 0
        : this.el.scroll.scrollTop < 4;
      // 没能回到原位置就别存，避免把已有的位置覆盖成 0
      if (atTop) return;
    }
    this.saveProgress(true);
  },


  /* ---------------- 样式 ---------------- */
  applyStyle() {
    const s = settings;
    const el = this.el.page;
    el.className = 'page active t-' + s.theme;
    el.style.setProperty('--rd-font', s.fontSize + 'px');
    el.style.setProperty('--rd-line', s.lineHeight);
    el.style.setProperty('--rd-pad', s.padding + 'px');
    const fam = s.family === 'serif'
      ? '"Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,serif'
      : s.family === 'kai'
        ? '"Kaiti SC",KaiTi,"STKaiti","Noto Serif SC",serif'
        : '-apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    this.el.text.style.fontFamily = fam;
    el.querySelector('.rd-chapter-title').style.fontFamily = fam;
    const pm = s.scrollMode === 'page';
    this.el.scroll.classList.toggle('page-mode', pm);
    if (!pm) {
      // 切回滚动模式：必须清掉列宽，否则残留的多列会让正文横向被裁掉
      this.el.content.style.columnWidth = '';
      this.el.content.style.columnCount = '';
      this.el.content.style.transform = '';
      this._colW = 0;
    }
    if (pm) requestAnimationFrame(() => this.measurePages(true));
  },

  measurePages(stay = false) {
    const c = this.el.content;
    if (settings.scrollMode === 'page') {
      // 列宽必须是实测像素：column-width 不支持百分比，写 100% 会让多列排布整体失效
      const cs = getComputedStyle(c);
      const inner = Math.round(c.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
      if (inner > 0 && this._colW !== inner) {
        this._colW = inner;
        c.style.columnWidth = inner + 'px';
        c.style.columnCount = 'auto';
      }
    }
    const gap = parseFloat(getComputedStyle(c).columnGap) || 0;
    const w = c.clientWidth;
    this.step = w + gap;
    // 页数按「最后一个句子排到的位置」算：scrollWidth 会把末尾的列间距也算进去，
    // 直接用它会多出半页空白，翻到最后一页就什么都看不到
    const last = this.spans[this.spans.length - 1];
    if (last) {
      const base = this.spans[0] ? this.spans[0].offsetLeft : 0;
      const end = last.offsetLeft - base + last.offsetWidth;
      this.pages = Math.max(1, Math.floor((end - 1) / this.step) + 1);
    } else {
      this.pages = Math.max(1, Math.round(c.scrollWidth / this.step));
    }
    if (!stay) {
      // 只把页码夹回有效范围，不走 goPage：避免被换章锁挡掉、或误取消正在进行的回位
      const p = Math.max(0, Math.min(this.page, this.pages - 1));
      if (p !== this.page) {
        this.page = p;
        this.el.content.style.transition = 'none';
        this.el.content.style.transform = `translateX(${-p * this.step}px)`;
      }
    }
  },

  goPage(p) {
    if (settings.scrollMode !== 'page') return;
    // 换章/回位还在进行：此刻 this.pages 与 translateX 属于上一章，翻页必然算错页
    if (Date.now() < (this._navLockUntil || 0)) return;
    // 用户/代码主动翻页：不再自动按住旧位置，也取消还没跑完的回位重试
    this.cancelRestore();
    if (p < 0) { if (this.chapterIndex > 0) this.loadChapter(this.chapterIndex - 1, { toEnd: true }); return; }
    if (p >= this.pages) {
      if (this.chapterIndex + 1 < this.titles.length) this.loadChapter(this.chapterIndex + 1, { toTop: true });
      else this.toast('已经是最后一章');
      return;
    }
    this.page = p;
    this.el.content.style.transition = 'transform .22s ease';
    this.el.content.style.transform = `translateX(${-p * this.step}px)`;
    this.saveProgress();
  },

  /**
   * 滚动 / 翻页 二选一切换。
   * 换完必须停在同一句上：先量出当前句子和比例，改完版面再回位一次，
   * 否则从滚动切到翻页会直接跳回章首（用户很容易以为丢进度了）。
   */
  setMode(mode) {
    const next = mode === 'page' ? 'page' : 'scroll';
    if (settings.scrollMode === next) return next;
    const ready = !!(this.book && this.sentences && this.sentences.length && this.hasLayout());
    const block = ready ? this.currentBlock() : 0;
    const ratio = ready ? this.currentRatio() : 0;
    saveSettings({ scrollMode: next });
    this.cancelRestore();
    this.applyStyle();
    if (ready) {
      this._want = { block, ratio };
      this._restoreTries = 0;
      this._restoreDone = false;
      this._userScrolled = false;
      // 不用 hold：切换是用户自己刚做的操作，按住位置反而会跟他的手势打架
      this.restoreTo(block, ratio, false);
    }
    return next;
  },

  /* ---------------- 进度 ---------------- */
  /**
   * 版面现在能不能量到真实位置。
   * 阅读页被隐藏（切到书架、App 在后台）时 display:none，scrollHeight/clientHeight 全是 0，
   * 这时候读出来的 block/ratio 是假的（ratio 会算成 1 = 章末），绝不能拿去存。
   */
  hasLayout() {
    const sc = this.el.scroll;
    return this.el.page.classList.contains('active') && sc.clientHeight > 0;
  },

  currentRatio() {
    const sc = this.el.scroll;
    if (settings.scrollMode === 'page') return this.pages > 1 ? this.page / (this.pages - 1) : 1;
    const max = sc.scrollHeight - sc.clientHeight;
    // 内容比屏幕短（整章一屏能看完）：1 是对的；
    // 但版面不可见时 max 也是 0，那种情况返回 0，别把「章末」写进进度
    if (max <= 0) return this.hasLayout() ? 1 : 0;
    return Math.min(1, Math.max(0, sc.scrollTop / max));
  },

  currentBlock() {
    if (settings.scrollMode === 'page') {
      const target = this.page * this.step;
      let best = 0;
      for (let i = 0; i < this.spans.length; i++) {
        if (this.spans[i].offsetLeft >= target - 4) { best = i; break; }
      }
      return best;
    }
    const sc = this.el.scroll;
    const top = sc.scrollTop + 8;
    let lo = 0, hi = this.spans.length - 1, res = 0;
    // 二分查找视口顶部所在的句子
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.spans[mid].offsetTop;
      if (t <= top) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return res;
  },

  async saveProgress(force) {
    if (!this.book || !this.chapter) return;
    // 正在回位的过程中不要存，否则会把刚恢复的位置写回 0
    if (this._restoring && !force) return;

    let ratio = this.currentRatio();
    let block = this.currentBlock();
    let chIdx = this.chapterIndex;
    let src = 'web';
    // 阅读页已经隐藏（切到书架 / App 在后台）：DOM 量出来是 0/1 这种假值，
    // 这种情况直接把上次存过的有效位置原样再写一次，别拿假位置覆盖
    const blind = !this.hasLayout();

    // 回位没做完就被要求存（切后台/退出）：存「目标位置」，别存半成品
    if (this._restoring && this._want) {
      block = this._want.block || block;
      ratio = this._want.ratio || ratio;
      src = 'restoring->want';
    } else if (blind) {
      const last = this._lastPos;
      if (last) {
        chIdx = last.chapterIndex; block = last.blockIndex; ratio = last.ratio;
        src = 'blind->last';
      } else if (!force) {
        return;                                 // 没有可信位置就什么都不写
      }
    }

    // 原生队列才是真位置：后台连播会自己跨章，网页这边还冻在老章上。
    // 但只有「真的在播」或「暂停且停在当前这一章」时才采信——
    // 否则用户暂停听书后手动翻到别处阅读，每次存进度都会被拉回听书的旧位置。
    const ns = this.speaker && this.speaker.nativeState ? this.speaker.nativeState() : null;
    const nativeTrusted = ns && (ns.playing || (ns.paused && ns.chapter === this.chapterIndex));
    if (nativeTrusted && ns.chapter >= 0 && ns.chapter < this.titles.length) {
      const nIdx = ns.index || 0;
      if (ns.chapter !== chIdx || nIdx !== block) src = 'native';
      chIdx = ns.chapter;
      block = nIdx;
      ratio = ns.total > 0 ? Math.min(0.999, nIdx / ns.total) : 0;
      this._ttsBlock = nIdx;
    } else if (document.hidden && this.speaker && this.speaker.playing && this._ttsBlock > 0) {
      // 浏览器语音（无原生队列）时，用朗读到的那句做位置
      block = this._ttsBlock;
      ratio = this.spans.length > 1 ? block / (this.spans.length - 1) : ratio;
      src = 'speech';
    }

    // 防回退：绝不用「第 1 章第 0 句」覆盖已有进度（这是位置丢失的典型痕迹）
    // 除非用户刚刚自己主动跳章（目录/上一章/下一章），那种情况要照实存
    const userJustJumped = this._userNavAt && Date.now() - this._userNavAt < 60000;
    if (chIdx === 0 && block === 0 && ratio < 0.01 && (this._baseChapter || 0) > 0 && !userJustJumped) {
      this._diagPush('拦截：拒绝把进度改回第1章开头（原第' + (this._baseChapter + 1) + '章）');
      this._wlog(0, 0, 'blocked');
      return;
    }

    const before = this.charsBefore[chIdx] || 0;
    const len = (chIdx === this.chapterIndex && this.chapter.len)
      || (this.titles[chIdx] && this.titles[chIdx].len) || 0;
    const read = before + Math.round(len * ratio);
    const total = this.book.chars || this.charsBefore[this.charsBefore.length - 1] || 1;
    const pct = Math.max(0, Math.min(99.9, read / total * 100));
    const patch = {
      progress: { chapterIndex: chIdx, blockIndex: block, ratio, percent: pct },
      lastReadAt: Date.now(),
    };
    this._baseChapter = chIdx;
    this._lastPos = { chapterIndex: chIdx, blockIndex: block, ratio };
    Object.assign(this.book, patch);
    this.savePosLocal(patch.progress);          // 先写本地备份，数据库失败也不丢
    this._wlog(chIdx, block, src);
    try { await db.patchBook(this.book.id, patch); } catch (e) { this._diagPush('写库失败 ' + (e.message || e)); }
    this.updateProgressBar();
  },

  /** 原生上次落盘的朗读位置（队列已停也能取到；不是这本书或太旧就返回 null） */
  lastNativePos(bookId) {
    try {
      const n = this.speaker && this.speaker.native;
      if (!n || !n.lastPos) return null;
      const p = JSON.parse(n.lastPos() || '{}');
      if (!p || p.book !== bookId) return null;
      if (!(p.chapter >= 0)) return null;
      // 超过 30 天视为过期，避免很久以前听过的位置把现在的进度顶掉
      if (p.ts && Date.now() - p.ts > 30 * 86400000) return null;
      return p;
    } catch (e) { return null; }
  },

  /** 用户主动跳章（目录、上一章/下一章）：短时间内允许进度“往回跳” */
  noteUserNav() { this._userNavAt = Date.now(); },

  /** 写进度流水（环形，20 条），出问题时能看出是哪一步把位置写坏的 */
  _wlog(chIdx, block, src) {
    try {
      const k = 'nr.wlog';
      const arr = JSON.parse(localStorage.getItem(k) || '[]');
      arr.push([Date.now() % 1000000, chIdx + 1, block, src].join('|'));
      while (arr.length > 20) arr.shift();
      localStorage.setItem(k, JSON.stringify(arr));
    } catch (e) {}
  },

  updateProgressBar() {
    const before = this.charsBefore[this.chapterIndex] || 0;
    const len = this.chapter ? (this.chapter.len || 0) : 0;
    const total = (this.book && this.book.chars) || this.charsBefore[this.charsBefore.length - 1] || 1;
    const pct = Math.min(100, (before + len * this.currentRatio()) / total * 100);
    this.el.fill.style.width = pct.toFixed(1) + '%';
  },

  /* ---------------- 朗读高亮 ---------------- */
  highlight(i) {
    if (i >= 0) this._ttsBlock = i;          // 记住朗读到哪一句，后台/不可见时也能存进度
    this.el.text.querySelectorAll('.sent.speaking').forEach(n => n.classList.remove('speaking'));
    if (i < 0 || !this.spans[i]) return;
    const el = this.spans[i];
    el.classList.add('speaking');
    if (settings.follow) {
      if (settings.scrollMode === 'page') {
        const p = Math.max(0, Math.round(el.offsetLeft / (this.step || 1)));
        if (p !== this.page) this.goPage(p);
      } else {
        const r = el.getBoundingClientRect();
        const sr = this.el.scroll.getBoundingClientRect();
        if (r.top < sr.top + 40 || r.bottom > sr.bottom - 60) {
          this.el.scroll.scrollTop = r.top - sr.top + this.el.scroll.scrollTop - sr.height * 0.35;
        }
      }
    }
  },

  /* ---------------- 交互 ---------------- */
  toggleChrome(force) {
    const on = force === undefined ? !this.chromeOn : force;
    this.chromeOn = on;
    this.el.top.classList.toggle('show', on);
    this.el.bottom.classList.toggle('show', on);
    this.el.scroll.classList.toggle('pad-mode', !on);
  },

  toast(msg) {
    if (this.onToast) return this.onToast(msg);
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove('show'), 1600);
  },

  /* ---------------- 导入后的章节写入 ---------------- */
  async saveBook(parsed, file, opts = {}) {
    const id = opts.id || newId();
    const chapters = parsed.chapters;
    const chars = chapters.reduce((a, c) => a + c.text.length, 0);
    const book = {
      id,
      title: parsed.title,
      author: parsed.author || '',
      format: parsed.format,
      encoding: parsed.encoding || '',
      cover: parsed.cover || null,
      color: opts.color !== undefined ? opts.color : Math.floor(Math.random() * 6),
      chapterCount: chapters.length,
      chars,
      size: file ? file.size : 0,
      fileName: file ? file.name : '',
      createdAt: opts.createdAt || Date.now(),
      lastReadAt: Date.now(),
      progress: { chapterIndex: 0, blockIndex: 0, ratio: 0, percent: 0 },
    };
    await db.putBook(book);
    await db.putChapters(id, chapters);
    if (file) { try { await db.putRaw(id, file); } catch (e) {} }
    return book;
  },

  async reparse(bookId, encoding) {
    const raw = await db.getRaw(bookId);
    if (!raw || !raw.file) throw new Error('原始文件已不存在，请重新导入');
    const { parseFile } = await import('./parser.js');
    const parsed = await parseFile(raw.file, { encoding });
    const chars = parsed.chapters.reduce((a, c) => a + c.text.length, 0);
    await db.putChapters(bookId, parsed.chapters);
    await db.patchBook(bookId, {
      chapterCount: parsed.chapters.length,
      chars,
      encoding: parsed.encoding || encoding,
      progress: { chapterIndex: 0, blockIndex: 0, ratio: 0, percent: 0 },
    });
    this.clearPos(bookId);
    this._baseChapter = 0;    // 重新分章后章节号全变了，防回退基准重置
    return parsed;
  },
};

/* 自动进入下一章：滚到底部后继续下滑即触发 */
(() => {
  const sc = $('rd-scroll');
  let lastTop = 0, lock = 0, lastChapter = -1;
  sc.addEventListener('scroll', () => {
    if (!settings.autoNext || settings.scrollMode === 'page' || !reader.book) return;
    // 程序在恢复上次位置（或恢复后正在按住位置），不是用户在往下滑，别误判成"读到底了"
    if (reader._restoring || reader._hold) { lastTop = sc.scrollTop; return; }
    // 换章后的第一次滚动不判断方向
    if (reader.chapterIndex !== lastChapter) { lastChapter = reader.chapterIndex; lastTop = sc.scrollTop; return; }
    const max = sc.scrollHeight - sc.clientHeight;
    if (max <= 0) return;
    const bottomGap = max - sc.scrollTop;
    const down = sc.scrollTop > lastTop;
    lastTop = sc.scrollTop;
    if (bottomGap < 8 && down && Date.now() - lock > 1200) {
      if (reader.chapterIndex + 1 < reader.titles.length) {
        lock = Date.now();
        reader.toast('正在进入下一章…');
        reader.loadChapter(reader.chapterIndex + 1, { toTop: true });
      }
    }
  }, { passive: true });
})();
