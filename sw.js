// スマホでホーム画面から使うときのための Service Worker(PC では登録しない)。
//
// - アプリ本体と単語データは端末に保存し、通信がなくても起動できるようにする。
//   開くたびに裏で新しい版を確かめ、全部そろって取れたときだけ入れ替える(次に開いたときに反映)。
// - 動画・BGM・読み上げ音声は、一度再生したものを端末に保存して、次からは通信しない。
//   動画と音声は再生位置を指定して読まれる(Range)ので、保存したファイルから必要な部分を切り出して返す。

const SHELL = 'tatetan-shell-v1';
const MEDIA = {
  video: { cache: 'tatetan-video-v1', limit: 50 }, // 1 本 平均 3.5MB → 最大 約 175MB
  bgm: { cache: 'tatetan-bgm-v1', limit: 40 }, // 1 曲 平均 2.3MB → 最大 約 90MB
  voice: { cache: 'tatetan-voice-v1', limit: 9000 }, // 全部で約 60MB
};
const KEEP = new Set([SHELL, ...Object.values(MEDIA).map((m) => m.cache)]);

const SHELL_FILES = [
  './',
  'manifest.webmanifest',
  'css/app.css',
  'js/main.js',
  'js/device.js',
  'js/debug.js',
  'js/engine.js',
  'js/feed.js',
  'js/fit.js',
  'js/icons.js',
  'js/install.js',
  'js/media.js',
  'js/onboarding.js',
  'js/pwa.js',
  'js/scheduler.js',
  'js/srs.js',
  'js/store.js',
  'js/ui.js',
  'js/voicekey.js',
  'js/words.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'data/media.json',
  'data/voice.json',
  'data/words/index.json',
];

const scope = new URL(self.registration.scope);
const abs = (path) => new URL(path, scope).href;

async function shellList() {
  // 単語ファイルは data/words/index.json に書かれたものを使う
  const files = [...SHELL_FILES];
  try {
    const index = await (await fetch(abs('data/words/index.json'), { cache: 'no-cache' })).json();
    for (const set of Object.values(index)) for (const f of Object.values(set)) files.push(`data/words/${f}`);
  } catch { /* 取れなければ本体だけ */ }
  return files.map(abs);
}

// 全部取れたときだけ保存する(古い版と新しい版のファイルが混ざらないように)
async function fetchShell() {
  const urls = await shellList();
  const responses = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${url} ${res.status}`);
      return [url, res];
    })
  );
  return responses;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      for (const [url, res] of await fetchShell()) await cache.put(url, res);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('tatetan-') && !KEEP.has(name)) await caches.delete(name);
      await self.clients.claim();
    })()
  );
});

/* ---------- アプリ本体の更新 ---------- */
let lastCheck = 0;
async function refreshShell() {
  if (Date.now() - lastCheck < 60 * 1000) return;
  lastCheck = Date.now();
  try {
    const fresh = await fetchShell();
    const cache = await caches.open(SHELL);
    let changed = false;
    const bodies = [];
    for (const [url, res] of fresh) {
      const body = await res.clone().arrayBuffer();
      const old = await cache.match(url);
      if (!old || !sameBytes(body, await old.arrayBuffer())) changed = true;
      bodies.push([url, res]);
    }
    if (!changed) return;
    for (const [url, res] of bodies) await cache.put(url, res);
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'updated' });
  } catch {
    // 通信できないときは今の版のまま
  }
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/* ---------- 動画・BGM・音声 ---------- */
const inflight = new Map();
const memory = new Map(); // 直近に使ったファイルの中身(Range のたびに読み直さないように)

function saveMedia(kind, url) {
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    const res = await fetch(url);
    if (!res.ok || res.status !== 200) return null;
    const blob = await res.blob();
    const cache = await caches.open(MEDIA[kind].cache);
    const headers = { 'Content-Type': res.headers.get('Content-Type') || typeOf(url), 'Content-Length': String(blob.size) };
    await cache.put(url, new Response(blob, { headers }));
    trim(kind);
    return blob;
  })()
    .catch(() => null)
    .finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

let trimming = Promise.resolve();
function trim(kind) {
  trimming = trimming.then(async () => {
    const cache = await caches.open(MEDIA[kind].cache);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MEDIA[kind].limit; i++) await cache.delete(keys[i]);
  }).catch(() => {});
}

function typeOf(url) {
  if (url.endsWith('.mp4')) return 'video/mp4';
  if (url.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

function remember(url, blob) {
  memory.delete(url);
  memory.set(url, blob);
  if (memory.size > 3) memory.delete(memory.keys().next().value);
}

async function mediaResponse(request, kind, url) {
  let blob = memory.get(url);
  if (!blob) {
    const cached = await (await caches.open(MEDIA[kind].cache)).match(url);
    if (cached) blob = await cached.blob();
  }
  if (!blob) blob = await saveMedia(kind, url);
  if (!blob) return fetch(request); // 保存できなかったときは通常どおり
  remember(url, blob);
  return ranged(request, blob, typeOf(url));
}

function ranged(request, blob, type) {
  const size = blob.size;
  const range = request.headers.get('range');
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (!range) return new Response(blob, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start;
  let end;
  if (!m || (!m[1] && !m[2])) {
    start = 0;
    end = size - 1;
  } else if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
  });
}

/* ---------- 振り分け ---------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.href.startsWith(scope.href)) return;
  const path = url.href.slice(scope.href.length).split('?')[0];
  const clean = abs(path);

  const media = /^media\/(video|bgm|voice)\//.exec(path);
  if (media) {
    event.respondWith(mediaResponse(request, media[1], clean));
    return;
  }

  // ページを開いたとき: 保存した版をすぐ返し、裏で新しい版を確かめる(?debug などの付いた URL も同じページ)
  if (request.mode === 'navigate') {
    event.waitUntil(refreshShell());
    event.respondWith(
      (async () => (await caches.match(abs('./'), { cacheName: SHELL })) || fetch(request))()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(clean, { cacheName: SHELL });
      if (hit) return hit;
      return fetch(request);
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'check') event.waitUntil(refreshShell());
});
