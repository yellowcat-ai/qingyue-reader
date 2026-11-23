/** settings.js — 阅读与听书偏好（localStorage 持久化） */

const KEY = 'nr.settings.v1';

export const DEFAULTS = {
  fontSize: 18,
  lineHeight: 1.8,
  padding: 20,
  theme: 'paper',
  family: 'sans',
  scrollMode: 'scroll',   // scroll | page
  autoNext: true,
  keepAwake: true,
  follow: true,
  ttsRate: 1,
  ttsPitch: 1,
  ttsVoice: '',
  seamless: true,        // 句间无缝连读（原生层提前准备下一句）
  joinShort: true,       // 短句合并朗读（相邻短句凑一段合成，减少换句停顿）
  multiRole: true,       // 多角色朗读（对白自动换音色，旁白用当前音色）
  roleOverrides: {},     // { 'bookId|角色名': voiceId } 手动指定的角色音色，按书隔离
  timerMin: 0,
  sortBy: 'recent',       // recent | title | added
  catalogDesc: false,     // 目录是否倒序（最新章节在上）
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
}

export const settings = Object.assign({}, DEFAULTS, load());

export function saveSettings(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
  return settings;
}
