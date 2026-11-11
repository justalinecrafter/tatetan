// ホーム画面から使うための準備(スマホだけ)。Service Worker の登録と、端末に保存した素材の管理。
import { DEVICE } from './device.js';

const MEDIA_CACHES = { video: 'tatetan-video-v1', bgm: 'tatetan-bgm-v1', voice: 'tatetan-voice-v1' };
// PC はこれまで通り毎回サーバーから読む(?sw を付けると PC でも試せる)
export const PWA_ON = 'serviceWorker' in navigator && (DEVICE.mobile || /[?&]sw\b/.test(location.search));

// 保存済みの素材の一覧を読み終えたら(最初の動画選びに使えるように)解決する
export function setupPwa(app) {
  if (!PWA_ON) {
    // PC で試しに登録したものが残っていたら外す(PC はこれまで通りの動きにする)
    navigator.serviceWorker?.getRegistrations?.().then((list) => list.forEach((r) => r.unregister())).catch(() => {});
    return Promise.resolve();
  }
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'updated') {
      app.ui.snack('新しい版を取得しました', { label: '再読み込み', run: () => location.reload() });
    }
  });
  // ホーム画面のアプリは、端末の空きが少なくなっても保存した素材を消されにくくする
  if (DEVICE.standalone) navigator.storage?.persist?.().catch(() => {});

  // 保存済みの動画・BGM を優先して選ぶための一覧
  const sync = () => syncCached(app);
  setInterval(sync, 30 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  return sync();
}

async function cachedNames(name) {
  const cache = await caches.open(name);
  return new Set((await cache.keys()).map((r) => decodeURIComponent(r.url.split('/').pop())));
}

async function syncCached(app) {
  if (!navigator.serviceWorker.controller) return;
  try {
    app.feed.videoShuffler.cached = await cachedNames(MEDIA_CACHES.video);
    app.bgm.shuffler.cached = await cachedNames(MEDIA_CACHES.bgm);
  } catch { /* 保存領域が使えない */ }
}

// 端末に保存している量(MB)。分からなければ null
export async function storageUsage() {
  try {
    const est = await navigator.storage?.estimate?.();
    return est ? Math.round(est.usage / 1024 / 1024) : null;
  } catch {
    return null;
  }
}

export async function clearMedia(app) {
  for (const name of Object.values(MEDIA_CACHES)) await caches.delete(name);
  app.feed.videoShuffler.cached = null;
  app.bgm.shuffler.cached = null;
}
