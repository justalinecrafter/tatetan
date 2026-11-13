// 個人データはすべてこの端末の localStorage に保存する。
import { newLearner } from './srs.js';
import { newLists, normalizeLists, syncSaved } from './lists.js';

const KEY = 'tatetan.v3';
// 出題の仕組みを作り変えたので、旧版の学習記録は引き継がない(設定と保存リストだけ移す)
const OLD_KEYS = ['tatetan.v2', 'tatetan.v1'];

export const DEFAULT_SETTINGS = {
  scope: 'en', // en | kb | both
  reverse: false, // true: 日本語 → 英語
  tts: true,
  ttsExample: true,
  ttsRate: 0.95,
  bgm: true,
  bgmVol: 0.35,
  bgmMode: 'swipe', // swipe: スワイプごとに曲が変わる / continuous: 1曲ずつ流す
  video: true,
  muted: false,
};

export function freshState() {
  return {
    v: 3,
    onboarded: false,
    levels: { en: null, kb: null }, // 最初に申告したレベル
    coached: false,
    settings: { ...DEFAULT_SETTINGS },
    // 言語ごとの学習者モデル。θ は単語リスト上の位置(0〜1)。テストを受けるまでは最初のほうから
    learners: { en: newLearner(0.1), kb: newLearner(0.1) },
    recs: {},
    saved: {},
    lists: newLists(),
    hidden: {},
    history: [],
    base: [],
    card: 0,
    days: {},
    sessions: [],
  };
}

function normalize(data) {
  const base = freshState();
  const learners = { ...base.learners, ...(data.learners || {}) };
  const st = {
    ...base,
    ...data,
    settings: { ...base.settings, ...(data.settings || {}) },
    learners,
    sessions: data.sessions || [],
    lists: normalizeLists(data),
  };
  syncSaved(st);
  return st;
}

export function createStore() {
  let state = freshState();
  let timer = null;
  let broken = false;

  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = normalize(JSON.parse(raw));
    else {
      let moved = false;
      for (const k of OLD_KEYS) {
        const old = localStorage.getItem(k);
        if (!old) continue;
        if (!moved) {
          moved = true;
          const parsed = JSON.parse(old);
          if (parsed.settings) state.settings = { ...state.settings, ...parsed.settings };
          if (parsed.lists || parsed.saved) {
            state.lists = normalizeLists(parsed);
            syncSaved(state);
          }
        }
        localStorage.removeItem(k);
      }
    }
  } catch {
    // 読み込めない場合は初期状態で動かす
  }

  // Safari のデータ自動削除をなるべく避ける
  try {
    navigator.storage?.persist?.();
  } catch {
    // 非対応でも動作に影響しない
  }

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      broken = false;
    } catch {
      broken = true;
    }
  };

  return {
    get state() {
      return state;
    },
    get saveFailed() {
      return broken;
    },
    save() {
      if (!timer) timer = setTimeout(flush, 500);
    },
    flush,
    exportJson() {
      flush();
      return JSON.stringify({ app: 'tatetan', exportedAt: new Date().toISOString(), data: state });
    },
    importJson(text) {
      const parsed = JSON.parse(text);
      const data = parsed.data || parsed;
      if (typeof data !== 'object' || !data.recs) throw new Error('縦単のバックアップではありません');
      if (data.v !== 3) throw new Error('古い形式のバックアップは読み込めません');
      state = normalize(data);
      flush();
    },
    reset() {
      const settings = state.settings;
      state = freshState();
      state.settings = settings;
      flush();
    },
  };
}

export function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function streak(days, now = Date.now()) {
  let n = 0;
  let t = now;
  if (!days[todayKey(t)]) t -= 86400000;
  while (days[todayKey(t)]) {
    n++;
    t -= 86400000;
  }
  return n;
}
