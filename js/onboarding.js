// 初回の実力テスト。結果は内部の実力 θ(単語リスト上の位置)としてだけ使い、画面にはレベルを出さない。
import { createPlacement, applyPlacement, TEST_QUESTIONS } from './engine.js';
import { icon, logo } from './icons.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function createOnboarding(app) {
  const { store, index } = app;
  const root = document.getElementById('onboard');
  let onDone = null;

  const close = () => {
    root.hidden = true;
    root.replaceChildren();
  };

  function finish() {
    const st = store.state;
    st.onboarded = true;
    store.flush();
    close();
    const done = onDone;
    onDone = null;
    done?.();
  }

  function showIntro() {
    root.hidden = false;
    root.innerHTML = `
      <div class="ob">
        <div class="ob-logo">${logo()}</div>
        <h1>まずは英単語の実力チェック</h1>
        <p class="ob-lead">${TEST_QUESTIONS}問、意味を4つから選ぶだけ(約1分)。結果に合わせて、あなたにとって簡単な単語から順に流します。あとは使うほど勝手に調整していきます。</p>
        <p class="ob-lead">わからないときは「わからない」を押してください。当てずっぽうより正確になります。</p>
        <button class="pill pill-w ob-test" id="obTest">${icon('quiz', 20)}テストを始める</button>
      </div>`;
    root.querySelector('#obTest').addEventListener('click', () => {
      app.unlockAudio();
      runTest();
    });
  }

  function runTest() {
    root.hidden = false;
    const lang = 'en';
    const pool = index.ordered(lang);
    const placement = createPlacement(index, lang);

    const render = () => {
      const w = placement.done ? null : placement.question();
      if (!w) {
        showResult();
        return;
      }
      const qNo = placement.results.length;
      // 誤答の選択肢は、品詞が同じで位置の近い語から
      const others = shuffle(pool.filter((x) => x.id !== w.id && x.pos === w.pos && x.m[0] !== w.m[0] && Math.abs(x.d - w.d) <= 0.15));
      const fallback = shuffle(pool.filter((x) => x.id !== w.id && x.m[0] !== w.m[0]));
      const wrong = [...new Set([...others, ...fallback].map((x) => x.m[0]))].slice(0, 3);
      const options = shuffle([w.m[0], ...wrong]);
      root.innerHTML = `
        <div class="ob ob-test-screen">
          <div class="ob-progress"><span style="width:${(qNo / TEST_QUESTIONS) * 100}%"></span></div>
          <p class="ob-count">${qNo + 1} / ${TEST_QUESTIONS}</p>
          <div class="ob-word">${esc(w.w)}</div>
          <div class="ob-list">
            ${options.map((o) => `<button class="ob-choice" data-a="${esc(o)}">${esc(o)}</button>`).join('')}
            <button class="ob-choice ob-skip" data-a="">わからない</button>
          </div>
          <button class="ob-quit" id="obQuit">やめる</button>
        </div>`;
      root.querySelectorAll('.ob-choice').forEach((b) => {
        b.addEventListener('click', () => {
          placement.answer(w, b.dataset.a === w.m[0]);
          render();
        });
      });
      root.querySelector('#obQuit').addEventListener('click', () => {
        if (store.state.onboarded) {
          close();
          const done = onDone;
          onDone = null;
          done?.();
        } else showIntro();
      });
    };

    const showResult = () => {
      const score = placement.results.filter((r) => r.correct).length;
      const total = placement.results.length;
      const lead = score >= total * 0.75
        ? 'お見事。知っている単語はさっさと飛ばして、知らない単語に集中します。'
        : score >= total * 0.4
          ? 'いい感じです。簡単な単語から確実に固めていきます。'
          : 'ここからです。簡単な単語から一緒に積み上げましょう。';
      root.innerHTML = `
        <div class="ob ob-result">
          <p class="ob-count">テスト結果</p>
          <div class="ob-lv">${score} / ${total}</div>
          <h1>問正解</h1>
          <p class="ob-lead">${lead}</p>
          <button class="pill pill-w ob-go" id="obGo">フィードを始める</button>
        </div>`;
      root.querySelector('#obGo').addEventListener('click', () => {
        applyPlacement(store.state, index, lang, placement, { now: Date.now() });
        finish();
      });
    };

    render();
  }

  return {
    needed: () => !store.state.onboarded,
    start(done) {
      onDone = done;
      showIntro();
    },
    startTest(done) {
      app.ui.closePage();
      app.feed.suspend();
      onDone = () => {
        done?.();
        app.pendingRestart = false;
        app.feed.start();
      };
      runTest();
    },
  };
}
