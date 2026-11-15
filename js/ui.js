// シート、スナックバー、各ページ。
import { icon, logo } from './icons.js';
import { ST, ST_LABEL, SHOWN_STATES, shownState, retrievability, settled, isNew } from './srs.js';
import { markExample, videoCredit } from './feed.js';
import { drillCount } from './scheduler.js';
import { todayKey } from './store.js';
import { DEVICE } from './device.js';
import { RANGE_SIZE, RANGE_LISTS, rangeList, rangeSource, rangeLabel } from './words.js';
import { PWA_ON, storageUsage, clearMedia } from './pwa.js';
import { DEFAULT_LIST, LIST_NAME_MAX, listById, inList, addTo, removeFrom, createList, renameList, deleteList, listWords } from './lists.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_ORDER = SHOWN_STATES;

// アプリを開いていた時間(数字を大きく、単位を小さく)。10時間を超えたら時間だけ(スマホの幅に収まるように)
function openTimeHtml(ms) {
  const m = Math.floor((ms || 0) / 60000);
  const h = Math.floor(m / 60);
  if (!h) return `${m}<small>分</small>`;
  if (h >= 10) return `${h.toLocaleString()}<small>時間</small>`;
  return `${h}<small>時間</small>${m % 60}<small>分</small>`;
}
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
  let currentOpts = {};
  let pageClose = null;
  // 開いた順のページ(前の画面へ戻るため)。1 件ごとに戻るボタン用の重なりも積む
  const pageStack = [];
  const PAGE_STACK_MAX = 30;
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
    if (isNew(rec)) return '<div class="pair"><b>状態</b><span>未出</span></div>';
    const now = Date.now();
    const next = rec.dueCard != null && rec.dueCard > S().card
      ? `あと${rec.dueCard - S().card}枚くらい`
      : rec.due && rec.due > now
        ? humanDuration(rec.due - now)
        : 'もうすぐ';
    const retain = `${Math.round(retrievability(rec, now) * 100)}%`;
    const note = rec.box != null
      ? `(学習枠 ${rec.box}段目)`
      : rec.park
        ? '(いったん後回し)'
        : rec.mkc || rec.lkc
          ? '(数日後に確認)'
          : settled(rec)
            ? '(定着)'
            : rec.st === ST.LIKELY
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
         <button class="pill" data-save-detail>${icon(S().saved[w.id] ? 'bookmarkFill' : 'bookmark', 20)}保存</button>
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
          if (e.target.closest('[data-save-detail]')) {
            openSaveSheet(w, { onChange: fromList?.onSaved });
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

  /* ---------- 保存先(リスト)を選ぶ ---------- */
  // YouTube の「保存先」と同じ形。チェックを入れ外しするとすぐ反映する。onChange({ added }) で呼び元の表示を直す
  const nameInput = (value = '') =>
    `<input class="lname" type="text" maxlength="${LIST_NAME_MAX}" placeholder="リストの名前" value="${esc(value)}" enterkeyhint="done">`;

  function openSaveSheet(word, { onChange } = {}) {
    const st = S();
    let creating = false;
    const html = () => `
      <p class="lword">${esc(word.w)}<small>${esc(word.m[0])}</small></p>
      <div class="lists">${st.lists
        .map((l) => {
          const on = inList(st, l.id, word.id);
          return `<button class="lrow" data-list="${esc(l.id)}" aria-pressed="${on}"><span class="lcheck">${on ? icon('check', 18) : ''}</span><span class="row-tx">${esc(l.name)}<small>${Object.keys(l.items).length}語</small></span></button>`;
        })
        .join('')}</div>
      ${creating
        ? `<form class="lnew">${nameInput()}<button class="pill pill-w" type="submit">作成</button></form>`
        : `<button class="row" data-new-list><span class="row-ic">${icon('add')}</span><span class="row-tx">新しいリスト</span></button>`}`;
    openSheet('保存先', html(), {
      onReady(node) {
        const body = node.querySelector('.sheet-body');
        const draw = () => {
          body.innerHTML = html();
          if (creating) body.querySelector('.lname').focus();
        };
        body.addEventListener('click', (e) => {
          const r = e.target.closest('[data-list]');
          if (r) {
            const l = listById(st, r.dataset.list);
            const added = !inList(st, l.id, word.id);
            if (added) addTo(st, l.id, word.id);
            else removeFrom(st, l.id, word.id);
            store.save();
            draw();
            snack(added ? `「${l.name}」に保存しました` : `「${l.name}」から外しました`);
            onChange?.({ added });
            return;
          }
          if (e.target.closest('[data-new-list]')) {
            creating = true;
            draw();
          }
        });
        body.addEventListener('submit', (e) => {
          e.preventDefault();
          const name = body.querySelector('.lname').value.trim();
          if (!name) return;
          const l = createList(st, name);
          addTo(st, l.id, word.id);
          store.save();
          creating = false;
          draw();
          snack(`「${l.name}」に保存しました`);
          onChange?.({ added: true });
        });
      },
    });
  }

  // 名前を入れるだけのシート(新しいリスト・名前の変更)
  function openNameSheet(title, value, done) {
    openSheet(title, `<form class="lnew">${nameInput(value)}<button class="pill pill-w" type="submit">${value ? '変更' : '作成'}</button></form>`, {
      onReady(node) {
        const input = node.querySelector('.lname');
        input.focus();
        node.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          closeSheetNow();
          done(name);
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
        ${video
          ? video.url
            ? `<a href="${esc(video.url)}" target="_blank" rel="noopener">${icon('link', 18)}<span>${esc(videoCredit(video))}</span></a>`
            : `<p>${icon('link', 18)}<span>${esc(videoCredit(video))}</span></p>`
          : ''}
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
      ${row('review', 'replay', S().settings.review ? '復習モードをやめる' : '復習モード', S().settings.review ? 'おまかせの出題に戻します' : '暗記済み・知ってそうの語を、忘れかけ・難しい語から出題します')}
      ${row('range', 'list', '範囲を決めて出題', '100語ずつに区切った範囲から選びます')}
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
          else if (r.dataset.row === 'review') setMode({ review: !S().settings.review });
          else if (r.dataset.row === 'range') openPage('range');
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

  // replace: 前の画面として積まずに、いまの画面を差し替える
  function openPage(name, opts = {}, { replace = false } = {}) {
    snackEl.classList.remove('on');
    if (currentPage && !replace && !(name === currentPage && sameOpts(opts, currentOpts))) {
      // いまの画面を「前の画面」として積む(戻るボタン・端末の戻るで、ここへ戻る)
      const prev = { name: currentPage, opts: restorable(currentOpts), scroll: page.scrollTop };
      const back = () => {
        const i = pageStack.indexOf(back);
        if (i >= 0) pageStack.splice(i, 1);
        showPage(prev.name, prev.opts, prev.scroll);
      };
      pageStack.push(back);
      pushLayer(back);
      if (pageStack.length > PAGE_STACK_MAX) removeLayer(pageStack.shift());
    }
    if (!currentPage) {
      app.feed.suspend();
      feedView.hidden = true;
      page.hidden = false;
      pageClose = () => {
        pageClose = null;
        currentPage = null;
        currentOpts = {};
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
    showPage(name, opts, 0);
  }

  function showPage(name, opts, scroll) {
    currentPage = name;
    currentOpts = opts;
    setNav(name);
    page.scrollTop = 0;
    RENDER[name](opts);
    if (scroll) page.scrollTop = scroll;
  }
  const sameOpts = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});
  // 戻ったときに繰り返さない指定(検索語の上書き・入力欄へのフォーカス)は外す
  const restorable = ({ q, focus, ...rest } = {}) => rest;

  // ページをすべて閉じてフィードへ
  function closePage() {
    if (!pageClose) return;
    while (pageStack.length) removeLayer(pageStack.pop());
    const close = pageClose;
    removeLayer(close);
    close();
  }

  // 前の画面へ(なければフィードへ)
  function goBack() {
    if (pageStack.length) popLayer();
    else closePage();
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
      <span class="wmeta"><em class="st-t-${st}">${ST_LABEL[st]}</em>${isNew(rec) ? '' : ` ・ ${rec.n}回`}${hidden ? ' ・ 非表示' : ''}</span></span>
    </button>`;
  }

  // 一覧の 1 行。右に保存ボタン(押すと保存先を選ぶ)
  function wordItem(w) {
    const on = !!S().saved[w.id];
    return `<div class="witem">${wordRow(w)}<button class="icon-btn wsave${on ? ' on' : ''}" data-save="${esc(w.id)}" aria-label="保存">${icon(on ? 'bookmarkFill' : 'bookmark', 22)}</button></div>`;
  }

  // onSaved: 保存先が変わったあとに一覧ごと描き直したいとき
  function bindRows(root, onSaved) {
    const refresh = (w) => {
      if (onSaved) return onSaved();
      const on = !!S().saved[w.id];
      root.querySelectorAll(`[data-save="${CSS.escape(w.id)}"]`).forEach((b) => {
        b.classList.toggle('on', on);
        b.innerHTML = icon(on ? 'bookmarkFill' : 'bookmark', 22);
      });
    };
    root.addEventListener('click', (e) => {
      const save = e.target.closest('[data-save]');
      if (save) {
        const w = index.byId.get(save.dataset.save);
        if (w) openSaveSheet(w, { onChange: () => refresh(w) });
        return;
      }
      const r = e.target.closest('.wrow');
      if (!r) return;
      const w = index.byId.get(r.dataset.word);
      if (w) openDetail(w, { fromList: { onSaved: () => refresh(w) } });
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
      list.innerHTML = hits.length ? hits.slice(0, LIST_LIMIT).map(wordItem).join('') : '<p class="empty">該当する単語はありません</p>';
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

  // 保存: リストの一覧。リストを開くと中の単語が並ぶ
  function renderSaved(opts = {}) {
    const st = S();
    const open = opts.list && listById(st, opts.list);
    if (open) return renderList(open);
    const card = (l) => {
      const words = listWords(l).map((id) => index.byId.get(id)).filter(Boolean);
      const top = words[0];
      const cls = top ? THUMB(top)[1] : 'av-empty';
      return `<button class="lcard" data-open-list="${esc(l.id)}">
        <span class="lthumb ${cls}"><b>${top ? esc(top.w) : ''}</b><span class="lcount">${icon('list', 14)}${words.length}</span></span>
        <span class="wmain"><b>${esc(l.name)}</b><span class="wmean">${words.length}語</span></span>
      </button>`;
    };
    page.innerHTML = `${pageHead('保存', `<button class="pill" data-new-list>${icon('add', 20)}新しいリスト</button>`)}
      <div class="page-in">
        <p class="count">保存ボタンを押すと、最後に使ったリストに入ります</p>
        <div class="llist">${st.lists.map(card).join('')}</div>
      </div>`;
    page.querySelector('[data-new-list]').addEventListener('click', () =>
      openNameSheet('新しいリスト', '', (name) => {
        const l = createList(st, name);
        store.save();
        openPage('saved', { list: l.id });
      })
    );
    page.querySelector('.llist').addEventListener('click', (e) => {
      const c = e.target.closest('[data-open-list]');
      if (c) openPage('saved', { list: c.dataset.openList });
    });
  }

  function renderList(l) {
    const st = S();
    const words = listWords(l).map((id) => index.byId.get(id)).filter(Boolean);
    page.scrollTop = 0;
    page.innerHTML = `<header class="page-head"><button class="icon-btn" data-back data-to-lists aria-label="戻る">${icon('back')}</button><h1>${esc(l.name)}</h1><span class="grow"></span>
        ${l.id === DEFAULT_LIST ? '' : `<button class="icon-btn" data-list-menu aria-label="リストの操作">${icon('more')}</button>`}</header>
      <div class="page-in">
        <p class="count">${words.length}語</p>
        ${words.length ? '' : '<p class="empty">フィードや単語帳の保存ボタンで、このリストに単語を入れられます</p>'}
        <div class="wlist" id="savedList">${words.map(wordItem).join('')}</div>
      </div>`;
    const redraw = () => {
      const now = listById(st, l.id);
      if (currentPage === 'saved' && now && page.querySelector('[data-to-lists]')) renderList(now);
    };
    bindRows(page.querySelector('#savedList'), redraw);
    page.querySelector('[data-list-menu]')?.addEventListener('click', () => {
      openSheet(l.name, `${row('rename', 'settings', '名前を変える')}${row('delete', 'block', 'リストを削除', '中の単語の学習記録は消えません')}`, {
        onReady(node) {
          node.addEventListener('click', (e) => {
            const r = e.target.closest('[data-row]');
            if (!r) return;
            closeSheetNow();
            if (r.dataset.row === 'rename') {
              openNameSheet('名前を変える', l.name, (name) => {
                renameList(st, l.id, name);
                store.save();
                redraw();
              });
            } else if (confirm(`「${l.name}」を削除しますか?`)) {
              deleteList(st, l.id);
              store.save();
              snack('リストを削除しました');
              // 一覧から開いたなら一覧へ戻る。そうでなければ、この画面を一覧に差し替える
              if (pageStack.length) goBack();
              else openPage('saved', {}, { replace: true });
            }
          });
        },
      });
    });
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
        <div class="wlist" id="histList">${list.map((x) => wordItem(x.w)).join('')}</div>
      </div>`;
    bindRows(page.querySelector('#histList'));
  }

  function renderYou() {
    const st = S();
    const now = Date.now();
    // 状態ごとの語数(単語・熟語・古典を分けて)。レベルは表示しない
    const statusLine = ([, label, match]) => {
      const c = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
      let total = 0;
      for (const w of index.words) {
        if (!match(w)) continue;
        c[shownState(st.recs[w.id])]++;
        total++;
      }
      if (!total) return '';
      return `<div class="st-table"><h3>${label}<small>${total}語</small></h3>${STATUS_ORDER.map((s) => `<div><span class="st-t-${s}">${ST_LABEL[s]}</span><b>${c[s]}</b></div>`).join('')}</div>`;
    };
    app.tickOpenTime?.();
    const langs = st.settings.scope === 'both' ? ['en', 'kb'] : [st.settings.scope];
    const groups = KIND_GROUPS.filter(([id]) => langs.includes(id.slice(0, 2)));
    page.innerHTML = `
      <div class="page-in you">
        <div class="you-head">
          <span class="you-av">${icon('person', 40)}</span>
          <div><h1>ゲストさん</h1><p>@tatetan ・ データはこの端末だけに保存</p></div>
        </div>
        ${store.saveFailed ? '<p class="warn">学習記録を保存できていません。このまま閉じると、今回の分が消えます。端末やブラウザの空き容量を確認し、設定の「バックアップを書き出す」で記録を残してください。</p>' : ''}
        <div class="stat-row">
          <div><b>${(st.days[todayKey(now)] || 0).toLocaleString()}</b><span>今日の枚数</span></div>
          <div><b>${(st.card || 0).toLocaleString()}</b><span>今までの枚数</span></div>
          <div><b>${openTimeHtml(st.openMs)}</b><span>アプリを開いた時間</span></div>
        </div>
        ${groups.map(statusLine).join('')}
        <div class="rows">
          ${row('range', st.settings.review ? 'replay' : 'list', '出題モード', modeText(st.settings))}
          ${row('history', 'history', '履歴')}
          ${row('saved', 'bookmark', '保存したリスト')}
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

  // スマホだけ: ホーム画面への追加と、端末に保存した素材
  function appSection() {
    if (!DEVICE.mobile) return '';
    return `<h3>アプリ</h3>
        ${app.install.available() ? '<button class="set set-btn" id="setInstall"><span>ホーム画面に追加する方法</span></button>' : ''}
        ${PWA_ON ? '<button class="set set-btn" id="setClearMedia"><span>端末に保存した動画・音楽を消す<small id="setUsage">保存量を調べています…</small></span></button>' : ''}
        <button class="set set-btn" id="setReload"><span>アプリを再読み込み<small>表示がおかしいときに</small></span></button>`;
  }

  function bindAppSection() {
    const $ = (id) => page.querySelector(`#${id}`);
    $('setInstall')?.addEventListener('click', () => app.install.show());
    $('setReload')?.addEventListener('click', () => location.reload());
    const usage = $('setUsage');
    const showUsage = async () => {
      const mb = await storageUsage();
      if (usage) usage.textContent = mb === null ? '一度見た動画や音楽を保存して、通信量を減らしています' : `いま約 ${mb}MB を保存しています`;
    };
    if (usage) showUsage();
    $('setClearMedia')?.addEventListener('click', async () => {
      if (!confirm('端末に保存した動画・音楽・読み上げ音声を消しますか?学習記録は消えません。')) return;
      await clearMedia(app);
      snack('保存した素材を消しました');
      showUsage();
    });
  }

  function renderSettings() {
    const s = S().settings;
    page.innerHTML = `${pageHead('設定')}
      <div class="page-in settings">
        <h3>出題</h3>
        <button class="set set-btn" id="setRange"><span>出題モード<small>${s.review ? '復習モード(暗記済み・知ってそうの語を定着させる)' : s.range ? `${esc(rangeLabel(index, s.range))}だけから出題中` : 'おまかせ(実力に合わせて全体から)'}</small></span>${icon(s.review ? 'replay' : 'list', 20)}</button>
        ${s.range ? '' : select('setScope', '出題する単語', s.scope, [['en', '英単語のみ'], ['kb', '古典単語のみ'], ['both', '両方']])}
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
        ${appSection()}
        <h3>このアプリについて</h3>
        <button class="set set-btn" id="setCredits"><span>クレジット</span></button>
      </div>`;
    const $ = (id) => page.querySelector(`#${id}`);
    const change = (id, fn) => $(id).addEventListener('change', (e) => {
      fn(e.target);
      store.save();
    });
    const restartLater = () => { app.pendingRestart = true; };

    if (!s.range) change('setScope', (t) => { s.scope = t.value; restartLater(); });
    $('setRange').addEventListener('click', () => openPage('range'));
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
    bindAppSection();
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
    const pixabay = manifest.videos.filter((v) => !v.credit);
    const videos = pixabay
      .map((v) => `<li><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.author)}</a><small>${esc(v.tags)}</small></li>`)
      .join('');
    // 音楽は提供元ごとに 1 行(同じ提供元の曲はまとめる)
    const music = new Map();
    for (const t of manifest.bgm) {
      const m = music.get(t.credit) || { url: t.url, titles: [] };
      m.titles.push(t.title);
      music.set(t.credit, m);
    }
    const musicRows = [...music]
      .map(([credit, m]) => `<p><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(credit)}</a>${m.titles.length <= 3 ? ` <small>(${m.titles.map(esc).join('、')})</small>` : ''}</p>`)
      .join('');
    const own = new Map();
    for (const v of manifest.videos) if (v.credit) own.set(v.credit, (own.get(v.credit) || 0) + 1);
    const ownRows = [...own].map(([credit, n]) => `<p>${esc(credit)}(${n}本)</p>`).join('');
    page.innerHTML = `${pageHead('クレジット')}
      <div class="page-in credits">
        <div class="brand">${logo()}<p>縦型単語フィード</p></div>
        <h3>音楽</h3>
        ${musicRows}
        <h3>映像</h3>
        ${ownRows}
        <p>映像：<a href="https://pixabay.com/ja/" target="_blank" rel="noopener">Pixabay</a> の各投稿者(${pixabay.length}本)</p>
        <ul class="credit-list">${videos}</ul>
        <h3>単語データ</h3>
        <p>英単語・英熟語のリスト、意味・例文はこのアプリのために作成しました。古典の用例は、著作権の切れた古典作品の原文と自作の例文(作例と表示)です。現代語訳は自作です。</p>
      </div>`;
  }

  /* ---------- 出題範囲 ---------- */
  // 各リストを易しい順に 100 語ずつ。覚えた語(暗記済み・知ってそう)の割合を棒で見せる
  // 出題モードの表示名
  const modeText = (set) => (set.review ? '復習モード' : set.range ? rangeLabel(index, set.range) : 'おまかせ');
  const inScope = (w) => S().settings.scope === 'both' || w.lang === S().settings.scope;

  // 出題モードを切り替える(おまかせ / 復習モード / 範囲)。ページを開いているなら、閉じたときに流し直す
  function setMode({ review = false, range = null }) {
    const set = S().settings;
    if (review && !drillCount(index.words.filter(inScope), S().recs, S().hidden)) {
      snack('復習できる語(暗記済み・知ってそう)がまだありません');
      return false;
    }
    set.review = review;
    set.range = review ? null : range;
    store.save();
    snack(review ? '復習モードにしました。忘れかけ・難しい語から出します' : set.range ? `${rangeLabel(index, set.range)} から出題します` : 'おまかせの出題に戻しました');
    if (currentPage) app.pendingRestart = true;
    else app.feed.start();
    return true;
  }

  // 出題モードのページ。YouTube の再生リストの並びに寄せる:
  // 上におまかせ・復習モード、下に範囲(チップで英単語・英熟語・古典単語を切り替え、100語ずつを再生リストのように並べる)
  let rangeTab = null;
  function renderRange() {
    const st = S();
    const set = st.settings;
    const cur = set.review ? null : set.range;
    const nDrill = drillCount(index.words.filter(inScope), st.recs, st.hidden);
    const lists = RANGE_LISTS.filter((l) => rangeSource(index, l).length);
    if (!lists.some((l) => l.id === rangeTab)) rangeTab = cur?.list || lists[0]?.id;
    const playing = `<span class="yt-over">${icon('bars', 20)}再生中</span>`;

    const card = (attrs, thumb, title, meta, on, off = false) =>
      `<button class="lcard rg-card${on ? ' on' : ''}" ${attrs}${off ? ' disabled' : ''}>
        ${thumb}
        <span class="wmain"><b>${title}</b><span class="wmean">${meta}</span></span>
      </button>`;
    const modeThumb = (cls, ic, on) => `<span class="lthumb ${cls}${on ? ' playing' : ''}">${icon(ic, 32)}${on ? playing : ''}</span>`;
    const modes = [
      card('data-mode="auto"', modeThumb('av-auto', 'feedFill', !set.review && !cur), 'おまかせ', '実力に合わせて全体から', !set.review && !cur),
      card('data-mode="review"', modeThumb('av-review', 'replay', set.review), '復習モード',
        nDrill ? `暗記済み・知ってそう ${nDrill.toLocaleString()}語` : '暗記済み・知ってそうの語がまだありません', set.review, !nDrill),
    ].join('');

    const rangeCard = (list, start, ws) => {
      let done = 0;
      let learning = 0;
      for (const w of ws) {
        const s = shownState(st.recs[w.id]);
        if (s === ST.MASTERED || s === ST.LIKELY) done++;
        else if (s === ST.LEARNING) learning++;
      }
      const on = !!cur && cur.list === list.id && cur.start === start;
      const full = done === ws.length;
      const prog = done ? `<span class="yt-prog"><i style="width:${Math.round((done / ws.length) * 100)}%"></i></span>` : '';
      const count = full ? `${icon('check', 14)}覚えきった` : `${ws.length}語`;
      const thumb = `<span class="lthumb ${THUMB(ws[0])[1]}${prog ? ' has-prog' : ''}${on ? ' playing' : ''}"><b>${esc(ws[0].w)}</b><span class="lcount">${count}</span>${on ? playing : ''}${prog}</span>`;
      const meta = done || learning ? `覚えた ${done}語${learning ? ` ・ 学習中 ${learning}語` : ''}` : 'まだ始めていません';
      return card(`data-list="${list.id}" data-start="${start}"`, thumb, `${esc(list.label)} ${start + 1}〜${start + ws.length}`, meta, on);
    };
    const rangeCards = () => {
      const list = rangeList(rangeTab);
      if (!list) return '';
      const all = rangeSource(index, list);
      const out = [];
      for (let s = 0; s < all.length; s += RANGE_SIZE) out.push(rangeCard(list, s, all.slice(s, s + RANGE_SIZE)));
      return out.join('');
    };
    const chips = () => lists.map((l) => `<button class="chip${l.id === rangeTab ? ' on' : ''}" data-tab="${l.id}">${esc(l.label)}</button>`).join('');

    page.innerHTML = `${pageHead('出題モード')}
      <div class="page-in range">
        <div class="llist">${modes}</div>
        <h2 class="yt-sec">範囲<small>100語ずつ・易しい順</small></h2>
        <div class="chips rg-chips">${chips()}</div>
        <div class="llist" id="rgList">${rangeCards()}</div>
      </div>`;

    // 選んでいる範囲が下のほうなら、そこまで送る
    const onCard = page.querySelector('#rgList .rg-card.on');
    if (onCard && onCard.getBoundingClientRect().bottom > page.clientHeight) onCard.scrollIntoView({ block: 'center' });

    const apply = (next) => {
      if (setMode(next)) closePage();
    };
    page.querySelector('.range').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        if (tab.dataset.tab === rangeTab) return;
        rangeTab = tab.dataset.tab;
        page.querySelector('.rg-chips').innerHTML = chips();
        page.querySelector('#rgList').innerHTML = rangeCards();
        return;
      }
      const c = e.target.closest('.rg-card');
      if (!c || c.disabled) return;
      if (c.dataset.mode) {
        const review = c.dataset.mode === 'review';
        if (review === !!set.review && !cur) closePage();
        else apply({ review });
        return;
      }
      const range = { list: c.dataset.list, start: Number(c.dataset.start) };
      if (cur && cur.list === range.list && cur.start === range.start) closePage();
      else apply({ range });
    });
  }

  const RENDER = {
    range: renderRange,
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
    openSaveSheet,
    openMore,
    openCreate,
    openPage,
    closePage,
    popLayer,
    pageOpen: () => !!currentPage,
    currentPage: () => currentPage,
  };
}
