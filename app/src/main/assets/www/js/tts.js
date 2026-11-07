/**
 * tts.js — 朗读控制器
 *
 * 两种运行环境：
 *  1) 安卓 APP（有 window.AndroidTTS）：**朗读由原生队列驱动**
 *     JS 一次性把整章句子交给原生，原生自己「合成 → 播放 → 下一句」。
 *     这样切后台 / 锁屏时网页被系统冻结也不影响播放（v1.18 起）。
 *     JS 只负责：发起朗读、收进度回调做高亮、控制暂停/切句。
 *  2) 普通浏览器：Web Speech API，逐句朗读。
 */

const synth = window.speechSynthesis;

/** 是否运行在安卓 APP 内（由 WebView 注入原生朗读桥接） */
export const isNativeApp = () => typeof window !== 'undefined' && !!window.AndroidTTS;

export class Speaker {
  constructor() {
    this.supported = !!synth || isNativeApp();
    this.native = isNativeApp() ? window.AndroidTTS : null;
    this.queueMode = !!this.native;
    this.voices = [];
    this.playing = false;
    this.paused = false;
    this.sentences = [];
    this.index = 0;
    this.total = 0;
    this.chapter = -1;      // 原生当前朗读的章节序号（-1 = 未知）
    this.token = 0;
    this.wakeLock = null;
    this.timerMin = 0;
    this.timerEndsAt = 0;
    this.timerId = null;

    this.hooks = {
      getSentences: () => [],          // () => string[]
      getMeta: () => ({ book: '', chapter: '', chapterIndex: 0 }), // 用于通知栏显示
      collectChapters: async () => '[]', // (fromChapter, count) => JSON 多章句子
      onRemoteChapter: () => {},        // (chapterIndex, title) 原生读到新章时通知网页
      highlight: () => {},             // (index) => void
      onChapterEnd: async () => false, // 返回 true 表示已切到下一章并可继续
      onState: () => {},
      onError: () => {},
      onSlowNet: () => {},              // 网速持续低于音频码率时提示换离线音色
    };

    if (this.native) {
      // 原生队列回调
      window.__ttsQueueProgress = (i, total, playing, chapter, title) =>
        this.onQueueProgress(i, total, playing, chapter, title);
      window.__ttsQueueEnd = () => this.onQueueEnd();
      // 原生念完已交付的章节，索要后续章节
      window.__ttsNeedChapters = (from, count) => this.provideChapters(from, count);
      window.__ttsQueueError = msg => {
        this.playing = false;
        this.paused = false;
        this.clearTimer();
        this.hooks.onError(msg || '语音朗读失败');
        this.emit();
      };
      // 通知栏「停止」
      window.__ttsQueueStopped = () => {
        this.playing = false;
        this.paused = false;
        this.clearTimer();
        this.timerEndsAt = 0;
        this.releaseWake();
        this.hooks.highlight(-1);
        this.emit();
      };
      // 耳机拔出 / 蓝牙断开：原生已把队列暂停，这里同步界面并说明原因
      window.__ttsNoisyPause = () => {
        const wasPlaying = this.playing && !this.paused;   // 已经暂停/停止时不要重复提示
        if (this.playing) this.paused = true;
        this.emit();
        if (wasPlaying) this.hooks.onError('耳机已断开，朗读已暂停');
      };
      // 原生定时关闭到点
      window.__ttsTimerEnd = () => {
        this.playing = false;
        this.paused = false;
        this.clearTimer();
        this.timerEndsAt = 0;
        this.releaseWake();
        this.emit();
        this.hooks.onError('定时关闭时间已到，朗读已停止');
      };
      window.__ttsEvent = (type, id) => {
        // slownet 是原生侧的带宽告警，与单句播放状态无关，不受下面的 token 校验约束
        if (type === 'slownet') { this.hooks.onSlowNet(); return; }
        this.onNativeEvent(type, id);
      };

      // 回到前台：后台期间进度回调可能被丢弃，这里与原生对齐一次
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) setTimeout(() => this.syncFromNative(), 120);
      });
    }

    this.loadVoices();
    if (!this.native && this.supported && typeof synth.onvoiceschanged !== 'undefined') {
      synth.onvoiceschanged = () => this.loadVoices();
    }
  }

  /* ---------------- 原生队列回调 ---------------- */

  onQueueProgress(i, total, playing, chapter, title) {
    if (typeof i === 'number') this.index = i;
    if (typeof total === 'number' && total > 0) this.total = total;
    if (playing === false && this.playing && !this.paused) this.paused = true;
    if (playing === true && !this.playing) this.playing = true;
    if (playing === true && this.paused) this.paused = false;
    if (typeof chapter === 'number' && chapter >= 0 && chapter !== this.chapter) {
      this.chapter = chapter;
      try { this.hooks.onRemoteChapter(chapter, title || ''); } catch (e) { /* ignore */ }
    }
    this.hooks.highlight(this.index);
    this.emit();
  }

  /** 原生索要后续章节：读库拼 JSON 回填 */
  async provideChapters(from, count) {
    if (!this.native) return;
    try {
      const json = await this.hooks.collectChapters(from, count || 8);
      if (json && json !== '[]') this.native.appendChapters(json);
    } catch (e) { /* ignore */ }
  }

  /** 回到前台时与原生状态对齐（后台期间网页被冻结，进度回调可能丢失） */
  /**
   * 原生队列的真实位置。
   * 网页被系统冻结/重载期间，朗读在原生侧继续跨章推进，
   * 这时原生状态是唯一可信的位置来源（网页里的 chapterIndex 是旧的）。
   */
  nativeState() {
    if (!this.queueMode || !this.native) return null;
    try {
      const s = JSON.parse(this.native.queueState() || '{}');
      if (!s || typeof s.playing !== 'boolean') return null;
      if (typeof s.chapter !== 'number' || s.chapter < 0) return null;
      // 原生在播别的书时，这份状态与当前页面无关：拿去同步会把 B 书的进度写进 A 书
      const meta = this.hooks.getMeta ? this.hooks.getMeta() : {};
      const cur = meta && meta.bookId;
      if (s.bookId && cur && s.bookId !== cur) return null;
      return s;
    } catch (e) { return null; }
  }

  syncFromNative() {
    if (!this.queueMode || !this.native) return;
    try {
      const s = this.nativeState();
      if (!s) return;
      if (s.chapter >= 0 && s.chapter !== this.chapter) {
        this.chapter = s.chapter;
        try { this.hooks.onRemoteChapter(s.chapter, s.title || ''); } catch (e) {}
      }
      this.index = s.index || 0;
      this.total = s.total || 0;
      this.playing = !!s.playing;
      this.paused = !!s.paused;
      this.hooks.highlight(this.index);
      this.emit();
    } catch (e) { /* ignore */ }
  }

  async onQueueEnd() {
    if (!this.playing) return;
    const moved = await this.hooks.onChapterEnd();
    if (moved) {
      this.sentences = this.hooks.getSentences() || [];
      this.index = 0;
      this.total = this.sentences.length;
      setTimeout(() => { if (this.playing) this.startNativeQueue(0); }, 150);
    } else {
      this.playing = false;
      this.clearTimer();
      this.emit();
    }
  }

  /** 兼容旧的单句事件（试听 / 浏览器路径） */
  onNativeEvent(type, id) {
    if (this.queueMode) return;   // 队列模式下由 __ttsQueue* 驱动
    if (!this.playing || this.paused) return;
    if (String(id) !== String(this.token)) return;
    if (type === 'done') {
      this.errStreak = 0;
      setTimeout(() => this.speakAt(this.index + 1), 30);
    } else if (type === 'error') {
      this.errStreak = (this.errStreak || 0) + 1;
      if (this.errStreak >= 3) {
        this.stop();
        this.hooks.onError('当前语音引擎没有可用的中文音色，请在听书面板里换一个在线音色');
        return;
      }
      setTimeout(() => this.speakAt(this.index + 1), 30);
    }
  }

  loadVoices() {
    if (this.native) return [];
    if (!this.supported) return [];
    const list = synth.getVoices() || [];
    if (list.length) this.voices = list;
    return this.voices;
  }

  /** 中文音色优先排序 */
  voiceOptions() {
    if (this.native) {
      try {
        const arr = JSON.parse(this.native.getVoices() || '[]');
        return arr.map(v => ({ voiceURI: v.name, name: v.name, lang: v.locale, localService: true }));
      } catch (e) { return []; }
    }
    const vs = this.voices.length ? this.voices : this.loadVoices();
    const score = v => {
      const l = (v.lang || '').toLowerCase();
      if (/^zh|^cmn/.test(l)) return l.includes('cn') || l.includes('hans') ? 0 : 1;
      if (/^yue/.test(l)) return 2;
      return 9;
    };
    return vs.slice().sort((a, b) => score(a) - score(b));
  }

  findVoice(uri) {
    if (!uri) return null;
    return this.voiceOptions().find(v => v.voiceURI === uri) || null;
  }

  on(events) { Object.assign(this.hooks, events); return this; }

  /* ---------------- 播放控制 ---------------- */

  async play(startIndex = -1, opt = {}) {
    if (!this.supported) { this.hooks.onError('当前浏览器不支持语音朗读'); return; }
    this.sentences = this.hooks.getSentences() || [];
    if (!this.sentences.length) { this.hooks.onError('本章没有可朗读的内容'); return; }
    if (startIndex >= 0) this.index = Math.min(startIndex, this.sentences.length - 1);
    if (this.index >= this.sentences.length) this.index = 0;

    this.playing = true;
    this.paused = false;
    this.errStreak = 0;
    this.opt = opt;
    this.total = this.sentences.length;

    await this.requestWake(opt.keepAwake);
    this.setTimer(opt.timerMin || 0);

    if (this.queueMode) {
      await this.startNativeQueue(this.index);
      return;
    }
    this.speakAt(this.index);
  }

  /** 预取章节数：一次交付给原生，锁屏/后台可连续播很久 */
  static get PREFETCH() { return 8; }

  /**
   * 把「当前章 + 后续若干章」一次性交给原生，由原生自己推进。
   * 原生念完这批会回叫 __ttsNeedChapters 索取下一批；
   * 网页若被冻结取不到，就在这批结束时自然停下（已尽量拉长）。
   */
  async startNativeQueue(from) {
    const o = this.opt || {};
    const meta = this.hooks.getMeta ? this.hooks.getMeta() : {};
    const base = typeof meta.chapterIndex === 'number' ? meta.chapterIndex : 0;
    try {
      this.native.setRate(o.rate || 1);
      this.native.setPitch(o.pitch || 1);
      if (o.voiceURI) this.native.setVoice(o.voiceURI);
      // 合并/无缝这类开关每次起播都同步一次，避免重启 App 后原生还停在默认值
      if (this.native.setSeamless && typeof o.seamless === 'boolean') this.native.setSeamless(o.seamless);
      if (this.native.setJoinShort && typeof o.joinShort === 'boolean') this.native.setJoinShort(o.joinShort);
      // 告诉原生是哪本书，它才能把朗读进度落盘（网页被冻结后靠它找回位置）
      if (this.native.setBookId && meta.bookId) this.native.setBookId(meta.bookId);
    } catch (e) { /* ignore */ }

    let payload = '';
    try {
      payload = await this.hooks.collectChapters(base, Speaker.PREFETCH);
    } catch (e) { payload = ''; }
    if (!payload || payload === '[]') {
      payload = JSON.stringify([{ t: meta.chapter || '', s: this.sentences }]);
    }

    try {
      if (this.native.startChapters) {
        this.native.startChapters(payload, from, meta.book || '', base, o.timerMin || 0);
      } else {
        this.native.startQueue(JSON.stringify(this.sentences), from,
          meta.chapter || '', meta.book || '', o.timerMin || 0);
      }
      this.chapter = base;
      this.playing = true;
      this.paused = false;
      this.emit();
    } catch (e) {
      this.playing = false;
      this.hooks.onError('朗读启动失败：' + (e && e.message ? e.message : e));
      this.emit();
    }
  }

  speakAt(i) {
    if (!this.playing) return;
    if (i >= this.sentences.length) { this.nextChapter(); return; }
    this.index = i;
    const text = this.sentences[i];
    this.hooks.highlight(i);
    this.emit();

    if (!text || !text.trim()) { setTimeout(() => this.speakAt(i + 1), 0); return; }

    if (this.native) {   // 非队列的旧路径（极少触发）
      this.token++;
      this.native.speak(text, String(this.token));
      return;
    }

    const my = ++this.token;
    const voiceURI = this.opt && this.opt.voiceURI;
    const u = new SpeechSynthesisUtterance(text);
    const v = this.findVoice(voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = (this.opt && this.opt.lang) || 'zh-CN'; }
    u.rate = this.opt && this.opt.rate ? this.opt.rate : 1;
    u.pitch = this.opt && this.opt.pitch ? this.opt.pitch : 1;
    u.volume = 1;

    u.onend = () => {
      if (my !== this.token || !this.playing) return;
      this.errStreak = 0;
      setTimeout(() => { if (my === this.token && this.playing && !this.paused) this.speakAt(i + 1); }, 30);
    };
    u.onerror = e => {
      if (my !== this.token) return;
      if (e && e.error === 'interrupted') return;
      this.errStreak = (this.errStreak || 0) + 1;
      if (this.errStreak >= 5) {
        this.stop();
        this.hooks.onError('语音朗读持续失败：当前环境可能没有可用的语音引擎');
        return;
      }
      setTimeout(() => { if (my === this.token && this.playing && !this.paused) this.speakAt(i + 1); }, 100);
    };
    try { synth.speak(u); } catch (e) { this.hooks.onError('语音朗读启动失败'); this.stop(); }
  }

  /** 播放中修改语速/音色/定时 */
  setOpt(patch) {
    this.opt = Object.assign({}, this.opt || {}, patch);
    if ('timerMin' in patch) this.setTimer(patch.timerMin);
    const speedChanged = ('rate' in patch) || ('pitch' in patch) || ('voiceURI' in patch);
    if (speedChanged && this.playing && !this.paused) {
      if (this.queueMode) {
        try {
          if ('rate' in patch) this.native.setRate(patch.rate);
          if ('pitch' in patch) this.native.setPitch(patch.pitch);
          this.native.queueRestartCurrent();      // 用新参数重读当前句
        } catch (e) { /* ignore */ }
      } else {
        this.token++;
        if (this.native) this.native.stop(); else { try { synth.cancel(); } catch (e) {} }
        setTimeout(() => this.speakAt(this.index), 80);
      }
    }
    this.emit();
  }

  /** 换音色后重读当前句（播放中切换音色用） */
  restartCurrent() {
    if (!this.playing) return;
    this.paused = false;
    if (this.queueMode) {
      try { this.native.queueRestartCurrent(); } catch (e) { /* ignore */ }
    } else {
      this.speakAt(this.index);
    }
    this.emit();
  }

  pause() {
    if (!this.playing || this.paused) return;
    this.paused = true;
    if (this.queueMode) { try { this.native.pauseQueue(); } catch (e) {} }
    else if (this.native) this.native.stop();
    else { try { synth.pause(); } catch (e) {} }
    this.emit();
  }

  resume() {
    if (!this.playing || !this.paused) return;
    this.paused = false;
    if (this.queueMode) { try { this.native.resumeQueue(); } catch (e) {} }
    else if (this.native) this.speakAt(this.index);
    else {
      try { synth.resume(); } catch (e) { this.speakAt(this.index); }
    }
    this.emit();
  }

  toggle() { this.paused ? this.resume() : this.pause(); }

  stop(keepIndex = true) {
    this.playing = false;
    this.paused = false;
    this.errStreak = 0;
    this.token++;
    if (this.native) this.native.stop();
    else { try { synth.cancel(); } catch (e) {} }
    this.clearTimer();
    this.releaseWake();
    if (!keepIndex) this.index = 0;
    this.hooks.highlight(-1);
    this.emit();
  }

  next() {
    if (!this.playing) return;
    if (this.queueMode) {
      this.paused = false;
      try { this.native.queueNext(); } catch (e) {}
      return;
    }
    this.token++;
    if (this.native) this.native.stop(); else { try { synth.cancel(); } catch (e) {} }
    setTimeout(() => this.speakAt(Math.min(this.index + 1, this.sentences.length - 1)), 40);
  }

  prev() {
    if (!this.playing) return;
    if (this.queueMode) {
      this.paused = false;
      try { this.native.queuePrev(); } catch (e) {}
      return;
    }
    this.token++;
    if (this.native) this.native.stop(); else { try { synth.cancel(); } catch (e) {} }
    setTimeout(() => this.speakAt(Math.max(this.index - 1, 0)), 40);
  }

  /** 跳到本章第 i 句 */
  seek(i) {
    if (!this.playing) return;
    if (this.queueMode) {
      this.index = i;
      this.paused = false;
      try { this.native.queueSeek(i); } catch (e) {}
      this.emit();
    } else {
      this.token++;
      this.speakAt(i);
    }
  }

  async nextChapter() {
    const moved = await this.hooks.onChapterEnd();
    if (moved) {
      this.sentences = this.hooks.getSentences() || [];
      this.index = 0;
      this.total = this.sentences.length;
      setTimeout(() => {
        if (this.queueMode) this.startNativeQueue(0);
        else this.speakAt(0);
      }, 120);
    } else {
      this.stop();
    }
  }

  /* --- 定时关闭：原生模式下由原生计时（后台 JS 定时器会被系统抑制） --- */
  setTimer(min) {
    this.clearTimer();
    this.timerMin = min || 0;
    if (this.queueMode) {
      try { this.native.setQueueTimer(this.timerMin); } catch (e) {}
    }
    if (!min) { this.timerEndsAt = 0; this.emit(); return; }
    this.timerEndsAt = Date.now() + min * 60000;
    // 仅用于界面倒计时显示；真正的停止由原生负责
    this.timerId = setInterval(() => {
      if (Date.now() >= this.timerEndsAt) {
        this.clearTimer();
        this.timerEndsAt = 0;
        if (!this.queueMode) { this.stop(); this.hooks.onError('定时关闭时间已到，朗读停止'); }
        else this.emit();
      } else this.emit();
    }, 1000);
  }
  clearTimer() { if (this.timerId) { clearInterval(this.timerId); this.timerId = null; } }
  timerLeftText() {
    if (!this.timerEndsAt) return '';
    const s = Math.max(0, Math.round((this.timerEndsAt - Date.now()) / 1000));
    const m = Math.floor(s / 60);
    return `将在 ${m}:${String(s % 60).padStart(2, '0')} 后自动停止（朗读中）`;
  }

  /* --- 屏幕常亮 --- */
  async requestWake(on) {
    if (this.native) { this.native.keepScreenOn(!!on); return; }
    this.releaseWake();
    if (!on || !('wakeLock' in navigator)) return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { this.wakeLock = null; }
  }
  releaseWake() {
    if (this.native) { this.native.keepScreenOn(false); return; }
    try { if (this.wakeLock) this.wakeLock.release(); } catch (e) {}
    this.wakeLock = null;
  }

  emit() {
    this.hooks.onState({
      playing: this.playing,
      paused: this.paused,
      index: this.index,
      total: this.total || this.sentences.length,
      text: this.playing ? (this.sentences[this.index] || '') : '',
      timer: this.timerLeftText(),
    });
  }
}

export function ttsSupported() {
  return isNativeApp() || (!!window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined');
}
