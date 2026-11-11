// 起動処理と、画面の外枠(上部バー・左メニュー・下部タブ)。
import { createStore } from './store.js';
import { loadWords } from './words.js';
import { Bgm, Tts } from './media.js';
import { createFeed } from './feed.js';
import { createUI } from './ui.js';
import { createOnboarding } from './onboarding.js';
import { icon, logo } from './icons.js';
import { debugState } from './device.js';
import { createInstall } from './install.js';
import { setupPwa } from './pwa.js';

function navItem(tag, nav, ic, icOn, label) {
  return `<${tag} class="nav-item" data-nav="${nav}" data-ic="${ic}" data-ic-on="${icOn}"><span class="nav-ic">${icon(ic)}</span><span class="nav-lb">${label}</span></${tag}>`;
}

function buildChrome(app) {
  document.getElementById('masthead').innerHTML = `
    <div class="mh-left">
      <button class="icon-btn" id="guideToggle" aria-label="メニュー">${icon('menu')}</button>
      <button class="mh-logo" data-nav="feed" aria-label="フィードへ">${logo()}</button>
    </div>
    <div class="mh-center">
      <form class="mh-search" id="searchForm" role="search">
        <input id="searchInput" type="search" placeholder="単語や意味で検索" autocomplete="off">
        <button type="submit" aria-label="検索">${icon('search')}</button>
      </form>
    </div>
    <div class="mh-right">
      <button class="pill mh-create" data-create>${icon('add')}作成</button>
      <button class="icon-btn" data-nav="settings" aria-label="設定">${icon('settings')}</button>
      <button class="mh-avatar" data-nav="you" aria-label="マイページ">${icon('person', 20)}</button>
    </div>`;

  document.getElementById('guide').innerHTML = `
    ${navItem('button', 'feed', 'feed', 'feedFill', 'フィード')}
    ${navItem('button', 'library', 'list', 'list', '単語帳')}
    ${navItem('button', 'saved', 'bookmark', 'bookmarkFill', '保存')}
    ${navItem('button', 'you', 'personOutline', 'person', 'マイページ')}`;

  document.getElementById('tabbar').innerHTML = `
    ${navItem('button', 'feed', 'feed', 'feedFill', 'フィード')}
    ${navItem('button', 'library', 'list', 'list', '単語帳')}
    <button class="nav-add" data-create aria-label="作成"><span>${icon('add', 28)}</span></button>
    ${navItem('button', 'saved', 'bookmark', 'bookmarkFill', '保存')}
    ${navItem('button', 'you', 'personOutline', 'person', 'マイページ')}`;

  document.getElementById('navBtns').innerHTML = `
    <button class="round-btn" data-go="-1" aria-label="前の単語">${icon('up', 28)}</button>
    <button class="round-btn" data-go="1" aria-label="次の単語">${icon('down', 28)}</button>`;

  document.getElementById('navBtns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) app.feed.go(Number(b.dataset.go));
  });

  document.getElementById('guideToggle').addEventListener('click', () => {
    document.getElementById('app').classList.toggle('guide-open');
  });

  document.getElementById('app').addEventListener('click', (e) => {
    if (e.target.closest('[data-create]')) {
      app.ui.openCreate();
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (!nav) return;
    const name = nav.dataset.nav;
    if (name === 'feed') {
      if (app.ui.pageOpen()) app.ui.closePage();
      return;
    }
    if (app.ui.currentPage() !== name) app.ui.openPage(name);
  });

  const input = document.getElementById('searchInput');
  const search = () => {
    if (app.ui.currentPage() !== 'library') app.ui.openPage('library', { q: input.value });
    else app.redrawLibrary?.(input.value);
  };
  input.addEventListener('input', search);
  input.addEventListener('focus', () => {
    if (app.ui.currentPage() !== 'library') app.ui.openPage('library', { q: input.value });
  });
  document.getElementById('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });
}

async function boot() {
  const splash = document.getElementById('splash');
  const store = createStore();
  const [index, manifest, voices] = await Promise.all([
    loadWords(),
    fetch('data/media.json').then((r) => {
      if (!r.ok) throw new Error('素材の一覧を読み込めませんでした');
      return r.json();
    }),
    // 読み上げ音声の一覧(無くても動く。そのときはブラウザの読み上げを使う)
    fetch('data/voice.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);

  const app = { store, index, manifest };
  app.bgm = new Bgm(manifest, () => store.state.settings);
  app.tts = new Tts((busy) => app.bgm.duck(busy), app.bgm);
  app.tts.setFiles(voices);

  // 必ずユーザー操作のイベントの中から呼ぶ。読み上げと BGM は別々に許可を取る
  // (BGM の読み込みが遅くても読み上げは先に使えるように)
  app.unlockAudio = () => {
    app.tts.unlock();
    if (app.bgm.unlocked) {
      app.bgm.wake();
      return;
    }
    const pending = app.bgm.unlocking;
    const result = app.bgm.unlock();
    if (pending) return;
    app.feed.afterUnlock();
    result.then((ok) => {
      if (!ok) app.feed.refreshMuteIcons();
    });
  };
  // スクロールの指離しは操作と見なされないので、タップとキー操作で取る。
  // 許可を取った後も、止まった音声や動画を起こすために聞き続ける
  const onGesture = (e) => {
    const fresh = !app.bgm.unlocked;
    app.unlockAudio();
    if (fresh) app.unlockEvent = e;
    app.feed.kick();
  };
  ['click', 'keydown'].forEach((ev) => document.addEventListener(ev, onGesture, true));

  app.ensureScope = (word) => {
    const s = store.state.settings;
    if (s.scope !== 'both' && s.scope !== word.lang) {
      s.scope = 'both';
      store.save();
    }
  };

  app.feed = createFeed(app);
  app.ui = createUI(app);
  app.onboarding = createOnboarding(app);
  app.install = createInstall(app);

  // 設定で出題内容を変えたら、フィードへ戻ったときに流し直す
  const originalResume = app.feed.resume;
  app.feed.resume = () => {
    if (app.pendingRestart) {
      app.pendingRestart = false;
      app.feed.start();
      return;
    }
    originalResume();
  };

  buildChrome(app);
  splash.remove();

  // スマホのブラウザで開いたら、先にホーム画面への追加を案内する
  // (iPhone はホーム画面版と学習記録が別になるので、実力テストより前に)
  const begin = () => {
    if (app.onboarding.needed()) app.onboarding.start(() => app.feed.start());
    else app.feed.start();
  };
  // 保存済みの素材の一覧を少しだけ待つ(最初の動画から保存済みを選べるように)
  await Promise.race([setupPwa(app), new Promise((r) => setTimeout(r, 400))]);
  if (app.install.needed()) app.install.show(begin);
  else begin();

  window.__tatetan = app;
  if (debugState.on) import('./debug.js').then((m) => m.startDebug(app));
}

boot().catch((err) => {
  console.error(err);
  const splash = document.getElementById('splash');
  if (splash) {
    splash.innerHTML = `<p class="boot-error">読み込みに失敗しました。<br>通信環境を確認して再読み込みしてください。</p>`;
  }
});
