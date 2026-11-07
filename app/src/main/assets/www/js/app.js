/**
 * app.js — 主控制器：书架、导入、目录、设置、听书面板、路由
 */

import { db, newId, storageInfo } from './db.js?v=1.36';
import { settings, saveSettings } from './settings.js?v=1.36';
import { parseFile } from './parser.js?v=1.36';
import { reader } from './reader.js?v=1.36';
import { ttsSupported, isNativeApp } from './tts.js?v=1.36';

const $ = id => document.getElementById(id);
const GRADS = [
  'linear-gradient(135deg,#8fa5ff,#4a63d9)',
  'linear-gradient(135deg,#ff9a8b,#e8577a)',
  'linear-gradient(135deg,#5fd0b5,#2b9b86)',
  'linear-gradient(135deg,#ffc46b,#e08e36)',
  'linear-gradient(135deg,#a78bfa,#6d4fd6)',
  'linear-gradient(135deg,#7f8c9b,#3f4a57)',
];

const app = {
  books: [],
  curBookId: null,

  /* ================= 启动 ================= */
  async init() {
    reader.init();
    reader.onToast = m => this.toast(m);
    reader.onTtsState = s => this.onTtsState(s);

    this.bindNav();
    this.bindImport();
    this.bindReader();
    this.bindSettings();
    this.bindTts();
    this.bindCatalog();
    this.bindSheets();

    await this.refreshShelf();
    this.route();
    window.addEventListener('hashchange', () => this.route());

    if (!isNativeApp() && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    if (!ttsSupported()) {
      $('tts-voice-tip').textContent = '当前浏览器不支持语音朗读，建议用 Chrome / Edge / Safari 打开';
    }

    // 安卓 APP：原生 TTS 状态显示 —— 拉模式（随时同步 getDiag()，无时序竞争）
    if (isNativeApp()) {
      const ttsTip = () => {
        const tip = $('tts-voice-tip');
        if (!tip) return;
        let d = null;
        try { d = JSON.parse(window.AndroidTTS.getDiag() || '{}'); } catch (e) { /* ignore */ }
        if (!d) return;
        const act = `style="color:#4a63d9;font-weight:600"`;
        const ver = d.ver ? ` <span style="opacity:.55;font-size:11px">轻阅 ${d.ver}</span>` : '';
        const downloading = d.modelProgress !== undefined && d.modelProgress !== null && d.modelProgress >= 0;
        if (downloading) {
          const p = Math.max(0, Math.min(100, d.modelProgress));
          tip.innerHTML = `<div style="margin-bottom:6px">正在下载离线语音包 <b>${p}%</b>　<span style="opacity:.65">${escapeHtml(d.modelMsg || '')}</span></div>` +
            `<div style="height:6px;border-radius:3px;background:rgba(120,135,180,.22);overflow:hidden">` +
            `<div style="height:100%;width:${p}%;background:#4a63d9;transition:width .3s"></div></div>`;
          return;
        }
        if (d.builtinReady) {
          tip.innerHTML = `当前语音引擎：<b>${escapeHtml(d.engine || '内置离线语音')}</b>（内置·离线可用） · ` +
            `<a href="javascript:void(0)" data-tts-act="test" ${act}>试听</a>` + ver;
        } else if (d.edgeOn) {
          const eStr = d.edgeErr ? String(d.edgeErr) : '';
          const is403 = /403/i.test(eStr);
          const bad = eStr ? ` <span style="color:#c0392b">· 上次合成失败：${escapeHtml(eStr.slice(0, 60))}${is403 ? '（网络被拒，可换「百度女声」试试）' : ''}</span>` : '';
          tip.innerHTML = `当前音色：<b>${escapeHtml(d.voiceName || '晓晓')}</b>（在线合成，需联网）${bad} · ` +
            `<a href="javascript:void(0)" data-tts-act="test" ${act}>试听</a>` +
            (d.zh ? ` · <a href="javascript:void(0)" data-tts-act="edgeoff" ${act}>改用系统语音</a>` : '') + ver;
        } else if (d.zh) {
          tip.innerHTML = `当前语音引擎：<b>${escapeHtml(d.engine || '系统默认')}</b>` +
            `${d.voices ? `（${d.voices} 个音色）` : ''} · ` +
            `<a href="javascript:void(0)" data-tts-act="edgeon" ${act}>用在线音色「晓晓」</a> · ` +
            `<a href="javascript:void(0)" data-tts-act="choose" ${act}>更换引擎</a> · ` +
            `<a href="javascript:void(0)" data-tts-act="test" ${act}>试听</a>` + ver;
        } else {
          // 离线语音包已移除：系统里没中文引擎时，直接引导用在线音色
          tip.innerHTML = `⚠️ 系统里没有可用的中文语音引擎。建议 ` +
            `<a href="javascript:void(0)" data-tts-act="edgeon" ${act}>使用在线音色「晓晓」</a>` +
            `（联网即可，无需安装引擎）；或 ` +
            `<a href="javascript:void(0)" data-tts-act="market" ${act}>去应用商店装中文语音引擎</a>` + ver;
        }
        tip.querySelectorAll('[data-tts-act]').forEach(a => {
          a.addEventListener('click', () => {
            const act2 = a.dataset.ttsAct;
            try {
              if (act2 === 'choose') window.AndroidTTS.chooseEngine();
              else if (act2 === 'settings') window.AndroidTTS.openTtsSettings();
              else if (act2 === 'market') { this.toast('安装中文语音引擎后回来点「重新检测」'); window.AndroidTTS.openMarket(); }
              else if (act2 === 'refresh') { this.toast('正在重新加载语音引擎…'); window.AndroidTTS.reinit(); }
              else if (act2 === 'edgeoff') { window.AndroidTTS.setEdge(false); this.toast('已改用系统语音'); setTimeout(ttsTip, 400); }
              else if (act2 === 'edgeon') { window.AndroidTTS.setEdge(true); this.toast('已切换到在线音色「晓晓」'); setTimeout(ttsTip, 800); }
              else if (act2 === 'reload') { this.toast('正在重新检测系统语音…'); window.AndroidTTS.reinit(); }
              else if (act2 === 'enablebi') { this.toast('正在开启离线语音（实验）…'); window.AndroidTTS.enableBuiltin(); setTimeout(ttsTip, 1500); setTimeout(ttsTip, 5000); }
              else if (act2 === 'disablebi') { window.AndroidTTS.disableBuiltin(); this.toast('已改用系统语音'); setTimeout(ttsTip, 500); }
              else if (act2 === 'reset') {
                if (confirm('会删除已下载的离线语音包（约 78MB），下次需要重新下载。确定吗？')) {
                  try { window.AndroidTTS.resetModel(); } catch (e) { /* ignore */ }
                  this.toast('已删除，可重新下载语音包');
                  setTimeout(ttsTip, 500);
                } else {
                  setTimeout(ttsTip, 100);
                }
              }
              else if (act2 === 'download') {
                this.toast('离线语音包已移除，请直接使用在线音色「晓晓」或系统语音');
              }
              else if (act2 === 'crashlog') {
                try {
                  const s = String(window.AndroidTTS.getCrashLog() || '').replace(/⏎/g, '\n').trim();
                  if (!s) { this.toast('暂无崩溃日志'); return; }
                  this.copyText(s).then(ok => {
                    this.toast(ok ? '崩溃日志已复制，回聊天里粘贴发我即可' : '复制失败，日志：' + s.slice(0, 200));
                  });
                } catch (e) { this.toast('读取日志失败'); }
              }
              else if (act2 === 'test') { this.toast('正在试听…'); window.AndroidTTS.testSpeak(); }
            } catch (e) { /* ignore */ }
          });
        });
        this.fillVoices();
      };
      window.__ttsState = () => ttsTip();
      window.__ttsTest = ok => {
        this.toast(ok ? '✅ 试听成功，可以正常听书了' : '❌ 试听失败，请看提示行说明');
        ttsTip();
      };
      window.__renderTtsTip = ttsTip;
      // 原生下载语音包的进度推送
      window.__onModel = st => {
        try {
          if (st && st.installed) {
            if (!this.__modelWasInstalled) {
              this.__modelWasInstalled = true;
              this.toast('✅ 离线语音包已就绪');
            }
          } else if (st && st.progress === -1 && st.msg && String(st.msg).indexOf('失败') >= 0) {
            this.toast('下载失败：' + st.msg);
          }
        } catch (e) { /* ignore */ }
        ttsTip();
        setTimeout(ttsTip, 1500);
        setTimeout(ttsTip, 4000);
      };
      try {
        const s0 = JSON.parse(window.AndroidTTS.modelStatus() || '{}');
        this.__modelWasInstalled = !!s0.installed;
      } catch (e) { /* ignore */ }
      // 首次渲染；内置引擎模型是异步加载的（1~2 秒），加载前后多刷几次确保提示跟上
      ttsTip();
      setTimeout(ttsTip, 800);
      setTimeout(ttsTip, 2500);
      setTimeout(ttsTip, 6000);
    }

    // 安卓 APP 环境适配：返回键接管、隐藏「添加到桌面」引导
    this.setupNativeHooks();
  },

  setupNativeHooks() {
    if (!isNativeApp()) return;
    window.__onBack = () => {
      const openSheet = document.querySelector('.sheet.open');
      if (openSheet) { this.closeSheets(); return true; }
      if ($('page-reader').classList.contains('active')) { $('btn-back').click(); return true; }
      return false;
    };
    const tip = document.querySelector('.about-tip');
    if (tip) tip.remove();
    const ttsTip = document.querySelector('.about-tip');
    if (ttsTip) {
      ttsTip.innerHTML = '<b>听书没声音？</b>在系统「设置 → 系统 → 语言和输入法 → 文字转语音」中确认已安装中文语音包，并在本页听书面板里选到中文音色。';
    }
    const about = document.querySelector('.about-body p');
    if (about) about.innerHTML = '<b>轻阅</b> 安卓版：所有书籍保存在手机本地，无需联网、无需登录。';
  },

  /* ================= 路由 ================= */
  route() {
    const m = /^#\/read\/(.+)$/.exec(location.hash || '');
    if (m) {
      const b = this.books.find(x => x.id === m[1]);
      // 已经在这本书的阅读页里（openBook 自己改 hash 会再触发一次 route），不要重开
      if (b && this.curBookId === b.id && $('page-reader').classList.contains('active')) return;
      if (b) this.openBook(b);
      else { location.hash = ''; this.showPage('library'); }
    } else {
      this.showPage('library');
    }
  },

  showPage(name) {
    // 离开阅读页时先存一次（趁版面还在、还量得到真实位置）
    if (name !== 'reader' && $('page-reader').classList.contains('active') && reader.book) {
      reader.saveProgress();
    }
    $('page-library').classList.toggle('active', name === 'library');
    $('page-reader').classList.toggle('active', name === 'reader');
  },

  /* ================= 书架 ================= */
  async refreshShelf() {
    this.books = await db.allBooks();
    this.renderShelf();
  },

  sortBooks() {
    const by = settings.sortBy;
    const arr = this.books.slice();
    if (by === 'title') arr.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    else if (by === 'added') arr.sort((a, b) => b.createdAt - a.createdAt);
    else arr.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
    return arr;
  },

  renderShelf() {
    const shelf = $('shelf');
    const list = this.sortBooks();
    shelf.innerHTML = '';
    $('empty-state').classList.toggle('show', !list.length);
    $('lib-count').textContent = list.length + ' 本';
    $('btn-sort').textContent = { recent: '按最近阅读', title: '按书名', added: '按导入时间' }[settings.sortBy];

    for (const b of list) {
      const el = document.createElement('div');
      el.className = 'book-card';
      const pct = (b.progress && b.progress.percent) || 0;
      const cover = b.cover ? `<img alt="">` : '';
      el.innerHTML = `
        <div class="bk-cover" style="background:${GRADS[b.color % GRADS.length]}">
          ${cover}
          <span class="bk-fmt">${(b.format || '').toUpperCase()}</span>
          <span class="bk-cover-text">${escapeHtml(b.title.slice(0, 1))}</span>
        </div>
        <button class="bk-menu" title="更多"><svg><use href="#i-more"/></svg></button>
        <div class="bk-info">
          <div class="bk-name">${escapeHtml(b.title)}</div>
          <div class="bk-prog"><i style="width:${pct.toFixed(1)}%"></i></div>
          <div class="bk-foot">
            <span>${pct > 0 ? '已读 ' + pct.toFixed(0) + '%' : (b.author || '未开始')}</span>
            <span>${relativeTime(b.lastReadAt)}</span>
          </div>
        </div>`;
      if (b.cover) {
        const img = el.querySelector('.bk-cover img');
        img.src = URL.createObjectURL(b.cover);
      }
      el.addEventListener('click', e => {
        if (e.target.closest('.bk-menu')) { this.openBookSheet(b); return; }
        this.openBook(b);
      });
      shelf.appendChild(el);
    }
  },

  /* ================= 导入 ================= */
  bindImport() {
    const input = $('file-input');
    const canNative = () => !!(window.AndroidFile && typeof window.AndroidFile.pickFiles === 'function');

    $('btn-import').addEventListener('click', () => {
      if (canNative()) {
        try {
          this.toast('正在打开文件选择器…');
          window.AndroidFile.pickFiles();   // 原生 SAF 选择器（APP 主通道）
          return;
        } catch (e) {
          console.warn('native pick failed, fallback', e);
        }
      }
      input.click();                        // 网页兜底
    });

    input.addEventListener('change', async e => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) await this.importFiles(files);
    });

    /* 原生 APP：系统选择器返回后，把 content:// 文件从虚拟域取回来 */
    window.__onFilesPickedB64 = async b64 => {
      const mask = $('loading-mask'), text = $('loading-text');
      try {
        const json = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
        const list = JSON.parse(json);
        const files = [];
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          const name = this.pickName(it.name, it.mime);
          const mb = it.size ? (it.size / 1048576).toFixed(1) : '?';
          text.textContent = `正在读取 ${name}（${mb} MB，${i + 1}/${list.length}）`;
          mask.classList.add('show');
          if (it.size > 60 * 1048576) {
            this.toast(`${name} 超过 60 MB，导入可能因内存不足失败`);
          }
          const buf = await this.fetchNativeFile(it);
          if (!buf || !buf.byteLength) { this.toast(`${name} 读取失败`); continue; }
          files.push(new File([buf], name, { type: it.mime || 'application/octet-stream' }));
        }
        mask.classList.remove('show');
        if (files.length) await this.importFiles(files);
      } catch (err) {
        mask.classList.remove('show');
        console.error(err);
        this.toast('导入失败：' + (err.message || '无法读取所选文件'));
      }
    };
  },

  async fetchNativeFile(it) {
    // 优先用原生侧复制到应用缓存的副本（f），避免 content:// 授权失效
    const q = it.f ? ('f=' + encodeURIComponent(it.f)) : ('u=' + encodeURIComponent(it.uri));
    const res = await fetch('/__local__/?' + q);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  },

  /** 系统选择器给出的文件名可能缺后缀，补一个以便正确识别 EPUB */
  pickName(name, mime) {
    let n = (name || '').trim() || '未命名.txt';
    if (!/\.[a-z0-9]+$/i.test(n)) {
      n += (mime && /epub|zip/i.test(mime)) ? '.epub' : '.txt';
    }
    return n;
  },

  async importFiles(files) {
    const mask = $('loading-mask'), text = $('loading-text');
    mask.classList.add('show');
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      text.textContent = `正在解析 ${f.name}（${i + 1}/${files.length}）`;
      await sleep(30);
      try {
        const parsed = await parseFile(f, { onProgress: p => { text.textContent = `正在解析 ${f.name} ${p}%`; } });
        const book = await reader.saveBook(parsed, f, { color: (this.books.length + ok) % GRADS.length });
        this.books.push(book);
        ok++;
      } catch (err) {
        console.error(err);
        this.toast(`${f.name} 解析失败：${err.message || '格式不支持'}`);
      }
    }
    mask.classList.remove('show');
    if (ok) { await this.refreshShelf(); this.toast(`成功导入 ${ok} 本`); }
  },

  /* ================= 阅读 ================= */
  openBook(book) {
    this.curBookId = book.id;
    const r = reader.open(book);
    this.showPage('reader');
    if (location.hash !== '#/read/' + book.id) location.hash = '#/read/' + book.id;
    r.then(ok => { if (ok) reader.toggleChrome(false); });
  },

  bindReader() {
    $('btn-back').addEventListener('click', () => {
      reader.saveProgress();
      if (reader.speaker.playing) reader.speaker.stop();
      location.hash = '';
      this.showPage('library');
      this.refreshShelf();
    });
    $('btn-catalog').addEventListener('click', () => this.openCatalog());
    $('btn-mode').addEventListener('click', () => {
      const now = reader.setMode(settings.scrollMode === 'page' ? 'scroll' : 'page');
      this.syncSettingsUI();
      this.toast(now === 'page' ? '翻页模式：左右点两侧 / 左右划屏 翻一页，点中间唤出菜单' : '已切换为上下滚动');
    });
    $('btn-font').addEventListener('click', () => this.openSheet('sheet-settings'));
    $('btn-listen').addEventListener('click', () => this.startListen());
    $('btn-tts-open').addEventListener('click', () => this.startListen());
    $('btn-theme').addEventListener('click', () => {
      const order = ['paper', 'white', 'green', 'gray', 'dark'];
      const next = order[(order.indexOf(settings.theme) + 1) % order.length];
      this.setTheme(next);
    });
    $('btn-next-chap').addEventListener('click', () => { reader.noteUserNav(); reader.loadChapter(reader.chapterIndex + 1, { toTop: true }); });
    $('btn-prev-chap').addEventListener('click', () => { reader.noteUserNav(); reader.loadChapter(reader.chapterIndex - 1, { toTop: true }); });
  },

  setTheme(t) {
    saveSettings({ theme: t });
    reader.applyStyle();
    this.syncSettingsUI();
    document.querySelector('meta[name=theme-color]').setAttribute('content',
      { paper: '#f7f3e8', white: '#ffffff', green: '#d3e8d0', gray: '#ececec', dark: '#16181c' }[t] || '#f7f3e8');
  },

  /* ================= 目录 ================= */
  openCatalog() {
    const b = this.books.find(x => x.id === this.curBookId);
    if (!b) return;
    this.openSheet('sheet-catalog');
    $('catalog-search').value = '';
    this._catQ = '';
    db.getTitles(b.id).then(titles => {
      this._catTitles = titles;
      this.renderCatalog(true);
    });
  },

  /** 渲染目录列表。desc=true 时按「最新章节在上」倒序。 */
  renderCatalog(centerCur) {
    const titles = this._catTitles || [];
    const desc = !!settings.catalogDesc;
    const btn = $('catalog-sort');
    btn.querySelector('span').textContent = desc ? '倒序' : '正序';
    btn.classList.toggle('on', desc);
    $('catalog-count').textContent = titles.length + ' 章';

    const list = $('catalog-list');
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    const rows = desc ? titles.slice().reverse() : titles;
    const q = (this._catQ || '').toLowerCase();
    for (const t of rows) {
      const d = document.createElement('div');
      d.className = 'cat-item' + (t.index === reader.chapterIndex ? ' cur' : '');
      if (q && !(t.title || '').toLowerCase().includes(q)) d.classList.add('hide');
      d.dataset.idx = t.index;
      d.innerHTML = `<span class="cat-idx">${t.index + 1}</span><span class="cat-t">${escapeHtml(t.title)}</span>`;
      d.addEventListener('click', () => {
        reader.noteUserNav();
        reader.loadChapter(t.index, { toTop: true });
        this.closeSheets();
      });
      frag.appendChild(d);
    }
    list.appendChild(frag);

    const cur = list.querySelector('.cat-item.cur');
    if (centerCur) {
      // 打开时定位到当前章（倒序时可能在列表顶部附近，也不冲突）
      if (cur) cur.scrollIntoView({ block: 'center' });
      else list.scrollTop = 0;
    } else {
      list.scrollTop = 0;
    }
  },

  toggleCatalogSort() {
    saveSettings({ catalogDesc: !settings.catalogDesc });
    this.renderCatalog(false);
  },

  bindCatalog() {
    $('catalog-search').addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      this._catQ = q;
      document.querySelectorAll('.cat-item').forEach(el => {
        el.classList.toggle('hide', !!q && !el.textContent.toLowerCase().includes(q));
      });
    });
    $('catalog-sort').addEventListener('click', () => this.toggleCatalogSort());
  },

  /* ================= 设置 ================= */
  bindSettings() {
    const bind = (id, key, fmt, apply) => {
      const el = $(id);
      el.addEventListener('input', () => {
        const v = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
        saveSettings({ [key]: v });
        if (fmt) fmt(v);
        if (apply !== false) reader.applyStyle();
        this.syncSettingsUI();
      });
    };
    bind('rng-font', 'fontSize');
    bind('rng-line', 'lineHeight');
    bind('rng-pad', 'padding');
    $('sw-auto-next').addEventListener('change', e => saveSettings({ autoNext: e.target.checked }));
    $('sw-wake').addEventListener('change', e => {
      saveSettings({ keepAwake: e.target.checked });
      if (reader.speaker.playing) reader.speaker.requestWake(e.target.checked);
    });
    $('sw-follow').addEventListener('change', e => saveSettings({ follow: e.target.checked }));
    const swSeam = $('sw-seamless');
    if (swSeam) swSeam.addEventListener('change', e => {
      saveSettings({ seamless: e.target.checked });
      if (window.AndroidTTS && window.AndroidTTS.setSeamless) {
        try { window.AndroidTTS.setSeamless(e.target.checked); } catch (err) { /* ignore */ }
      }
    });
    const swJoin = $('sw-join');
    if (swJoin) swJoin.addEventListener('change', e => {
      saveSettings({ joinShort: e.target.checked });
      if (window.AndroidTTS && window.AndroidTTS.setJoinShort) {
        try { window.AndroidTTS.setJoinShort(e.target.checked); } catch (err) { /* ignore */ }
      }
    });

    $('seg-font').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const v = Math.max(14, Math.min(30, settings.fontSize + parseInt(b.dataset.v, 10)));
      saveSettings({ fontSize: v });
      reader.applyStyle(); this.syncSettingsUI();
    });
    $('theme-picker').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      this.setTheme(b.dataset.theme);
    });
    $('seg-family').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      saveSettings({ family: b.dataset.v });
      reader.applyStyle(); this.syncSettingsUI();
    });
    $('seg-scroll').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const now = reader.setMode(b.dataset.v);
      this.syncSettingsUI();
      this.toast(now === 'page' ? '翻页模式：点左右两侧翻页，点中间唤出菜单' : '已切换为滚动模式');
    });
    this.syncSettingsUI();
  },

  syncSettingsUI() {
    const s = settings;
    $('rng-font').value = s.fontSize; $('val-font').textContent = s.fontSize;
    $('rng-line').value = s.lineHeight; $('val-line').textContent = s.lineHeight.toFixed(1);
    $('rng-pad').value = s.padding; $('val-pad').textContent = s.padding;
    $('sw-auto-next').checked = s.autoNext;
    $('sw-wake').checked = s.keepAwake;
    $('sw-follow').checked = s.follow;
    const swS = $('sw-seamless');
    if (swS) swS.checked = s.seamless !== false;
    const swJ = $('sw-join');
    if (swJ) swJ.checked = s.joinShort !== false;
    document.querySelectorAll('#theme-picker button').forEach(b => b.classList.toggle('on', b.dataset.theme === s.theme));
    document.querySelectorAll('#seg-family button').forEach(b => b.classList.toggle('on', b.dataset.v === s.family));
    document.querySelectorAll('#seg-scroll button').forEach(b => b.classList.toggle('on', b.dataset.v === s.scrollMode));
    const pm = s.scrollMode === 'page';
    const mb = $('btn-mode');
    if (mb) {
      const u = mb.querySelector('use');
      if (u) u.setAttribute('href', pm ? '#i-roll' : '#i-flip');
      mb.querySelector('span').textContent = pm ? '滚动' : '翻页';
      mb.title = pm ? '当前：左右翻页，点击切换为上下滚动' : '当前：上下滚动，点击切换为左右翻页';
    }
    document.querySelectorAll('#seg-timer button').forEach(b => b.classList.toggle('on', parseInt(b.dataset.v, 10) === s.timerMin));
    $('rng-rate').value = s.ttsRate; $('val-rate').textContent = s.ttsRate.toFixed(1);
    $('rng-pitch').value = s.ttsPitch; $('val-pitch').textContent = s.ttsPitch.toFixed(1);
    const btn = $('btn-theme');
    btn.querySelector('span').textContent = s.theme === 'dark' ? '日间' : '夜间';
  },

  /* ================= 听书 ================= */
  bindTts() {
    $('tts-play').addEventListener('click', () => {
      const sp = reader.speaker;
      if (!sp.playing) this.startListen();
      else sp.toggle();
    });
    $('tts-stop').addEventListener('click', () => {
      reader.speaker.stop();
      $('tts-text').textContent = '已停止';
    });
    $('tts-prev').addEventListener('click', () => reader.speaker.prev());
    $('tts-next').addEventListener('click', () => reader.speaker.next());

    $('tts-voice').addEventListener('change', e => {
      saveSettings({ ttsVoice: e.target.value });
      reader.speaker.setOpt({ voiceURI: e.target.value });
    });
    $('rng-rate').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      saveSettings({ ttsRate: v }); $('val-rate').textContent = v.toFixed(1);
      reader.speaker.setOpt({ rate: v });
    });
    $('rng-pitch').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      saveSettings({ ttsPitch: v }); $('val-pitch').textContent = v.toFixed(1);
      reader.speaker.setOpt({ pitch: v });
    });
    $('seg-timer').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const v = parseInt(b.dataset.v, 10);
      saveSettings({ timerMin: v });
      reader.speaker.setOpt({ timerMin: v });
      this.syncSettingsUI();
      if (v && reader.speaker.playing) this.toast(`${v} 分钟后自动停止朗读`);
    });

    $('btn-battery').addEventListener('click', () => {
      try {
        if (window.AndroidTTS && window.AndroidTTS.requestIgnoreBattery) {
          window.AndroidTTS.requestIgnoreBattery();
          this.toast('请在系统弹窗里选择「允许」，把轻阅加入白名单');
        } else {
          this.toast('当前环境无需设置');
        }
      } catch (e) { this.toast('打开设置失败'); }
      setTimeout(() => this.refreshBattery(), 1200);
    });
  },

  /** 锁屏保活状态：未忽略电池优化时，锁屏久了系统会冻结 App */
  refreshBattery() {
    const el = $('battery-state');
    if (!el) return;
    if (!isNativeApp() || !window.AndroidTTS || !window.AndroidTTS.isIgnoringBattery) {
      $('grp-battery').style.display = 'none';
      return;
    }
    let ok = true;
    try { ok = !!window.AndroidTTS.isIgnoringBattery(); } catch (e) { ok = true; }
    el.textContent = ok ? '已加入白名单，锁屏可长时间播放' : '未加入白名单，锁屏久了可能被系统暂停';
    el.style.color = ok ? '' : 'var(--danger)';
    $('btn-battery').textContent = ok ? '去查看' : '去设置';
  },

  startListen() {
    if (!ttsSupported()) { this.toast('当前浏览器不支持语音朗读'); return; }
    const sp = reader.speaker;
    if (!reader.book) { this.toast('请先打开一本书'); return; }
    if (sp.playing) { this.openSheet('sheet-tts'); return; }

    this.openSheet('sheet-tts');
    this.fillVoices();
    if (window.AndroidTTS && window.AndroidTTS.setSeamless) {
      try { window.AndroidTTS.setSeamless(settings.seamless !== false); } catch (e) { /* ignore */ }
    }
    if (window.AndroidTTS && window.AndroidTTS.setJoinShort) {
      try { window.AndroidTTS.setJoinShort(settings.joinShort !== false); } catch (e) { /* ignore */ }
    }
    const start = reader.currentBlock ? reader.currentBlock() : 0;
    sp.play(start, {
      rate: settings.ttsRate,
      pitch: settings.ttsPitch,
      voiceURI: settings.ttsVoice,
      lang: 'zh-CN',
      keepAwake: settings.keepAwake,
      timerMin: settings.timerMin,
      seamless: settings.seamless !== false,
      joinShort: settings.joinShort !== false,
    });
  },

  fillVoices() {
    // 安卓 APP：用原生音色表渲染卡片网格（在线多音色 + 系统语音）
    if (isNativeApp() && window.AndroidTTS && window.AndroidTTS.getVoiceList) {
      const grid = $('voice-grid');
      const sel = $('tts-voice');
      if (!grid) return;
      try {
        let list = [];
        try { list = JSON.parse(window.AndroidTTS.getVoiceList() || '[]'); } catch (e) { list = []; }
        if (!list.length) { grid.hidden = true; sel.hidden = false; return; }
        let cur = '';
        try { cur = window.AndroidTTS.getVoiceId() || ''; } catch (e) { cur = ''; }
        sel.hidden = true;
        grid.hidden = false;
        const online = list.filter(v => v.group === 'online');
        const system = list.filter(v => v.group === 'system');
        const card = v => `<button class="voice-card ${v.id === cur ? 'on' : ''}" data-vid="${escapeHtml(v.id)}">` +
          `<b>${escapeHtml(v.name)}</b><span>${escapeHtml(v.desc || '')}</span></button>`;
        grid.innerHTML =
          `<div class="voice-sec" style="grid-column:1/-1">在线音色 · 需联网</div>` +
          online.map(card).join('') +
          (system.length ? `<div class="voice-sec" style="grid-column:1/-1">系统语音 · 离线</div>` + system.map(card).join('') : '') +
          `<div class="voice-sec" style="grid-column:1/-1">离线音色需要在系统里安装中文语音引擎；本机未检测到，故暂不提供离线音色下载</div>`;
        grid.querySelectorAll('[data-vid]').forEach(btn => {
          btn.addEventListener('click', () => {
            const vid = btn.dataset.vid;
            try { window.AndroidTTS.setVoiceId(vid); } catch (e) { /* ignore */ }
            grid.querySelectorAll('.voice-card').forEach(b => b.classList.toggle('on', b === btn));
            this.toast(`已切换到「${btn.querySelector('b').textContent}」`);
            if (reader.speaker.playing) {
              // 正在朗读：直接用新音色重读当前句（不打断阅读节奏）
              reader.speaker.restartCurrent();
            } else {
              try { window.AndroidTTS.testSpeak(); } catch (e) { /* ignore */ }
            }
            if (window.__renderTtsTip) setTimeout(window.__renderTtsTip, 400);
          });
        });
        return;
      } catch (e) {
        // 任何异常都退回系统音色下拉，保证面板还能用
        grid.hidden = true;
        sel.hidden = false;
      }
    }

    // 浏览器 / PWA：退回系统音色下拉
    const sel = $('tts-voice');
    const opts = reader.speaker.voiceOptions();
    sel.innerHTML = '';
    if (!opts.length) {
      sel.innerHTML = '<option value="">（使用系统默认音色）</option>';
      return;
    }
    for (const v of opts) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      if (v.name === '系统默认音色' || v.voiceURI === '系统默认音色') {
        o.textContent = '系统默认音色（未检测到其它音色，仍可朗读）';
      } else {
        const local = v.localService ? '本地' : '云端';
        o.textContent = `${v.name} · ${v.lang}${local ? ' · ' + local : ''}`;
      }
      sel.appendChild(o);
    }
    if (settings.ttsVoice && opts.some(v => v.voiceURI === settings.ttsVoice)) sel.value = settings.ttsVoice;
  },

  onTtsState(s) {
    $('tts-play').classList.toggle('playing', s.playing && !s.paused);
    $('tts-play-ic').innerHTML = `<use href="#${s.playing && !s.paused ? 'i-pause' : 'i-play'}"/>`;
    $('tts-text').textContent = s.playing ? (s.text || '…') : '已停止';
    $('tts-now').textContent = s.playing && reader.book
      ? `正在朗读：${reader.book.title} · ${reader.titles[reader.chapterIndex]?.title || ''}（${s.index + 1}/${s.total}）`
      : (reader.book ? reader.book.title : '—');
    $('tts-timer-left').textContent = s.timer || '';
    $('btn-listen').classList.toggle('on', s.playing);
    $('btn-tts-open').classList.toggle('on', s.playing);
  },

  /* ================= 书籍详情 ================= */
  openBookSheet(book) {
    this.curBookId = book.id;
    $('bk-title').textContent = book.title;
    const p = book.progress || {};
    const rows = [
      ['作者', book.author || '—'],
      ['格式', (book.format || '').toUpperCase() + (book.encoding ? ' · ' + book.encoding : '')],
      ['章节', book.chapterCount + ' 章'],
      ['字数', fmtChars(book.chars)],
      ['大小', fmtSize(book.size)],
      ['导入时间', fmtDate(book.createdAt)],
      ['上次阅读', (p.chapterIndex !== undefined ? `第 ${p.chapterIndex + 1} 章 · ` : '') + (p.percent ? p.percent.toFixed(1) + '%' : '未读')],
    ];
    $('bk-info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
    $('bk-encode-group').style.display = book.format === 'txt' ? '' : 'none';
    $('bk-encode').value = 'auto';
    this.openSheet('sheet-book');
  },

  /* ================= 面板通用 ================= */
  bindNav() {
    $('btn-about').addEventListener('click', async () => {
      $('about-storage').textContent = await storageInfo();
      this.openSheet('sheet-about');
    });
    $('btn-sort').addEventListener('click', () => {
      const order = ['recent', 'title', 'added'];
      saveSettings({ sortBy: order[(order.indexOf(settings.sortBy) + 1) % order.length] });
      this.renderShelf();
    });

    $('bk-restart').addEventListener('click', async () => {
      const b = this.books.find(x => x.id === this.curBookId);
      if (!b) return;
      await db.patchBook(b.id, { progress: { chapterIndex: 0, blockIndex: 0, ratio: 0, percent: 0 } });
      Object.assign(b, { progress: { chapterIndex: 0, blockIndex: 0, ratio: 0, percent: 0 } });
      reader.clearPos(b.id);
      this.closeSheets();
      this.openBook(b);
    });
    $('bk-reparse').addEventListener('click', async () => {
      const b = this.books.find(x => x.id === this.curBookId);
      if (!b) return;
      const enc = $('bk-encode').value;
      $('loading-mask').classList.add('show');
      $('loading-text').textContent = '正在重新分章…';
      try {
        const parsed = await reader.reparse(b.id, enc);
        b.chapterCount = parsed.chapters.length;
        b.chars = parsed.chapters.reduce((a, c) => a + c.text.length, 0);
        b.encoding = parsed.encoding || enc;
        await db.patchBook(b.id, { chapterCount: b.chapterCount, chars: b.chars, encoding: b.encoding });
        this.closeSheets();
        this.renderShelf();
        this.toast(`已重新分章，共 ${b.chapterCount} 章`);
      } catch (e) {
        this.toast(e.message || '重新分章失败');
      } finally {
        $('loading-mask').classList.remove('show');
      }
    });
    $('bk-delete').addEventListener('click', async () => {
      const b = this.books.find(x => x.id === this.curBookId);
      if (!b) return;
      if (!confirm(`确定从书架删除《${b.title}》？\n该书的阅读进度也会一并删除。`)) return;
      await db.deleteBook(b.id);
      this.closeSheets();
      await this.refreshShelf();
      this.toast('已删除');
    });
  },

  bindSheets() {
    document.querySelectorAll('[data-close]').forEach(el => {
      el.addEventListener('click', () => this.closeSheets());
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.closeSheets();
    });
  },

  openSheet(id) {
    document.querySelectorAll('.sheet').forEach(s => s.classList.remove('open'));
    $(id).classList.add('open');
    if (id === 'sheet-tts') {
      this.fillVoices();
      this.refreshBattery();
      if (isNativeApp() && window.__renderTtsTip) window.__renderTtsTip();
    }
  },
  closeSheets() {
    document.querySelectorAll('.sheet').forEach(s => s.classList.remove('open'));
  },

  toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._t);
    this._t = setTimeout(() => t.classList.remove('show'), 2000);
  },

  async copyText(s) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch (e) { /* fallthrough */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  },
};

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtChars(n) {
  n = n || 0;
  return n >= 10000 ? (n / 10000).toFixed(1) + ' 万字' : n + ' 字';
}
function fmtSize(n) {
  n = n || 0;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function relativeTime(ts) {
  if (!ts) return '未读';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 604800000) return Math.floor(d / 86400000) + ' 天前';
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}-${dt.getDate()}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.init();
