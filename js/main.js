// 起動処理と、画面の外枠(上部バー・左メニュー・下部タブ)。
import { createStore } from './store.js';
import { loadWords } from './words.js';
import { Bgm, Tts } from './media.js';
import { createFeed } from './feed.js';
import { createUI } from './ui.js';
import { createOnboarding } from './onboarding.js';
import { icon, logo } from './icons.js';

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
  const [index, manifest] = await Promise.all([
    loadWords(),
    fetch('data/media.json').then((r) => {
      if (!r.ok) throw new Error('素材の一覧を読み込めませんでした');
      return r.json();
    }),
  ]);

  const app = { store, index, manifest };
  app.bgm = new Bgm(manifest, () => store.state.settings);
  app.tts = new Tts((busy) => app.bgm.duck(busy));

  app.unlockAudio = () => {
    if (app.bgm.unlocked) return;
    app.tts.unlock();
    app.bgm.unlock().then((ok) => {
      if (ok) {
        removeUnlockListeners();
        app.feed.afterUnlock();
      }
    });
  };
  const unlockEvents = ['click', 'touchend', 'keydown'];
  const onGesture = () => app.unlockAudio();
  const removeUnlockListeners = () => unlockEvents.forEach((ev) => document.removeEventListener(ev, onGesture, true));
  unlockEvents.forEach((ev) => document.addEventListener(ev, onGesture, true));

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

  if (app.onboarding.needed()) app.onboarding.start(() => app.feed.start());
  else app.feed.start();

  window.__tatetan = app;
}

boot().catch((err) => {
  console.error(err);
  const splash = document.getElementById('splash');
  if (splash) {
    splash.innerHTML = `<p class="boot-error">読み込みに失敗しました。<br>通信環境を確認して再読み込みしてください。</p>`;
  }
});
