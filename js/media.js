// BGM と読み上げ。背景動画の再生は feed.js 側で管理する。
import { DEVICE, debugLog } from './device.js';
import { voiceKey } from './voicekey.js';

const randomOf = (list) => list[Math.floor(Math.random() * list.length)];

// 端末に保存済みの素材がこれだけ貯まったら、保存済みを優先して選ぶ(通信量を抑える)
const PREFER_MIN = 8;
const PREFER_RATE = 0.75;

function pickRandom(list, recent, keep, cached, onlySaved) {
  const blocked = new Set(recent);
  const pool = list.filter((x) => !blocked.has(x));
  let from = pool.length ? pool : list;
  if (cached && cached.size) {
    const saved = from.filter((x) => cached.has(x.f));
    // 通信できないときは保存済みだけから選ぶ
    if (saved.length && (onlySaved || !navigator.onLine || (saved.length >= PREFER_MIN && Math.random() < PREFER_RATE))) from = saved;
  }
  const picked = randomOf(from);
  recent.push(picked);
  if (recent.length > keep) recent.shift();
  return picked;
}

export class Shuffler {
  constructor(list, keep) {
    this.list = list;
    this.keep = Math.min(keep, Math.max(0, list.length - 1));
    this.recent = [];
    this.cached = null; // 端末に保存済みのファイル名(Service Worker が動いているときだけ)
  }
  // onlySaved: 読み込めなかったときの選び直し。保存済みがあればそこから選ぶ
  next(onlySaved = false) {
    return this.list.length ? pickRandom(this.list, this.recent, this.keep, this.cached, onlySaved) : null;
  }
}

// 2 本の audio を切り替えて、スワイプ時の曲替えを途切れさせない。
export class Bgm {
  constructor(manifest, getSettings) {
    this.base = manifest.bgmBase;
    this.getSettings = getSettings;
    this.shuffler = new Shuffler(manifest.bgm, 15);
    this.channels = [this.makeChannel(), this.makeChannel()];
    this.cur = 0;
    this.want = null;
    this.ducked = false;
    this.suspended = false;
    this.unlocked = false;
    this.timer = null;
    this.ctx = null;
    this.onTrackChange = null;
  }

  makeChannel() {
    const el = new Audio();
    el.preload = 'auto';
    if (/^https?:/.test(this.base)) el.crossOrigin = 'anonymous';
    const ch = { el, track: null, gain: null, errors: 0 };
    el.addEventListener('ended', () => this.handleEnded(ch));
    el.addEventListener('playing', () => { ch.errors = 0; });
    // 読み込めない曲(電波が無いなど)は、保存済みの曲に替える
    el.addEventListener('error', () => {
      if (!ch.track || ch !== this.channels[this.cur] || ++ch.errors > 3) return;
      debugLog(`bgm error: ${el.error?.code}`);
      this.want = this.shuffler.next(true);
      this.onTrackChange?.(this.want);
      this.commit();
    });
    return ch;
  }

  handleEnded(ch) {
    if (ch !== this.channels[this.cur]) return;
    if (this.getSettings().bgmMode === 'continuous') {
      this.play(this.shuffler.next());
      this.onTrackChange?.(this.want);
    } else {
      ch.el.currentTime = 0;
      ch.el.play().catch(() => {});
    }
  }

  graph() {
    if (this.ctx || this.noGraph) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      for (const ch of this.channels) {
        ch.gain = this.ctx.createGain();
        ch.gain.gain.value = 0;
        this.ctx.createMediaElementSource(ch.el).connect(ch.gain).connect(this.ctx.destination);
      }
    } catch {
      this.ctx = null;
      this.noGraph = true;
    }
  }

  level() {
    const s = this.getSettings();
    if (s.muted || !s.bgm) return 0;
    return s.bgmVol * (this.ducked ? 0.4 : 1);
  }

  setLevel(ch, value, seconds = 0.08) {
    if (ch.gain && this.ctx) {
      ch.gain.gain.setTargetAtTime(value, this.ctx.currentTime, seconds);
    } else {
      ch.el.volume = Math.min(1, value);
    }
  }

  refreshLevel() {
    const cur = this.channels[this.cur];
    this.setLevel(cur, this.level());
    this.setLevel(this.channels[1 - this.cur], 0);
    if (!this.getSettings().bgm) cur.el.pause();
    else if (this.unlocked && !this.suspended && cur.track) cur.el.play().catch(() => {});
  }

  duck(on) {
    this.ducked = on;
    this.setLevel(this.channels[this.cur], this.level(), 0.12);
  }

  url(track) {
    return this.base + encodeURIComponent(track.f);
  }

  load(ch, track) {
    if (ch.track === track) return;
    ch.track = track;
    ch.el.src = this.url(track);
    ch.el.load();
  }

  // 音声の再生許可はユーザー操作の中でしか取れない。
  // iOS は await を挟むと操作中と見なされなくなるので、play() までを同期で呼ぶ。
  unlock() {
    if (this.unlocked) {
      this.wake();
      return Promise.resolve(true);
    }
    if (this.unlocking) return this.unlocking;
    // iOS 17 以降: マナーモードでも BGM を鳴らす(Web Audio は既定だと消音スイッチに従う)
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* 未対応 */ }
    this.graph();
    this.wake();
    const cur = this.channels[this.cur];
    const other = this.channels[1 - this.cur];
    if (this.want) this.load(cur, this.want);
    else if (!cur.track) this.load(cur, this.shuffler.next());
    if (!other.track) this.load(other, this.shuffler.next());
    const silent = this.suspended || !this.getSettings().bgm;
    // iOS は操作の中で 1 回でも再生した要素だけ、後から自動で鳴らせる。両方とも今ここで再生しておく
    other.el.muted = true;
    if (silent) cur.el.muted = true;
    const blessOther = other.el.play();
    const blessCur = cur.el.play();
    this.unlocked = true; // 読み込みを待たずに許可済みとして扱う(曲替えが止まらないように)
    this.setLevel(cur, this.level());
    const settle = (ch, p) =>
      Promise.resolve(p).then(
        () => true,
        (e) => {
          debugLog(`bgm play: ${e?.name || e}`);
          return e?.name !== 'NotAllowedError';
        }
      ).finally(() => {
        if (ch !== this.channels[this.cur] || this.suspended || !this.getSettings().bgm) ch.el.pause();
        ch.el.muted = false;
      });
    this.unlocking = Promise.all([settle(cur, blessCur), settle(other, blessOther)]).then(([ok]) => {
      this.unlocking = null;
      if (!ok) this.unlocked = false;
      return ok;
    });
    return this.unlocking;
  }

  // iOS は裏に回ったり電話が来たりすると AudioContext が止まる。操作のたびに起こす
  wake() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  play(track) {
    if (!track) return;
    this.want = track;
    clearTimeout(this.timer);
    // 高速で連続スワイプしても通信を浪費しないよう少し待つ
    this.timer = setTimeout(() => this.commit(), 140);
  }

  commit() {
    if (!this.unlocked || this.suspended || !this.getSettings().bgm) return;
    const cur = this.channels[this.cur];
    if (cur.track === this.want) {
      if (cur.el.paused) cur.el.play().catch(() => {});
      this.setLevel(cur, this.level());
      return;
    }
    const nextIndex = 1 - this.cur;
    const next = this.channels[nextIndex];
    if (next.track === this.want) {
      try { next.el.currentTime = 0; } catch { /* 読み込み前は無視 */ }
    } else {
      this.load(next, this.want);
    }
    this.setLevel(next, 0, 0.001);
    next.el.play().catch(() => {});
    this.setLevel(next, this.level(), 0.08);
    this.setLevel(cur, 0, 0.08);
    this.cur = nextIndex;
    setTimeout(() => {
      if (this.channels[this.cur] !== cur) cur.el.pause();
    }, 320);
  }

  // 次の曲を裏で読み込んでおく
  preload(track) {
    const idle = this.channels[1 - this.cur];
    if (track && idle.el.paused && idle.track !== track) this.load(idle, track);
  }

  suspend() {
    this.suspended = true;
    clearTimeout(this.timer);
    for (const ch of this.channels) ch.el.pause();
  }

  resume() {
    this.suspended = false;
    if (!this.unlocked) return;
    this.wake();
    if (this.want) this.commit();
  }
}

// 英語の読み上げ。
// スマホは、ブラウザの読み上げ機能を使うと「別のアプリの音」として扱われ、
// 鳴った瞬間にページの動画と BGM が止められてしまう(特に iPhone)。
// そこで、事前に作った音声ファイル(tools/gen-voice.mjs)を BGM と同じ Web Audio で鳴らす。
// PC はこれまで通りブラウザの読み上げを使う(?voicefile を付けると PC でも音声ファイルで試せる)。
const FILE_VOICE = DEVICE.mobile || /[?&]voicefile\b/.test(location.search);
const VOICE_CACHE = 60;

export class Tts {
  constructor(onBusy, bgm) {
    this.synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.bgm = bgm; // AudioContext を共有する
    this.voice = null;
    this.voiceCount = 0;
    this.onBusy = onBusy;
    this.token = 0;
    this.unlocked = false;
    this.timer = null;
    this.busyTimer = null;
    this.live = []; // 再生中の発話を参照しておく(Chrome は参照が切れると終了通知が来ない)
    this.lastError = '';
    this.files = null; // 音声ファイルがある文のキー
    this.fileBase = '';
    this.cache = new Map(); // キー → { raw: 読み込み, buf: 変換済み }
    this.source = null;
    this.out = null;
    this.mode = '';
    if (this.synth) {
      this.pickVoice();
      const onChange = () => this.pickVoice();
      if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', onChange);
      else this.synth.onvoiceschanged = onChange;
    }
  }

  setFiles(index) {
    if (!FILE_VOICE || !index?.keys?.length) return;
    this.files = new Set(index.keys);
    this.fileBase = index.base;
  }

  get fileMode() {
    return !!this.files;
  }

  get available() {
    return this.fileMode || !!this.synth;
  }

  pickVoice() {
    const all = this.synth.getVoices();
    this.voiceCount = all.length;
    const voices = all.filter((v) => /^en[-_]/i.test(v.lang));
    const rank = (v) => {
      const us = /en[-_]US/i.test(v.lang) ? 0 : 5;
      // 通信が要る声は、電波が悪いと黙ってしまうので後回し
      const net = v.localService === false ? 10 : 0;
      if (/Google US English/i.test(v.name)) return 0 + us + net;
      if (/Samantha|Ava|Allison|Natural/i.test(v.name)) return 1 + us + net;
      if (/Aria|Jenny|Zira/i.test(v.name)) return 2 + us + net;
      return 4 + us + net;
    };
    this.voice = voices.sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  // ユーザー操作の中で呼ぶ。音声ファイルは BGM と同じ AudioContext で鳴らすので、ここでは何もしない。
  // ブラウザの読み上げは、iOS だと操作の中で 1 度話させないと以後が無音になる
  unlock() {
    if (this.unlocked) return;
    if (this.fileMode) {
      this.unlocked = true;
      return;
    }
    if (!this.synth) return;
    this.unlocked = true;
    // Android・PC は一度でも画面を操作していれば話せるので、何も鳴らさない
    if (!DEVICE.ios) return;
    try {
      this.synth.cancel();
      const u = new SpeechSynthesisUtterance('hi');
      u.lang = 'en-US';
      u.volume = 0;
      u.rate = 2;
      u.onerror = (e) => {
        debugLog(`tts unlock: ${e.error}`);
        if (e.error === 'not-allowed') this.unlocked = false;
      };
      this.hold(u);
      this.synth.speak(u);
    } catch (e) {
      this.unlocked = false;
      debugLog(`tts unlock: ${e?.message || e}`);
    }
  }

  hold(u) {
    this.live.push(u);
    if (this.live.length > 8) this.live.shift();
  }

  setBusy(on, token, ms = 0) {
    if (token !== this.token) return;
    clearTimeout(this.busyTimer);
    this.onBusy?.(on);
    // 終了の通知が来ない端末があるので、長くても文の長さぶんで BGM の音量を戻す
    if (on) this.busyTimer = setTimeout(() => this.setBusy(false, token), ms);
  }

  /* ---------- 音声ファイル ---------- */
  hasFiles(texts) {
    return this.fileMode && texts.every((t) => this.files.has(voiceKey(t)));
  }

  entry(key) {
    let e = this.cache.get(key);
    if (e) {
      this.cache.delete(key); // 最近使った順に並べ直す
    } else {
      e = {
        raw: fetch(this.fileBase + key + '.mp3')
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null),
        buf: null,
      };
    }
    this.cache.set(key, e);
    if (this.cache.size > VOICE_CACHE) this.cache.delete(this.cache.keys().next().value);
    return e;
  }

  // 次に読む単語を先に読み込んでおく(スワイプしてすぐ鳴るように)
  prefetch(texts) {
    if (!this.fileMode) return;
    for (const t of texts) {
      if (!t) continue;
      const key = voiceKey(t);
      if (this.files.has(key)) this.entry(key);
    }
  }

  buffer(key) {
    const ctx = this.bgm?.ctx;
    const e = this.entry(key);
    if (!ctx) return Promise.resolve(null);
    if (!e.buf) {
      e.buf = e.raw
        .then((ab) => ab && new Promise((ok, ng) => ctx.decodeAudioData(ab.slice(0), ok, ng)))
        .catch((err) => {
          debugLog(`voice decode: ${err?.message || err}`);
          e.buf = null;
          return null;
        });
    }
    return e.buf;
  }

  async playFiles(texts, rate, token) {
    const ctx = this.bgm.ctx;
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.connect(ctx.destination);
    }
    this.bgm.wake();
    // 音の高さも変わるので、速さの設定は控えめに反映する(ふつう = 元の速さ)
    const speed = Math.min(1.15, Math.max(0.85, rate / 0.95));
    for (let i = 0; i < texts.length; i++) {
      const buf = await this.buffer(voiceKey(texts[i]));
      if (token !== this.token) return;
      if (!buf) continue;
      if (i > 0) await new Promise((r) => { this.timer = setTimeout(r, 220); });
      if (token !== this.token) return;
      await new Promise((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = speed;
        src.connect(this.out);
        src.onended = resolve;
        this.source = src;
        this.setBusy(true, token, (buf.duration / speed) * 1000 + 1500);
        src.start();
      });
      if (token !== this.token) return;
    }
    this.source = null;
    this.setBusy(false, token);
  }

  /* ---------- 読み上げ ---------- */
  speak(texts, rate = 1) {
    const queue = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
    if (this.fileMode) {
      if (this.bgm?.ctx && this.hasFiles(queue)) {
        this.cancel();
        if (queue.length) {
          this.mode = 'file';
          this.playFiles(queue, rate, this.token);
        }
        return;
      }
      // 音声ファイルが無い文(自分で作った単語など)。iPhone は動画と BGM が止まるので読まない
      if (DEVICE.ios) {
        debugLog('voice: ファイルなし');
        return;
      }
    }
    this.speakSynth(queue, rate);
  }

  speakSynth(queue, rate) {
    if (!this.synth) return;
    const wasBusy = this.synth.speaking || this.synth.pending;
    this.cancel();
    const token = this.token;
    if (!queue.length) return;
    this.mode = 'synth';
    const chars = queue.reduce((n, t) => n + t.length, 0);
    const run = () => {
      if (token !== this.token) return;
      // Android の Chrome は一時停止のまま固まることがある
      if (this.synth.paused) this.synth.resume();
      queue.forEach((text, i) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = this.voice?.lang?.replace('_', '-') || 'en-US';
        if (this.voice) u.voice = this.voice;
        u.rate = rate;
        if (i === 0) u.onstart = () => this.setBusy(true, token, 2000 + (chars * 110) / rate);
        const done = () => { if (i === queue.length - 1) this.setBusy(false, token); };
        u.onend = done;
        u.onerror = (e) => {
          if (e.error !== 'interrupted' && e.error !== 'canceled') {
            this.lastError = e.error;
            debugLog(`tts: ${e.error}`);
          }
          done();
        };
        this.hold(u);
        this.synth.speak(u);
      });
    };
    // 止めた直後に話させると、Chrome は新しい発話まで捨ててしまうことがある
    if (wasBusy || DEVICE.android) this.timer = setTimeout(run, 60);
    else run();
  }

  cancel() {
    this.token++;
    clearTimeout(this.timer);
    clearTimeout(this.busyTimer);
    if (this.source) {
      const src = this.source;
      this.source = null;
      try { src.stop(); } catch { /* 再生前 */ }
    }
    if (this.synth && (this.synth.speaking || this.synth.pending)) this.synth.cancel();
    this.onBusy?.(false);
  }
}
