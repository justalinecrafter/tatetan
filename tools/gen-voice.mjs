// 英単語・英熟語と例文の読み上げ音声を作る(Windows 専用: 標準の音声合成と ffmpeg を使う)。
//
//   node tools/gen-voice.mjs            足りない音声だけ作る
//   node tools/gen-voice.mjs --voice "Microsoft David Desktop"
//
// 出力: media/voice/<キー>.mp3 と data/voice.json(作った音声の一覧)
// 単語データを直したら、もう一度実行すれば差分だけ作り直す。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir, cpus } from 'node:os';
import { voiceKey, voiceText } from '../js/voicekey.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'media', 'voice');
const indexFile = join(root, 'data', 'voice.json');
const args = process.argv.slice(2);
const voice = args.includes('--voice') ? args[args.indexOf('--voice') + 1] : 'Microsoft Zira Desktop';

// 読み上げる文: 見出し語と、答えを開いたときに読む最初の例文
const texts = new Map();
for (const f of ['en-words.jsonl', 'en-phrases.jsonl']) {
  for (const line of readFileSync(join(root, 'data', 'words', f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const w = JSON.parse(line);
    for (const t of [w.w, w.ex?.[0]?.t]) {
      if (!t) continue;
      const text = voiceText(t);
      const key = voiceKey(text);
      if (texts.has(key) && texts.get(key) !== text) throw new Error(`キーが重複しました: ${text} / ${texts.get(key)}`);
      texts.set(key, text);
    }
  }
}

mkdirSync(outDir, { recursive: true });
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity; // 試し用
const todo = [...texts].filter(([key]) => !existsSync(join(outDir, `${key}.mp3`))).slice(0, limit);
console.log(`全 ${texts.size} 件のうち、作るのは ${todo.length} 件 (${voice})`);

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}: ${err.slice(-400)}`))));
  });
}

async function pool(items, n, fn) {
  let i = 0;
  let done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      if (++done % 500 === 0) console.log(`  ${done}/${items.length}`);
    }
  }));
}

if (todo.length) {
  const work = join(tmpdir(), `tatetan-voice-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    // 1) 標準の音声合成で WAV にする(PowerShell を何本か並べて動かす)
    const ps = `
param($list, $dir, $voice)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice($voice)
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($line in [System.IO.File]::ReadAllLines($list, [System.Text.Encoding]::UTF8)) {
  $k, $t = $line -split "\`t", 2
  $s.SetOutputToWaveFile((Join-Path $dir "$k.wav"), $fmt)
  $s.Speak($t)
}
$s.SetOutputToNull()
`;
    writeFileSync(join(work, 'say.ps1'), `﻿${ps}`, 'utf8');
    const lanes = Math.max(1, Math.min(6, cpus().length - 1));
    const chunks = Array.from({ length: lanes }, (_, i) => todo.filter((_, j) => j % lanes === i));
    console.log(`音声合成中 (${lanes} 並列)…`);
    await Promise.all(chunks.map((chunk, i) => {
      const list = join(work, `list${i}.tsv`);
      writeFileSync(list, chunk.map(([k, t]) => `${k}\t${t}`).join('\n'), 'utf8');
      return run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'say.ps1'), list, work, voice]);
    }));

    // 2) 前後の無音を削って、小さい MP3 にする
    console.log('MP3 に変換中…');
    const trim = 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,apad=pad_dur=0.08';
    await pool(todo, Math.max(2, cpus().length), ([key]) =>
      run('ffmpeg', ['-v', 'error', '-y', '-i', join(work, `${key}.wav`), '-af', trim, '-ac', '1', '-ar', '22050', '-b:a', '32k', join(outDir, `${key}.mp3`)])
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// 単語データから消えた文の音声は消す
const keep = new Set(texts.keys());
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.mp3') && !keep.has(f.slice(0, -4))) unlinkSync(join(outDir, f));
}
const made = [...keep].filter((key) => existsSync(join(outDir, `${key}.mp3`))).sort();
writeFileSync(indexFile, `${JSON.stringify({ base: 'media/voice/', voice, keys: made })}\n`);
console.log(`完了: ${made.length}/${keep.size} 件 → data/voice.json`);
