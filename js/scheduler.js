// 次に流す単語を選ぶ。DOM に依存しない。
//
// 前線方式: 単語リスト・熟語リストをそれぞれ易しい順の1本の道とみなし、新しい語は「知っているか怪しくなり始めるところ」から
// 易しい順に出す。覚えかけの語は学習枠(既定8語)に入れ、枠が空くまで次の新しい語は出さない。
// その合間に、長期の復習・易しい語の確認・背伸びの語・定着した語の抜き打ちを混ぜる。
import { ST, DAY, BOX_GAPS, retrievability, isDue, overdue, pKnown, settled } from './srs.js';

const RECENT_LIMIT = 6; // 同じ語を続けない
const SESSION_CAP = 4; // 1 回の利用で同じ語を流す上限
const CONFUSE_GAP = 30; // 紛らわしい語は、この枚数以内に続けて新出にしない
const AHEAD_MIN_CARDS = 12; // 期限前に出すときも、直前に見た語は避ける
const CHECK_MIN_GAP = DAY / 2;
const FORCE_OVERDUE = 10; // 学習枠の出番をこの枚数過ぎたら必ず出す

const WINDOW_START_U = 0.15; // 知らない確率がこれを超えたところから新しい語の窓を始める
const WINDOW_SUM = 6; // 窓に入れる「知らない語」の見込み数
const WINDOW_TAU = 3;
const WINDOW_MAX = 150;
const EASY_PK = 0.85;

const RATE = {
  box: 0.7,
  reviewBase: 0.15,
  reviewPer: 0.03,
  reviewMax: 0.4,
  easy: 0.06,
  stretch: 0.06,
  checkMin: 0.03,
  checkMax: 0.05,
};

function sample(items, weightOf, rng) {
  let total = 0;
  const weights = items.map((it) => {
    const w = Math.max(0, weightOf(it));
    total += w;
    return w;
  });
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

const median = (list) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// 利用の習慣(影響は小さめに使う)
//   days: { 'YYYY-MM-DD': 枚数 }   sessions: [{ t: 開始時刻, n: 枚数 }]
export function summarizeHabits(days, sessions, now) {
  const keys = Object.keys(days).sort().slice(-15);
  const stamps = keys.map((k) => new Date(`${k}T12:00:00`).getTime());
  const gaps = [];
  for (let i = 1; i < stamps.length; i++) gaps.push(Math.round((stamps[i] - stamps[i - 1]) / DAY));
  const done = sessions.slice(0, -1).slice(-14).map((s) => s.n);
  const cur = sessions[sessions.length - 1];
  const prev = sessions[sessions.length - 2];
  const recentDays = keys.slice(-14).map((k) => days[k]);
  return {
    gapDays: gaps.length >= 3 ? median(gaps) : 1,
    sessionMedian: done.length >= 3 ? median(done) : null,
    dailyAvg: recentDays.length >= 3 ? recentDays.reduce((a, b) => a + b, 0) / recentDays.length : null,
    sessionCards: cur ? cur.n : 0,
    // 6 時間以上空いたら、最初の 3 枚は復習から(準備運動)
    warmup: !!(cur && prev && cur.t - (prev.end || prev.t) >= 6 * 3600000 && cur.n < 3),
  };
}

// 学習枠の段の数。2〜3日おきに使う人は、卒業前にもう1段確かめる
export const boxStages = (habit) => (habit && habit.gapDays >= 2 ? 4 : 3);

// 新しい語の窓。fresh は易しい順に並んだ未出の単語。
//   返り値: { items: [{ w, wt }], frontier, easy: [易しい側の未出語] }
export function frontierWindow(fresh, L) {
  const items = [];
  const easy = [];
  let started = false;
  let sumU = 0;
  let wSum = 0;
  let dSum = 0;
  for (const w of fresh) {
    const u = 1 - pKnown(L, w);
    if (!started && u < WINDOW_START_U) {
      if (easy.length < 12 && u < 1 - EASY_PK) easy.push(w);
      continue;
    }
    started = true;
    const wt = u * Math.exp(-sumU / WINDOW_TAU);
    items.push({ w, wt });
    wSum += wt;
    dSum += wt * w.d;
    sumU += u;
    if (sumU >= WINDOW_SUM || items.length >= WINDOW_MAX) break;
  }
  const frontier = wSum > 0 ? dSum / wSum : fresh.length ? fresh[fresh.length - 1].d : 1;
  return { items, frontier, easy };
}

function collect(ctx, lang) {
  const { index, recs, hidden, now, card, recent, queued, sessionCount, L } = ctx;
  const blocked = new Set(recent.slice(-RECENT_LIMIT));
  for (const id of queued) blocked.add(id);
  const ok = (w) => !hidden[w.id] && !blocked.has(w.id) && (sessionCount[w.id] || 0) < SESSION_CAP;

  const g = {
    box: [], boxDue: [], review: [], check: [], ahead: [],
    freshWords: [], freshPhrases: [], loose: [],
    boxCount: 0, stretchInBox: 0, heads: new Map(), upcoming: 0,
    remPhrases: 0, totalPhrases: 0, unseenWords: 0, totalWords: 0,
  };
  const scan = (w) => {
    const rec = recs[w.id];
    const unseen = !rec || rec.def;
    if (!hidden[w.id] && rec && rec.box != null) {
      g.boxCount++;
      if (rec.stretch) g.stretchInBox++;
      if (w.head) g.heads.set(w.head, (g.heads.get(w.head) || 0) + 1);
    }
    if (!hidden[w.id] && rec && !unseen && rec.box == null && !settled(rec) && rec.st !== ST.WATCH && rec.due != null && rec.due < now + DAY) g.upcoming++;
    if (!hidden[w.id]) {
      if (w.kind === 'phrase') {
        g.totalPhrases++;
        if (unseen) g.remPhrases++;
      } else {
        g.totalWords++;
        if (unseen) g.unseenWords++;
      }
    }
    if (!ok(w)) return;
    g.loose.push(w);
    if (unseen) {
      if (w.kind === 'word') g.freshWords.push(w);
      else g.freshPhrases.push(w);
      return;
    }
    if (rec.box != null) {
      g.box.push(w);
      if (card >= rec.dueCard || (rec.due != null && now >= rec.due)) g.boxDue.push(w);
      return;
    }
    if (settled(rec)) {
      if (now - rec.last >= CHECK_MIN_GAP) g.check.push(w);
      return;
    }
    if (rec.park) {
      if (now >= rec.due || (ctx.frontierOf(frontierKey(w)) ?? 0) >= rec.park.at) g.review.push(w);
      return;
    }
    if (isDue(rec, now, card)) g.review.push(w);
    // 暗記ボタンを押した語は、決めた日の確認まで前倒しで出さない
    else if (card - (rec.lastCard ?? -Infinity) >= AHEAD_MIN_CARDS && rec.st !== ST.WATCH && !rec.mkc) g.ahead.push(w);
  };
  for (const w of index.ordered(lang)) scan(w);
  for (const w of index.phrases(lang)) scan(w);

  // 紛らわしい語(綴りが近い・発音が同じ)を、覚えかけの語の直後に新出にしない
  const nearIds = new Set(blocked);
  for (const w of g.box) nearIds.add(w.id);
  g.freshWords = g.freshWords.filter((w) => {
    const conf = index.confusables(w.id);
    if (!conf) return true;
    for (const id of conf) {
      const r = recs[id];
      if (nearIds.has(id) || (r && r.firstCard != null && card - r.firstCard < CONFUSE_GAP)) return false;
    }
    return true;
  });
  // 同じ動詞で始まる句動詞は、学習枠に同時に2つまで
  g.freshPhrases = g.freshPhrases.filter((p) => !p.head || (g.heads.get(p.head) || 0) < 2);

  // 単語と熟語は別々の道。どちらも同じ前線方式で、窓・易しい語の確認・背伸びを作る
  const win = frontierWindow(g.freshWords, L);
  g.window = win.items;
  g.frontier = win.frontier;
  g.easy = win.easy;
  g.stretch = g.freshWords.filter((w) => !recs[w.id] && w.d >= win.frontier + 0.1 && w.d <= win.frontier + 0.4);
  g.remWordsAhead = g.freshWords.filter((w) => w.d >= win.frontier - 0.05).length;

  const pwin = frontierWindow(g.freshPhrases, L);
  g.pWindow = pwin.items;
  g.pFrontier = pwin.frontier;
  g.pEasy = pwin.easy;
  g.pStretch = g.freshPhrases.filter((p) => !recs[p.id] && p.d >= pwin.frontier + 0.1 && p.d <= pwin.frontier + 0.4);
  g.remPhrasesAhead = g.freshPhrases.filter((p) => p.d >= pwin.frontier - 0.05).length;
  return g;
}

// 前線の記録の鍵。単語は言語名、熟語は「言語名:p」
export const frontierKey = (w) => (w.kind === 'phrase' ? `${w.lang}:p` : w.lang);

function pickReview(list, ctx) {
  const { recs, saved, now, card } = ctx;
  return sample(
    list,
    (w) => {
      const rec = recs[w.id];
      const d = w.d ?? 0.5;
      // 暗記ボタンを押した語の最初の確認は少し優先する
      return (1 + overdue(rec, now, card)) * (1 + 0.5 * (1 - d)) * (saved[w.id] ? 1.4 : 1) * (1 + 0.2 * (rec.lapse || 0)) * (rec.mkc ? 1.5 : 1);
    },
    ctx.rng
  );
}

function pickBoxDue(list, ctx) {
  const { recs, card } = ctx;
  return sample(list, (w) => 1 + Math.max(0, card - (recs[w.id].dueCard ?? card)) / 5, ctx.rng);
}

function pickCheck(list, ctx) {
  const { recs, saved, now, card } = ctx;
  return sample(
    list,
    (w) => {
      const rec = recs[w.id];
      const lost = 1 - retrievability(rec, now);
      return Math.pow(lost, 1.5) * (isDue(rec, now, card) ? 3 : 1) * (saved[w.id] ? 1.5 : 1) + 1e-4;
    },
    ctx.rng
  );
}

function pickAhead(list, ctx) {
  const { recs, now, card } = ctx;
  return sample(
    list,
    (w) => {
      const rec = recs[w.id];
      if (rec.box != null) return 0.5 * Math.min(2, (card - rec.lastCard) / BOX_GAPS[rec.box - 1]);
      return Math.pow(1 - retrievability(rec, now), 2) + 1e-3;
    },
    ctx.rng
  );
}

// 熟語の割合: 前線より先に残っている熟語と単語の比。
// 進み具合(出した割合)が単語より遅れていれば増やし、進んでいれば減らす。単語と熟語がほぼ同時に終わる
function phraseShare(g, flow) {
  if (!g.remPhrasesAhead && !g.pWindow.length) return 0;
  if (!g.remWordsAhead && !g.window.length) return 1;
  const base = g.remPhrasesAhead / Math.max(1, g.remPhrasesAhead + g.remWordsAhead);
  const lag = (1 - g.unseenWords / Math.max(1, g.totalWords)) - (1 - g.remPhrases / Math.max(1, g.totalPhrases));
  const share = Math.min(0.5, Math.max(0.15, base + lag));
  return flow?.bored ? Math.min(0.5, share + 0.1) : share;
}

// 単語か熟語のどちらから出すか。片方が空ならもう片方
function pickSide(words, phrases, share, rng) {
  if (!words.length) return phrases.length ? phrases : null;
  if (!phrases.length) return words;
  return rng() < share ? phrases : words;
}

function pickFresh(g, ctx) {
  const list = pickSide(g.window, g.pWindow, g.share, ctx.rng);
  if (!list) return null;
  return { word: sample(list, (x) => x.wt, ctx.rng).w, why: 'new' };
}

function pickFromLang(ctx, lang) {
  const { rng } = ctx;
  const g = collect(ctx, lang);
  ctx.frontiers[lang] = g.frontier;
  ctx.frontiers[`${lang}:p`] = g.pFrontier;
  const L = ctx.L;
  const habit = ctx.habit || {};
  const flow = ctx.flow || {};
  g.share = phraseShare(g, flow);

  // ① 学習枠の出番
  if (g.boxDue.length) {
    const late = g.boxDue.filter((w) => ctx.card - (ctx.recs[w.id].dueCard ?? ctx.card) >= FORCE_OVERDUE);
    if (late.length) return { word: pickBoxDue(late, ctx), why: 'box' };
  }

  // 久しぶりに来たときの準備運動
  if (habit.warmup) {
    const pool = [...g.review, ...g.boxDue, ...g.check];
    if (pool.length) return { word: pickReview(pool, ctx), why: 'warmup' };
  }

  if (g.boxDue.length && rng() < RATE.box) return { word: pickBoxDue(g.boxDue, ctx), why: 'box' };

  // ② 割合で選ぶ
  let pReview = g.review.length ? Math.min(RATE.reviewMax, RATE.reviewBase + RATE.reviewPer * g.review.length) : 0;
  let pCheck = 0;
  if (g.check.length) {
    const avg = g.check.reduce((a, w) => a + (1 - retrievability(ctx.recs[w.id], ctx.now)), 0) / g.check.length;
    pCheck = RATE.checkMin + (RATE.checkMax - RATE.checkMin) * Math.min(1, avg * 2);
  }
  const pEasy = g.easy.length || g.pEasy.length ? RATE.easy : 0;
  let pStretch = g.stretch.length || g.pStretch.length ? RATE.stretch : 0;

  // 飽きているときは復習を減らし、新しい語・背伸びへ回す
  let freed = 0;
  if (flow.bored && pReview > 0) {
    freed = pReview / 2;
    pReview -= freed;
    if (pStretch) pStretch *= 1.5;
  }

  const rest = Math.max(0, 1 - pReview - pCheck - pEasy - pStretch);
  // 学習枠が満杯のとき: 枠の中にもうすぐ出番の語があれば待つ。
  // 待っても当分出番がない(段の間隔が長い)なら、3語まで枠をはみ出して新しい語を出す。
  // どちらの場合も、知っている見込みが高い語(枠を使わずに通過できる語)は出してよい
  if (g.boxCount >= L.box) {
    const soon = g.box.some((w) => {
      const r = ctx.recs[w.id];
      return (ctx.card - r.lastCard) / BOX_GAPS[r.box - 1] >= 0.6;
    });
    if (g.boxCount >= L.box + 3) {
      g.window = [];
      g.pWindow = [];
    } else if (soon) {
      g.window = g.window.filter((x) => pKnown(L, x.w) >= 0.6);
      g.pWindow = g.pWindow.filter((x) => pKnown(L, x.w) >= 0.6);
    }
  }
  const canFresh = g.window.length || g.pWindow.length;
  let throttle = 1;
  // ③ 復習が溜まっているときは新しい語を絞る(ふだんの1日の枚数に合わせる)
  const t1 = habit.dailyAvg ? Math.max(15, habit.dailyAvg * 0.4) : 30;
  const t2 = habit.dailyAvg ? Math.max(30, habit.dailyAvg * 0.8) : 60;
  if (g.upcoming > t2) throttle = 0;
  else if (g.upcoming > t1) throttle *= 0.5;
  // 利用の終わりぎわは新しい語を減らし、覚えかけを仕上げる
  if (habit.sessionMedian && habit.sessionMedian > 40 && habit.sessionCards > habit.sessionMedian - 25) throttle *= 0.5;
  // 手応えの波: 成功率が低ければ新しい語を減らし、高ければ増やす
  if (flow.rate != null) {
    if (flow.rate < 0.8) throttle *= 0.7;
    else if (flow.rate > 0.85) throttle *= 1.2;
  }
  const pFresh = canFresh ? Math.min(rest, rest * throttle + (flow.bored ? freed : 0)) : 0;
  // 新しい語に使わなかった分は、まず期限の来た復習へ、なければ前倒しへ
  let leftover = Math.max(0, rest - pFresh);
  if (g.review.length && leftover > 0) {
    pReview += leftover;
    leftover = 0;
  }
  const pAhead = g.ahead.length || g.box.length ? leftover : 0;

  const options = [
    ['review', pReview],
    ['check', pCheck],
    ['easy', pEasy],
    ['stretch', pStretch],
    ['new', pFresh],
    ['ahead', pAhead],
  ].filter(([, p]) => p > 0);
  if (!options.length) return null;
  let kind = sample(options, ([, p]) => p, rng)[0];

  // 手応えの波: 失敗の直後は、知らない可能性が高い語を続けない
  if ((kind === 'new' || kind === 'stretch') && flow.lastFail) {
    const swap = [['review', g.review], ['easy', [...g.easy, ...g.pEasy]], ['check', g.check], ['ahead', [...g.ahead]]].find(([, l]) => l.length);
    if (swap) kind = swap[0];
  }

  switch (kind) {
    case 'review': return { word: pickReview(g.review, ctx), why: 'review' };
    case 'check': return { word: pickCheck(g.check, ctx), why: 'check' };
    case 'easy': {
      // 易しい順に先頭の数語から
      const list = pickSide(g.easy, g.pEasy, g.share, rng);
      return { word: list[Math.floor(rng() * Math.min(4, list.length))], why: 'easy' };
    }
    case 'stretch': {
      const list = pickSide(g.stretch, g.pStretch, g.share, rng);
      return { word: list[Math.floor(rng() * list.length)], why: 'stretch' };
    }
    case 'new': {
      const picked = pickFresh(g, ctx);
      if (picked) return picked;
      break;
    }
    case 'ahead': {
      const pool = g.ahead.length ? g.ahead : g.box;
      return { word: pickAhead(pool, ctx), why: 'ahead' };
    }
    default:
  }
  return null;
}

function fallback(ctx, lang) {
  const g = collect(ctx, lang);
  if (!g.loose.length) return null;
  const word = sample(
    g.loose,
    (w) => {
      const rec = ctx.recs[w.id];
      return rec && !rec.def ? 1 - retrievability(rec, ctx.now) + 0.02 : 1;
    },
    ctx.rng
  );
  return { word, why: 'fallback' };
}

// ctx: { index, recs, saved, hidden, learners, now, card, recent, queued, sessionCount, scope, habit, flow, rng }
export function pickNext(ctx) {
  const rng = ctx.rng || Math.random;
  const langs = ctx.scope === 'both' ? (rng() < 0.5 ? ['en', 'kb'] : ['kb', 'en']) : [ctx.scope];
  const frontiers = ctx.frontiers || {};
  const base = { ...ctx, rng, frontiers, frontierOf: (l) => frontiers[l] };
  for (const lang of langs) {
    if (!ctx.learners[lang]) continue;
    const picked = pickFromLang({ ...base, L: ctx.learners[lang] }, lang);
    if (picked) return picked;
  }
  for (const lang of langs) {
    if (!ctx.learners[lang]) continue;
    const picked = fallback({ ...base, L: ctx.learners[lang] }, lang);
    if (picked) return picked;
  }
  // 単語が極端に少ない場合の最後の手段
  const any = ctx.index.words.filter((w) => langs.includes(w.lang) && !ctx.hidden[w.id]);
  if (!any.length) return null;
  return { word: any[Math.floor(rng() * any.length)], why: 'fallback' };
}

// 前線の位置(テスト・記録の更新で使う)
export function frontierOf(index, recs, L, lang, kind = 'word') {
  const list = kind === 'phrase' ? index.phrases(lang) : index.ordered(lang);
  const fresh = list.filter((w) => !recs[w.id] || recs[w.id].def);
  return frontierWindow(fresh, L).frontier;
}

// 復習待ちの語数(マイページ表示用)
export function dueCount(words, recs, now, card) {
  let n = 0;
  for (const w of words) {
    const rec = recs[w.id];
    if (rec && !rec.def && !settled(rec) && rec.st !== ST.WATCH && isDue(rec, now, card)) n++;
  }
  return n;
}
