// 端末の種類。スマホだけ挙動を変えたい処理はここを見る(PC はこれまで通り)。
const ua = navigator.userAgent;

const ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const android = /Android/i.test(ua);
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export const DEVICE = {
  ios,
  android,
  // タッチ操作が主のスマホ・タブレット
  mobile: ios || android || coarse,
  // ホーム画面から開いたとき
  standalone:
    navigator.standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches),
};

// ?debug を付けて開くと、音と動画の状態を画面に出す(実機での確認用)
const debugOn = /[?&]debug\b/.test(location.search);
const logs = [];
export function debugLog(msg) {
  if (!debugOn) return;
  const t = new Date().toTimeString().slice(0, 8);
  logs.push(`${t} ${msg}`);
  if (logs.length > 12) logs.shift();
}
export const debugState = { on: debugOn, logs };
