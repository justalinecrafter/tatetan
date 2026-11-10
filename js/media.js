// BGM と読み上げ。背景動画の再生は feed.js 側で管理する。

function pickRandom(list, recent, keep) {
  const blocked = new Set(recent);
  const pool = list.filter((x) => !blocked.has(x));
  const picked = (pool.length ? pool : list)[Math.floor(Math.random() * (pool.length || list.length))];
  recent.push(picked);
  if (recent.length > keep) recent.shift();
  return picked;
}

export class Shuffler {
  constructor(list, keep) {
    this.list = list;
    this.keep = Math.min(keep, Math.max(0, list.length - 1));
    this.recent = [];
  }
  next() {
    return this.list.length ? pickRandom(this.list, this.recent, this.keep) : null;
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
    const ch = { el, track: null, gain: null };
    el.addEventListener('ended', () => this.handleEnded(ch));
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

  // 音声の再生許可はユーザー操作の中でしか取れない
  async unlock() {
    if (this.unlocked) return true;
    this.graph();
    try {
      if (this.ctx) await this.ctx.resume();
      const cur = this.channels[this.cur];
      const other = this.channels[1 - this.cur];
      if (this.want) this.load(cur, this.want);
      else if (!cur.track) this.load(cur, this.shuffler.next());
      if (!other.track) this.load(other, this.shuffler.next());
      await cur.el.play();
      // iOS は 1 回でも再生した要素だけ後から自動で鳴らせる
      other.el.play().then(() => other.el.pause()).catch(() => {});
      this.unlocked = true;
      if (this.suspended || !this.getSettings().bgm) cur.el.pause();
      this.setLevel(cur, this.level());
      return true;
    } catch {
      return false;
    }
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
    this.ctx?.resume();
    if (this.want) this.commit();
  }
}

export class Tts {
  constructor(onBusy) {
    this.synth = window.speechSynthesis || null;
    this.voice = null;
    this.onBusy = onBusy;
    this.token = 0;
    if (this.synth) {
      this.pickVoice();
      this.synth.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
  }

  get available() {
    return !!this.synth;
  }

  pickVoice() {
    const voices = this.synth.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
    const rank = (v) => {
      const us = /en[-_]US/i.test(v.lang) ? 0 : 5;
      if (/Google US English/i.test(v.name)) return 0 + us;
      if (/Samantha|Ava|Allison|Natural/i.test(v.name)) return 1 + us;
      if (/Aria|Jenny|Zira/i.test(v.name)) return 2 + us;
      return 4 + us;
    };
    this.voice = voices.sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  // iOS はユーザー操作の中で 1 度鳴らしておく必要がある
  unlock() {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    this.synth.speak(u);
  }

  speak(texts, rate = 1) {
    if (!this.synth) return;
    this.cancel();
    const token = ++this.token;
    const queue = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
    queue.forEach((text, i) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.voice?.lang || 'en-US';
      if (this.voice) u.voice = this.voice;
      u.rate = rate;
      if (i === 0) u.onstart = () => { if (token === this.token) this.onBusy?.(true); };
      const done = () => { if (i === queue.length - 1 && token === this.token) this.onBusy?.(false); };
      u.onend = done;
      u.onerror = done;
      this.synth.speak(u);
    });
  }

  cancel() {
    if (!this.synth) return;
    this.token++;
    this.synth.cancel();
    this.onBusy?.(false);
  }
}
