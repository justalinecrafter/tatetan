// ?debug を付けて開いたときだけ読み込む。実機で音と動画の状態を確かめるための表示。
import { DEVICE, debugState } from './device.js';

const RS = ['なし', '情報', '現在', '先あり', '十分'];
const NS = ['空', '待機', '読込中', 'src無'];

function media(el) {
  if (!el) return '-';
  return `${el.paused ? '停止' : '再生'} ${RS[el.readyState]}/${NS[el.networkState]} ${el.currentTime.toFixed(1)}s${el.error ? ` err${el.error.code}` : ''}${el.muted ? ' muted' : ''}`;
}

export function startDebug(app) {
  const box = document.createElement('pre');
  box.style.cssText =
    'position:fixed;left:4px;top:4px;z-index:99999;max-width:96vw;margin:0;padding:6px 8px;' +
    'font:10px/1.35 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,.78);' +
    'border-radius:6px;pointer-events:none;white-space:pre-wrap;';
  document.body.append(box);

  const kind = DEVICE.ios ? 'iOS' : DEVICE.android ? 'Android' : DEVICE.mobile ? 'タッチ端末' : 'PC';
  setInterval(() => {
    const { bgm, tts } = app;
    const ch = bgm.channels[bgm.cur];
    const synth = tts.synth;
    const s = app.store.state.settings;
    box.textContent = [
      `${kind}${DEVICE.standalone ? ' ホーム画面' : ' ブラウザ'}`,
      `ctx:${bgm.ctx ? bgm.ctx.state : bgm.noGraph ? '無し' : '未作成'} bgm許可:${bgm.unlocked} ${s.bgm ? '' : '(BGM OFF)'}${s.muted ? '(ミュート)' : ''}`,
      `bgm: ${media(ch.el)} ${ch.track?.f || ''}`,
      `tts許可:${tts.unlocked} ${tts.fileMode ? `音声ファイル(${tts.files.size}) ${tts.source ? '再生中' : ''}` : ''} 声:${tts.voice ? tts.voice.name : 'なし'}(${tts.voiceCount}) ${synth ? `${synth.speaking ? '話し中' : ''}${synth.pending ? '待ち' : ''}${synth.paused ? '一時停止' : ''}` : '非対応'}`,
      `video: ${media(app.feed.activeVideo())}`,
      ...debugState.logs,
    ].join('\n');
  }, 500);
}
