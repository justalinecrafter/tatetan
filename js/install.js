// スマホのブラウザで開いたときに、ホーム画面への追加を案内する。
// Android(Chrome など)はボタン 1 つで追加画面を出せる。iPhone は自動では出せないので手順を見せる。
import { DEVICE } from './device.js';
import { logo } from './icons.js';

const SKIP_KEY = 'tatetan.installSkip';
const SKIP_DAYS = 7;

// 追加の画面を出す合図は起動直後に来ることがあるので、読み込んだ時点で受け取っておく
let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
});

function skippedRecently() {
  try {
    const t = Number(localStorage.getItem(SKIP_KEY));
    return t && Date.now() - t < SKIP_DAYS * 864e5;
  } catch {
    return false;
  }
}

export function createInstall(app) {
  const root = document.getElementById('onboard');
  let installed = false;
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
  });

  function steps() {
    if (DEVICE.ios) {
      return `<ol class="ig-steps">
        <li>画面の<b>共有ボタン</b>(四角から上に矢印が出たアイコン)を押す。見当たらないときは「…」の中にあります</li>
        <li>メニューを下にずらして「<b>ホーム画面に追加</b>」を選ぶ</li>
        <li>「<b>追加</b>」を押して、ホーム画面にできた「縦単」から開く</li>
      </ol>`;
    }
    return `<ol class="ig-steps">
      <li>ブラウザの<b>メニュー</b>(右上の︙など)を開く</li>
      <li>「<b>ホーム画面に追加</b>」または「<b>アプリをインストール</b>」を選ぶ</li>
      <li>ホーム画面にできた「縦単」から開く</li>
    </ol>`;
  }

  function show(done) {
    root.hidden = false;
    const hasData = (app.store.state.card || 0) > 0;
    const render = () => {
      root.innerHTML = `
        <div class="ob ig">
          <div class="ob-logo">${logo()}</div>
          <h1>ホーム画面に追加して使ってください</h1>
          <p class="ob-lead">アプリのように全画面で開けます。一度見た動画や音楽は端末に保存するので、通信量が減り、電波が弱くても止まりにくくなります。</p>
          ${installed
            ? '<p class="ig-done">追加しました。ホーム画面の「縦単」から開いてください。</p>'
            : deferred
              ? '<button class="pill pill-w ig-add" id="igAdd">ホーム画面に追加</button>'
              : steps()}
          ${DEVICE.ios && hasData
            ? '<p class="note">iPhone では、ホーム画面から開いた縦単とこのブラウザとで学習記録が別になります。今までの記録を引き継ぐには、設定の「バックアップを書き出す」で保存し、ホーム画面の縦単で「バックアップを読み込む」を使ってください。</p>'
            : ''}
          <button class="ob-quit" id="igSkip">ブラウザのまま使う</button>
        </div>`;
      root.querySelector('#igAdd')?.addEventListener('click', async () => {
        const e = deferred;
        if (!e) return;
        e.prompt();
        const choice = await e.userChoice.catch(() => null);
        deferred = null;
        if (choice?.outcome === 'accepted') installed = true;
        render();
      });
      root.querySelector('#igSkip').addEventListener('click', () => {
        try { localStorage.setItem(SKIP_KEY, String(Date.now())); } catch { /* 保存できなくても続ける */ }
        root.hidden = true;
        root.replaceChildren();
        done?.();
      });
    };
    render();
    // 合図が少し遅れて来たときは、ボタンに切り替える
    const onPrompt = () => { if (!root.hidden && root.querySelector('.ig')) render(); };
    window.addEventListener('beforeinstallprompt', onPrompt, { once: true });
  }

  return {
    // スマホのブラウザで開いていて、最近「ブラウザのまま使う」を選んでいないとき
    needed: () => DEVICE.mobile && !DEVICE.standalone && !skippedRecently(),
    available: () => DEVICE.mobile && !DEVICE.standalone,
    show,
  };
}
