// シート、スナックバー、各ページ。
import { icon, logo } from './icons.js';
import { ST, ST_LABEL, SHOWN_STATES, shownState, retrievability } from './srs.js';
import { dueCount } from './scheduler.js';
import { markExample } from './feed.js';
import { streak, todayKey } from './store.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_ORDER = SHOWN_STATES;
const KIND_GROUPS = [
  ['en-word', '英単語', (w) => w.lang === 'en' && w.kind === 'word'],
  ['en-phrase', '英熟語', (w) => w.lang === 'en' && w.kind === 'phrase'],
  ['kb', '古典単語', (w) => w.lang === 'kb'],
];
const THUMB = (w) => (w.lang === 'kb' ? ['古', 'av-kb'] : w.kind === 'phrase' ? ['熟', 'av-phrase'] : ['単', 'av-word']);
const LIST_LIMIT = 200;

function humanDuration(ms) {
  const m = ms / 60000;
  if (m < 1) return 'すぐ';
  if (m < 60) return `約${Math.round(m)}分後`;
  const h = m / 60;
  if (h < 24) return `約${Math.round(h)}時間後`;
  const d = h / 24;
  if (d < 45) return `約${Math.round(d)}日後`;
  return `約${Math.round(d / 30)}か月後`;
}

function humanAgo(t) {
  const m = (Date.now() - t) / 60000;
  if (m < 1) return 'たった今';
  if (m < 60) return `${Math.floor(m)}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return `${Math.floor(m / 1440)}日前`;
}

export function createUI(app) {
  const { store, index, manifest } = app;
  const S = () => store.state;
  const page = document.getElementById('page');
  const feedView = document.getElementById('feedView');
  const snackEl = document.getElementById('snack');
  const sheetRoot = document.getElementById('sheetRoot');
  const layers = [];
  let snackTimer = 0;
  let currentPage = null;
  let pageClose = null;
  let sheetClose = null;

  /* ---------- 戻るボタン対応 ---------- */
  // 履歴に積むのは番兵の 1 件だけにして、重なりの管理は layers 側で行う。
  // シートの差し替えなどで history.back() が連続しても、ずれないようにするため。
  let guard = false;
  let skipPop = 0;

  function armGuard() {
    if (guard) return;
    history.pushState({ tatetan: 1 }, '');
    guard = true;
  }
  function releaseGuardIfEmpty() {
    if (layers.length || !guard) return;
    guard = false;
    skipPop++;
    history.back();
  }
  function pushLayer(close) {
    layers.push(close);
    armGuard();
  }
  function removeLayer(close) {
    const i = layers.indexOf(close);
    if (i >= 0) layers.splice(i, 1);
    releaseGuardIfEmpty();
  }
  function popLayer() {
    const close = layers.pop();
    close?.();
    releaseGuardIfEmpty();
  }
  window.addEventListener('popstate', () => {
    if (skipPop) {
      skipPop--;
      return;
    }
    guard = false;
    const close = layers.pop();
    close?.();
    if (layers.length) armGuard();
  });

  /* ---------- スナックバー ---------- */
  function snack(text, action) {
    clearTimeout(snackTimer);
    snackEl.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
    snackEl.classList.add('on');
    if (action) {
      snackEl.querySelector('button').addEventListener('click', () => {
        snackEl.classList.remove('on');
        action.run();
      });
    }
    snackTimer = setTimeout(() => snackEl.classList.remove('on'), action ? 4000 : 2400);
  }

  /* ---------- シート ---------- */
  function openSheet(title, bodyHtml, { onReady, wide } = {}) {
    closeSheetNow();
    const node = document.createElement('div');
    node.className = `sheet-wrap${wide ? ' wide' : ''}`;
    node.innerHTML = `
      <div class="sheet-bg"></div>
      <div class="sheet" role="dialog" aria-label="${esc(title)}">
        <div class="sheet-grip"><span></span></div>
        <header class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="閉じる">${icon('close')}</button></header>
        <div class="sheet-body">${bodyHtml}</div>
      </div>`;
    sheetRoot.append(node);
    document.getElementById('feed').classList.add('locked');
    requestAnimationFrame(() => node.classList.add('on'));

    const remove = () => {
      node.classList.remove('on');
      document.getElementById('feed').classList.remove('locked');
      setTimeout(() => node.remove(), 220);
      sheetClose = null;
    };
    sheetClose = remove;
    pushLayer(remove);

    node.querySelector('.sheet-bg').addEventListener('click', popLayer);
    node.querySelector('[data-close]').addEventListener('click', popLayer);

    // つまみを下へドラッグして閉じる
    const sheet = node.querySelector('.sheet');
    const grip = node.querySelector('.sheet-grip');
    let startY = null;
    grip.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      grip.setPointerCapture(e.pointerId);
      sheet.style.transition = 'none';
    });
    grip.addEventListener('pointermove', (e) => {
      if (startY == null) return;
      sheet.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
    });
    grip.addEventListener('pointerup', (e) => {
      if (startY == null) return;
      const moved = e.clientY - startY;
      startY = null;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (moved > 90) popLayer();
    });
    onReady?.(node);
    return node;
  }

  function closeSheetNow() {
    if (!sheetClose) return;
    const close = sheetClose;
    removeLayer(close);
    close();
  }

  /* ---------- 詳細(コメント欄の形) ---------- */
  function comment(handle, cls, body) {
    return `<article class="cmt"><span class="cmt-av ${cls}">${esc(handle.slice(0, 1))}</span><div class="cmt-main"><div class="cmt-h">@${esc(handle)}</div><div class="cmt-b">${body}</div></div></article>`;
  }

  const pairList = (pairs) =>
    pairs.map(([a, b]) => `<div class="pair"><b>${esc(a)}</b><span>${esc(b)}</span></div>`).join('');

  function recordLines(word) {
    const rec = S().recs[word.id];
    const shown = shownState(rec);
    if (!rec || rec.def) return '<div class="pair"><b>状態</b><span>未出</span></div>';
    const now = Date.now();
    const next = rec.dueCard != null && rec.dueCard > S().card
      ? `あと${rec.dueCard - S().card}枚くらい`
      : rec.due && rec.due > now
        ? humanDuration(rec.due - now)
        : 'もうすぐ';
    const retain = rec.st === ST.WATCH ? '判定待ち' : `${Math.round(retrievability(rec, now) * 100)}%`;
    const note = rec.st === ST.WATCH
      ? '(判断材料を集め中)'
      : rec.box != null
        ? `(学習枠 ${rec.box}段目)`
        : rec.park
          ? '(いったん後回し)'
          : rec.im
            ? '(行動からの推定)'
            : '';
    return `<div class="pair"><b>状態</b><span>${ST_LABEL[shown]}${note}</span></div>
      <div class="pair"><b>見た回数</b><span>${rec.n}回</span></div>
      <div class="pair"><b>記憶の推定</b><span>${retain}</span></div>
      <div class="pair"><b>次に出る</b><span>${next}</span></div>`;
  }

  function openDetail(word, { item, fromList } = {}) {
    const w = word;
    const parts = [];
    parts.push(
      comment('意味', 'c1', `<div class="cmt-word">${esc(w.w)}${w.kanji ? ` <small>${esc(w.kanji)}</small>` : ''}${w.ipa ? ` <small>${esc(w.ipa)}</small>` : ''}</div>
        <div class="tag-pos">${esc(w.pos)}</div> ${esc(w.m.join('、'))}`)
    );
    parts.push(
      comment('例文', 'c2', w.ex.map((ex) => `<div class="cmt-ex">${markExample(ex)}${ex.src ? `<small>(${esc(ex.src)})</small>` : ''}<div class="cmt-ja">${esc(ex.ja)}</div></div>`).join(''))
    );
    if (w.syn?.length) parts.push(comment('似た意味', 'c3', pairList(w.syn)));
    if (w.ant?.length) parts.push(comment('反対の意味', 'c4', pairList(w.ant)));
    if (w.phr?.length) parts.push(comment('熟語', 'c5', pairList(w.phr)));
    if (w.conf?.length) parts.push(comment('混同注意', 'c6', pairList(w.conf)));
    if (w.tip) parts.push(comment('覚え方おじさん', 'c8', esc(w.tip)));
    parts.push(comment('あなたの記録', 'c9', recordLines(w)));

    const footer = fromList
      ? `<div class="sheet-foot"><button class="pill pill-w" data-play="${esc(w.id)}">フィードで流す</button>
         <button class="pill" data-toggle-hide="${esc(w.id)}">${S().hidden[w.id] ? '再び出す' : '出さない'}</button></div>`
      : '';

    openSheet('詳細', parts.join('') + footer, {
      onReady(node) {
        node.addEventListener('click', (e) => {
          const fam = e.target.closest('[data-word]');
          if (fam) {
            const target = index.byId.get(fam.dataset.word);
            if (target) {
              closeSheetNow();
              openDetail(target, { fromList: true });
            }
            return;
          }
          const play = e.target.closest('[data-play]');
          if (play) {
            const target = index.byId.get(play.dataset.play);
            closeSheetNow();
            closePage();
            app.ensureScope(target);
            app.feed.start(target);
            return;
          }
          const hide = e.target.closest('[data-toggle-hide]');
          if (hide) {
            setHidden(w, !S().hidden[w.id]);
            hide.textContent = S().hidden[w.id] ? '再び出す' : '出さない';
          }
        });
      },
    });
  }

  function setHidden(word, on) {
    if (on) S().hidden[word.id] = 1;
    else delete S().hidden[word.id];
    store.save();
    snack(on ? 'この単語はもう出しません' : 'また出すようにしました');
  }

  /* ---------- その他メニュー ---------- */
  function row(id, ic, label, sub = '') {
    return `<button class="row" data-row="${id}"><span class="row-ic">${icon(ic)}</span><span class="row-tx">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
  }

  function openMore(item) {
    const w = item.word;
    const track = item.track;
    const video = item.video;
    const body = `
      ${row('hide', 'block', 'この単語を出さない', '単語帳からいつでも戻せます')}
      ${row('credits', 'info', 'クレジットを見る')}
      ${row('settings', 'settings', '設定')}
      <div class="more-credit">
        ${track ? `<a href="${esc(track.url)}" target="_blank" rel="noopener">${icon('music', 18)}<span>${esc(track.credit)} (${esc(track.title)})</span></a>` : ''}
        ${video ? `<a href="${esc(video.url)}" target="_blank" rel="noopener">${icon('link', 18)}<span>映像：Pixabay / ${esc(video.author)}</span></a>` : ''}
      </div>`;
    openSheet('その他', body, {
      onReady(node) {
        node.addEventListener('click', (e) => {
          const r = e.target.closest('[data-row]');
          if (!r) return;
          closeSheetNow();
          if (r.dataset.row === 'hide') {
            setHidden(w, true);
            app.feed.go(1);
          } else if (r.dataset.row === 'credits') openPage('credits');
          else if (r.dataset.row === 'settings') openPage('settings');
        });
      },
    });
  }

  /* ---------- 作成メニュー(中央の +) ---------- */
  function openCreate() {
    const body = `
      ${row('test', 'quiz', '実力テストを受け直す', '簡単な単語から流す基準を測り直します')}
      ${row('library', 'list', '単語帳で探す')}
      ${row('settings', 'settings', '出題の種類を変える')}`;
    openSheet('作成', body, {
      onReady(node) {
        node.addEventListener('click', (e) => {
          const r = e.target.closest('[data-row]');
          if (!r) return;
          closeSheetNow();
          if (r.dataset.row === 'test') app.onboarding.startTest();
          else if (r.dataset.row === 'library') openPage('library', { focus: true });
          else openPage('settings');
        });
      },
    });
  }

  /* ---------- ページ ---------- */
  function setNav(name) {
    document.querySelectorAll('[data-nav]').forEach((b) => {
      const on = b.dataset.nav === name;
      b.classList.toggle('on', on);
      const ic = b.dataset.ic;
      if (ic) b.querySelector('.nav-ic').innerHTML = icon(on ? b.dataset.icOn : ic);
    });
  }

  function openPage(name, opts = {}) {
    snackEl.classList.remove('on');
    if (!currentPage) {
      app.feed.suspend();
      feedView.hidden = true;
      page.hidden = false;
      pageClose = () => {
        pageClose = null;
        currentPage = null;
        page.hidden = true;
        page.replaceChildren();
        feedView.hidden = false;
        setNav('feed');
        const box = document.getElementById('searchInput');
        if (box) box.value = '';
        app.feed.resume();
        app.feed.refreshCurrent();
      };
      pushLayer(pageClose);
    }
    currentPage = name;
    setNav(name);
    page.scrollTop = 0;
    RENDER[name](opts);
  }

  function closePage() {
    if (!pageClose) return;
    const close = pageClose;
    removeLayer(close);
    close();
  }

  function pageHead(title, right = '') {
    return `<header class="page-head"><button class="icon-btn only-m" data-back aria-label="戻る">${icon('back')}</button><h1>${esc(title)}</h1><span class="grow"></span>${right}</header>`;
  }

  page.addEventListener('click', (e) => {
    if (e.target.closest('[data-back]')) popLayer();
  });

  function wordRow(w) {
    const rec = S().recs[w.id];
    const st = shownState(rec);
    const hidden = S().hidden[w.id];
    const [thumb, cls] = THUMB(w);
    return `<button class="wrow" data-word="${esc(w.id)}">
      <span class="wthumb ${cls}">${thumb}</span>
      <span class="wmain"><b>${esc(w.w)}</b><span class="wmean">${esc(w.pos)} ${esc(w.m[0])}</span>
      <span class="wmeta"><em class="st-t-${st}">${ST_LABEL[st]}</em>${rec && !rec.def ? ` ・ ${rec.n}回` : ''}${hidden ? ' ・ 非表示' : ''}</span></span>
    </button>`;
  }

  function bindRows(root) {
    root.addEventListener('click', (e) => {
      const r = e.target.closest('.wrow');
      if (!r) return;
      const w = index.byId.get(r.dataset.word);
      if (w) openDetail(w, { fromList: true });
    });
  }

  const library = { q: '', status: 'all', lang: 'all' };

  function renderLibrary(opts) {
    if (opts.q != null) library.q = opts.q;
    const chip = (group, id, label) =>
      `<button class="chip${library[group] === id ? ' on' : ''}" data-chip="${group}" data-v="${id}">${esc(label)}</button>`;
    page.innerHTML = `${pageHead('単語帳')}
      <div class="page-in">
        <div class="search-row only-m"><span>${icon('search', 20)}</span><input id="libSearch" type="search" placeholder="単語や意味で検索" value="${esc(library.q)}" enterkeyhint="search"></div>
        <div class="chips">${chip('status', 'all', 'すべて')}${STATUS_ORDER.map((s) => chip('status', s, ST_LABEL[s])).join('')}</div>
        <div class="chips">${chip('lang', 'all', 'すべて')}${KIND_GROUPS.map(([id, label]) => chip('lang', id, label)).join('')}</div>
        <p class="count" id="libCount"></p>
        <div class="wlist" id="libList"></div>
      </div>`;
    const list = page.querySelector('#libList');
    const countEl = page.querySelector('#libCount');
    const draw = () => {
      const q = library.q.trim().toLowerCase();
      const hits = index.words.filter((w) => {
        const st = shownState(S().recs[w.id]);
        if (library.status !== 'all' && st !== library.status) return false;
        if (library.lang !== 'all' && !KIND_GROUPS.find((g) => g[0] === library.lang)?.[2](w)) return false;
        if (!q) return true;
        return w.w.toLowerCase().includes(q) || w.m.some((m) => m.includes(q)) || (w.kanji || '').includes(q);
      });
      countEl.textContent = `${hits.length}語${hits.length > LIST_LIMIT ? `(先頭${LIST_LIMIT}語を表示)` : ''}`;
      list.innerHTML = hits.length ? hits.slice(0, LIST_LIMIT).map(wordRow).join('') : '<p class="empty">該当する単語はありません</p>';
    };
    draw();
    bindRows(list);
    page.querySelectorAll('.chip').forEach((c) => {
      c.addEventListener('click', () => {
        library[c.dataset.chip] = c.dataset.v;
        page.querySelectorAll(`.chip[data-chip="${c.dataset.chip}"]`).forEach((x) => x.classList.toggle('on', x === c));
        draw();
      });
    });
    const input = page.querySelector('#libSearch');
    input.addEventListener('input', () => {
      library.q = input.value;
      draw();
    });
    app.redrawLibrary = (q) => {
      library.q = q;
      input.value = q;
      draw();
    };
    if (opts.focus && window.innerWidth < 768) input.focus();
  }

  function renderSaved() {
    const st = S();
    const ids = Object.keys(st.saved).sort((a, b) => st.saved[b] - st.saved[a]);
    const words = ids.map((id) => index.byId.get(id)).filter(Boolean);
    page.innerHTML = `${pageHead('保存した単語')}
      <div class="page-in">
        <p class="count">${words.length}語</p>
        ${words.length ? '' : '<p class="empty">右の保存ボタンで残した単語がここに並びます</p>'}
        <div class="wlist" id="savedList">${words.map(wordRow).join('')}</div>
      </div>`;
    bindRows(page.querySelector('#savedList'));
  }

  function renderHistory() {
    const seen = new Set();
    const list = [];
    for (let i = S().history.length - 1; i >= 0; i--) {
      const h = S().history[i];
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      const w = index.byId.get(h.id);
      if (w) list.push({ w, t: h.t });
    }
    page.innerHTML = `${pageHead('履歴')}
      <div class="page-in">
        ${list.length ? '' : '<p class="empty">まだ何も見ていません</p>'}
        <div class="wlist" id="histList">${list.map((x) => wordRow(x.w)).join('')}</div>
      </div>`;
    bindRows(page.querySelector('#histList'));
  }

  function renderYou() {
    const st = S();
    const now = Date.now();
    // 状態ごとの語数(単語・熟語・古典を分けて)。レベルは表示しない
    const statusLine = ([, label, match]) => {
      const c = { new: 0, learning: 0, known: 0, mastered: 0 };
      let total = 0;
      for (const w of index.words) {
        if (!match(w)) continue;
        c[shownState(st.recs[w.id])]++;
        total++;
      }
      if (!total) return '';
      return `<div class="st-table"><h3>${label}<small>${total}語</small></h3>${STATUS_ORDER.map((s) => `<div><span class="st-t-${s}">${ST_LABEL[s]}</span><b>${c[s]}</b></div>`).join('')}</div>`;
    };
    const due = dueCount(index.words.filter((w) => st.settings.scope === 'both' || w.lang === st.settings.scope), st.recs, now, st.card);
    const langs = st.settings.scope === 'both' ? ['en', 'kb'] : [st.settings.scope];
    const groups = KIND_GROUPS.filter(([id]) => langs.includes(id.slice(0, 2)));
    page.innerHTML = `
      <div class="page-in you">
        <div class="you-head">
          <span class="you-av">${icon('person', 40)}</span>
          <div><h1>ゲストさん</h1><p>@tatetan ・ データはこの端末だけに保存</p></div>
        </div>
        <div class="stat-row">
          <div><b>${st.days[todayKey(now)] || 0}</b><span>今日の枚数</span></div>
          <div><b>${streak(st.days, now)}</b><span>連続日数</span></div>
          <div><b>${due}</b><span>復習待ち</span></div>
        </div>
        ${groups.map(statusLine).join('')}
        <div class="rows">
          ${row('history', 'history', '履歴')}
          ${row('saved', 'bookmark', '保存した単語')}
          ${row('library', 'list', '単語帳')}
          ${row('settings', 'settings', '設定')}
          ${row('credits', 'info', 'クレジット')}
        </div>
      </div>`;
    page.querySelector('.rows').addEventListener('click', (e) => {
      const r = e.target.closest('[data-row]');
      if (r) openPage(r.dataset.row);
    });
  }

  function select(id, label, value, options) {
    return `<label class="set"><span>${esc(label)}</span><select id="${id}">${options
      .map(([v, l]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`)
      .join('')}</select></label>`;
  }
  function toggle(id, label, value, sub = '') {
    return `<label class="set"><span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span><input id="${id}" type="checkbox" class="sw"${value ? ' checked' : ''}></label>`;
  }

  function renderSettings() {
    const s = S().settings;
    page.innerHTML = `${pageHead('設定')}
      <div class="page-in settings">
        <h3>出題</h3>
        ${select('setScope', '出題する単語', s.scope, [['en', '英単語のみ'], ['kb', '古典単語のみ'], ['both', '両方']])}
        ${select('setDir', '英単語の出題順', s.reverse ? 'rev' : 'std', [['std', '英語 → 日本語'], ['rev', '日本語 → 英語']])}
        <button class="set set-btn" id="setTest"><span>実力テストを受け直す<small>簡単な単語から流す基準を測り直します</small></span>${icon('quiz', 20)}</button>
        <h3>音</h3>
        ${toggle('setTts', '英語の読み上げ', s.tts, '古典単語は読み上げません')}
        ${toggle('setTtsEx', '答えを開いたら例文も読む', s.ttsExample)}
        ${select('setRate', '読み上げの速さ', s.ttsRate, [[0.75, 'ゆっくり'], [0.95, 'ふつう'], [1.15, '速い']])}
        ${toggle('setBgm', 'BGM', s.bgm)}
        <label class="set"><span>BGM の音量</span><input id="setVol" type="range" min="0" max="1" step="0.05" value="${s.bgmVol}"></label>
        ${select('setMode', 'BGM の流れ方', s.bgmMode, [['swipe', 'スワイプごとに曲が変わる'], ['continuous', '1曲ずつ最後まで流す']])}
        <h3>映像</h3>
        ${toggle('setVideo', '背景動画', s.video, 'オフにすると通信量を抑えられます')}
        <h3>データ</h3>
        <button class="set set-btn" id="setExport"><span>バックアップを書き出す</span></button>
        <button class="set set-btn" id="setImport"><span>バックアップを読み込む</span></button>
        <input id="setImportFile" type="file" accept="application/json,.json" hidden>
        <button class="set set-btn danger" id="setReset"><span>学習データをすべて消す</span></button>
        <p class="note">学習データはこの端末のブラウザにだけ保存されます。ブラウザのデータを消すと失われるので、ときどき書き出してください。</p>
        <h3>このアプリについて</h3>
        <button class="set set-btn" id="setCredits"><span>クレジット</span></button>
      </div>`;
    const $ = (id) => page.querySelector(`#${id}`);
    const change = (id, fn) => $(id).addEventListener('change', (e) => {
      fn(e.target);
      store.save();
    });
    const restartLater = () => { app.pendingRestart = true; };

    change('setScope', (t) => { s.scope = t.value; restartLater(); });
    change('setDir', (t) => { s.reverse = t.value === 'rev'; restartLater(); });
    change('setTts', (t) => { s.tts = t.checked; });
    change('setTtsEx', (t) => { s.ttsExample = t.checked; });
    change('setRate', (t) => { s.ttsRate = Number(t.value); });
    change('setBgm', (t) => { s.bgm = t.checked; app.bgm.refreshLevel(); });
    change('setVol', (t) => { s.bgmVol = Number(t.value); app.bgm.refreshLevel(); });
    change('setMode', (t) => { s.bgmMode = t.value; restartLater(); });
    change('setVideo', (t) => { s.video = t.checked; app.feed.setVideoEnabled(); });
    $('setTest').addEventListener('click', () => app.onboarding.startTest());
    $('setCredits').addEventListener('click', () => openPage('credits'));
    $('setExport').addEventListener('click', () => {
      const blob = new Blob([store.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tatetan-backup-${todayKey()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('setImport').addEventListener('click', () => $('setImportFile').click());
    $('setImportFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        store.importJson(await file.text());
        snack('読み込みました');
        location.reload();
      } catch (err) {
        snack(`読み込めませんでした: ${err.message}`);
      }
    });
    $('setReset').addEventListener('click', () => {
      if (!confirm('学習データをすべて消します。元に戻せません。よろしいですか?')) return;
      store.reset();
      location.reload();
    });
  }

  function renderCredits() {
    const videos = manifest.videos
      .map((v) => `<li><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.author)}</a><small>${esc(v.tags)}</small></li>`)
      .join('');
    page.innerHTML = `${pageHead('クレジット')}
      <div class="page-in credits">
        <div class="brand">${logo()}<p>縦型単語フィード</p></div>
        <h3>音楽</h3>
        <p><a href="https://maou.audio/" target="_blank" rel="noopener">音楽：魔王魂</a></p>
        <h3>映像</h3>
        <p>映像：<a href="https://pixabay.com/ja/" target="_blank" rel="noopener">Pixabay</a> の各投稿者(${manifest.videos.length}本)</p>
        <ul class="credit-list">${videos}</ul>
        <h3>単語データ</h3>
        <p>英単語・英熟語のリスト、意味・例文はこのアプリのために作成しました。古典の用例は、著作権の切れた古典作品の原文と自作の例文(作例と表示)です。現代語訳は自作です。</p>
      </div>`;
  }

  const RENDER = {
    library: renderLibrary,
    saved: renderSaved,
    history: renderHistory,
    you: renderYou,
    settings: renderSettings,
    credits: renderCredits,
  };

  return {
    snack,
    openDetail,
    openMore,
    openCreate,
    openPage,
    closePage,
    popLayer,
    pageOpen: () => !!currentPage,
    currentPage: () => currentPage,
  };
}
