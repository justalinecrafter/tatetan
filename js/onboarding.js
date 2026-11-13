// 初回のレベル設定。英語・古典のレベルを自己申告してもらい、英語はそのあと実力テストで確かめる。
// 結果は内部の実力 θ(単語リスト上の位置)としてだけ使い、画面にはレベルを出さない。
import { createPlacement, applyPlacement, applyLevels, LEVELS, TEST_QUESTIONS } from './engine.js';
import { icon, logo } from './icons.js';
import { fitAll } from './fit.js';

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

  // レベルの自己申告(英語は必須、古典は「やらない(未回答)」も選べる)
  function showIntro() {
    root.hidden = false;
    const pick = { en: store.state.levels?.en || null, kb: store.state.levels?.kb || 'none' };
    const group = (lang, title) => `
      <h2 class="ob-h2">${title}</h2>
      <div class="ob-levels" data-lang="${lang}">${LEVELS[lang]
        .map((lv) => `<button class="ob-level${pick[lang] === lv.id ? ' on' : ''}" data-lv="${lv.id}">${esc(lv.label)}</button>`)
        .join('')}</div>`;
    root.innerHTML = `
      <div class="ob">
        <div class="ob-logo">${logo()}</div>
        <h1>まずはあなたのレベルを教えてください</h1>
        <p class="ob-lead">だいたいで大丈夫です。英語はこのあと${TEST_QUESTIONS}問のテスト(約1分)で確かめます。あとは使うほど勝手に調整していきます。</p>
        ${group('en', '英単語')}
        ${group('kb', '古典単語')}
        <button class="pill pill-w ob-test" id="obTest" ${pick.en ? '' : 'disabled'}>${icon('quiz', 20)}テストへ進む</button>
      </div>`;
    root.querySelectorAll('.ob-levels').forEach((g) => {
      g.addEventListener('click', (e) => {
        const b = e.target.closest('[data-lv]');
        if (!b) return;
        pick[g.dataset.lang] = b.dataset.lv;
        g.querySelectorAll('.ob-level').forEach((x) => x.classList.toggle('on', x === b));
        root.querySelector('#obTest').disabled = !pick.en;
      });
    });
    root.querySelector('#obTest').addEventListener('click', () => {
      if (!pick.en) return;
      app.unlockAudio();
      applyLevels(store.state, pick);
      // 古典のレベルを答えたら、古典も一緒に流す
      if (pick.kb !== 'none' && store.state.settings.scope === 'en') store.state.settings.scope = 'both';
      store.save();
      runTest();
    });
  }

  function runTest() {
    root.hidden = false;
    const lang = 'en';
    const pool = index.ordered(lang);
    const self = LEVELS.en.find((x) => x.id === store.state.levels?.en);
    const placement = createPlacement(index, lang, { start: self ? self.theta : null });

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
          <div class="ob-word" data-fit>${esc(w.w)}</div>
          <div class="ob-list">
            ${options.map((o) => `<button class="ob-choice" data-a="${esc(o)}">${esc(o)}</button>`).join('')}
            <button class="ob-choice ob-skip" data-a="">わからない</button>
          </div>
          <button class="ob-quit" id="obQuit">やめる</button>
        </div>`;
      fitAll(root);
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
