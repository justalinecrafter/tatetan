// 学習の進行をまとめる。DOM に依存しない(フィードとシミュレーションで共用する)。
//   st:  保存データ(store.state)
//   ses: 1 回の利用のあいだだけ持つ情報 { counts, recent, flow }
import {
  ST, G, classify, apply, confirm, memorize, downgrade, dislike, pKnown, updateLearner, logBox, logReview,
  pushBaseline, thresholds, newLearner, dayKey,
} from './srs.js';
import { pickNext, summarizeHabits, boxStages, frontierOf } from './scheduler.js';

const SESSION_GAP = 30 * 60000; // これ以上空いたら別の利用とみなす

export function newSession() {
  return { counts: {}, recent: [], flow: { out: [], skip: [], dwell: [] } };
}

export function learner(st, lang) {
  if (!st.learners[lang]) st.learners[lang] = newLearner();
  return st.learners[lang];
}

// 流し見・飽き・成功率(直近の様子)
export function flowSummary(ses, baseline) {
  const { out, skip, dwell } = ses.flow;
  const graded = out.filter((x) => x != null);
  const last8 = skip.slice(-8);
  const skimming = last8.length >= 8 && last8.filter(Boolean).length >= 6;
  const recentDwell = dwell.slice(-8);
  const base = baseline && baseline.length >= 8 ? [...baseline].sort((a, b) => a - b)[baseline.length >> 1] : null;
  const dwellDrop = base != null && recentDwell.length >= 8 &&
    [...recentDwell].sort((a, b) => a - b)[4] < base * 0.6;
  const skipShare = last8.length >= 8 ? last8.filter(Boolean).length / 8 : 0;
  return {
    lastFail: out.length > 0 && out[out.length - 1] === 0,
    rate: graded.length >= 10 ? graded.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, graded.length) : null,
    skimming,
    bored: skimming || (skipShare >= 0.5 && dwellDrop),
  };
}

export function habitsOf(st, now) {
  return summarizeHabits(st.days, st.sessions, now);
}

function touchSession(st, now) {
  const cur = st.sessions[st.sessions.length - 1];
  if (!cur || now - (cur.end || cur.t) > SESSION_GAP) {
    st.sessions.push({ t: now, end: now, n: 0 });
    if (st.sessions.length > 20) st.sessions.splice(0, st.sessions.length - 20);
  }
  return st.sessions[st.sessions.length - 1];
}

// 次の1枚
export function next(st, ses, index, { now, queued = [], scope, rng }) {
  const cur = st.sessions[st.sessions.length - 1];
  // 開いた直後(まだ1枚も数えていない)も新しい利用として扱う
  const habit = habitsOf(st, now);
  if (!cur || now - (cur.end || cur.t) > SESSION_GAP) {
    habit.sessionCards = 0;
    habit.warmup = !!cur && now - (cur.end || cur.t) >= 6 * 3600000;
  }
  return pickNext({
    index,
    recs: st.recs,
    saved: st.saved,
    hidden: st.hidden,
    learners: st.learners,
    now,
    card: st.card,
    recent: ses.recent,
    queued,
    sessionCount: ses.counts,
    scope,
    habit,
    flow: flowSummary(ses, st.base),
    frontiers: ses.frontiers || (ses.frontiers = {}),
    rng,
  });
}

function wordMetrics(word) {
  const ex = word.ex?.[0];
  return {
    chars: [...word.w].length,
    mcount: word.m.length,
    exlen: ex ? ex.t.length + ex.ja.length : 40,
  };
}

// 1枚を見終えたときの記録。imp: { frontMs, backMs, revealed, detail, returned, manual, replay, saved, explicit }
// 返り値: { ev, fx }  fx は演出の種類
export function commit(st, ses, index, word, imp, { now, why, rng }) {
  const L = learner(st, word.lang);
  const rec = st.recs[word.id];
  const first = !rec || rec.st === ST.WATCH || !!rec.def;
  const habit = habitsOf(st, now);
  const flow = flowSummary(ses, st.base);
  const metrics = wordMetrics(word);
  let ev = { kind: 'none' };
  let fx = null;

  if (!imp.explicit) {
    const pk = pKnown(L, word);
    // 学習枠に入れる背伸びの語は2つまで
    const stretchFull = why === 'stretch' && Object.values(st.recs).filter((r) => r.stretch && r.box != null).length >= 2;
    ev = classify({ ...imp, ...metrics }, rec, {
      baseline: st.base,
      pk,
      now,
      skimming: flow.skimming,
      stretch: why === 'stretch',
    });
    if (stretchFull && ev.kind === 'grade' && !ev.implied) {
      ev = { ...ev, kind: 'watch', defer: true };
    }
    const res = apply(rec, ev, word, {
      now,
      card: st.card,
      theta: L.theta,
      pk,
      stages: boxStages(habit),
      frontier: ses.frontiers?.[word.lang] ?? frontierOf(index, st.recs, L, word.lang),
      ivl: L.ivl,
      rng,
    });
    if (res.rec) {
      if (why === 'stretch' && res.rec.box != null) res.rec.stretch = 1;
      if (res.rec.box == null) delete res.rec.stretch;
      if (!imp.revealed && ev.kind === 'grade' && ev.grade >= G.GOOD) res.rec.fm = imp.frontMs;
      st.recs[word.id] = res.rec;
    }
    fx = res.fx;
    if (first && ev.y != null && ev.w) updateLearner(L, word, ev.y, ev.w);
    if (rec && ev.kind === 'grade') {
      const gap = now - rec.last;
      // 学習枠の大きさは、同じ利用の中での成否で決める
      if (rec.box != null && gap < 2 * 3600000) logBox(L, ev.grade >= G.GOOD);
      // 間を空けた復習の成否で、その人に合う間隔の倍率を決める
      if (rec.box == null && (rec.st === ST.KNOWN || rec.st === ST.MASTERED) && gap > 12 * 3600000) logReview(L, ev.grade >= G.GOOD);
    }
  }

  // 直近の様子
  const { quick } = thresholds(st.base, metrics.chars);
  const f = ses.flow;
  f.out.push(ev.kind === 'grade' ? (ev.grade >= G.GOOD ? 1 : ev.grade === G.HARD ? 0.5 : 0) : imp.explicit ? 1 : null);
  f.skip.push(!imp.revealed && imp.frontMs / 1000 < quick);
  f.dwell.push(imp.frontMs / 1000);
  for (const k of ['out', 'skip', 'dwell']) if (f[k].length > 30) f[k].shift();

  if (!imp.revealed && !imp.manual) st.base = pushBaseline(st.base, imp.frontMs / 1000);
  st.card++;
  ses.counts[word.id] = (ses.counts[word.id] || 0) + 1;
  ses.recent.push(word.id);
  if (ses.recent.length > 40) ses.recent.shift();
  st.history.push({ id: word.id, t: now });
  if (st.history.length > 300) st.history.splice(0, st.history.length - 300);
  const day = dayKey(now);
  st.days[day] = (st.days[day] || 0) + 1;
  const s = touchSession(st, now);
  s.n++;
  s.end = now;
  return { ev, fx };
}

// ダブルタップ・確認ボタン: 未出・学習中 → 確認済み → 暗記済み。暗記済みなら何もしない。
// 返り値: { action: 'confirm' | 'memorize' | null }
export function advance(st, index, word, { revealed, now }) {
  const L = learner(st, word.lang);
  const rec = st.recs[word.id];
  const ctx = { now, card: st.card, theta: L.theta, pk: pKnown(L, word), ivl: L.ivl };
  if (rec && rec.st === ST.MASTERED) return { action: null };
  if (rec && rec.st === ST.KNOWN) {
    st.recs[word.id] = memorize(rec, { revealed }, word, ctx);
    return { action: 'memorize' };
  }
  const first = !rec || rec.st === ST.WATCH || !!rec.def;
  st.recs[word.id] = confirm(rec, { revealed }, word, ctx);
  // 答えを見る前に確認した = もともと知っていた、の強い証拠
  if (first && !revealed) updateLearner(L, word, 1, 0.6);
  return { action: 'confirm' };
}

export function stepBack(st, word, { now }) {
  const rec = st.recs[word.id];
  if (!rec || rec.st !== ST.MASTERED) return false;
  st.recs[word.id] = downgrade(rec, { now, card: st.card, ivl: learner(st, word.lang).ivl });
  return true;
}

/* ---------- 最初のテスト ---------- */
// 単語リスト上の位置で出題する。0.35 から始め、正解なら後ろへ、不正解・わからないなら前へ。
// 動かす幅は 0.20 から毎回 0.8 倍。4択のまぐれ当たりを見込んで、上げる幅は下げる幅の 0.8 倍。
export const TEST_QUESTIONS = 12;

export function createPlacement(index, lang, rng = Math.random) {
  const pool = index.ordered(lang);
  const used = new Set();
  const results = [];
  let theta = 0.35;
  let step = 0.2;
  return {
    results,
    get theta() { return theta; },
    get done() { return results.length >= TEST_QUESTIONS || used.size >= pool.length; },
    question() {
      const center = Math.round(theta * (pool.length - 1));
      for (let span = 8; span <= pool.length; span *= 2) {
        const near = pool.slice(Math.max(0, center - span), center + span + 1).filter((w) => !used.has(w.id));
        if (near.length) {
          const w = near[Math.floor(rng() * near.length)];
          used.add(w.id);
          return w;
        }
      }
      return null;
    },
    answer(word, correct) {
      results.push({ word, correct });
      theta = Math.min(1, Math.max(0, theta + (correct ? 0.8 * step : -step)));
      step *= 0.8;
    },
  };
}

// テストの結果を記録にする。正解 = 確認済み(推定)、不正解 = 学習枠へ
export function applyPlacement(st, index, lang, placement, { now, rng }) {
  const L = learner(st, lang);
  L.theta = placement.theta;
  L.n = 0;
  L.tested = true;
  for (const { word, correct } of placement.results) {
    const rec = st.recs[word.id];
    if (rec && rec.st !== ST.WATCH && !rec.def) continue;
    const ev = correct
      ? { kind: 'grade', grade: G.GOOD, conf: 0.6, implied: true, why: 'テストで正解' }
      : { kind: 'grade', grade: G.AGAIN, conf: 0.7, why: 'テストで不正解' };
    const res = apply(rec, ev, word, { now, card: st.card, theta: L.theta, pk: pKnown(L, word), ivl: L.ivl, rng });
    st.recs[word.id] = res.rec;
  }
}

export function markDifficult(st, word, { now }) {
  const L = learner(st, word.lang);
  st.recs[word.id] = dislike(st.recs[word.id], word, { now, card: st.card, theta: L.theta });
}
