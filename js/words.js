// 単語データの読み込み。データ形式は README.md を参照。
//
// 単語リストは「並び順 = 大まかな難易度順」。読み込み時に各単語へ位置 d (0〜1) を付ける。
// 熟語リストは並び順を問わない。位置は持たず、含まれる語の位置から「弱い難易度」だけを作る。

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

// 熟語の語と単語リストの語を照合するための素朴な語幹
function stem(t) {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

const tokens = (s) => s.toLowerCase().replace(/[～~（）()[\]、。,.!?'"]/g, ' ').split(/\s+/).filter(Boolean);

export function buildIndex(words) {
  const byId = new Map();
  const ordered = {}; // lang -> 単語(位置の順)
  const phrases = {}; // lang -> 熟語
  for (const w of words) {
    byId.set(w.id, w);
    if (w.kind === 'word') (ordered[w.lang] ||= []).push(w);
    else (phrases[w.lang] ||= []).push(w);
  }

  // 位置 d と、紛らわしい語(綴りが1文字違い・発音が同じ)
  const confusables = new Map();
  for (const [lang, list] of Object.entries(ordered)) {
    const n = list.length;
    const lookup = new Map();
    const keys = new Map();
    const byIpa = new Map();
    list.forEach((w, i) => {
      w.ord = i;
      w.d = (i + 0.5) / n;
      const lw = w.w.toLowerCase();
      if (!lookup.has(lw)) lookup.set(lw, w);
      if (!lookup.has(stem(lw))) lookup.set(stem(lw), w);
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

    // 熟語の弱い難易度: 含まれる語のうち、単語リストで最も後ろにある語の位置
    for (const p of phrases[lang] || []) {
      let hard = 0;
      for (const t of tokens(p.w)) {
        const hit = lookup.get(t) || lookup.get(stem(t));
        if (hit && hit.d > hard) hard = hit.d;
      }
      p.hard = hard;
      p.head = p.pos === '句動詞' ? tokens(p.w)[0] : null;
    }
  }
  for (const [lang, list] of Object.entries(phrases)) {
    if (!ordered[lang]) for (const p of list) { p.hard = 0; p.head = null; }
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

export async function loadWords() {
  const res = await fetch('data/words/index.json');
  if (!res.ok) throw new Error('単語の一覧を読み込めませんでした');
  const index = await res.json();
  const jobs = [];
  for (const [lang, files] of Object.entries(index)) {
    for (const [kind, f] of Object.entries(files)) {
      jobs.push(
        fetch(`data/words/${f}`).then(async (r) => {
          if (!r.ok) throw new Error(`${f} を読み込めませんでした`);
          return parseJsonl(await r.text(), lang, kind === 'phrases' ? 'phrase' : 'word');
        })
      );
    }
  }
  return buildIndex((await Promise.all(jobs)).flat());
}
