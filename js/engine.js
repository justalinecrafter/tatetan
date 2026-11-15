// 学習の進行をまとめる。DOM に依存しない(フィードとシミュレーションで共用する)。
//   st:  保存データ(store.state)
//   ses: 1 回の利用のあいだだけ持つ情報 { counts, recent, checked, flow, drill }
import {
  ST, G, classify, apply, memorize, unmark, dislike, pKnown, farEasy, updateLearner, logBox, logReview,
  pushBaseline, thresholds, newLearner, newTrack, thetaOf, dayKey, isNew,
} from './srs.js';
import { pickNext, summarizeHabits, boxStages, frontierOf, frontierKey, DRILL_AGAIN_MAX } from './scheduler.js';

const SESSION_GAP = 30 * 60000; // これ以上空いたら別の利用とみなす

export function newSession() {
  // recent: この利用で見た語(新しい順に最大40) / checked: それぞれが「もとから暗記済みの語の確認」だったか
  return { counts: {}, recent: [], checked: [], flow: { out: [], skip: [], dwell: [] } };
}

// 復習モードの、この利用での記録(出した語・思い出せなかった語)
const drillOf = (ses) => ses.drill || (ses.drill = { drilled: {}, missed: {} });

export function learner(st, lang) {
  if (!st.learners[lang]) st.learners[lang] = newLearner();
  return st.learners[lang];
}

// 飽き・成功率(直近の様子)
export function flowSummary(ses, baseline) {
  const { out, skip, dwell } = ses.flow;
  const graded = out.filter((x) => x != null);
  const last8 = skip.slice(-8);
  const recentDwell = dwell.slice(-8);
  const base = baseline && baseline.length >= 8 ? [...baseline].sort((a, b) => a - b)[baseline.length >> 1] : null;
  const dwellDrop = base != null && recentDwell.length >= 8 && [...recentDwell].sort((a, b) => a - b)[4] < base * 0.6;
  const skipShare = last8.length >= 8 ? last8.filter(Boolean).length / 8 : 0;
  return {
    lastFail: out.length > 0 && out[out.length - 1] === 0,
    rate: graded.length >= 10 ? graded.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, graded.length) : null,
    bored: skipShare >= 0.75 || (skipShare >= 0.5 && dwellDrop),
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
// drill: true なら復習モード(暗記済み・知ってそうの語だけを、定着に効く順に)
export function next(st, ses, index, { now, queued = [], scope, range = null, drill = false, rng }) {
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
    checked: ses.checked,
    queued,
    sessionCount: ses.counts,
    scope,
    range,
    drill: drill ? drillOf(ses) : null,
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

// 1枚を見終えたときの記録。imp: { frontMs, backMs, revealed, detail, returned, manual, replay, saved, explicit, resumed }
//   resumed: ページを開いて戻った・アプリを切り替えて戻ったあとの見直し(同じ1枚の続きなので、枚数には数えない)
// 返り値: { ev, fx }  fx は演出の種類
export function commit(st, ses, index, word, imp, { now, why, rng }) {
  const L = learner(st, word.lang);
  const rec = st.recs[word.id];
  const first = isNew(rec);
  // もとから暗記済みの語の確認か(この1枚で暗記ボタンを押した語は数えない)
  const wasMastered = rec?.st === ST.MASTERED && !imp.explicit;
  const drilling = why === 'drill' || why === 'drill-again';
  const habit = habitsOf(st, now);
  const metrics = wordMetrics(word);
  let ev = { kind: 'none' };
  let fx = null;

  if (!imp.explicit) {
    const pk = pKnown(L, word);
    // 学習枠に入れる背伸びの語は2つまで
    const stretchFull = why === 'stretch' && Object.values(st.recs).filter((r) => r.stretch && r.box != null).length >= 2;
    ev = classify({ ...imp, ...metrics }, rec, { baseline: st.base, pk, far: farEasy(L, word), stretch: why === 'stretch', now });
    if (stretchFull && ev.kind === 'grade') ev = { kind: 'hold', gap: 60, y: ev.y, w: ev.w, why: '背伸びの語が学習枠にもう2つある' };
    const res = apply(rec, ev, word, {
      now,
      card: st.card,
      theta: thetaOf(L, word),
      pk,
      stages: boxStages(habit),
      frontier: ses.frontiers?.[frontierKey(word)] ?? frontierOf(index, st.recs, L, word.lang, word.kind),
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
    // 復習モードは難しい語・忘れかけの語に寄せて出すので、枠の大きさ・間隔の倍率の調整には使わない
    if (!first && ev.kind === 'grade' && !drilling) {
      const gap = now - rec.last;
      // 学習枠の大きさは、同じ利用の中での成否で決める
      if (rec.box != null && gap < 2 * 3600000) logBox(L, ev.grade >= G.GOOD);
      // 間を空けた復習の成否で、その人に合う間隔の倍率を決める
      if (rec.box == null && gap > 12 * 3600000) logReview(L, ev.grade >= G.GOOD);
    }
  }

  // 復習モード: 出した語は、この利用ではもう出さない。思い出せなかった・迷った語は、間を空けてもう一度
  if (drilling) {
    const d = drillOf(ses);
    d.drilled[word.id] = 1;
    const m = d.missed[word.id];
    if (imp.explicit || (ev.kind === 'grade' && ev.grade >= G.GOOD)) delete d.missed[word.id];
    else if (!imp.resumed && ((ev.kind === 'grade' && ev.grade <= G.HARD) || m)) {
      // 思い出せなかった・迷った(もう一度の語を飛ばした・放置した場合も、少しあとにもう一度。合わせて3回まで)
      const n = (m?.n || 0) + 1;
      if (n > DRILL_AGAIN_MAX) delete d.missed[word.id];
      else d.missed[word.id] = { at: st.card, n };
    }
  }

  // 戻ってきたあとの見直しは、離れる前に数えた1枚の続き。枚数・履歴・直近の様子には入れない
  if (imp.resumed) return { ev, fx };

  // 直近の様子
  const { quick } = thresholds(st.base, metrics.chars);
  const f = ses.flow;
  f.out.push(ev.kind === 'grade' ? (ev.grade >= G.GOOD ? 1 : ev.grade === G.HARD ? 0.5 : 0) : imp.explicit ? 1 : null);
  f.skip.push(!imp.revealed && imp.frontMs / 1000 < quick);
  f.dwell.push(imp.frontMs / 1000);
  for (const k of ['out', 'skip', 'dwell']) if (f[k].length > 30) f[k].shift();

  if (!imp.revealed && !imp.manual) st.base = pushBaseline(st.base, imp.frontMs / 1000);
  st.card++;
  // 一瞬で飛ばした分は、1回の利用で同じ語を出す上限に数えない(覚えかけの語が上限で止まらないように)
  if (ev.kind !== 'skip') ses.counts[word.id] = (ses.counts[word.id] || 0) + 1;
  ses.recent.push(word.id);
  ses.checked.push(wasMastered);
  if (ses.recent.length > 40) {
    ses.recent.shift();
    ses.checked.shift();
  }
  st.history.push({ id: word.id, t: now });
  if (st.history.length > 300) st.history.splice(0, st.history.length - 300);
  const day = dayKey(now);
  st.days[day] = (st.days[day] || 0) + 1;
  const s = touchSession(st, now);
  s.n++;
  s.end = now;
  // 50枚ほど使えば、テストや申告がなくても θ はあてになる
  if (!L.sure && L.n >= 30) L.sure = true;
  return { ev, fx };
}

// 利用者が暗記済みにした語か(暗記済みはボタンを押した語だけ)
export const isMarked = (rec) => !!rec && rec.st === ST.MASTERED;

// 知ってそうの語のうち、暗記ボタンを押すように一度だけ声をかける語
export const wantsNudge = (rec) => !!rec && rec.st === ST.LIKELY && !rec.lkc && !rec.nudged;

// ダブルタップ・暗記ボタン: 暗記済みにする。すでに暗記済みなら何もしない。
// 返り値: { action: 'memorize' | null }
export function advance(st, index, word, { revealed, now, rng = Math.random }) {
  const L = learner(st, word.lang);
  const rec = st.recs[word.id];
  if (isMarked(rec)) return { action: null };
  const first = isNew(rec);
  st.recs[word.id] = memorize(rec, { revealed }, word, { now, card: st.card, theta: thetaOf(L, word), pk: pKnown(L, word), ivl: L.ivl, rng });
  // 初めての語で暗記を押した = もともと知っていた、の強い証拠(答えを見る前ならなお強い)
  if (first) updateLearner(L, word, revealed ? 0.7 : 1, revealed ? 0.3 : 0.6);
  return { action: 'memorize' };
}

// 暗記済みを外す(学習中へ戻す)
export function stepBack(st, word, { now, rng }) {
  const rec = st.recs[word.id];
  if (!isMarked(rec)) return false;
  st.recs[word.id] = unmark(rec, { now, card: st.card, rng });
  return true;
}

export function markDifficult(st, word, { now }) {
  const L = learner(st, word.lang);
  st.recs[word.id] = dislike(st.recs[word.id], word, { now, card: st.card, theta: thetaOf(L, word) });
}

/* ---------- 最初のレベル設定 ---------- */
// 自己申告のレベル → リスト上の開始位置。英単語リストは高校基礎(feed, judge…)から難関(scrutinize…)まで。
// 古典は「やらない(未回答)」なら申告なしとして既定の位置から始める。
export const LEVELS = {
  en: [
    { id: 'jh', label: '中学生', theta: 0.0 },
    { id: 'hs', label: '高校生(基礎)', theta: 0.08 },
    { id: 'exam', label: '大学受験(共通テスト)', theta: 0.25 },
    { id: 'hard', label: '難関大・英検準1級', theta: 0.5 },
    { id: 'adv', label: '上級(英検1級など)', theta: 0.75 },
  ],
  kb: [
    { id: 'none', label: 'やらない(未回答)', theta: null },
    { id: 'begin', label: 'ほぼ初めて', theta: 0.0 },
    { id: 'class', label: '高校の授業レベル', theta: 0.12 },
    { id: 'exam', label: '共通テストレベル', theta: 0.3 },
    { id: 'hard', label: '難関大レベル', theta: 0.55 },
    { id: 'adv', label: '古文が得意', theta: 0.75 },
  ],
};
const levelOf = (lang, id) => LEVELS[lang].find((x) => x.id === id) || null;

// 古典はテストがないので申告だけで始める。ずれていても早く合うように、坂を広く・動きを速くする
export function applyLevels(st, { en, kb }) {
  st.levels = { en: en || null, kb: kb || null };
  const ke = levelOf('kb', kb);
  if (ke && ke.theta != null) {
    st.learners.kb = newLearner(ke.theta, { w: 0.12, lr: 0.12 });
    st.learners.kb.sure = true;
  }
}

/* ---------- 英単語のテスト ---------- */
// 単語リスト上の位置で出題する。申告したレベル(なければ 0.35)から始め、正解なら後ろへ、不正解・わからないなら前へ。
// 動かす幅は 0.20 から毎回 0.8 倍(申告が大きくずれていても、テストの中で戻れるように)。
// 4択のまぐれ当たりを見込んで、上げる幅は下げる幅の 0.8 倍。
export const TEST_QUESTIONS = 12;

export function createPlacement(index, lang, { start = null, rng = Math.random } = {}) {
  const pool = index.ordered(lang);
  const used = new Set();
  const results = [];
  let theta = start ?? 0.35;
  let step = 0.2;
  return {
    results,
    start,
    get theta() { return theta; },
    get done() { return results.length >= TEST_QUESTIONS || used.size >= pool.length; },
    question() {
      const center = Math.round(Math.max(0, theta) * (pool.length - 1));
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

// テストの結果を記録にする。θ はテスト 75% + 申告 25%(0.2 以上食い違うときはテストだけを信じる)。
// 正解の語 = 知ってそう(数日後に確かめる)、不正解の語 = 学習枠へ
export function applyPlacement(st, index, lang, placement, { now, rng }) {
  const self = placement.start;
  const test = placement.theta;
  const theta = self == null || Math.abs(test - self) > 0.2 ? test : 0.75 * test + 0.25 * self;
  // 受け直したときも、学習枠の大きさや間隔の倍率はそのまま。θ と坂だけ測り直す
  const L = learner(st, lang);
  Object.assign(L, newTrack(theta));
  L.p = newTrack(theta);
  L.sure = true;
  for (const { word, correct } of placement.results) {
    const rec = st.recs[word.id];
    if (!isNew(rec)) continue;
    const ctx = { now, card: st.card, theta: thetaOf(L, word), pk: pKnown(L, word), ivl: L.ivl, rng };
    const ev = correct
      ? { kind: 'likely', s: 2 + 6 * ctx.pk, confirm: true, why: 'テストで正解' }
      : { kind: 'grade', grade: G.AGAIN, why: 'テストで不正解' };
    st.recs[word.id] = apply(rec, ev, word, ctx).rec;
  }
}
