// 縦スクロールのフィード本体。
// スクロールはブラウザ標準の scroll-snap に任せ(指に吸い付く感触を保つため)、
// 中身と動画要素だけを現在位置の周辺に限って差し替える。
import { icon } from './icons.js';
import { ST_LABEL, shownState } from './srs.js';
import { newSession, next as pickNextCard, commit, advance, stepBack, markDifficult, isMarked } from './engine.js';
import { Shuffler } from './media.js';
import { DEVICE, debugLog } from './device.js';
import { fitAll } from './fit.js';

const VIDEO_POOL = 4;
const RENDER_BEHIND = 2;
const RENDER_AHEAD = 3;
const DOUBLE_TAP_MS = 280;
// 読み込み中のまま動かない動画を差し替えるまでの時間
// (Service Worker が動いているときは 1 本まるごと保存してから再生するので長めに待つ)
const STALL_MS = navigator.serviceWorker?.controller ? 20000 : 9000;

// チャンネル名は種類ごと(難易度は出さない)
const CHANNELS = {
  'en-word': ['放課後えいご部', '共テ対策ちゃんねる', '赤本は友達', '通学電車の英単語'],
  'en-phrase': ['熟語しか勝たん', '句動詞研究会', 'イディオム沼'],
  'kb-word': ['平安貴族の朝活', 'いとをかしチャンネル', '国語便覧の住人'],
};
const AVATAR = { 'en-word': ['単', 'av-word'], 'en-phrase': ['熟', 'av-phrase'], 'kb-word': ['古', 'av-kb'] };
const TAG = { 'en-word': '#英単語', 'en-phrase': '#英熟語', 'kb-word': '#古文単語' };
const kindKey = (w) => `${w.lang}-${w.kind === 'phrase' ? 'phrase' : 'word'}`;

const TITLES = [
  '【悲報】この単語、まだ覚えてない人がいるらしい',
  '3秒で覚えてください',
  'これ知らないと恥かくやつ',
  '9割が間違える(当社調べ)',
  '先生には内緒で覚えろ',
  '通学中に見る用',
  '寝る前に見ると夢に出る単語',
  '知ってたら天才(たぶん)',
  'テストに出ます(知らんけど)',
  '1回で覚えたら教えてください',
  'この単語で人生変わりました(変わってない)',
  'スワイプする指を止めた君は正しい',
];
const TITLES_BY_REASON = {
  box: ['さっきの、もう忘れてません?', '再登場です。覚えてますか?', 'もう一回いきます'],
  review: ['また会いましたね', '覚えてるか確かめに来ました', '再登場です。覚えてますか?'],
  warmup: ['おかえりなさい。まずは復習から', '準備運動です'],
  check: ['抜き打ちです', '前に暗記したやつです。まさか忘れてませんよね', '昔の単語が帰ってきました'],
  ahead: ['念のためもう一回', 'そろそろ忘れる頃かと思って'],
  easy: ['これは余裕ですよね?', '小手調べ'],
  stretch: ['ちょっと背伸びしてみる', '上級者向け(知らなくて当然)', 'レア単語が出ました'],
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const markExample = (ex) => {
  let html = esc(ex.t);
  if (html.includes('{')) return html.replace(/\{([^}]+)\}/g, '<mark>$1</mark>');
  if (ex.hl) return html.replace(esc(ex.hl), `<mark>${esc(ex.hl)}</mark>`);
  return html;
};

const plainExample = (ex) => ex.t.replace(/[{}]/g, '');
const randomOf = (list) => list[Math.floor(Math.random() * list.length)];

export function createFeed(app) {
  const { store, index, manifest, bgm, tts } = app;
  const el = document.getElementById('feed');
  const view = document.getElementById('feedView');
  const videoShuffler = new Shuffler(manifest.videos, 12);

  let items = [];
  let active = -1;
  let imp = null;
  let suspended = true;
  let userPaused = false;
  let ses = newSession();
  let speakTimer = null;
  let scrollFrame = 0;
  let lastTap = { t: 0, x: 0, y: 0, i: -1 };
  let tapTimer = null;
  let wheelLock = 0;
  let pendingWord = null;

  const S = () => store.state;
  const settings = () => S().settings;

  /* ---------- 動画プール ---------- */
  const pool = Array.from({ length: VIDEO_POOL }, makeVideo);

  function makeVideo() {
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    for (const a of ['muted', 'playsinline', 'webkit-playsinline', 'disableremoteplayback']) v.setAttribute(a, '');
    v.addEventListener('loadeddata', () => {
      v.classList.add('ready');
      if (v._kick) {
        v._kick = false;
        if (v._item !== items[active]) {
          v.pause();
          try { v.currentTime = 0; } catch { /* 読み込み途中は無視 */ }
        }
      }
    });
    v.addEventListener('playing', () => {
      v.classList.add('ready');
      clearTimeout(v._stall);
      if (v._item) setBuffering(v._item, false);
    });
    v.addEventListener('waiting', () => {
      if (v._item && v._item === items[active]) {
        setBuffering(v._item, true);
        watchStall(v);
      }
    });
    v.addEventListener('error', () => {
      if (!v._item || !v.getAttribute('src')) return;
      debugLog(`video error: ${v.error?.code}`);
      replaceVideo(v);
    });
    return v;
  }

  // 読み込めない・止まったままの動画は別の動画に差し替える
  function replaceVideo(v) {
    const it = v._item;
    clearTimeout(v._stall);
    it.videoErrors = (it.videoErrors || 0) + 1;
    if (it.videoErrors > 3) return; // 背景のグラデーションだけで続行する
    it.video = videoShuffler.next(true);
    v._url = null;
    bindVideo(v, it);
    if (it === items[active] && !userPaused && !suspended) v.play().catch(() => {});
  }

  // 電波が弱いと読み込み中のまま固まることがあるので、しばらく待って差し替える
  function watchStall(v) {
    clearTimeout(v._stall);
    v._stall = setTimeout(() => {
      if (v._item && v._item === items[active] && !userPaused && !suspended && v.readyState < 3) {
        debugLog('video stalled');
        replaceVideo(v);
      }
    }, STALL_MS);
  }

  // 使わなくなった動画の読み込みを止めて、スマホの通信と映像処理を空ける
  function releaseVideo(v) {
    v.pause();
    clearTimeout(v._stall);
    v._item = null;
    if (DEVICE.mobile && v.getAttribute('src')) {
      v._url = null;
      v._kick = false;
      v.classList.remove('ready');
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
  }

  function setBuffering(item, on) {
    const box = item.slide.querySelector('.spin');
    if (box) box.classList.toggle('on', on);
  }

  function videoUrl(item) {
    return manifest.videoBase + encodeURIComponent(item.video.f);
  }

  function bindVideo(v, item) {
    v._item = item;
    const box = item.slide.querySelector('.vbox');
    if (box && v.parentNode !== box) box.prepend(v);
    const url = videoUrl(item);
    if (v._url !== url) {
      v._url = url;
      v.classList.remove('ready');
      v.src = url;
      v.load();
      v._kick = DEVICE.ios; // iOS は再生を始めないと先読みしない
    }
  }

  function refreshVideos() {
    if (!settings().video || !manifest.videos.length) {
      for (const v of pool) {
        v.pause();
        v._item = null;
        v.remove();
      }
      return;
    }
    const saveData = navigator.connection?.saveData;
    // スマホは今の動画と次の動画(と戻ったとき用の直前の動画)だけにする
    const order = saveData
      ? [active, active + 1]
      : DEVICE.mobile
        ? [active, active + 1, active - 1]
        : [active, active + 1, active + 2, active - 1];
    const wanted = order.map((i) => items[i]).filter(Boolean);
    const free = pool.filter((v) => !v._item || !wanted.includes(v._item));
    for (const item of wanted) {
      let v = pool.find((x) => x._item === item);
      if (!v) v = free.shift();
      if (v) bindVideo(v, item);
    }
    for (const v of free) {
      if (!wanted.includes(v._item)) releaseVideo(v);
    }
    syncPlayback();
  }

  function syncPlayback() {
    const cur = items[active];
    for (const v of pool) {
      if (v._item && v._item === cur && !suspended && !userPaused) {
        v.play().catch((e) => debugLog(`video play: ${e?.name}`));
        if (v.readyState < 3) watchStall(v);
      } else if (v._item && v._kick && !suspended) {
        v.play().catch(() => {});
      } else if (!v.paused) {
        v.pause();
      }
    }
  }

  /* ---------- スライド生成 ---------- */
  function makeItem(word, why) {
    const item = {
      word,
      why,
      video: videoShuffler.next(),
      track: bgm.shuffler.next(),
      revealed: false,
      title: pickTitle(word, why),
      channel: randomOf(CHANNELS[kindKey(word)]),
      snaps: [],
      hue: Math.floor(Math.random() * 360),
      slide: null,
    };
    const slide = document.createElement('section');
    slide.className = 'slide';
    slide.dataset.i = items.length;
    item.slide = slide;
    items.push(item);
    el.append(slide);
    return item;
  }

  function pickTitle(word, why) {
    if (word.lang === 'kb' && Math.random() < 0.2) return 'いとをかしと思ったら暗記';
    const pool = TITLES_BY_REASON[why];
    return randomOf(pool && Math.random() < 0.75 ? pool : TITLES);
  }

  function ensureItems() {
    while (items.length < active + RENDER_AHEAD + 2) {
      if (pendingWord) {
        makeItem(pendingWord, 'manual');
        pendingWord = null;
        continue;
      }
      const picked = pickNextCard(S(), ses, index, {
        now: Date.now(),
        queued: items.slice(Math.max(0, active + 1)).map((it) => it.word.id),
        scope: settings().scope,
      });
      if (!picked) break;
      makeItem(picked.word, picked.why);
    }
  }

  function statusOf(word) {
    return shownState(S().recs[word.id]);
  }

  function fitSize(text, width, ratio, max, min) {
    const len = [...text].length;
    return Math.max(min, Math.min(max, Math.floor(width / (len * ratio))));
  }

  function frontHtml(item, width) {
    const w = item.word;
    if (w.lang === 'en' && settings().reverse) {
      const meaning = w.m.slice(0, 2).join('、');
      return `<div class="t-word ja" style="font-size:${fitSize(meaning, width * 1.6, 1.02, 40, 26)}px">${esc(meaning)}</div>
        <div class="t-sub"><span class="t-pos">${esc(w.pos)}</span></div>`;
    }
    const ratio = w.lang === 'kb' ? 1.04 : 0.58;
    const size = fitSize(w.w, width, ratio, 60, 28);
    const sub = w.lang === 'en'
      ? `<div class="t-sub"><span class="t-ipa">${esc(w.ipa || '')}</span><button class="t-speak" data-act="speak" aria-label="読み上げ">${icon('volumeUp', 18)}</button></div>`
      : `<div class="t-sub"><span class="t-pos">${esc(w.pos)}</span></div>`;
    return `<div class="t-word ${w.lang === 'kb' ? 'ja' : ''}"${w.lang === 'kb' ? '' : ' data-fit'} style="font-size:${size}px">${esc(w.w)}</div>${sub}`;
  }

  function pairsLine(cls, mark, pairs) {
    if (!pairs || !pairs.length) return '';
    return `<div class="${cls}"><span class="t-mark">${mark}</span>${pairs
      .slice(0, 2)
      .map(([a, b]) => `<b>${esc(a)}</b> ${esc(b)}`)
      .join('<i>/</i>')}</div>`;
  }

  function backHtml(item, width) {
    const w = item.word;
    const ex = w.ex[0];
    const reversed = w.lang === 'en' && settings().reverse;
    const head = reversed
      ? `<div class="t-answer en" data-fit style="font-size:${fitSize(w.w, width, 0.58, 44, 26)}px">${esc(w.w)}</div>
         <div class="t-sub"><span class="t-ipa">${esc(w.ipa || '')}</span><button class="t-speak" data-act="speak" aria-label="読み上げ">${icon('volumeUp', 18)}</button></div>`
      : `<div class="t-answer">${w.lang === 'en' ? `<span class="t-pos">${esc(w.pos)}</span>` : ''}${esc(w.m.slice(0, 3).join('、'))}</div>
         ${w.kanji ? `<div class="t-kanji">漢字: ${esc(w.kanji)}</div>` : ''}`;
    return `${head}
      <div class="t-ex">${markExample(ex)}${ex.src ? `<span class="t-src">(${esc(ex.src)})</span>` : ''}</div>
      <div class="t-exja">${esc(ex.ja)}</div>
      ${pairsLine('t-line', '≒', w.syn)}
      ${w.phr && w.phr.length ? pairsLine('t-line', '句', w.phr.slice(0, 1)) : ''}
      ${w.tip ? `<div class="t-tip">${esc(w.tip)}</div>` : ''}`;
  }

  function actionBtn(act, name, label, on = false) {
    return `<button class="act${on ? ' on' : ''}" data-act="${act}" aria-label="${label}"><span class="act-ic">${icon(name, 26)}</span><span class="act-lb">${label}</span></button>`;
  }

  // 暗記ボタンの見た目。利用者が暗記済みにした語だけ点灯する(行動からの推定で暗記済みになった語は押せば確定する)
  function advanceLook(word) {
    return isMarked(S().recs[word.id])
      ? { name: 'thumbUpFill', label: '暗記済み', on: true }
      : { name: 'thumbUp', label: '暗記', on: false };
  }

  function fill(item) {
    const w = item.word;
    const st = S();
    const status = statusOf(w);
    const width = Math.max(180, playerWidth() - 96);
    const saved = !!st.saved[w.id];
    const muted = settings().muted || !bgm.unlocked;
    const kk = kindKey(w);
    const [avText, avClass] = AVATAR[kk];
    const look = advanceLook(w);
    item.slide.classList.toggle('revealed', item.revealed);
    item.slide.innerHTML = `
      <div class="player">
        <div class="vbox" style="background:linear-gradient(160deg,hsl(${item.hue} 45% 22%),hsl(${(item.hue + 50) % 360} 40% 9%))"></div>
        <div class="scrim"></div>
        <div class="dim"></div>
        <div class="spin"></div>
        <div class="ptop">
          <button class="pbtn" data-act="pause" aria-label="一時停止">${icon(userPaused ? 'play' : 'pause')}</button>
          <button class="pbtn pmute" data-act="mute" aria-label="ミュート切替">${icon(muted ? 'volumeOff' : 'volumeUp')}<span class="hint"${bgm.unlocked ? ' hidden' : ''}>タップで音声ON</span></button>
          <span class="grow"></span>
          <button class="pbtn only-m" data-act="search" aria-label="検索">${icon('search')}</button>
          <button class="pbtn only-m" data-act="settings" aria-label="設定">${icon('settings')}</button>
        </div>
        <div class="telop">
          <div class="t-front">${frontHtml(item, width)}</div>
          <div class="t-back">${backHtml(item, width)}</div>
          ${st.card < 8 ? '<div class="t-hint">タップで答え / ダブルタップで暗記</div>' : ''}
        </div>
        <div class="meta">
          <div class="ch-row">
            <span class="avatar ${avClass}">${avText}</span>
            <span class="ch">@${esc(item.channel)}</span>
            <button class="sub st-${status}" data-act="detail">${ST_LABEL[status]}</button>
          </div>
          <div class="title">${esc(item.title)} <span class="tags">${TAG[kk]} #縦単</span></div>
          <div class="ticker" data-act="more">${icon('music', 14)}<span class="ticker-tx">${tickerText(item)}</span></div>
        </div>
        <div class="progress"><span></span></div>
      </div>
      <div class="actions">
        ${actionBtn('advance', look.name, look.label, look.on)}
        ${actionBtn('dislike', item.disliked ? 'thumbDownFill' : 'thumbDown', '苦手', !!item.disliked)}
        ${actionBtn('detail', 'comment', '詳細')}
        ${actionBtn('save', saved ? 'bookmarkFill' : 'bookmark', '保存', saved)}
        ${actionBtn('share', 'share', '共有')}
        ${actionBtn('more', 'more', 'その他')}
        <button class="disc" data-act="more" aria-label="使用している素材" style="background:linear-gradient(135deg,hsl(${item.hue} 70% 45%),hsl(${(item.hue + 80) % 360} 70% 30%))">${icon('music', 16)}</button>
      </div>`;
    item.filled = true;
    fitAll(item.slide);
  }

  function tickerText(item) {
    const track = settings().bgmMode === 'continuous' ? bgm.want || item.track : item.track;
    const music = track ? `${esc(track.title)} ・ ${esc(track.credit)}` : '';
    return `${music} ・ 映像：Pixabay / ${esc(item.video?.author || '')}`;
  }

  function clear(item) {
    for (const v of pool) if (v._item === item && v.parentNode) v.remove();
    item.slide.replaceChildren();
    item.filled = false;
  }

  function renderWindow() {
    for (let i = 0; i < items.length; i++) {
      const near = i >= active - RENDER_BEHIND && i <= active + RENDER_AHEAD;
      if (near && !items[i].filled) fill(items[i]);
      else if (!near && items[i].filled) clear(items[i]);
    }
  }

  function updateChrome(item) {
    if (!item.filled) return;
    const status = statusOf(item.word);
    const q = (s) => item.slide.querySelector(s);
    const sub = q('.sub');
    if (sub) {
      sub.className = `sub st-${status}`;
      sub.textContent = ST_LABEL[status];
    }
    const look = advanceLook(item.word);
    const adv = q('[data-act="advance"]');
    if (adv) {
      adv.classList.toggle('on', look.on);
      adv.querySelector('.act-ic').innerHTML = icon(look.name, 26);
      adv.querySelector('.act-lb').textContent = look.label;
      adv.setAttribute('aria-label', look.label);
    }
    setAct(q('[data-act="dislike"]'), !!item.disliked, 'thumbDown', 'thumbDownFill');
    setAct(q('[data-act="save"]'), !!S().saved[item.word.id], 'bookmark', 'bookmarkFill');
  }

  function setAct(btn, on, off, onIcon) {
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.querySelector('.act-ic').innerHTML = icon(on ? onIcon : off, 26);
  }

  function playerWidth() {
    const h = el.clientHeight || window.innerHeight;
    const w = el.clientWidth || window.innerWidth;
    return window.innerWidth >= 768 ? Math.min(w, (h - 24) * (9 / 16)) : w;
  }

  /* ---------- 視聴の記録 ---------- */
  function beginImpression(item, opts = {}) {
    imp = {
      start: Date.now(),
      revealAt: null,
      revealed: false,
      detail: false,
      replay: false,
      saved: false,
      manual: item.why === 'manual' || !!opts.manual,
      returned: !!item.seen && !opts.manual,
      item,
    };
    item.seen = true;
  }

  // 明示的な操作(暗記・苦手)をしたカードは、行動からの推定をしない
  const isExplicit = (item) => item.snaps.length > 0 || !!item.disliked;

  function commitImpression() {
    if (!imp) return;
    const current = imp;
    imp = null;
    const now = Date.now();
    const total = now - current.start;
    const explicit = isExplicit(current.item);
    // 指が通過しただけの 1 枚は見なかったことにする
    if (total < 250 && !explicit && !current.revealed) return;

    const w = current.item.word;
    const { fx } = commit(S(), ses, index, w, {
      frontMs: (current.revealAt || now) - current.start,
      backMs: current.revealAt ? now - current.revealAt : 0,
      revealed: current.revealed,
      detail: current.detail,
      returned: current.returned,
      manual: current.manual,
      replay: current.replay,
      saved: current.saved,
      explicit,
    }, { now, why: current.item.why });
    updateChrome(current.item);
    if (fx === 'graduate') celebrate('graduate', w);
    store.save();
  }

  // 学習枠の卒業(学習中 → 暗記済み)を、次のカードの上に短く知らせる
  function celebrate(kind, word) {
    const node = document.createElement('div');
    node.className = `cele cele-${kind}`;
    node.innerHTML = `${icon('school', 22)}<span><b>${esc(word.w)}</b>覚えた!</span>`;
    view.append(node);
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 2600);
    navigator.vibrate?.(8);
  }

  /* ---------- 現在位置の切替 ---------- */
  function setActive(i) {
    if (i === active || !items[i]) return;
    const prev = items[active];
    commitImpression();
    clearTimeout(speakTimer);
    tts.cancel();
    clearTimeout(tapTimer);
    tapTimer = null;
    lastTap.t = 0;
    active = i;
    userPaused = false;
    if (prev) {
      prev.slide.classList.remove('active');
      // 戻ってきたら問題の状態から始める(スナップが終わるのを待って隠す)
      setTimeout(() => {
        if (items[active] !== prev) {
          prev.revealed = false;
          prev.slide.classList.remove('revealed');
        }
      }, 450);
    }
    ensureItems();
    renderWindow();
    const item = items[active];
    item.slide.classList.add('active');
    refreshVideos();
    item.slide.querySelector('.pbtn[data-act="pause"]')?.replaceChildren(iconNode('pause'));
    if (!suspended) {
      beginImpression(item);
      startSound(item);
    }
  }

  function iconNode(name) {
    const t = document.createElement('template');
    t.innerHTML = icon(name);
    return t.content.firstChild;
  }

  function startSound(item) {
    if (settings().bgmMode === 'swipe') {
      bgm.play(item.track);
      bgm.preload(items[active + 1]?.track);
    } else if (!bgm.want) {
      bgm.play(item.track);
    } else {
      bgm.commit();
    }
    speakTimer = setTimeout(() => speakFront(item), 320);
    prefetchVoice(item);
    prefetchVoice(items[active + 1]);
  }

  // 音声ファイルで読み上げる端末は、読みそうな文を先に読み込んでおく
  function prefetchVoice(item) {
    const w = item?.word;
    if (!w || w.lang !== 'en' || !settings().tts) return;
    tts.prefetch([w.w, settings().ttsExample ? w.ex[0]?.t : null]);
  }

  function canSpeak() {
    const s = settings();
    // BGM の許可とは切り離す(BGM が読み込めなくても読み上げは動くように)
    return s.tts && !s.muted && tts.unlocked && tts.available;
  }

  function speakFront(item) {
    if (!canSpeak() || item !== items[active] || suspended) return;
    const w = item.word;
    if (w.lang !== 'en' || settings().reverse || item.revealed) return;
    tts.speak(w.w, settings().ttsRate);
  }

  function speakBack(item) {
    if (!canSpeak() || item !== items[active]) return;
    const w = item.word;
    if (w.lang !== 'en') return;
    const parts = [];
    if (settings().reverse) parts.push(w.w);
    if (settings().ttsExample) parts.push(plainExample(w.ex[0]));
    if (parts.length) tts.speak(parts, settings().ttsRate);
  }

  /* ---------- 操作 ---------- */
  function reveal(item, on = !item.revealed) {
    item.revealed = on;
    item.slide.classList.toggle('revealed', on);
    if (on) {
      if (imp && imp.item === item && !imp.revealed) {
        imp.revealed = true;
        imp.revealAt = Date.now();
      }
      clearTimeout(speakTimer);
      speakBack(item);
    } else {
      tts.cancel();
    }
    dismissCoach();
  }

  function burst(x, y, kind) {
    const rect = view.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = `burst burst-${kind}`;
    node.style.left = `${x - rect.left}px`;
    node.style.top = `${y - rect.top}px`;
    const look = {
      mastered: ['thumbUpFill', '暗記済み'],
      already: ['thumbUpFill', 'もう暗記済み'],
    }[kind];
    node.innerHTML = `${icon(look[0], 84)}<span>${look[1]}</span>`;
    view.append(node);
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 1200);
    navigator.vibrate?.(kind === 'mastered' ? [12, 40, 12] : 12);
  }

  // 取り消せるように、操作の前の記録を残す
  function pushSnap(item) {
    const st = S();
    const w = item.word;
    const rec = st.recs[w.id];
    item.snaps.push({
      rec: rec ? JSON.parse(JSON.stringify(rec)) : null,
      learner: JSON.parse(JSON.stringify(st.learners[w.lang])),
      disliked: !!item.disliked,
      dislikeSnap: item.dislikeSnap || null,
    });
  }

  function popSnap(item) {
    const snap = item.snaps.pop();
    if (!snap) return;
    const st = S();
    const w = item.word;
    if (snap.rec) st.recs[w.id] = snap.rec;
    else delete st.recs[w.id];
    st.learners[w.lang] = snap.learner;
    item.disliked = snap.disliked;
    item.dislikeSnap = snap.dislikeSnap;
    store.save();
    updateChrome(item);
    app.ui.snack('取り消しました');
  }

  function popButton(item) {
    const btn = item.slide.querySelector('[data-act="advance"]');
    btn?.classList.remove('pop');
    void btn?.offsetWidth;
    btn?.classList.add('pop');
  }

  // ダブルタップ・暗記ボタン: 暗記済みにする。結果は語の状態として保存する。
  // 暗記済みのとき、ダブルタップでは何も変えない。ボタンなら外す(このカードで押した直後なら取り消し)。
  function advanceWord(item, viaDouble, point) {
    const st = S();
    const w = item.word;
    const now = Date.now();
    if (isMarked(st.recs[w.id])) {
      if (viaDouble) {
        burst(point.x, point.y, 'already');
        return;
      }
      if (item.snaps.length) {
        popSnap(item);
        return;
      }
      pushSnap(item);
      stepBack(st, w, { now });
      store.save();
      updateChrome(item);
      app.ui.snack('暗記済みを外しました', { label: '取り消す', run: () => popSnap(item) });
      return;
    }
    pushSnap(item);
    advance(st, index, w, { revealed: item.revealed, now });
    item.disliked = false;
    item.dislikeSnap = null;
    store.save();
    updateChrome(item);
    popButton(item);
    if (viaDouble) burst(point.x, point.y, 'mastered');
    app.ui.snack('暗記済みにしました', { label: '取り消す', run: () => popSnap(item) });
    dismissCoach();
  }

  function toggleDislike(item) {
    const st = S();
    const w = item.word;
    if (item.disliked) {
      if (item.dislikeSnap) {
        if (item.dislikeSnap.rec) st.recs[w.id] = item.dislikeSnap.rec;
        else delete st.recs[w.id];
      }
      item.disliked = false;
      item.dislikeSnap = null;
    } else {
      const rec = st.recs[w.id];
      item.dislikeSnap = { rec: rec ? JSON.parse(JSON.stringify(rec)) : null };
      markDifficult(st, w, { now: Date.now() });
      item.disliked = true;
      app.ui.snack('苦手に入れました。近いうちにまた出します');
    }
    store.save();
    updateChrome(item);
  }

  function toggleSave(item) {
    const st = S();
    const id = item.word.id;
    if (st.saved[id]) {
      delete st.saved[id];
      app.ui.snack('保存を解除しました');
    } else {
      st.saved[id] = Date.now();
      if (imp && imp.item === item) imp.saved = true;
      app.ui.snack('保存しました', { label: '見る', run: () => app.ui.openPage('saved') });
    }
    store.save();
    updateChrome(item);
  }

  async function share(item) {
    const w = item.word;
    const text = `${w.w} = ${w.m[0]} (縦単で覚えた)`;
    const url = location.origin + location.pathname;
    try {
      if (navigator.share) await navigator.share({ title: '縦単', text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        app.ui.snack('コピーしました');
      }
    } catch {
      // 共有をキャンセルした場合は何もしない
    }
  }

  function togglePause(item) {
    userPaused = !userPaused;
    const v = pool.find((x) => x._item === item);
    if (userPaused) {
      v?.pause();
      bgm.suspend();
      tts.cancel();
    } else {
      v?.play().catch(() => {});
      bgm.resume();
    }
    item.slide.querySelector('.pbtn[data-act="pause"]')?.replaceChildren(iconNode(userPaused ? 'play' : 'pause'));
  }

  function toggleMute(event) {
    // このタップで初めて音声の許可を取ったときは、ミュートの切替はしない
    if (!bgm.unlocked || event === app.unlockEvent) {
      app.unlockAudio();
      refreshMuteIcons();
      return;
    }
    settings().muted = !settings().muted;
    store.save();
    bgm.refreshLevel();
    if (settings().muted) tts.cancel();
    refreshMuteIcons();
  }

  function refreshMuteIcons() {
    const muted = settings().muted || !bgm.unlocked;
    for (const item of items) {
      if (!item.filled) continue;
      const btn = item.slide.querySelector('.pmute');
      if (!btn) continue;
      btn.querySelector('.ic').replaceWith(iconNode(muted ? 'volumeOff' : 'volumeUp'));
      const hint = btn.querySelector('.hint');
      if (hint) hint.hidden = bgm.unlocked;
    }
  }

  function handleAction(act, item, event) {
    switch (act) {
      case 'advance': advanceWord(item, false, event); break;
      case 'dislike': toggleDislike(item); break;
      case 'detail':
        if (imp && imp.item === item) imp.detail = true;
        app.ui.openDetail(item.word, { item });
        break;
      case 'save': toggleSave(item); break;
      case 'share': share(item); break;
      case 'more': app.ui.openMore(item); break;
      case 'pause': togglePause(item); break;
      case 'mute': toggleMute(event); break;
      case 'search': app.ui.openPage('library', { focus: true }); break;
      case 'settings': app.ui.openPage('settings'); break;
      case 'speak':
        if (imp && imp.item === item) imp.replay = true;
        if (canSpeak()) tts.speak(item.word.w, settings().ttsRate);
        else app.unlockAudio();
        break;
      default:
    }
  }

  function handleTap(item, e) {
    const now = performance.now();
    const index_ = items.indexOf(item);
    const near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 48;
    if (now - lastTap.t < DOUBLE_TAP_MS && near && lastTap.i === index_) {
      clearTimeout(tapTimer);
      tapTimer = null;
      lastTap.t = 0;
      advanceWord(item, true, { x: e.clientX, y: e.clientY });
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY, i: index_ };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      tapTimer = null;
      if (item === items[active]) reveal(item);
    }, DOUBLE_TAP_MS - 40);
  }

  el.addEventListener('click', (e) => {
    const slide = e.target.closest('.slide');
    if (!slide) return;
    const item = items[Number(slide.dataset.i)];
    if (!item) return;
    const action = e.target.closest('[data-act]');
    if (action) {
      handleAction(action.dataset.act, item, e);
      return;
    }
    if (item === items[active] && e.target.closest('.player')) handleTap(item, e);
  });

  /* ---------- スクロール ---------- */
  el.addEventListener(
    'scroll',
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        const h = el.clientHeight;
        if (h) setActive(Math.round(el.scrollTop / h));
      });
    },
    { passive: true }
  );

  function go(delta) {
    const target = active + delta;
    if (target < 0) return;
    ensureItems();
    if (!items[target]) return;
    el.scrollTo({ top: target * el.clientHeight, behavior: 'smooth' });
  }

  // PC のホイールは 1 回で 1 枚だけ進む(YouTube と同じ)
  view.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      const now = performance.now();
      if (now < wheelLock || Math.abs(e.deltaY) < 8) return;
      wheelLock = now + 480;
      go(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false }
  );

  document.addEventListener('keydown', (e) => {
    if (suspended || e.target.closest?.('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const item = items[active];
    if (!item) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowdown' || k === 'j') { e.preventDefault(); go(1); }
    else if (k === 'arrowup' || k === 'k') { e.preventDefault(); go(-1); }
    else if (k === ' ' || k === 'enter') { e.preventDefault(); reveal(item); }
    else if (k === 'a' || k === 'l') {
      const r = view.getBoundingClientRect();
      advanceWord(item, false, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    else if (k === 'd') handleAction('dislike', item);
    else if (k === 's') handleAction('save', item);
    else if (k === 'm') handleAction('mute', item);
  });

  new ResizeObserver(() => {
    if (active < 0) return;
    el.scrollTop = active * el.clientHeight;
    for (const item of items) if (item.filled) fitAll(item.slide);
  }).observe(el);
  // 文字の大きさを測るのはフォントの読み込みが終わってから
  document.fonts?.ready.then(() => {
    for (const item of items) if (item.filled) fitAll(item.slide);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) feed.suspend();
    else if (!app.ui.pageOpen()) feed.resume();
  });
  window.addEventListener('pagehide', () => {
    commitImpression();
    store.flush();
  });

  // 再生位置に合わせて細いバーを伸ばす
  function tick() {
    requestAnimationFrame(tick);
    if (suspended) return;
    const item = items[active];
    if (!item?.filled) return;
    const v = pool.find((x) => x._item === item);
    const bar = item.slide.querySelector('.progress span');
    if (v && bar && v.duration) bar.style.transform = `scaleX(${v.currentTime / v.duration})`;
  }
  requestAnimationFrame(tick);

  bgm.onTrackChange = () => {
    if (settings().bgmMode !== 'continuous') return;
    for (const item of items) {
      if (item.filled) item.slide.querySelector('.ticker-tx').innerHTML = tickerText(item);
    }
  };

  /* ---------- 公開メソッド ---------- */
  const feed = {
    go,
    // firstWord を指定すると、その単語から流す(単語帳から開いたとき)
    start(firstWord) {
      commitImpression();
      for (const v of pool) {
        v.pause();
        v._item = null;
        v.remove();
      }
      items = [];
      el.replaceChildren();
      active = -1;
      ses = newSession();
      pendingWord = firstWord || null;
      el.scrollTop = 0;
      ensureItems();
      suspended = false;
      if (items.length) setActive(0);
      else app.ui.snack('この出題範囲に単語がありません');
      showCoach();
    },
    suspend() {
      if (suspended) return;
      commitImpression();
      suspended = true;
      clearTimeout(speakTimer);
      clearTimeout(tapTimer);
      tts.cancel();
      bgm.suspend();
      syncPlayback();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      userPaused = false;
      const item = items[active];
      if (!item) return;
      item.slide.querySelector('.pbtn[data-act="pause"]')?.replaceChildren(iconNode('pause'));
      syncPlayback();
      bgm.resume();
      beginImpression(item, { manual: true });
    },
    refreshMuteIcons,
    // タップのたびに呼ぶ。省電力モードなどで止められた動画をもう一度再生する
    kick() {
      if (suspended || userPaused || !settings().video) return;
      const v = pool.find((x) => x._item && x._item === items[active]);
      if (v && v.paused) v.play().catch(() => {});
    },
    afterUnlock() {
      refreshMuteIcons();
      const item = items[active];
      if (!item || suspended) return;
      startSound(item);
    },
    refreshCurrent() {
      for (const item of items) if (item.filled) updateChrome(item);
    },
    current: () => items[active],
    setVideoEnabled() {
      refreshVideos();
    },
    debug: () => ({ active, count: items.length, imp, pool: pool.map((v) => v._url), recent: [...ses.recent], flow: ses.flow }),
    videoShuffler,
    activeVideo: () => pool.find((x) => x._item && x._item === items[active]) || null,
  };

  function showCoach() {
    if (S().coached || view.querySelector('.coach')) return;
    const node = document.createElement('div');
    node.className = 'coach';
    node.innerHTML = `
      <div class="coach-box">
        <p><b>上にスワイプ</b>次の単語へ</p>
        <p><b>タップ</b>答えと例文を見る</p>
        <p><b>ダブルタップ</b>知ってた! 暗記済みにする</p>
        <small>どこかをタップして始める</small>
      </div>`;
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissCoach();
    });
    view.append(node);
  }

  function dismissCoach() {
    view.querySelector('.coach')?.remove();
    if (!S().coached) {
      S().coached = true;
      store.save();
    }
  }

  return feed;
}
