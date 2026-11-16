// 単語データの読み込み。データ形式は README.md を参照。
//
// 単語リスト・熟語リスト・古典単語リストとも「並び順 = 難易度順」(易しい順)。読み込み時に各語へリスト上の位置 d (0〜1) を付ける。
// 範囲を決めて出題するモードでは、この順に 100 語ずつ区切る(RANGE_SIZE)。
// 単語と熟語は別々の道として扱う(位置はそれぞれのリストの中で数える)。

export const LANG_NAME = { en: '英単語', kb: '古典単語' };
export const KIND_NAME = { word: '単語', phrase: '熟語' };

export function parseJsonl(text, lang, kind = 'word') {
  const out = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    const key = String(o.id || o.w).toLowerCase();
    if (seen.has(key)) continue; // 重複は先の行を残す
    seen.add(key);
    o.lang = lang;
    o.kind = kind;
    o.id = `${lang}:${kind === 'word' ? 'w' : 'p'}:${o.id || o.w}`;
    out.push(o);
  }
  return out;
}

const tokens = (s) => s.toLowerCase().replace(/[～~（）()[\]、。,.!?'"]/g, ' ').split(/\s+/).filter(Boolean);

export function buildIndex(words) {
  const byId = new Map();
  const ordered = {}; // lang -> 単語(位置の順)
  const phrases = {}; // lang -> 熟語(位置の順)
  for (const w of words) {
    byId.set(w.id, w);
    if (w.kind === 'word') (ordered[w.lang] ||= []).push(w);
    else (phrases[w.lang] ||= []).push(w);
  }

  // 位置 d と、紛らわしい語(綴りが1文字違い・発音が同じ)
  const confusables = new Map();
  for (const [lang, list] of Object.entries(ordered)) {
    const n = list.length;
    const keys = new Map();
    const byIpa = new Map();
    list.forEach((w, i) => {
      w.ord = i;
      w.d = (i + 0.5) / n;
      const lw = w.w.toLowerCase();
      if (lw.length >= 4) {
        const variants = new Set([lw]);
        for (let k = 0; k < lw.length; k++) variants.add(lw.slice(0, k) + lw.slice(k + 1));
        for (const v of variants) {
          if (!keys.has(v)) keys.set(v, []);
          keys.get(v).push(w);
        }
      }
      if (w.ipa) {
        if (!byIpa.has(w.ipa)) byIpa.set(w.ipa, []);
        byIpa.get(w.ipa).push(w);
      }
    });
    const link = (group) => {
      if (group.length < 2 || group.length > 8) return;
      for (const a of group) {
        for (const b of group) {
          if (a === b) continue;
          if (!confusables.has(a.id)) confusables.set(a.id, new Set());
          confusables.get(a.id).add(b.id);
        }
      }
    };
    for (const g of keys.values()) link(g);
    for (const g of byIpa.values()) link(g);
  }

  // 熟語の位置 d と、句動詞の先頭の動詞(同じ動詞の句動詞を学習枠に詰め込まないため)
  for (const list of Object.values(phrases)) {
    const n = list.length;
    list.forEach((p, i) => {
      p.ord = i;
      p.d = (i + 0.5) / n;
      p.head = p.pos === '句動詞' ? tokens(p.w)[0] : null;
    });
  }

  return {
    words,
    byId,
    ordered: (lang) => ordered[lang] || [],
    phrases: (lang) => phrases[lang] || [],
    confusables: (id) => confusables.get(id) || null,
    langs: () => [...new Set(words.map((w) => w.lang))],
  };
}

/* ---------- 範囲を決めて出題する ----------
  各リストを易しい順に 100 語ずつ区切る。範囲は { list, start }(start は 0, 100, 200 …) */
export const RANGE_SIZE = 100;
export const RANGE_LISTS = [
  { id: 'en-w', lang: 'en', kind: 'word', label: '英単語' },
  { id: 'en-p', lang: 'en', kind: 'phrase', label: '英熟語' },
  { id: 'kb', lang: 'kb', kind: 'word', label: '古典単語' },
];
export const rangeList = (id) => RANGE_LISTS.find((l) => l.id === id) || null;
export const rangeSource = (index, list) => (list.kind === 'phrase' ? index.phrases(list.lang) : index.ordered(list.lang));

// 範囲の語。範囲が正しくなければ null
export function rangeWords(index, range) {
  const list = range && rangeList(range.list);
  if (!list) return null;
  const all = rangeSource(index, list);
  if (!(range.start >= 0) || range.start >= all.length) return null;
  return all.slice(range.start, range.start + RANGE_SIZE);
}

export function rangeLabel(index, range) {
  const list = range && rangeList(range.list);
  const ws = rangeWords(index, range);
  if (!ws) return '';
  return `${list.label} ${range.start + 1}〜${range.start + ws.length}`;
}

/* ---------- 英単語のリスト ----------
  設定で選んだ 1 つだけを読み込む(index.json の en の、key に書いたファイル)。
  LEAP の並びは『必携英単語 LEAP』に合わせ、意味・例文は縦単の語をそのまま使う(ない語だけ独自に作成)。
  LEAP の語のうち縦単にもある語は、縦単での位置 od を持つ(リストを切り替えたときに θ を移すため) */
export const EN_LISTS = [
  { id: 'own', key: 'words', label: '縦単オリジナル(3000語)' },
  { id: 'leap', key: 'leap', label: 'LEAP(2300語)' },
];
const enListOf = (id) => EN_LISTS.find((l) => l.id === id) || EN_LISTS[0];

async function fetchList(file, lang, kind) {
  const r = await fetch(`data/words/${file}`);
  if (!r.ok) throw new Error(`${file} を読み込めませんでした`);
  return parseJsonl(await r.text(), lang, kind);
}

async function fetchFiles() {
  const res = await fetch('data/words/index.json');
  if (!res.ok) throw new Error('単語の一覧を読み込めませんでした');
  return res.json();
}

export async function loadWords(enList = 'own') {
  const files = await fetchFiles();
  const skip = new Set(EN_LISTS.map((l) => l.key).filter((k) => k !== enListOf(enList).key));
  const jobs = [];
  for (const [lang, set] of Object.entries(files)) {
    for (const [key, f] of Object.entries(set)) {
      if (lang === 'en' && skip.has(key)) continue;
      jobs.push(fetchList(f, lang, key === 'phrases' ? 'phrase' : 'word'));
    }
  }
  // LEAP には熟語が少し入っている。単語のリストにある熟語は熟語のリストから外す(同じ語を二度出さない)
  const all = (await Promise.all(jobs)).flat();
  const head = (w) => `${w.lang}:${w.w.toLowerCase()}`;
  const asWord = new Set(all.filter((w) => w.kind === 'word').map(head));
  const index = buildIndex(all.filter((w) => w.kind === 'word' || !asWord.has(head(w))));
  index.enList = enListOf(enList).id;
  return index;
}

// LEAP の単語(位置 d 付き)。いま LEAP を読み込んでいればそれを、なければファイルから
export async function leapWords(index) {
  if (index.enList === 'leap') return index.ordered('en');
  const files = await fetchFiles();
  return buildIndex(await fetchList(files.en.leap, 'en', 'word')).ordered('en');
}

// 出題の対象の語か(言語と、英熟語を出すか)
export const inScope = (w, set) => (set.scope === 'both' || w.lang === set.scope) && (w.kind === 'word' || set.phrases !== false);

// いまの出題モードで選んでいる範囲(おまかせと復習モードで別々に持つ)
export const modeRange = (set) => (set.review ? set.reviewRange : set.range);

// 復習モードで出す語の候補(範囲を決めていればその範囲の語、なければ出題の対象の語)
export const drillPool = (index, set, range = set.reviewRange) =>
  (range ? rangeWords(index, range) || [] : index.words.filter((w) => inScope(w, set)));
