// 記憶モデル。DOM に依存しない純粋関数だけを置く(tests/ から Node で直接検証できる)。
//
// 忘却は FSRS 系のべき乗曲線で表す。
//   R(t) = (1 + F * t / S) ^ C    S: 安定度(R が 0.9 に落ちるまでの日数)
// 利用者は正誤を入力しないので、滞在時間や答えの表示などの行動から
// 「思い出せたか(grade)」と「その推定の確からしさ(conf)」を見積もり、conf の分だけ安定度を更新する。
//
// 覚えかけの語は「学習枠」に入れ、枚数で刻んだ短い間隔(約4 → 10 → 25枚)で確かめてから卒業させる。
// 実力 θ は単語リスト上の位置(0〜1)で表し、「知っている確率」は θ を中心としたなだらかな坂で持つ。

export const DAY = 86400000;
const F = 19 / 81;
const C = -0.5;

export const ST = { NEW: 'new', WATCH: 'watch', LEARNING: 'learning', KNOWN: 'known', MASTERED: 'mastered' };
export const ST_LABEL = {
  new: '未出',
  watch: '様子見',
  learning: '学習中',
  known: '確認済み',
  mastered: '暗記済み',
};
// 画面に出す状態は4つ。様子見(判断材料が足りない語)は未出として見せる。
export const SHOWN_STATES = [ST.NEW, ST.LEARNING, ST.KNOWN, ST.MASTERED];
export const shownState = (rec) => (!rec || rec.st === ST.WATCH || rec.def ? ST.NEW : rec.st);

export const G = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

// 次回出題までに許す記憶保持率。暗記済みは下がるまで待つので、めったに出ない。
const TARGET_R = { learning: 0.9, known: 0.88, mastered: 0.8 };
export const BOX_GAPS = [4, 10, 25, 40]; // 学習枠の段ごとの間隔(枚)。4段目は間を空けて使う人だけ
export const MASTER_S = 21; // 暗記済みにする安定度(日)
const MASTER_DAYS = 2; // 暗記済みにするのに必要な、成功した日の数
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

export function newLearner(theta = 0.1) {
  return {
    theta, // 坂の中心。知っている確率が 50% になる位置
    w: 0.08, // 坂の幅
    n: 0, // θ を更新した回数
    tested: false,
    cal: { z: 1 }, // 坂から遠い語での予測の外れ(見込みどおりなら 1)
    phr: { 句動詞: [1, 1], 熟語: [1, 1] }, // 熟語の既知率(知っていた / 知らなかった の重み)
    box: 8, // 学習枠の大きさ
    boxLog: [], // 学習枠の復習の成否(直近30回)
    ivl: 1, // 復習の間隔の倍率
  };
}

// 学習者が語を(アプリで覚える前から)知っている確率
export function pKnown(L, word) {
  if (word.kind === 'phrase') {
    const [a, b] = L.phr[word.pos] || L.phr['熟語'];
    return a / (a + b);
  }
  return 1 / (1 + Math.exp(-(L.theta - word.d) / L.w));
}

// 初めて見た語への反応で θ・坂の幅・熟語の既知率を更新する。y: 知っていた度合い(0〜1)
export function updateLearner(L, word, y, weight) {
  if (!weight) return;
  if (word.kind === 'phrase') {
    const key = L.phr[word.pos] ? word.pos : '熟語';
    const c = L.phr[key];
    c[0] += y * weight;
    c[1] += (1 - y) * weight;
    const total = c[0] + c[1];
    if (total > 40) {
      c[0] *= 40 / total;
      c[1] *= 40 / total;
    }
    return;
  }
  const p = pKnown(L, word);
  const lr = Math.max(0.012, 0.06 / (1 + L.n / 25));
  L.theta = clamp(L.theta + lr * weight * (y - p), -0.05, 1.05);
  L.n++;
  // 坂から遠い語で外れが見込みより多いなら坂をなだらかに、少ないなら急にする。
  // 外れの大きさは1回ごとに上限を設ける(知っている語でのうっかりミス1回で坂が崩れないように)
  if (Math.abs(L.theta - word.d) / L.w > 1.5) {
    const z2 = Math.min(6, ((y - p) * (y - p)) / Math.max(0.01, p * (1 - p)));
    L.cal.z = 0.95 * (L.cal.z ?? 1) + 0.05 * z2;
    if (L.cal.z > 1.4) L.w = Math.min(0.15, L.w * 1.01);
    else if (L.cal.z < 0.7) L.w = Math.max(0.05, L.w * 0.99);
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

/* ---------- 行動の読み取り ---------- */

// 個人の「読む速さ」を基準にする。遅い人を「考え込んだ」と誤判定しないため。
// 長い見出し(熟語)は読むのに時間がかかるので、その分だけ基準を延ばす。
export function thresholds(baseline, chars = 8) {
  const list = baseline && baseline.length >= 8 ? [...baseline].sort((a, b) => a - b) : null;
  const median = list ? list[list.length >> 1] : 2.2;
  const extra = Math.max(0, chars - 10);
  return {
    quick: clamp(median * 0.55, 0.6, 1.4) + extra * 0.03,
    think: clamp(median * 1.6, 2.2, 7) + extra * 0.06,
  };
}

export function pushBaseline(baseline, sec) {
  if (sec < 0.3 || sec > 30) return baseline;
  const next = [...baseline, Math.round(sec * 100) / 100];
  return next.length > 60 ? next.slice(-60) : next;
}

const isFirst = (rec) => !rec || rec.st === ST.WATCH || !!rec.def;

// 行動 → 記憶の推定。明示的な確認・暗記・苦手は別経路(confirm / memorize / dislike)で処理する。
//   imp: { frontMs, backMs, revealed, detail, returned, manual, replay, saved, chars, mcount, exlen }
//   ctx: { baseline, pk, skimming, stretch }
// 返す y / w は θ の更新に使う(初めて見た語だけ)。
export function classify(imp, rec, ctx) {
  const { quick, think } = thresholds(ctx.baseline, imp.chars);
  const f = imp.frontMs / 1000;
  const b = imp.backMs / 1000;
  const first = isFirst(rec);
  const pk = first ? ctx.pk : retrievability(rec, ctx.now);
  // 答えをじっくり読んだか(意味の数・例文の長さで補正)
  const encodeAt = 2.5 + 0.5 * (imp.mcount || 1) + 0.02 * (imp.exlen || 40);
  const encode = b >= encodeAt || !!imp.detail;
  const interest = encode || !!imp.saved;
  const damp = ctx.skimming ? 0.5 : 1; // 流し見中は推定を弱める

  if (imp.manual) return { kind: 'none', why: '単語帳から開いた' };
  if (!imp.revealed && f > 30) return { kind: 'none', why: '放置とみなす' };

  if (imp.returned) {
    if (imp.revealed) return { kind: 'grade', grade: G.AGAIN, conf: 0.6, why: '戻って答えを確認した' };
    if (f < quick) return { kind: 'none', why: '通り過ぎただけ' };
    if (first) return { kind: 'none', why: '戻って見直した' };
    return { kind: 'grade', grade: G.HARD, conf: 0.3, why: '戻って見直した' };
  }

  if (first) {
    let ev;
    if (imp.revealed) {
      if (b < 0.9 && f >= quick) {
        ev = pk >= 0.7
          ? { kind: 'grade', grade: G.GOOD, conf: 0.5, implied: true, y: 0.8, w: 0.3, why: '答えを一瞬確認しただけ' }
          : { kind: 'grade', grade: G.HARD, conf: 0.5, y: 0.4, w: 0.3, why: '答えをちらっと見た' };
      } else if (f >= think) {
        ev = { kind: 'grade', grade: G.AGAIN, conf: 0.8, y: 0, w: 0.5, encode: true, why: '考えて思い出せなかった' };
      } else {
        ev = { kind: 'grade', grade: G.AGAIN, conf: 0.7, y: 0, w: 0.5, encode, why: 'すぐ答えを見た' };
      }
    } else if (f < quick) {
      ev = pk >= 0.8 && !ctx.skimming
        ? { kind: 'grade', grade: G.GOOD, conf: 0.5, implied: true, y: 1, w: 0.4, why: '簡単なのですぐ飛ばした' }
        : { kind: 'watch', gap: pk <= 0.35 ? 15 : 35, y: 0.75, w: ctx.skimming ? 0 : 0.3, why: '知っているか不明なまま飛ばした' };
    } else if (f < think) {
      // 答えを見ずに読み進めた = 知っていた可能性が高い。知らなかった語(答えを見た)と同じ重みで θ に効かせる
      ev = pk >= 0.6
        ? { kind: 'grade', grade: G.GOOD, conf: 0.55 * damp, implied: true, y: 1, w: 0.5, why: '読んで答えを見ずに進んだ' }
        : { kind: 'watch', gap: 20, y: 0.9, w: 0.5, why: '読んだが判断材料が足りない' };
    } else {
      ev = { kind: 'watch', gap: 10, why: '長く見たが答えを見なかった' };
    }
    if (ev.w) ev.w *= damp;
    // 背伸びの語は、知らなくても関心がなければ学習枠に入れない(前線が届いてから普通に出す)
    if (ctx.stretch && ev.kind === 'grade' && !ev.implied && !interest && !imp.disliked) {
      ev = { ...ev, kind: 'watch', defer: true, why: `${ev.why}(背伸びの語なので後回し)` };
    }
    return ev;
  }

  // 2 回目以降
  let ev;
  if (imp.revealed) {
    if (b < 0.9 && f < think) ev = { kind: 'grade', grade: G.HARD, conf: 0.5, why: '合っているか確認した' };
    else if (f >= think || encode) ev = { kind: 'grade', grade: G.AGAIN, conf: 0.75, lapse: true, why: '思い出せず答えを読んだ' };
    else ev = { kind: 'grade', grade: G.HARD, conf: 0.55, weak: true, why: '少し迷って答えを見た' };
  } else if (f < quick) {
    const settled = rec.ok > 0 || rec.s >= 1;
    ev = settled
      ? { kind: 'grade', grade: G.GOOD, conf: 0.4, why: '見てすぐ飛ばした' }
      : { kind: 'grade', grade: G.HARD, conf: 0.25, why: '覚えたてなのに即飛ばした' };
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
  ev.conf *= damp;
  return ev;
}

/* ---------- 記録の更新 ---------- */

function initialDifficulty(ctx, word) {
  if (word.kind !== 'word') return 5;
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

function blank(ctx, word) {
  return { st: ST.WATCH, s: MIN_S, d: initialDifficulty(ctx, word), n: 0, ok: 0, lapse: 0, watch: 0, box: null, fail: 0, okd: [] };
}

function copy(rec, ctx, word) {
  return rec ? { ...rec, okd: [...(rec.okd || [])] } : blank(ctx, word);
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
  delete rec.def;
  rec.dueCard = ctx.card + jitter(BOX_GAPS[stage - 1], rng);
  rec.due = ctx.now + 4 * 3600000; // 利用が途切れたら、次に来たときに出す
}

// ivl: その人に合わせた間隔の倍率(復習の成功率が 86% 前後になるように調整される)
function scheduleDays(rec, ctx) {
  rec.box = null;
  rec.dueCard = null;
  rec.due = ctx.now + intervalDays(rec.s, TARGET_R[rec.st] || 0.9) * (ctx.ivl || 1) * DAY;
}

// 確認済み・暗記済みの語を、間を空けて復習した結果で間隔の倍率を調整する
export function logReview(L, success) {
  L.ivl = clamp((L.ivl || 1) * (success ? 1.01 : 0.94), 0.4, 2);
}

function promote(rec) {
  if (rec.st === ST.KNOWN && !rec.im && rec.s >= MASTER_S && rec.okd.length >= MASTER_DAYS) {
    rec.st = ST.MASTERED;
    return true;
  }
  return false;
}

// classify の結果を単語の記録へ反映する。
//   ctx: { now, card, theta, pk, stages(3 か 4), frontier, rng }
//   返り値: { rec, fx }  fx は演出の種類('known' | 'graduate' | 'mastered' | null)
export function apply(rec, ev, word, ctx) {
  if (ev.kind === 'none') return { rec, fx: null };
  const rng = ctx.rng || Math.random;
  const next = copy(rec, ctx, word);
  const wasFirst = isFirst(rec);
  touch(next, ctx);

  if (ev.kind === 'watch') {
    next.st = ST.WATCH;
    next.box = null;
    if (ev.defer) {
      // 普通の新出に戻す。前線が届いたらまた出る
      next.def = 1;
      next.dueCard = null;
      next.due = null;
      return { rec: next, fx: null };
    }
    delete next.def;
    next.watch = (next.watch || 0) + 1;
    // 何度も即飛ばしされる語は興味が薄いので間隔を倍々に広げる
    const gap = ev.gap * Math.pow(2, next.watch - 1);
    next.dueCard = ctx.card + jitter(gap, rng);
    next.due = ctx.now + Math.min(gap * 0.02, 2) * DAY;
    return { rec: next, fx: null };
  }

  const stages = ctx.stages || 3;
  let fx = null;

  if (wasFirst) {
    delete next.def;
    if (ev.implied) {
      next.st = ST.KNOWN;
      next.im = true;
      next.s = 2 + 6 * (ctx.pk ?? 0.8);
      scheduleDays(next, ctx);
    } else if (ev.grade === G.AGAIN) {
      next.s = ev.encode ? 0.02 : 0.01;
      enterBox(next, 1, ctx);
    } else if (ev.grade === G.HARD) {
      next.s = 0.05;
      enterBox(next, 2, ctx);
    } else {
      next.s = 0.5;
      enterBox(next, stages, ctx);
    }
    return { rec: next, fx };
  }

  // 2 回目以降
  const R = retrievability(rec, ctx.now);
  const target = ev.grade === G.AGAIN ? lapsedS(rec, R) : grownS(rec, R, ev.grade);
  next.s = clamp(blendS(rec.s, target, ev.conf), MIN_S, MAX_S);
  next.d = clamp(rec.d - 0.6 * (ev.grade - 3) * ev.conf, 1, 10);
  next.d = 0.95 * next.d + 0.05 * initialDifficulty(ctx, word);
  const success = ev.grade >= G.GOOD;
  if (success) {
    next.ok = (next.ok || 0) + 1;
    addOkDay(next, ctx.now);
    next.im = false; // 推定だけで上がった語も、復習で成功すれば裏が取れた
  }
  if (ev.lapse) next.lapse = (next.lapse || 0) + 1;

  if (next.box != null) {
    // 間が空いた(別の利用の)あとで思い出せたなら、それ以上の確認はいらない
    const gapped = ctx.now - rec.last > 12 * 3600000;
    if (success) {
      if (next.box >= stages || gapped) {
        next.st = ST.KNOWN;
        next.s = Math.max(next.s, 0.6); // 翌日の利用で確かめる
        next.fail = 0;
        scheduleDays(next, ctx);
        fx = 'graduate';
      } else enterBox(next, next.box + 1, ctx);
    } else if (ev.grade === G.HARD) {
      enterBox(next, next.box, ctx);
    } else {
      // 後回しの判断は、同じ利用の中で何度もつまずいた語だけ(間が空いて忘れたのは自然なこと)
      if (!gapped) next.fail = (next.fail || 0) + 1;
      if (next.fail >= PARK_FAILS) {
        // つまずいた語は後回し。3日後か、前線が少し進んでから出し直す
        next.st = ST.LEARNING;
        next.box = null;
        next.dueCard = null;
        next.due = ctx.now + 3 * DAY;
        next.park = { at: (ctx.frontier ?? 0) + 0.05 };
      } else enterBox(next, 1, ctx);
    }
    return { rec: next, fx };
  }

  if (next.park) {
    // 後回しにしていた語。思い出せたら枠の途中から、だめなら最初から
    next.fail = 0;
    enterBox(next, success ? 2 : 1, ctx);
    return { rec: next, fx };
  }

  if (ev.grade === G.AGAIN) {
    if (next.st === ST.MASTERED && !rec.im) {
      next.st = ST.KNOWN;
      next.s = Math.max(next.s, 0.5);
      scheduleDays(next, ctx);
    } else {
      next.fail = 0;
      enterBox(next, 1, ctx);
    }
    return { rec: next, fx };
  }
  if (ev.weak && next.st === ST.MASTERED) next.st = ST.KNOWN;
  if (next.st === ST.LEARNING) next.st = ST.KNOWN;
  if (promote(next)) fx = 'mastered';
  scheduleDays(next, ctx);
  return { rec: next, fx };
}

// 利用者が「確認」を押した(未出・学習中 → 確認済み)。答えを見ずに押したなら本当に知っていたとみなす。
export function confirm(rec, imp, word, ctx) {
  const next = copy(rec, ctx, word);
  const wasFirst = isFirst(rec);
  touch(next, ctx);
  if (wasFirst) {
    next.s = imp.revealed ? 1 : 3 + 7 * (ctx.pk ?? 0.5);
  } else {
    const R = retrievability(rec, ctx.now);
    next.s = Math.max(1, grownS(next, R, imp.revealed ? G.GOOD : G.EASY));
  }
  next.d = clamp(next.d - 0.4, 1, 10);
  next.ok = (next.ok || 0) + 1;
  addOkDay(next, ctx.now);
  next.st = ST.KNOWN;
  next.im = false;
  next.fail = 0;
  delete next.park;
  delete next.def;
  scheduleDays(next, ctx);
  return next;
}

// 利用者が「暗記」を押した(確認済み → 暗記済み)
export function memorize(rec, imp, word, ctx) {
  const next = copy(rec, ctx, word);
  touch(next, ctx);
  next.s = Math.max(imp.revealed ? 10 : 30, next.s);
  next.d = clamp(next.d - 0.6, 1, 10);
  next.ok = (next.ok || 0) + 1;
  addOkDay(next, ctx.now);
  next.st = ST.MASTERED;
  next.im = false;
  next.fail = 0;
  delete next.park;
  delete next.def;
  scheduleDays(next, ctx);
  return next;
}

// 暗記済みを1段階戻す(暗記済み → 確認済み)
export function downgrade(rec, ctx) {
  const next = { ...rec, okd: [...(rec.okd || [])] };
  next.st = ST.KNOWN;
  next.s = Math.min(next.s, 7);
  scheduleDays(next, ctx);
  return next;
}

// 利用者が「苦手」を押した。学習枠の最初の段へ入れる(枠が満杯でも入れる)。
export function dislike(rec, word, ctx) {
  const next = copy(rec, ctx, word);
  const wasFirst = isFirst(rec);
  touch(next, ctx);
  next.s = wasFirst ? 0.01 : lapsedS(next, retrievability(rec, ctx.now));
  next.d = clamp(next.d + 1, 1, 10);
  if (!wasFirst) next.lapse = (next.lapse || 0) + 1;
  next.im = false;
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
