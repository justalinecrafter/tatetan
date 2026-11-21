// LEAP の並びの英単語ファイル(data/words/leap-words.jsonl)を作る。
//
//   node tools/build-leap.mjs <LEAP の一覧.txt>   一覧の並びで作る
//   node tools/build-leap.mjs                     いまの leap-words.jsonl の並びのまま作り直す(縦単の語を直したとき)
//
// 一覧は「番号<TAB>見出し語<TAB>…」の行。使うのは番号の順と見出し語だけ(一覧の訳は使わない)。
// 意味・例文は:
//   縦単オリジナル(en-words.jsonl)にある語 … そのままコピーして、縦単での位置 od を付ける(リストを切り替えたときに θ を移すため)
//   縦単の熟語(en-phrases.jsonl)にある語   … 熟語からコピー
//   どちらにもない語                         … tools/leap-extra.jsonl(独自に作成)から
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const words = join(root, 'data', 'words');
const out = join(words, 'leap-words.jsonl');
const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const key = (w) => w.toLowerCase();

// 一覧の見出し語と、縦単での見出し語が違うもの
const ALIAS = { 'afterward(s)': 'afterward', 'on behalf of ～': 'on behalf of' };

const [listFile] = process.argv.slice(2);
const order = listFile
  ? readFileSync(listFile, 'utf8').split(/\r?\n/).filter((l) => l.trim())
    .map((l) => l.split('\t'))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, w]) => ALIAS[w.trim()] || w.trim())
  : readJsonl(out).map((x) => x.w);

const own = readJsonl(join(words, 'en-words.jsonl'));
const ownAt = new Map(own.map((x, i) => [key(x.w), i]));
const phrases = new Map(readJsonl(join(words, 'en-phrases.jsonl')).map((x) => [key(x.w), x]));
const extra = new Map(readJsonl(join(root, 'tools', 'leap-extra.jsonl')).map((x) => [key(x.w), x]));

const counts = { own: 0, phrase: 0, extra: 0 };
const missing = [];
const lines = order.map((w) => {
  const k = key(w);
  if (ownAt.has(k)) {
    const i = ownAt.get(k);
    counts.own++;
    return { ...own[i], od: Math.round(((i + 0.5) / own.length) * 1e4) / 1e4 };
  }
  if (phrases.has(k)) {
    counts.phrase++;
    return phrases.get(k);
  }
  if (extra.has(k)) {
    counts.extra++;
    return extra.get(k);
  }
  missing.push(w);
  return null;
});
if (missing.length) throw new Error(`意味・例文がない語があります(tools/leap-extra.jsonl に足してください): ${missing.join(', ')}`);

// 例文には見出し語の印 {…} が要る(答えの面で強調する)。
// 訳は日本語だけ(日本語→英語の出題で答えが見えないように。語法は phr: [[英語, 訳], …] に書く)
for (const x of lines) {
  if (!x.m?.length || x.ex?.length !== 2 || x.ex.some((e) => !/\{[^}]+\}/.test(e.t) || !e.ja)) throw new Error(`形式が正しくありません: ${x.w}`);
  if (x.m.some((m) => /[A-Za-z]{2,}/.test(m))) throw new Error(`訳に英語が入っています(phr へ): ${x.w}`);
}
writeFileSync(out, `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`);
console.log(`${lines.length} 語 → data/words/leap-words.jsonl(縦単 ${counts.own}・熟語 ${counts.phrase}・独自 ${counts.extra})`);
const unused = [...extra.keys()].filter((k) => !order.some((w) => key(w) === k));
if (unused.length) console.log(`使っていない独自の語: ${unused.join(', ')}`);
