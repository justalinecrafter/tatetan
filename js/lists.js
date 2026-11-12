// 保存リスト(YouTube の再生リストのように、いくつも作れる)。
// st.lists: [{ id, name, items: { 単語id: 保存した時刻 }, t: 作った時刻 }]。先頭は消せない「後で見る」。
// st.saved は「どれかのリストに入っている語」のまとめ(出題の重み付けで使う)。リストを変えるたびに作り直す。

export const DEFAULT_LIST = 'later';
export const LIST_NAME_MAX = 40;

export function newLists(saved = {}) {
  return [{ id: DEFAULT_LIST, name: '後で見る', items: { ...saved }, t: 0 }];
}

// 旧版(リストがなく st.saved だけ)の保存は「後で見る」へ入れる
export function normalizeLists(data) {
  let lists = Array.isArray(data.lists) && data.lists.length ? data.lists : newLists(data.saved || {});
  lists = lists
    .filter((l) => l && l.id)
    .map((l) => ({ id: String(l.id), name: String(l.name || 'リスト').slice(0, LIST_NAME_MAX), items: { ...(l.items || {}) }, t: l.t || 0 }));
  if (!lists.some((l) => l.id === DEFAULT_LIST)) lists.unshift(newLists()[0]);
  return lists;
}

export function syncSaved(st) {
  const saved = {};
  for (const l of st.lists) for (const [id, t] of Object.entries(l.items)) saved[id] = Math.max(saved[id] || 0, t);
  st.saved = saved;
}

export const listById = (st, id) => st.lists.find((l) => l.id === id);

// 最後に保存したリスト(なければ「後で見る」)
export const lastList = (st) => listById(st, st.lastList) || listById(st, DEFAULT_LIST);

export function inList(st, listId, wordId) {
  return !!listById(st, listId)?.items[wordId];
}

export function addTo(st, listId, wordId, now = Date.now()) {
  const l = listById(st, listId);
  if (!l) return;
  l.items[wordId] = now;
  st.lastList = listId;
  syncSaved(st);
}

export function removeFrom(st, listId, wordId) {
  const l = listById(st, listId);
  if (!l) return;
  delete l.items[wordId];
  syncSaved(st);
}

export function createList(st, name, now = Date.now()) {
  const l = { id: `l${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name.trim().slice(0, LIST_NAME_MAX) || '新しいリスト', items: {}, t: now };
  st.lists.push(l);
  return l;
}

export function renameList(st, listId, name) {
  const l = listById(st, listId);
  const n = name.trim().slice(0, LIST_NAME_MAX);
  if (l && n) l.name = n;
}

export function deleteList(st, listId) {
  if (listId === DEFAULT_LIST) return;
  st.lists = st.lists.filter((l) => l.id !== listId);
  if (st.lastList === listId) delete st.lastList;
  syncSaved(st);
}

// 新しく保存した順
export const listWords = (l) => Object.keys(l.items).sort((a, b) => l.items[b] - l.items[a]);
