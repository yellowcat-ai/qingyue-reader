/**
 * rolebook.js — 一本书的角色档案
 *
 * 解决的问题有两个：
 *   1. 跨章一致。旧版每章独立算音色，同一个「郭襄」在 A 章拿到晓伊、B 章拿到晓萱，
 *      听众会觉得换了个人 —— 这是「出戏」的主要来源。
 *   2. 一人一音。Edge 免费接口的普通话音色只有 7 个（3 女 4 男），一本小说十几个角色
 *      根本不够分。这里把「基础音色 × 音高变体」当作音色槽来分配：
 *      云希 +0 和 云希 +10Hz 在听感上是两个不同的人。实测服务端接受 pitch='±NHz'
 *      （见 test/probe_pitch.py），容量从 7 扩到 35，足够一部长篇的主要角色。
 *
 * 存储：localStorage，键 nr.rolebook.<bookId>，随书隔离，删书不影响别书。
 */

import { MALE_POOL, FEMALE_POOL, stableHash } from './roles.js';

const KEY = (bid) => 'nr.rolebook.' + (bid || '_default');
const MAX_CHARS = 200;          // 防御：异常文本可能产生大量伪角色，超过就不再新建

/**
 * 音高档位（Hz）。Hz 而非百分比：实测 edge 接口只认 '+18Hz' 这种写法，
 * 传 '+10%' 会被客户端直接拒绝（ValueError）。
 *
 * 步长按性别定：男声基频约 110–130Hz，±10Hz 已有明显区分；女声基频约 190–220Hz，
 * 同样幅度需要更大 Hz 才等效，所以女声用 ±14/±24。上限控制在约 15% 以内，
 * 再大就开始出现「娃娃音 / 低音炮」，反而不像正常人。
 */
export const PITCH_STEPS = {
  m: [0, -10, 10, -18, 18],
  f: [0, -14, 14, -24, 24],
};

/** 'edge:zh-CN-YunxiNeural@-10' → 'edge:zh-CN-YunxiNeural' */
export function baseOf(voice) {
  const i = String(voice || '').indexOf('@');
  return i < 0 ? String(voice || '') : String(voice).slice(0, i);
}

/** 'edge:zh-CN-YunxiNeural@-10' → -10；无后缀返回 0 */
export function pitchOf(voice) {
  const i = String(voice || '').indexOf('@');
  if (i < 0) return 0;
  const n = parseInt(String(voice).slice(i + 1), 10);
  return Number.isFinite(n) ? n : 0;
}

/** 基础音色 + 音高 → 槽 id */
export function slotOf(base, hz) {
  return hz ? base + '@' + hz : base;
}

export class RoleBook {
  constructor(bookId) {
    this.id = bookId || '';
    /** @type {Object<string,{g:string,s:number,c:number,v:string,fx:boolean}>} */
    this.chars = {};
    this._voted = new Set();     // 本章已投过票的角色（同一章重算时不重复累加）
    this.load();
  }

  load() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY(this.id)) || '{}');
      this.chars = (o && o.chars) || {};
    } catch (e) { this.chars = {}; }
    return this;
  }

  save() {
    try { localStorage.setItem(KEY(this.id), JSON.stringify({ v: 1, chars: this.chars })); } catch (e) { /* 配额满：忽略，内存里仍然有效 */ }
    return this;
  }

  /**
   * 换章时切换投票窗口。
   * 同一章反复重算（换旁白音色、改设置都会触发 refreshRoles）必须幂等，
   * 否则一个角色在一章里出现 10 句就会被重复计票 10 次，性别一旦定错再也翻不回来。
   */
  beginChapter(chapter) {
    if (this._chapter !== chapter) this._voted = new Set();
    this._chapter = chapter;
    return this;
  }

  touch(name) {
    const k = String(name || '');
    if (!this.chars[k]) {
      if (Object.keys(this.chars).length >= MAX_CHARS) return null;
      this.chars[k] = { g: '', s: 0, c: 0, v: '', fx: false };
    }
    return this.chars[k];
  }

  has(name) { return !!this.chars[String(name || '')]; }

  /**
   * 跨章名字归一。
   *
   * 同一角色在不同章节可能被切成不同长度：本章识别成「郭襄心」，上一章是「郭襄」。
   * 章内的 canonical() 只看得到本章，跨章就会分裂成两个角色、两个声音 ——
   * 听众的感受就是「郭襄换人了」。
   *
   * 规则：差一个字且互为前缀 / 后缀就并到档案里已有的名字上。
   * 宁可把两个配角并成一个声音，也不要让同一个人换声音。
   */
  alias(name) {
    const n = String(name || '');
    if (!n) return n;
    if (this.chars[n]) return n;
    for (const old of Object.keys(this.chars)) {
      if (old.length < 2 || n.length < 2) continue;
      if (Math.abs(old.length - n.length) !== 1) continue;
      if (old.startsWith(n) || n.startsWith(old) || old.endsWith(n) || n.endsWith(old)) return old;
    }
    return n;
  }

  /**
   * 累积性别证据并返回当前结论。
   * @param {string} name 角色名
   * @param {number} score 本次证据（正男负女，见 roles.genderScore）
   * @returns {'m'|'f'} 永不为空 —— 判不出来按男性，中文小说男性角色占多数
   */
  genderOf(name, score) {
    const c = this.touch(name);
    if (!c) return score < 0 ? 'f' : 'm';
    const k = String(name);
    if (!this._voted.has(k)) {
      c.s = (c.s || 0) + (score || 0);
      c.c = (c.c || 0) + 1;
      this._voted.add(k);
    }
    const want = c.s < 0 ? 'f' : 'm';
    if (!c.g) {
      c.g = want;
    } else if (want !== c.g && Math.abs(c.s) >= 6) {
      // 证据足够强才翻案，避免一两句的噪声让角色反复换性别（换性别必然换声音）
      c.g = want;
      if (!c.fx) c.v = '';      // 音色作废，下次重新分配
    }
    return c.g;
  }

  gender(name) { const c = this.chars[String(name || '')]; return (c && c.g) || ''; }

  /** 其他角色（以及旁白）已经占用的音色 */
  usedVoices(exceptName) {
    const used = new Set();
    for (const n of Object.keys(this.chars)) {
      if (n === exceptName) continue;
      const v = this.chars[n] && this.chars[n].v;
      if (v) used.add(v);
    }
    return used;
  }

  /**
   * 取这个角色的音色。已有且性别匹配就直接复用（跨章稳定的关键），
   * 否则分配一个没人用的槽。
   */
  voiceFor(name, gender, opt = {}) {
    const c = this.touch(name);
    if (!c) return null;
    const g = gender === 'f' ? 'f' : 'm';
    const pool = g === 'f'
      ? ((opt.femalePool && opt.femalePool.length) ? opt.femalePool : FEMALE_POOL)
      : ((opt.malePool && opt.malePool.length) ? opt.malePool : MALE_POOL);

    // 手动指定过的：原样保留，不参与自动分配
    if (c.fx && c.v) return c.v;

    if (c.v) {
      if (pool.includes(baseOf(c.v))) return c.v;   // 性别没变，沿用
      c.v = '';                                     // 性别改了，旧音色作废
    }

    const used = this.usedVoices(name);
    if (opt.narration) used.add(opt.narration);
    c.v = allocSlot(name, pool, used, PITCH_STEPS[g]) || '';
    return c.v || null;
  }

  /** 用户手动指定（写死，自动分配不再改动它） */
  setVoice(name, voice) {
    const c = this.touch(name);
    if (!c) return;
    c.v = voice || '';
    c.fx = !!voice;
    this.save();
  }

  /** 手动指定是否与自动结果一致时取消写死 */
  clearFixed(name) {
    const c = this.chars[String(name || '')];
    if (c) { c.fx = false; this.save(); }
  }

  /** 清空整本书的档案（角色全部重新识别、重新配音） */
  reset() {
    this.chars = {};
    this._voted = new Set();
    this.save();
  }

  /** 面板展示用：按出场顺序列出角色 */
  list() {
    return Object.keys(this.chars)
      .map(n => ({ name: n, ...this.chars[n] }))
      .filter(r => r.v || r.c)
      .sort((a, b) => (b.c || 0) - (a.c || 0));
  }
}

/**
 * 从「池 × 音高」里挑一个没被占用的槽。
 * 第一轮只用基础音色（听感最自然），池用尽了才叠加音高变体。
 */
function allocSlot(name, pool, used, steps) {
  if (!pool.length) return '';
  const start = stableHash(name) % pool.length;
  for (let k = 0; k < pool.length; k++) {
    const b = pool[(start + k) % pool.length];
    if (!used.has(b)) return b;
  }
  const all = [];
  for (const hz of (steps || [0])) for (const b of pool) all.push(slotOf(b, hz));
  const s2 = stableHash(name) % all.length;
  for (let k = 0; k < all.length; k++) {
    const v = all[(s2 + k) % all.length];
    if (!used.has(v)) return v;
  }
  return all[s2];      // 全占满了：只能复用一个，仍然保持确定性
}

/** 单例缓存：一个会话里同一本书只建一个档案对象 */
const books = new Map();
export function roleBookOf(bookId) {
  const k = bookId || '_default';
  if (!books.has(k)) books.set(k, new RoleBook(bookId));
  return books.get(k);
}
