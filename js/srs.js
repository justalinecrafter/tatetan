// 記憶モデル。DOM に依存しない純粋関数だけを置く(シミュレーションから Node で直接検証できる)。
//
// 忘却は FSRS 系のべき乗曲線で表す。
//   R(t) = (1 + F * t / S) ^ C    S: 安定度(R が 0.9 に落ちるまでの日数)
// 利用者は正誤を入力しないので、滞在時間や答えの表示などの行動から
// 「思い出せたか(grade)」と「その推定の確からしさ(conf)」を見積もり、conf の分だけ安定度を更新する。
//
// 状態は 4 つ。
//   未出     まだ出ていない語。即スワイプしただけの語も、ほとんど目に入っていないとみなして未出のまま
//   学習中   覚えている途中。覚えかけは「学習枠」で枚数刻み(約4 → 10 → 25枚)に確かめ、卒業後は日単位で復習する
//   知ってそう 行動から定着度が高いと推定した語。抜き打ちでたまに出すだけ
//   暗記済み  利用者が暗記ボタンを押した語だけ。押した数日後に一度確かめ、そのあとは抜き打ちだけ
// 実力 θ はリスト上の位置(0〜1)で表し、「知っている確率」は θ を中心としたなだらかな坂で持つ。
// 単語と熟語はリストが別なので、θ と坂の幅もそれぞれに持つ。

export const DAY = 86400000;
const HOUR = 3600000;
const F = 19 / 81;
const C = -0.5;

export const ST = { NEW: 'new', LEARNING: 'learning', LIKELY: 'likely', MASTERED: 'mastered' };
export const ST_LABEL = { new: '未出', learning: '学習中', likely: '知ってそう', mastered: '暗記済み' };
export const SHOWN_STATES = [ST.NEW, ST.LEARNING, ST.LIKELY, ST.MASTERED];
export const shownState = (rec) => rec?.st || ST.NEW;
export const isNew = (rec) => !rec || rec.st === ST.NEW;

export const G = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

// 次回出題までに許す記憶保持率。知ってそう・定着した暗記済みは下がるまで待つので、めったに出ない。
const TARGET_R = { learning: 0.9, mastered: 0.88, rare: 0.75 };
export const BOX_GAPS = [4, 10, 25, 40]; // 学習枠の段ごとの間隔(枚)。4段目は間を空けて使う人だけ
export const LIKELY_S = 21; // 学習中の語がこの安定度に育ち、別の日に何度も思い出せたら「知ってそう」
const LIKELY_DAYS = 3;
const MARK_S = { 2: 10, 1: 21 }; // 暗記ボタンを押した語が定着とみなされる安定度(答えを見る前に押した: 2 / 見てから: 1)
const MARK_CHECK = { 2: [2, 4], 1: [1, 3] }; // 暗記ボタンを押した語の最初の確認(日)。押した日のうちは出さない
export const FAR_PK = 0.97; // 即スワイプを「知っていた」とみなすのは、知っている確率がこれ以上の語(レベルより大幅に易しい語)だけ
const SKIP_HOLD = [30, 80, 200]; // 未出のまま即スワイプされた語を、次に出せるまでの枚数
const PARK_FAILS = 4; // 学習枠で何回失敗したら後回しにするか
const MAX_S = 1500;
const MIN_S = 0.005;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const jitter = (n, rng) => Math.max(2, Math.round(n * (0.8 + 0.4 * rng())));

export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function retrievability(rec, now) {
  if (!rec || !rec.s) return 0;
  const t = Math.max(0, now - rec.last) / DAY;
  return Math.pow(1 + (F * t) / rec.s, C);
}

export function intervalDays(s, targetR) {
  return (s / F) * (Math.pow(targetR, 1 / C) - 1);
}

/* ---------- 学習者のモデル(言語ごと) ---------- */

// lr: θ を動かす速さ(最初の値)。テストのない古典は自己申告だけで始めるので、速めに動かして合わせる
export const newTrack = (theta, { w = 0.08, lr = 0.06 } = {}) => ({
  theta, // 坂の中心。知っている確率が 50% になる位置
  w, // 坂の幅
  lr,
  n: 0, // θ を更新した回数
  cal: { z: 1 }, // 坂から遠い語での予測の外れ(見込みどおりなら 1)
});

export function newLearner(theta = 0.1, opts) {
  return {
    ...newTrack(theta, opts), // 単語リストの θ・坂
    p: newTrack(theta, opts), // 熟語リストの θ・坂。最初は単語と同じ位置から始め、行動で合わせていく
    sure: false, // θ があてになるか(テストを受けた・自己申告した・十分に使った)
    box: 8, // 学習枠の大きさ
    boxLog: [], // 学習枠の復習の成否(直近30回)
    ivl: 1, // 復習の間隔の倍率
  };
}

// 語の種類に応じた θ・坂(単語は学習者そのもの、熟語は L.p)
export const trackOf = (L, word) => (word.kind === 'phrase' ? L.p : L);
export const thetaOf = (L, word) => trackOf(L, word).theta;

// 学習者が語を(アプリで覚える前から)知っている確率
export function pKnown(L, word) {
  const T = trackOf(L, word);
  return 1 / (1 + Math.exp(-(T.theta - word.d) / T.w));
}

// 即スワイプを「知っていた」とみなしてよい語か(レベルより大幅に易しく、θ があてになるとき)
export const farEasy = (L, word) => (L.sure || L.n >= 30) && pKnown(L, word) >= FAR_PK;

// 初めて見た語への反応で θ・坂の幅を更新する。y: 知っていた度合い(0〜1)
export function updateLearner(L, word, y, weight) {
  if (!weight) return;
  const T = trackOf(L, word);
  const p = pKnown(L, word);
  const lr = Math.max(0.012, (T.lr || 0.06) / (1 + T.n / 25));
  T.theta = clamp(T.theta + lr * weight * (y - p), -0.05, 1.05);
  T.n++;
  // 坂から遠い語で外れが見込みより多いなら坂をなだらかに、少ないなら急にする。
  // 外れの大きさは1回ごとに上限を設ける(知っている語でのうっかりミス1回で坂が崩れないように)
  if (Math.abs(T.theta - word.d) / T.w > 1.5) {
    const z2 = Math.min(6, ((y - p) * (y - p)) / Math.max(0.01, p * (1 - p)));
    T.cal.z = 0.95 * (T.cal.z ?? 1) + 0.05 * z2;
    if (T.cal.z > 1.4) T.w = Math.min(0.15, T.w * 1.01);
    else if (T.cal.z < 0.7) T.w = Math.max(0.05, T.w * 0.99);
  }
}

// 学習枠の復習の成否から、枠の大きさを調整する
export function logBox(L, success) {
  L.boxLog.push(success ? 1 : 0);
  if (L.boxLog.length > 30) L.boxLog.shift();
  if (L.boxLog.length < 15) return;
  const rate = L.boxLog.reduce((a, b) => a + b, 0) / L.boxLog.length;
  if (rate >= 0.85 && L.box < 12) {
    L.box++;
    L.boxLog = L.boxLog.slice(-10);
  } else if (rate < 0.6 && L.box > 5) {
    L.box--;
    L.boxLog = L.boxLog.slice(-10);
  }
}

// 日単位の復習の成否で、間隔の倍率を調整する(成功率が 86% 前後になるように)
export function logReview(L, success) {
  L.ivl = clamp((L.ivl || 1) * (success ? 1.01 : 0.94), 0.4, 2);
}

/* ---------- 行動の読み取り ---------- */

// 個人の「読む速さ」を基準にする。遅い人を「考え込んだ」と誤判定しないため。
// quick は「一瞬でスワイプした」とみなす速さ。普段の読む時間の 3 割ほど(読まずに指を動かした速さ)。
// 長い見出し(熟語)は読むのに時間がかかるので、その分だけ基準を延ばす。
export function thresholds(baseline, chars = 8) {
  const list = baseline && baseline.length >= 8 ? [...baseline].sort((a, b) => a - b) : null;
  const median = list ? list[list.length >> 1] : 2.2;
  const extra = Math.max(0, chars - 10);
  return {
    quick: clamp(median * 0.3, 0.4, 0.9) + extra * 0.02,
    think: clamp(median * 1.6, 2.2, 7) + extra * 0.06,
  };
}

export function pushBaseline(baseline, sec) {
  if (sec < 0.3 || sec > 30) return baseline;
  const next = [...baseline, Math.round(sec * 100) / 100];
  return next.length > 60 ? next.slice(-60) : next;
}

// 暗記済みのうち、押したあと別の日にも思い出せて、安定度が育った語(定着)。抜き打ちでたまに出すだけ
export function settled(rec) {
  if (!rec || rec.st !== ST.MASTERED || rec.mkc) return false;
  return rec.s >= MARK_S[rec.mk || 1] && (rec.okd?.length || 0) >= 2;
}

// たまに抜き打ちで出すだけの語(知ってそう・定着した暗記済み)
export const rare = (rec) => !!rec && ((rec.st === ST.LIKELY && !rec.lkc) || settled(rec));

// 行動 → 記憶の推定。明示的な暗記・苦手は別経路(memorize / dislike)で処理する。
//   imp: { frontMs, backMs, revealed, detail, returned, manual, replay, saved, chars, mcount, exlen }
//   ctx: { baseline, pk, far, stretch, now }
// kind:
//   none  何もしない          skip  見ていない扱い(未出なら少し後に回す・既出なら期限を少し延ばす)
//   hold  判断を保留(未出のまま、少し後にもう一度)   likely  知ってそう   grade  思い出せたか
// 返す y / w は θ の更新に使う(初めて見た語だけ)。
export function classify(imp, rec, ctx) {
  const { quick, think } = thresholds(ctx.baseline, imp.chars);
  const f = imp.frontMs / 1000;
  const b = imp.backMs / 1000;
  const first = isNew(rec);
  // 答えをじっくり読んだか(意味の数・例文の長さで補正)
  const encodeAt = 2.5 + 0.5 * (imp.mcount || 1) + 0.02 * (imp.exlen || 40);
  const encode = b >= encodeAt || !!imp.detail;
  const interest = encode || !!imp.saved;
  const instant = !imp.revealed && f < quick;

  if (imp.manual) return { kind: 'none', why: '単語帳から開いた' };
  if (!imp.revealed && f > 30) return { kind: 'none', why: '放置とみなす' };

  if (imp.returned) {
    if (imp.revealed) return { kind: 'grade', grade: G.AGAIN, conf: 0.6, why: '戻って答えを確認した' };
    if (instant || first) return { kind: 'none', why: '戻ってきて通り過ぎた' };
    return { kind: 'grade', grade: G.HARD, conf: 0.3, why: '戻って見直した' };
  }

  if (first) {
    if (instant) {
      return ctx.far
        ? { kind: 'likely', s: 10 + 20 * clamp((ctx.pk - FAR_PK) / (1 - FAR_PK), 0, 1), why: 'レベルよりずっと易しいので即スワイプした' }
        : {
          kind: 'skip',
          // 語は未出のまま。ただ、知っている語ほど一瞬で飛ばされやすいので、知っていそうな語(50% 以上)なら θ をわずかに上げる。
          // そうしないと、知っている語の証拠だけが抜け落ちて θ が低めに偏る
          y: 1,
          w: ctx.pk >= 0.5 ? 0.15 : 0,
          why: '一瞬でスワイプした(ほとんど見ていない)',
        };
    }
    let ev;
    if (imp.revealed) {
      if (b < 0.9) {
        ev = ctx.pk >= 0.7
          ? { kind: 'likely', s: 2 + 4 * ctx.pk, confirm: true, y: 0.8, w: 0.3, why: '答えを一瞬確認しただけ' }
          : { kind: 'grade', grade: G.HARD, y: 0.4, w: 0.3, why: '答えをちらっと見た' };
      } else if (f >= think) {
        ev = { kind: 'grade', grade: G.AGAIN, y: 0, w: 0.5, encode: true, why: '考えて思い出せなかった' };
      } else {
        ev = { kind: 'grade', grade: G.AGAIN, y: 0, w: 0.5, encode, why: 'すぐ答えを見た' };
      }
      // 背伸びの語は、知らなくても関心がなければ未出に戻す(前線が届いてから普通に出す)
      if (ctx.stretch && ev.kind === 'grade' && !interest) ev = { kind: 'hold', gap: 60, y: ev.y, w: ev.w, why: `${ev.why}(背伸びの語なので後回し)` };
      return ev;
    }
    if (f < think) {
      // 答えを見ずに読み進めた = 知っていた可能性が高い。2回目なら(前にも読んで進んだ)知ってそうにする
      return ctx.pk >= 0.6 || rec?.seen
        ? { kind: 'likely', s: 2 + 6 * ctx.pk, confirm: true, y: 1, w: 0.5, why: '読んで答えを見ずに進んだ' }
        : { kind: 'hold', gap: 20, y: 0.9, w: 0.5, why: '読んだが判断材料が足りない' };
    }
    return { kind: 'hold', gap: 10, why: '長く見たが答えを見なかった' };
  }

  // 2 回目以降
  if (instant) {
    return ctx.far
      ? { kind: 'grade', grade: G.GOOD, conf: 0.3, why: 'レベルよりずっと易しいので即スワイプした' }
      : { kind: 'skip', why: '一瞬でスワイプした(判断しない)' };
  }
  let ev;
  if (imp.revealed) {
    if (b < 0.9 && f < think) ev = { kind: 'grade', grade: G.HARD, conf: 0.5, why: '合っているか確認した' };
    else if (f >= think || encode) ev = { kind: 'grade', grade: G.AGAIN, conf: 0.75, lapse: true, why: '思い出せず答えを読んだ' };
    else ev = { kind: 'grade', grade: G.HARD, conf: 0.55, why: '少し迷って答えを見た' };
  } else if (f < think) {
    const faster = rec.fm && imp.frontMs < rec.fm * 0.7 && rec.s >= 1;
    ev = faster
      ? { kind: 'grade', grade: G.EASY, conf: 0.5, why: '前回より速く思い出せた' }
      : { kind: 'grade', grade: G.GOOD, conf: 0.6, why: '答えを見ずに進んだ' };
  } else {
    ev = { kind: 'grade', grade: G.HARD, conf: 0.45, why: '時間をかけて思い出した' };
  }
  // 音声を聞き直した = まだ少し怪しい
  if (imp.replay && ev.grade >= G.GOOD) ev = { ...ev, grade: G.GOOD, conf: ev.conf * 0.7, why: `${ev.why}(音声を聞き直した)` };
  return ev;
}

/* ---------- 記録の更新 ---------- */

function initialDifficulty(ctx, word) {
  if (word.d == null || ctx.theta == null) return 5;
  return clamp(5 + (word.d - ctx.theta) * 12, 1, 10);
}

function grownS(rec, R, grade) {
  const bonus = grade === G.HARD ? 0.5 : grade === G.EASY ? 2 : 1;
  const gain = Math.exp(1.5) * (11 - rec.d) * Math.pow(rec.s, -0.1) * (Math.exp(1 - R) - 1) * bonus;
  return clamp(rec.s * (1 + gain), rec.s, MAX_S);
}

function lapsedS(rec, R) {
  const next = 1.8 * Math.pow(rec.d, -0.2) * (Math.pow(rec.s + 1, 0.25) - 1) * Math.exp(1 - R);
  return clamp(Math.min(rec.s, next), MIN_S, MAX_S);
}

// conf の分だけ新しい値へ寄せる(掛け算の世界で補間)
const blendS = (from, to, conf) => Math.exp(Math.log(from) * (1 - conf) + Math.log(to) * conf);

function touch(rec, ctx) {
  rec.n = (rec.n || 0) + 1;
  rec.last = ctx.now;
  rec.lastCard = ctx.card;
  if (!rec.first) rec.first = ctx.now;
  if (rec.firstCard == null) rec.firstCard = ctx.card;
  return rec;
}

// 初めて記録を作るとき。未出の語の記録(飛ばした回数など)は引き継ぐ
function start(rec, ctx, word) {
  return { st: ST.NEW, s: MIN_S, d: initialDifficulty(ctx, word), n: 0, ok: 0, lapse: 0, fail: 0, okd: [], box: null, skip: rec?.skip || 0, seen: rec?.seen || 0 };
}

function copy(rec, ctx, word) {
  return isNew(rec) ? start(rec, ctx, word) : { ...rec, okd: [...(rec.okd || [])] };
}

function addOkDay(rec, now) {
  const k = dayKey(now);
  if (!rec.okd.includes(k)) rec.okd = [...rec.okd, k].slice(-4);
}

function enterBox(rec, stage, ctx) {
  const rng = ctx.rng || Math.random;
  rec.st = ST.LEARNING;
  rec.box = stage;
  delete rec.park;
  delete rec.mk;
  delete rec.mkc;
  delete rec.lkc;
  rec.dueCard = ctx.card + jitter(BOX_GAPS[stage - 1], rng);
  rec.due = ctx.now + 4 * HOUR; // 利用が途切れたら、次に来たときに出す
}

// 日単位の次の出番。ivl: その人に合わせた間隔の倍率
function scheduleDays(rec, ctx) {
  rec.box = null;
  rec.dueCard = null;
  const target = rare(rec) ? TARGET_R.rare : TARGET_R[rec.st] || 0.9;
  rec.due = ctx.now + intervalDays(rec.s, target) * (ctx.ivl || 1) * DAY;
}

// 最初の確認を数日後に寄せる(押した日・推定した日のうちには出さない。遠すぎる場合も一度確かめる)
function confirmIn(rec, [lo, hi], ctx) {
  const days = clamp((rec.due - ctx.now) / DAY, lo, hi) * (0.9 + 0.2 * (ctx.rng || Math.random)());
  rec.due = ctx.now + days * DAY;
}

// 学習中の語が十分に定着したら「知ってそう」へ(暗記済みにはしない)
function promote(rec) {
  if (rec.st === ST.LEARNING && rec.box == null && !rec.park && rec.s >= LIKELY_S && rec.okd.length >= LIKELY_DAYS) {
    rec.st = ST.LIKELY;
    return true;
  }
  return false;
}

// classify の結果を単語の記録へ反映する。
//   ctx: { now, card, theta, pk, stages(3 か 4), frontier, ivl, rng }
//   返り値: { rec, fx }  fx は演出の種類('likely': 学習中から知ってそうへ育った | null)
export function apply(rec, ev, word, ctx) {
  if (ev.kind === 'none') return { rec, fx: null };
  const rng = ctx.rng || Math.random;
  const first = isNew(rec);

  if (ev.kind === 'skip') {
    if (first) {
      // 未出のまま。飛ばすたびに次に出せるまでを長くする
      const next = { ...start(rec, ctx, word) };
      next.skip++;
      next.hold = ctx.card + jitter(SKIP_HOLD[Math.min(next.skip, SKIP_HOLD.length) - 1], rng);
      return { rec: next, fx: null };
    }
    // 既出の語: 記録は変えず、少しあとにもう一度
    const next = { ...rec, lastCard: ctx.card };
    if (next.box != null) next.dueCard = ctx.card + jitter(BOX_GAPS[next.box - 1], rng);
    else next.due = ctx.now + Math.max(6 * HOUR, 0.25 * Math.max(0, (rec.due ?? ctx.now) - rec.last));
    return { rec: next, fx: null };
  }

  if (ev.kind === 'hold') {
    const next = { ...start(rec, ctx, word) };
    next.seen++;
    next.hold = ctx.card + jitter(ev.gap * Math.pow(2, next.seen - 1), rng);
    return { rec: next, fx: null };
  }

  const next = copy(rec, ctx, word);
  touch(next, ctx);
  delete next.hold;

  if (ev.kind === 'likely') {
    next.st = ST.LIKELY;
    next.s = ev.s;
    next.ok++;
    addOkDay(next, ctx.now);
    if (ev.confirm) next.lkc = 1; // 推定の確かめがまだ(数日後に一度出す)
    scheduleDays(next, ctx);
    if (ev.confirm) confirmIn(next, [1, 3], ctx);
    return { rec: next, fx: null };
  }

  const stages = ctx.stages || 3;

  if (first) {
    if (ev.grade === G.AGAIN) {
      next.s = ev.encode ? 0.02 : 0.01;
      enterBox(next, 1, ctx);
    } else if (ev.grade === G.HARD) {
      next.s = 0.05;
      enterBox(next, 2, ctx);
    } else {
      next.s = 0.5;
      enterBox(next, stages, ctx);
    }
    return { rec: next, fx: null };
  }

  // 2 回目以降
  const R = retrievability(rec, ctx.now);
  const conf = ev.conf ?? 0.6;
  const target = ev.grade === G.AGAIN ? lapsedS(rec, R) : grownS(rec, R, ev.grade);
  next.s = clamp(blendS(rec.s, target, conf), MIN_S, MAX_S);
  next.d = clamp(rec.d - 0.6 * (ev.grade - 3) * conf, 1, 10);
  next.d = 0.95 * next.d + 0.05 * initialDifficulty(ctx, word);
  const success = ev.grade >= G.GOOD;
  const gapped = ctx.now - rec.last > 12 * HOUR; // 別の利用(間が空いた)での結果か
  if (success) {
    next.ok++;
    addOkDay(next, ctx.now);
  }
  if (ev.lapse) next.lapse = (next.lapse || 0) + 1;

  // 学習枠
  if (next.box != null) {
    if (success) {
      // 間が空いたあとで思い出せたなら、それ以上の確認はいらない
      if (next.box >= stages || gapped) {
        next.s = Math.max(next.s, 0.6); // 翌日の利用で確かめる
        next.fail = 0;
        scheduleDays(next, ctx);
      } else enterBox(next, next.box + 1, ctx);
    } else if (ev.grade === G.HARD) {
      enterBox(next, next.box, ctx);
    } else {
      // 後回しの判断は、同じ利用の中で何度もつまずいた語だけ(間が空いて忘れたのは自然なこと)
      if (!gapped) next.fail = (next.fail || 0) + 1;
      if (next.fail >= PARK_FAILS) {
        // つまずいた語は後回し。3日後か、前線が少し進んでから出し直す
        next.box = null;
        next.dueCard = null;
        next.due = ctx.now + 3 * DAY;
        next.park = { at: (ctx.frontier ?? 0) + 0.05 };
      } else enterBox(next, 1, ctx);
    }
    return { rec: next, fx: null };
  }

  if (next.park) {
    // 後回しにしていた語。思い出せたら枠の途中から、だめなら最初から
    next.fail = 0;
    enterBox(next, success ? 2 : 1, ctx);
    return { rec: next, fx: null };
  }

  // 日単位の復習(学習中・知ってそう・暗記済み)
  if (ev.grade === G.AGAIN) {
    if (settled(rec)) {
      // 定着していた暗記済みの1回のど忘れは、学習枠へ戻さず間隔を縮めるだけ
      next.s = Math.max(next.s, 0.5);
      scheduleDays(next, ctx);
    } else {
      // 知ってそう・暗記済みでも、忘れていたら学習中に戻す
      next.fail = 0;
      enterBox(next, 1, ctx);
    }
    return { rec: next, fx: null };
  }

  // 確かめの出番を、別の日に通過した
  if (gapped && next.mkc) {
    delete next.mkc;
    if (!success && next.mk === 2) next.mk = 1; // 迷ったなら、答えを見てから押したのと同じ扱いに
  }
  if (gapped && next.lkc) {
    delete next.lkc;
    if (!success) next.st = ST.LEARNING; // 迷ったなら、知ってそうではなく学習中として復習する
  }
  const fx = promote(next) ? 'likely' : null;
  scheduleDays(next, ctx);
  return { rec: next, fx };
}

// 利用者が「暗記」を押した(未出・学習中・知ってそう → 暗記済み)。答えを見ずに押したなら本当に知っていたとみなす。
export function memorize(rec, imp, word, ctx) {
  const next = copy(rec, ctx, word);
  const first = isNew(rec);
  touch(next, ctx);
  delete next.hold;
  if (first) {
    next.s = imp.revealed ? 1 : 3 + 7 * (ctx.pk ?? 0.5);
  } else {
    const R = retrievability(rec, ctx.now);
    next.s = Math.max(1, grownS(next, R, imp.revealed ? G.GOOD : G.EASY));
  }
  next.d = clamp(next.d - 0.4, 1, 10);
  next.ok++;
  addOkDay(next, ctx.now);
  next.st = ST.MASTERED;
  next.fail = 0;
  next.mk = Math.max(next.mk || 0, imp.revealed ? 1 : 2);
  next.mkc = 1;
  delete next.lkc;
  delete next.park;
  scheduleDays(next, ctx);
  confirmIn(next, MARK_CHECK[next.mk], ctx);
  return next;
}

// 暗記済みを外す(暗記済み → 学習中)。学習枠の2段目から確かめ直す
export function unmark(rec, ctx) {
  const next = { ...rec, okd: [...(rec.okd || [])] };
  next.s = Math.min(next.s, 0.5);
  next.fail = 0;
  enterBox(next, 2, ctx);
  return next;
}

// 利用者が「苦手」を押した。学習枠の最初の段へ入れる(枠が満杯でも入れる)。
export function dislike(rec, word, ctx) {
  const next = copy(rec, ctx, word);
  const first = isNew(rec);
  touch(next, ctx);
  delete next.hold;
  next.s = first ? 0.01 : lapsedS(next, retrievability(rec, ctx.now));
  next.d = clamp(next.d + 1, 1, 10);
  if (!first) next.lapse = (next.lapse || 0) + 1;
  next.fail = 0;
  enterBox(next, 1, ctx);
  return next;
}

// 期限が来ているか(枚数または日時の早いほう)
export function isDue(rec, now, card) {
  if (rec.dueCard != null && card >= rec.dueCard) return true;
  return rec.due != null && now >= rec.due;
}

// どれくらい期限を過ぎたか。0 なら期限ぴったり。
export function overdue(rec, now, card) {
  if (rec.dueCard != null && card >= rec.dueCard) return Math.min(5, (card - rec.dueCard) / 10);
  if (rec.due == null) return 0;
  const span = Math.max(rec.due - rec.last, 60000);
  return clamp((now - rec.due) / span, 0, 5);
}
