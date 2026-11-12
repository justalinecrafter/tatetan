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

// どのブラウザで開いているか。手順がブラウザごとに違うので見分ける
//   inapp: LINE・Instagram などアプリの中の画面(ここからは追加できない)
function detectBrowser() {
  const ua = navigator.userAgent;
  if (/\bLine\/|FBAN|FBAV|Instagram|Twitter|TikTok|musical_ly|Bytedance|YJApp|GSA\/|; wv\)/i.test(ua)) return 'inapp';
  if (DEVICE.ios) {
    if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua)) return 'other';
    return /Version\/[\d.]+.*Safari/.test(ua) ? 'safari' : 'inapp';
  }
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Firefox/.test(ua)) return 'firefox';
  if (/EdgA|OPR\//.test(ua)) return 'other';
  return 'chrome';
}
const BROWSER = detectBrowser();

// 手順の中に出す、ボタンの形
const svg = (d) =>
  `<svg class="ig-g" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const G = {
  share: svg('<path d="M8 10H6v10h12V10h-2"/><path d="M12 3v11"/><path d="m8 7 4-4 4 4"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
  dots: svg('<circle cx="12" cy="5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
};

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

  const list = (items) => `<ol class="ig-steps">${items.map((x) => `<li>${x}</li>`).join('')}</ol>`;
  const copyBtn = '<button class="pill ig-copy" id="igCopy">このページのURLをコピー</button>';

  function steps() {
    const b = BROWSER;
    if (DEVICE.ios) {
      const safari = [
        `画面下の ${G.share} <b>共有</b>を押す(iPad は右上)。見当たらないときは右下の ${G.more} を押すと出ます`,
        '「<b>ホーム画面に追加</b>」を選ぶ(なければ下にずらすか「もっと見る」)',
        '右上の「<b>追加</b>」を押す',
      ];
      if (b === 'safari') return `<p class="ig-for">iPhone(Safari)</p>${list(safari)}`;
      // Safari 以外(Chrome や LINE の中など)では、Safari で開き直してもらう
      return `<p class="ig-for">iPhone</p>
        <p class="ig-warn">iPhone では <b>Safari</b> から追加します。いま開いているのは${b === 'inapp' ? 'アプリの中の画面' : 'Safari 以外のブラウザ'}です。</p>
        ${list([
          `${b === 'inapp' ? 'メニューの「<b>Safariで開く</b>」を選ぶか、' : ''}下のボタンでURLをコピーし、<b>Safari</b> のアドレス欄に貼り付けて開く${copyBtn}`,
          ...safari.map((x, i) => (i === 0 ? `Safari で、${x}` : x)),
        ])}`;
    }
    if (b === 'inapp') {
      return `<p class="ig-for">Android</p>
        <p class="ig-warn">アプリの中の画面からは追加できません。<b>Chrome</b> で開き直してください。</p>
        ${list([
          `メニューの「<b>ブラウザで開く</b>」などを選ぶか、下のボタンでURLをコピーし、Chrome に貼り付けて開く${copyBtn}`,
          `Chrome で右上の ${G.dots} を押し、「<b>ホーム画面に追加</b>」を選ぶ`,
          '「<b>インストール</b>」を押す',
        ])}`;
    }
    if (b === 'samsung') {
      return `<p class="ig-for">Android(Samsung Internet)</p>${list([
        `画面下の ${G.menu} を押す`,
        '「<b>ページを追加</b>」→「<b>ホーム画面</b>」を選ぶ',
        '「<b>追加</b>」を押す',
      ])}`;
    }
    if (DEVICE.android) {
      const name = { chrome: '(Chrome)', firefox: '(Firefox)' }[b] || '';
      return `<p class="ig-for">Android${name}</p>${list([
        `右上(下にあるときは右下)の ${G.dots} を押す`,
        '「<b>アプリをインストール</b>」か「<b>ホーム画面に追加</b>」を選ぶ',
        '「<b>インストール</b>」(または「<b>追加</b>」)を押す',
      ])}`;
    }
    return list([
      'ブラウザの<b>メニュー</b>を開く',
      '「<b>ホーム画面に追加</b>」または「<b>アプリをインストール</b>」を選ぶ',
    ]);
  }

  async function copyUrl(btn) {
    const url = location.origin + location.pathname;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // 古い仕組みでコピーする
      const t = document.createElement('textarea');
      t.value = url;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;opacity:0';
      document.body.append(t);
      t.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      t.remove();
    }
    btn.textContent = ok ? 'コピーしました' : url;
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
      root.querySelector('#igCopy')?.addEventListener('click', (e) => copyUrl(e.currentTarget));
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
