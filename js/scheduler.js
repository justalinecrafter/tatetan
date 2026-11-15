// 次に流す単語を選ぶ。DOM に依存しない。
//
// 前線方式: 単語リスト・熟語リストをそれぞれ易しい順の1本の道とみなし、新しい語は「知っているか怪しくなり始めるところ」から
// 易しい順に出す。覚えかけの語は学習枠(既定8語)に入れ、枠が空くまで次の新しい語は出さない。
// その合間に、日単位の復習・易しい語の確認・背伸びの語・抜き打ち(知ってそう・定着した暗記済み)を混ぜる。
// 即スワイプされた未出の語は、しばらく出さず(hold)、新しい語の窓の中でも選ばれにくくする。
// 復習モード(pickDrill)では、暗記済み・知ってそうの語だけを、定着させるのに効く順に出す。
import { ST, DAY, BOX_GAPS, retrievability, isDue, overdue, pKnown, rare, isNew } from './srs.js';

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

// 単語と熟語の比: 直近 30 枚(この利用の中)のうち熟語がこの幅に収まるようにする。
// 幅を外れそうなら、足りない側から出す。利用の始めは目安の割合を少し混ぜて数える(最初の数枚で偏らないように)
const PHRASE_BAND = [0.15, 0.4];
const PHRASE_AIM = 0.28;
const BALANCE_WINDOW = 30;
const BALANCE_PRIOR = 6;
// 暗記済みの語の確認(復習・前倒し・抜き打ち)は、直近 30 枚のうち 2 割まで。
// 日を空けて開いたときに、暗記済みの確認ばかりにならないように(残りは次の利用へ回る)
const MASTERED_SHARE = 0.2;
const MASTERED_WINDOW = 30;

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

// 新しい語の窓。fresh は易しい順に並んだ未出の単語。何度も即スワイプされた語は選ばれにくくする。
//   返り値: { items: [{ w, wt }], frontier, easy: [易しい側の未出語] }
export function frontierWindow(fresh, L, recs = {}) {
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
    const wt = u * Math.exp(-sumU / WINDOW_TAU) * Math.pow(0.5, recs[w.id]?.skip || 0);
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
    boxCount: 0, stretchInBox: 0, heads: new Map(), upcoming: 0, upcomingMastered: 0,
    remPhrases: 0, totalPhrases: 0, unseenWords: 0, totalWords: 0,
  };
  const scan = (w) => {
    if (ctx.only && !ctx.only.has(w.id)) return; // 範囲を決めて出題しているときは、範囲の語だけ
    const rec = recs[w.id];
    const unseen = isNew(rec);
    if (!hidden[w.id] && rec && rec.box != null) {
      g.boxCount++;
      if (rec.stretch) g.stretchInBox++;
      if (w.head) g.heads.set(w.head, (g.heads.get(w.head) || 0) + 1);
    }
    if (!hidden[w.id] && !unseen && rec.box == null && !rare(rec) && rec.due != null && rec.due < now + DAY) {
      if (rec.st === ST.MASTERED) g.upcomingMastered++;
      else g.upcoming++;
    }
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
      if (rec?.hold > card) return; // 即スワイプした・判断を保留した語は、しばらく出さない
      if (w.kind === 'word') g.freshWords.push(w);
      else g.freshPhrases.push(w);
      return;
    }
    if (rec.box != null) {
      g.box.push(w);
      if (card >= rec.dueCard || (rec.due != null && now >= rec.due)) g.boxDue.push(w);
      return;
    }
    if (rare(rec)) {
      if (now - rec.last >= CHECK_MIN_GAP) g.check.push(w);
      return;
    }
    if (rec.park) {
      if (now >= rec.due || (ctx.frontierOf(frontierKey(w)) ?? 0) >= rec.park.at) g.review.push(w);
      return;
    }
    if (isDue(rec, now, card)) g.review.push(w);
    // 暗記ボタンを押した語・知ってそうと推定した語は、決めた日の確認まで前倒しで出さない
    else if (card - (rec.lastCard ?? -Infinity) >= AHEAD_MIN_CARDS && !rec.mkc && !rec.lkc) g.ahead.push(w);
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
  const win = frontierWindow(g.freshWords, L, recs);
  g.window = win.items;
  g.frontier = win.frontier;
  g.easy = win.easy;
  const untouched = (w) => !recs[w.id];
  g.stretch = g.freshWords.filter((w) => untouched(w) && w.d >= win.frontier + 0.1 && w.d <= win.frontier + 0.4);
  g.remWordsAhead = g.freshWords.filter((w) => w.d >= win.frontier - 0.05).length;

  const pwin = frontierWindow(g.freshPhrases, L, recs);
  g.pWindow = pwin.items;
  g.pFrontier = pwin.frontier;
  g.pEasy = pwin.easy;
  g.pStretch = g.freshPhrases.filter((p) => untouched(p) && p.d >= pwin.frontier + 0.1 && p.d <= pwin.frontier + 0.4);
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
      // 暗記ボタンを押した語・知ってそうと推定した語の最初の確認は少し優先する
      return (1 + overdue(rec, now, card)) * (1 + 0.5 * (1 - d)) * (saved[w.id] ? 1.4 : 1) * (1 + 0.2 * (rec.lapse || 0)) * (rec.mkc || rec.lkc ? 1.5 : 1) * (rec.st === ST.MASTERED ? 0.6 : 1);
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

// 直近の語(この利用で見た語と、もう並べてある語)
const recentIds = (ctx, n) => [...ctx.recent, ...ctx.queued].slice(-n);

// 暗記済みの語の確認が、直近の枠を使い切っているか(10 枚に満たないうちは 10 枚として数える)。
// 見た語は「見たときにもとから暗記済みだったか」、並べてある語はいまの状態で数える
function masteredFull(ctx) {
  const queued = ctx.queued.slice(-MASTERED_WINDOW);
  const seen = Math.max(0, MASTERED_WINDOW - queued.length);
  const flags = seen ? (ctx.checked || []).slice(-seen) : [];
  let m = flags.filter(Boolean).length;
  for (const id of queued) if (ctx.recs[id]?.st === ST.MASTERED) m++;
  const n = flags.length + queued.length;
  return m + 1 > MASTERED_SHARE * Math.max(n + 1, 10);
}

function dropMastered(g, recs) {
  const keep = (w) => recs[w.id]?.st !== ST.MASTERED;
  g.review = g.review.filter(keep);
  g.ahead = g.ahead.filter(keep);
  g.check = g.check.filter(keep);
}

// 単語と熟語の比が幅を外れそうなら、足りない側('word' / 'phrase')を返す
function balanceSide(ctx, lang, g) {
  if (!g.totalPhrases || !g.totalWords) return null;
  const ids = recentIds(ctx, 80).filter((id) => id.startsWith(`${lang}:`)).slice(-BALANCE_WINDOW);
  let p = 0;
  for (const id of ids) if (id.startsWith(`${lang}:p:`)) p++;
  const share = (p + PHRASE_AIM * BALANCE_PRIOR) / (ids.length + BALANCE_PRIOR);
  if (share < PHRASE_BAND[0]) return 'phrase';
  if (share > PHRASE_BAND[1]) return 'word';
  return null;
}

// 単語だけ・熟語だけに絞った候補
function restrict(g, side) {
  const phrase = side === 'phrase';
  const keep = (w) => (w.kind === 'phrase') === phrase;
  return {
    ...g,
    box: g.box.filter(keep),
    boxDue: g.boxDue.filter(keep),
    review: g.review.filter(keep),
    check: g.check.filter(keep),
    ahead: g.ahead.filter(keep),
    window: phrase ? [] : g.window,
    pWindow: phrase ? g.pWindow : [],
    easy: phrase ? [] : g.easy,
    pEasy: phrase ? g.pEasy : [],
    stretch: phrase ? [] : g.stretch,
    pStretch: phrase ? g.pStretch : [],
    share: phrase ? 1 : 0,
  };
}

function pickFromLang(ctx, lang) {
  const g = collect(ctx, lang);
  ctx.frontiers[lang] = g.frontier;
  ctx.frontiers[`${lang}:p`] = g.pFrontier;
  g.share = phraseShare(g, ctx.flow || {});
  // 暗記済みの語の確認が枠を使い切っていたら、この1枚では出さない。
  // そのとき暗記済みの語は復習の溜まり具合にも数えない(出せない語のために新しい語を止めない)
  if (masteredFull(ctx)) dropMastered(g, ctx.recs);
  else g.upcoming += g.upcomingMastered;
  // 単語と熟語の比を保つ。足りない側に出せる語がなければ、ふだんどおり選ぶ
  const side = balanceSide(ctx, lang, g);
  if (side) {
    const picked = choose(ctx, restrict(g, side), true);
    if (picked) return picked;
  }
  return choose(ctx, g, false);
}

// 集めた候補から 1 枚選ぶ。forced: 単語と熟語の比を保つために片側に絞っているとき
function choose(ctx, g, forced) {
  const { rng } = ctx;
  const L = ctx.L;
  const habit = ctx.habit || {};
  const flow = ctx.flow || {};

  // ① 学習枠の出番
  if (g.boxDue.length) {
    const late = g.boxDue.filter((w) => ctx.card - (ctx.recs[w.id].dueCard ?? ctx.card) >= FORCE_OVERDUE);
    if (late.length) return { word: pickBoxDue(late, ctx), why: 'box' };
  }

  // 久しぶりに来たときの準備運動
  if (habit.warmup) {
    const pool = [...g.review, ...g.boxDue];
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
  if (forced) throttle = Math.max(throttle, 1);
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

// 範囲を決めて出題するとき。範囲の中だけで、学習枠 → 期限の来た復習 → 新しい語(易しい順) → 前倒しの順に回す。
// 範囲の語を覚えきるのが目的なので、θ による窓・易しい語の確認・背伸びは使わない。
// 知ってそう・定着した暗記済みの語(抜き打ちだけの語)は、ほかに出す語がないときだけ
function pickRange(ctx, lang) {
  const { rng, recs, card } = ctx;
  const g = collect(ctx, lang);
  if (g.boxDue.length) {
    const late = g.boxDue.filter((w) => card - (recs[w.id].dueCard ?? card) >= FORCE_OVERDUE);
    if (late.length) return { word: pickBoxDue(late, ctx), why: 'box' };
    if (rng() < RATE.box) return { word: pickBoxDue(g.boxDue, ctx), why: 'box' };
  }
  if (g.review.length && rng() < Math.min(0.6, 0.2 + 0.05 * g.review.length)) return { word: pickReview(g.review, ctx), why: 'review' };
  const fresh = [...g.freshWords, ...g.freshPhrases].sort((a, b) => a.d - b.d);
  const pickNew = () => ({ word: fresh[Math.floor(rng() * Math.min(3, fresh.length))], why: 'new' });
  if (fresh.length && g.boxCount < ctx.L.box + 2) return pickNew();
  if (g.boxDue.length) return { word: pickBoxDue(g.boxDue, ctx), why: 'box' };
  if (g.review.length) return { word: pickReview(g.review, ctx), why: 'review' };
  if (g.ahead.length || g.box.length) return { word: pickAhead(g.ahead.length ? g.ahead : g.box, ctx), why: 'ahead' };
  if (fresh.length) return pickNew();
  if (g.check.length) return { word: pickCheck(g.check, ctx), why: 'check' };
  return null;
}

/* ---------- 復習モード ----------
  暗記済み・知ってそうの語(ふだんはほとんど出ない語)だけを出す。ランダムではなく、いま復習すると定着に効く語から:
    忘れかけている(思い出せる見込み R が低い) … 復習の効果がいちばん大きい。忘れていたら学習中へ戻して拾い直せる
    難しい(レベルより上の語・記録上の難しさが高い) … 安定度が育ちにくく、忘れやすい
    安定度がまだ低い・前に忘れたことがある … 定着しきっていない
    推定だけで知ってそうにした語・答えを見てから暗記を押した語 … 本人が確かめきっていない
  12 時間以内に見た語は、思い出せて当然で効果が薄いので後回し(1 時間以内に見た語は出さない)。1 回の利用で同じ語は 1 度だけ。
  思い出せなかった・迷った語は、6 枚ほど空けてもう一度出す(1 語につき 3 回まで。思い出せたら終わり) */
const DRILL_AGAIN_GAP = 6;
export const DRILL_AGAIN_MAX = 3;
const DRILL_TOP = 5; // 点数の高い順にこの数の中から選ぶ(毎回同じ並びにならないように)
const DRILL_FRESH = 3600000; // さっき見た語(出し終えたあとのふだんの出題で知ってそうになった語など)は復習に回さない

export const drillable = (rec) => !!rec && (rec.st === ST.MASTERED || rec.st === ST.LIKELY);

// 復習モードでの優先度(大きいほど先に出す)
export function drillScore(rec, w, L, now, saved = false) {
  const risk = 1 - retrievability(rec, now);
  const hard = 0.5 * (1 - (L ? pKnown(L, w) : 0.5)) + 0.5 * Math.min(1, Math.max(0, ((rec.d ?? 5) - 1) / 9));
  const weak = 1 / (1 + (rec.s || 0) / 15);
  const lapses = Math.min(rec.lapse || 0, 3) / 3;
  const unsure = rec.st === ST.LIKELY ? 1 : rec.mk === 2 ? 0 : 0.5;
  let score = 0.1 + 1.5 * risk + 0.8 * hard + 0.4 * weak + 0.4 * lapses + 0.25 * unsure;
  if (saved) score *= 1.3;
  if (now - (rec.last ?? 0) < DAY / 2) score *= 0.15;
  else if ((rec.mkc || rec.lkc) && rec.due > now) score *= 0.6; // 最初の確かめがもうすぐふだんの出題で来る
  return score;
}

// 復習モードで出せる語(暗記済み・知ってそう)の数
export function drillCount(words, recs, hidden = {}) {
  let n = 0;
  for (const w of words) if (!hidden[w.id] && drillable(recs[w.id])) n++;
  return n;
}

// ctx.drill: { drilled: { id: 1 }(この利用で出した語), missed: { id: { at: 枚数, n: 回数 } }(思い出せなかった語) }
function pickDrill(ctx, langs) {
  const { index, recs, hidden, saved, learners, now, card, rng, drill } = ctx;
  const blocked = new Set([...ctx.recent.slice(-RECENT_LIMIT), ...ctx.queued]);
  const inScope = (w) => w && langs.includes(w.lang) && !hidden[w.id] && !blocked.has(w.id);
  // この利用で思い出せなかった語を、間を空けてもう一度(古いものから)
  const again = Object.entries(drill.missed)
    .filter(([id, m]) => card - m.at >= DRILL_AGAIN_GAP && inScope(index.byId.get(id)))
    .sort((a, b) => a[1].at - b[1].at);
  if (again.length) return { word: index.byId.get(again[0][0]), why: 'drill-again' };
  const cands = [];
  for (const w of index.words) {
    const rec = recs[w.id];
    if (!drillable(rec) || drill.drilled[w.id] || !inScope(w) || now - (rec.last ?? 0) < DRILL_FRESH) continue;
    cands.push({ w, score: drillScore(rec, w, learners[w.lang], now, !!saved[w.id]) });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, DRILL_TOP);
  return { word: sample(top, (x) => x.score * x.score, rng).w, why: 'drill' };
}

function fallback(ctx, lang) {
  const g = collect(ctx, lang);
  if (!g.loose.length) return null;
  const word = sample(
    g.loose,
    (w) => {
      const rec = ctx.recs[w.id];
      return isNew(rec) ? 1 : 1 - retrievability(rec, ctx.now) + 0.02;
    },
    ctx.rng
  );
  return { word, why: 'fallback' };
}

// ctx: { index, recs, saved, hidden, learners, now, card, recent, checked, queued, sessionCount, scope, range, drill, habit, flow, rng }
// range: { lang, ids: Set } のとき、その範囲の語だけを出す
// drill: 復習モードのとき、この利用での記録(pickDrill)。出せる語がなくなったら、ふだんどおり選んで drillDone を付ける
export function pickNext(ctx) {
  const rng = ctx.rng || Math.random;
  const frontiers = ctx.frontiers || {};
  if (ctx.drill) {
    const langs = ctx.scope === 'both' ? ['en', 'kb'] : [ctx.scope];
    const picked = pickDrill({ ...ctx, rng }, langs);
    if (picked) return picked;
    const rest = pickNext({ ...ctx, drill: null });
    return rest && { ...rest, drillDone: true };
  }
  if (ctx.range) {
    const { lang, ids } = ctx.range;
    const base = { ...ctx, rng, frontiers, frontierOf: (l) => frontiers[l], only: ids, L: ctx.learners[lang] };
    const picked = pickRange(base, lang) || fallback(base, lang);
    if (picked) return picked;
    const any = [...ids].map((id) => ctx.index.byId.get(id)).filter((w) => w && !ctx.hidden[w.id]);
    return any.length ? { word: any[Math.floor(rng() * any.length)], why: 'fallback' } : null;
  }
  const langs = ctx.scope === 'both' ? (rng() < 0.5 ? ['en', 'kb'] : ['kb', 'en']) : [ctx.scope];
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
  const fresh = list.filter((w) => isNew(recs[w.id]));
  return frontierWindow(fresh, L, recs).frontier;
}

// 復習待ちの語数(マイページ表示用)
export function dueCount(words, recs, now, card) {
  let n = 0;
  for (const w of words) {
    const rec = recs[w.id];
    if (!isNew(rec) && !rare(rec) && isDue(rec, now, card)) n++;
  }
  return n;
}
