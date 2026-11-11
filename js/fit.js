// 英単語が途中で折り返さないように、実際の幅を測って文字を小さくする。
// 文字幅は端末のフォントで変わる(iPhone のヒラギノは太くて幅が広い)ので、見積もりだけでは足りない。
// 空白を含む熟語は空白のところで折り返してよいので、1 語がはみ出すときだけ縮める。
export function fitWidth(node, min = 16) {
  if (!node || !node.isConnected) return;
  // CSS が古いまま残っていても語の途中で折り返さないよう、ここでも指定する
  node.style.overflowWrap = 'normal';
  node.style.wordBreak = 'normal';
  const box = node.clientWidth;
  if (!box) return;
  // 画面の幅が広がったときに戻せるよう、最初の大きさから測り直す
  if (node.dataset.fs === undefined) node.dataset.fs = node.style.fontSize;
  else node.style.fontSize = node.dataset.fs;
  let size = parseFloat(getComputedStyle(node).fontSize);
  for (let i = 0; i < 4 && node.scrollWidth > box + 1 && size > min; i++) {
    size = Math.max(min, Math.floor(size * (box / node.scrollWidth) * 0.98));
    node.style.fontSize = `${size}px`;
  }
}

export function fitAll(root) {
  root?.querySelectorAll('[data-fit]').forEach((n) => fitWidth(n));
}
