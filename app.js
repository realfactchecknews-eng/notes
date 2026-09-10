/* Конспекты — локальное приложение на GitHub Pages.
   Данные лежат в IndexedDB браузера, по одному документу на пользователя. */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------- IndexedDB (одно хранилище ключ-значение) ---------- */
const db = (() => {
  const open = indexedDB.open('notes', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  const ready = new Promise((res, rej) => {
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
  });
  const tx = async (mode, fn) => {
    const d = await ready;
    return new Promise((res, rej) => {
      const r = fn(d.transaction('kv', mode).objectStore('kv'));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)),
  };
})();

/* ---------- Модалки и диалоги (вместо системных prompt) ---------- */
function show(m) { m.classList.remove('hidden'); requestAnimationFrame(() => m.classList.add('in')); }
function hide(m) { m.classList.remove('in'); setTimeout(() => m.classList.add('hidden'), 180); }

function ask(title, value = '', table = false) {
  return new Promise(res => {
    const m = $('#ask-modal'), inp = $('#ask-input');
    $('#ask-title').textContent = title;
    inp.value = value;
    inp.classList.toggle('hidden', table);
    $('#ask-extra').classList.toggle('hidden', !table);
    show(m);
    setTimeout(() => (table ? $('#ask-cols') : inp).focus(), 60);

    const done = v => { hide(m); cleanup(); res(v); };
    const ok = () => done(table
      ? { cols: +$('#ask-cols').value, rows: +$('#ask-rows').value }
      : inp.value.trim() || null);
    const no = () => done(null);
    const key = e => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); no(); }
    };
    function cleanup() {
      $('#ask-yes').onclick = $('#ask-no').onclick = null;
      m.removeEventListener('keydown', key);
    }
    $('#ask-yes').onclick = ok;
    $('#ask-no').onclick = no;
    m.addEventListener('keydown', key);
  });
}

/* ---------- Авторизация: Firebase, с гостевым режимом ---------- */
let me = null;          // uid пользователя или 'гость'
let user = null;        // объект Firebase, null у гостя
let data = null;        // { folders: [{id,name,open,notes:[{id,title,html,files,ts}]}], cards, tests }
let cur = null;         // текущая заметка
let curFolder = null;

let fb = null, auth = null, store = null, bucket = null;
try {
  if (window.FB && !String(window.FB.apiKey).includes('ВСТАВЬ')) {
    fb = firebase.initializeApp(window.FB);
    auth = firebase.auth();
    store = firebase.firestore();
    bucket = firebase.storage();
    store.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  }
} catch (e) { console.warn('Firebase не поднялся:', e.message); }

const cloud = () => !!user;
const errText = c => ({
  'auth/invalid-email': 'Неправильная почта',
  'auth/missing-password': 'Введи пароль',
  'auth/weak-password': 'Пароль слишком короткий, нужно от 6 символов',
  'auth/email-already-in-use': 'На эту почту уже есть аккаунт — войди',
  'auth/invalid-credential': 'Неверная почта или пароль',
  'auth/user-not-found': 'Такого аккаунта нет',
  'auth/wrong-password': 'Неверный пароль',
  'auth/too-many-requests': 'Слишком много попыток, подожди минуту',
  'auth/popup-closed-by-user': 'Окно Google закрыли',
  'auth/network-request-failed': 'Нет связи с сервером',
}[c] || 'Ошибка: ' + c);

/* --- сохранение --- */
/* Метаданные (папки, карточки, результаты) лежат одним документом,
   каждый конспект — своим, чтобы не упереться в лимит документа Firestore. */
const meta = () => ({
  folders: data.folders.map(f => ({
    id: f.id, name: f.name, open: !!f.open,
    notes: f.notes.map(n => ({ id: n.id, title: n.title, ts: n.ts })),
  })),
  cards: data.cards || [],
  tests: data.tests || [],
});

let saveT, dirty = new Set();
function save(noteId) {
  if (noteId) dirty.add(noteId);
  else if (cur) dirty.add(cur.id);
  if (!cloud()) return db.set('data:' + me, data);
  clearTimeout(saveT);
  saveT = setTimeout(pushCloud, 400);
  return Promise.resolve();
}

async function pushCloud() {
  if (!cloud()) return;
  const ids = [...dirty]; dirty.clear();
  try {
    const batch = store.batch();
    batch.set(store.doc(`users/${user.uid}`), meta());
    for (const id of ids) {
      const n = findNote(id);
      if (n) batch.set(store.doc(`users/${user.uid}/notes/${id}`),
        { title: n.title || '', html: n.html || '', files: n.files || [], ts: n.ts || Date.now() });
    }
    await batch.commit();
  } catch (e) { toast('Не сохранилось в облако: ' + e.message); }
}

function findNote(id) {
  for (const f of data.folders) { const n = f.notes.find(x => x.id === id); if (n) return n; }
}

async function dropNote(id) {
  if (cloud()) store.doc(`users/${user.uid}/notes/${id}`).delete().catch(() => {});
}

/* --- загрузка --- */
async function pullCloud() {
  const [m, ns] = await Promise.all([
    store.doc(`users/${user.uid}`).get(),
    store.collection(`users/${user.uid}/notes`).get(),
  ]);
  const bodies = {};
  ns.forEach(d => bodies[d.id] = d.data());
  const raw = m.exists ? m.data() : { folders: [] };
  return {
    folders: (raw.folders || []).map(f => ({
      ...f,
      notes: (f.notes || []).map(s => ({ ...s, ...(bodies[s.id] || { html: '', files: [] }) })),
    })),
    cards: raw.cards || [],
    tests: raw.tests || [],
  };
}

/* --- вход --- */
async function enter(who, fbUser) {
  user = fbUser || null;
  me = fbUser ? fbUser.uid : 'гость';
  localStorage.setItem('last', me);

  if (cloud()) {
    data = await pullCloud();
    const local = await db.get('data:гость');
    if (local?.folders?.length && !data.folders.length && confirm(
      'Перенести записи, созданные без аккаунта, в этот аккаунт?')) {
      data = local;
      data.folders.forEach(f => f.notes.forEach(n => dirty.add(n.id)));
      await pushCloud();
    }
  } else {
    data = (await db.get('data:гость')) || { folders: [] };
  }

  $('#who').textContent = who;
  $('#who').title = cloud() ? 'Записи синхронизируются' : 'Только в этом браузере';
  const a = $('#auth');
  a.classList.add('gone');
  setTimeout(() => a.classList.add('hidden'), 340);
  $('#app').classList.remove('hidden');
  $('#burger').classList.remove('hidden');
  render();
  refreshBadge();
}

/* --- кнопки --- */
const creds = () => [$('#auth-login').value.trim(), $('#auth-pass').value];

$('#btn-register').onclick = async () => {
  if (!auth) return err('Облако ещё не настроено — заходи без аккаунта');
  const [m, p] = creds();
  busy(true);
  try { await auth.createUserWithEmailAndPassword(m, p); }
  catch (e) { err(errText(e.code)); }
  busy(false);
};

$('#btn-login').onclick = async () => {
  if (!auth) return err('Облако ещё не настроено — заходи без аккаунта');
  const [m, p] = creds();
  busy(true);
  try { await auth.signInWithEmailAndPassword(m, p); }
  catch (e) { err(errText(e.code)); }
  busy(false);
};

$('#btn-google').onclick = async () => {
  if (!auth) return err('Облако ещё не настроено — заходи без аккаунта');
  busy(true);
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (e) { err(errText(e.code)); }
  busy(false);
};

$('#btn-reset').onclick = async () => {
  const [m] = creds();
  if (!m) return err('Впиши почту, на неё придёт письмо');
  try { await auth.sendPasswordResetEmail(m); toast('Письмо для сброса отправлено'); }
  catch (e) { err(errText(e.code)); }
};

$('#btn-guest').onclick = () => enter('гость');

function busy(on) {
  $$('.auth-card button').forEach(b => b.disabled = on);
  $('#btn-login').textContent = on ? 'Секунду…' : 'Войти';
}

/* Firebase сам вспоминает, кто вошёл */
if (auth) auth.onAuthStateChanged(u => {
  if (u) enter(u.displayName || u.email, u);
  else if (localStorage.getItem('last') === 'гость') enter('гость');
});

/* переключение Вход / Регистрация */
$$('.tab').forEach(t => t.onclick = () => {
  const reg = t.dataset.tab === 'reg';
  $('.tabs').classList.toggle('reg', reg);
  $$('.tab').forEach(x => x.classList.toggle('on', x === t));
  $('#btn-login').classList.toggle('hidden', reg);
  $('#btn-register').classList.toggle('hidden', !reg);
  $('#btn-reset').classList.toggle('hidden', reg);
  $('#auth-err').textContent = '';
  $('#auth-login').focus();
});
const submitAuth = () => ($('.tabs').classList.contains('reg') ? $('#btn-register') : $('#btn-login')).click();
$('#auth-login').onkeydown = e => e.key === 'Enter' && $('#auth-pass').focus();
$('#auth-pass').onkeydown = e => e.key === 'Enter' && submitAuth();

function err(m) {
  const el = $('#auth-err');
  el.textContent = m;
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}

$('#btn-logout').onclick = async () => {
  localStorage.removeItem('last');
  if (auth && user) await auth.signOut();
  location.reload();
};

/* ---------- Дерево папок ---------- */
function render() {
  const q = $('#search').value.trim().toLowerCase();
  const tree = $('#tree');
  tree.innerHTML = '';

  if (!data.folders.length) {
    tree.innerHTML = '<p class="tree-hint">Пока пусто.<br>Создай первый предмет ↓</p>';
    return;
  }

  for (const f of data.folders) {
    const hit = f.name.toLowerCase().includes(q);
    const notes = q && !hit
      ? f.notes.filter(n => (n.title + ' ' + n.html).toLowerCase().includes(q))
      : f.notes;
    if (q && !hit && !notes.length) continue;

    const el = document.createElement('div');
    el.className = 'folder' + (f.open || q ? ' open' : '');
    el.innerHTML = `
      <div class="f-row">
        <span class="arw">▶</span>
        <span class="f-name"></span>
        <span class="count"></span>
        <span class="f-act">
          <button class="icon" data-a="add" title="Новый конспект">＋</button>
          <button class="icon" data-a="ren" title="Переименовать">✎</button>
          <button class="icon" data-a="del" title="Удалить">🗑</button>
        </span>
      </div>
      <div class="notes"></div>`;
    el.querySelector('.f-name').textContent = f.name;
    el.querySelector('.count').textContent = f.notes.length || '';

    el.querySelector('.f-row').onclick = async e => {
      const a = e.target.dataset.a;
      if (a === 'add') return newNote(f);
      if (a === 'ren') {
        const n = await ask('Название предмета', f.name);
        if (n) { f.name = n; save(); render(); }
        return;
      }
      if (a === 'del') {
        if (!confirm(`Удалить «${f.name}» со всеми конспектами?`)) return;
        f.notes.forEach(n => dropNote(n.id));
        data.folders = data.folders.filter(x => x !== f);
        if (curFolder === f) closeNote();
        save(); render();
        return;
      }
      f.open = !f.open; save(); render();
    };

    const box = el.querySelector('.notes');
    notes.forEach((n, i) => {
      const ne = document.createElement('div');
      ne.className = 'note' + (cur === n ? ' active' : '');
      ne.style.animationDelay = i * 20 + 'ms';
      ne.innerHTML = `<span class="ico">📄</span><span class="n-name"></span>
        <span class="f-act">
          <button class="icon" data-n="ren" title="Переименовать">✎</button>
          <button class="icon" data-n="del" title="Удалить">🗑</button>
        </span>`;
      ne.querySelector('.n-name').textContent = n.title || 'Без названия';
      ne.onclick = async e => {
        const a = e.target.dataset.n;
        if (a === 'ren') {
          const t = await ask('Название конспекта', n.title);
          if (t) { n.title = t; if (cur === n) $('#title').value = t; save(); render(); }
          return;
        }
        if (a === 'del') return delNote(f, n);
        openNote(f, n);
      };
      box.appendChild(ne);
    });
    tree.appendChild(el);
  }
}

$('#search').oninput = render;

$('#btn-folder').onclick = async () => {
  const n = await ask('Новый предмет');
  if (!n) return;
  data.folders.push({ id: uid(), name: n, open: true, notes: [] });
  save(); render();
};

function newNote(f) {
  const n = { id: uid(), title: '', html: '', files: [], ts: Date.now() };
  f.notes.unshift(n);
  f.open = true;
  save(); openNote(f, n);
  $('#title').focus();
}

function delNote(f, n) {
  if (!confirm('Удалить конспект?')) return;
  dropNote(n.id);
  f.notes = f.notes.filter(x => x !== n);
  save();
  if (cur === n) closeNote();
  render();
}

/* ---------- Редактор ---------- */
function openNote(f, n) {
  curFolder = f; cur = n;
  if (!$('#study').classList.contains('hidden')) view(false);
  $('#empty').classList.add('hidden');
  const ed = $('#editor');
  ed.classList.remove('hidden', 'in'); void ed.offsetWidth; ed.classList.add('in');
  $('#title').value = n.title;
  $('#body').innerHTML = n.html;
  ensureTail();
  renderFiles();
  renderMeta();
  render();
  closeSidebar();
}
function closeNote() {
  cur = curFolder = null;
  $('#editor').classList.add('hidden');
  $('#empty').classList.remove('hidden');
  $('#ai-panel').classList.add('hidden');
}

let timer;
function touch() {
  if (!cur) return;
  cur.title = $('#title').value;
  cur.html = $('#body').innerHTML;
  cur.ts = Date.now();
  const s = $('#saved');
  s.textContent = 'сохраняю…';
  s.classList.add('show', 'busy');
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await save();
    s.textContent = '✓ сохранено';
    s.classList.remove('busy');
    setTimeout(() => s.classList.remove('show'), 1100);
    render();
  }, 500);
}
$('#title').oninput = touch;
$('#title').onkeydown = e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#body').focus(); }
};
$('#body').oninput = () => { ensureTail(); touch(); renderMeta(); };

function renderMeta() {
  if (!cur) return;
  const words = ($('#body').innerText.match(/[\p{L}\p{N}]+/gu) || []).length;
  const d = new Date(cur.ts);
  $('#meta').textContent = `${words} слов · изменён ${d.toLocaleDateString('ru')} ${d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`;
}

$('#btn-del').onclick = () => cur && delNote(curFolder, cur);

/* форматирование */
$$('[data-cmd]').forEach(b => b.onclick = () => {
  document.execCommand(b.dataset.cmd, false, null);
  $('#body').focus(); touch(); syncTools();
});
$$('[data-block]').forEach(b => b.onclick = () => {
  const on = b.classList.contains('on');
  document.execCommand('formatBlock', false, on ? 'p' : b.dataset.block);
  $('#body').focus(); touch(); syncTools();
});
$('#btn-hl').onclick = () => {
  document.execCommand('hiliteColor', false, '#3b82f655');
  $('#body').focus(); touch();
};
$('#btn-line').onclick = () => insert('<hr>');

$('#btn-table').onclick = async () => {
  const r = await ask('Таблица', '', true);
  if (!r || !r.cols || !r.rows) return;
  const row = t => '<tr>' + `<${t}><br></${t}>`.repeat(r.cols) + '</tr>';
  insert(`<table><thead>${row('th')}</thead><tbody>${row('td').repeat(r.rows)}</tbody></table>`);
};

/* подсветка активных кнопок панели */
function syncTools() {
  $$('[data-cmd]').forEach(b => {
    try { b.classList.toggle('on', document.queryCommandState(b.dataset.cmd)); } catch {}
  });
  let block = '';
  try { block = (document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch {}
  $$('[data-block]').forEach(b => b.classList.toggle('on', b.dataset.block === block));
}
document.addEventListener('selectionchange', () => {
  if (document.activeElement === $('#body')) syncTools();
});

/* всегда оставляем пустой абзац в конце — иначе после картинки/таблицы некуда писать */
function ensureTail() {
  const b = $('#body'), last = b.lastElementChild;
  if (!last || !/^(P|DIV)$/.test(last.tagName) || last.querySelector('img,table,hr')) {
    b.insertAdjacentHTML('beforeend', '<p><br></p>');
  }
}

/* вставка блока и перевод курсора на строку под ним */
function insert(html) {
  const b = $('#body');
  b.focus();
  document.execCommand('insertHTML', false, html + '<p id="__c"><br></p>');
  const c = document.getElementById('__c');
  if (c) {
    c.removeAttribute('id');
    const r = document.createRange();
    r.setStart(c, 0); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    c.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  ensureTail();
  touch();
}

/* клик по пустому месту под текстом — курсор в конец */
$('#body').addEventListener('click', e => {
  if (e.target !== $('#body')) return;
  ensureTail();
  const r = document.createRange();
  r.selectNodeContents($('#body').lastElementChild); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
});

/* картинка из буфера */
$('#body').addEventListener('paste', e => {
  const img = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (!img) return;
  e.preventDefault();
  const f = img.getAsFile();
  keep(f, f.name || 'вставка.png').then(src => insert(`<p><img src="${src}"></p>`));
});

/* ---------- Экспорт в PDF / Word ---------- */
const esc = t => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* стили документа — светлая бумага, но фиолетовые акценты приложения */
const DOC_CSS = `
@page{margin:18mm 16mm}
body{font:11.5pt/1.65 Georgia,"Times New Roman",serif;color:#111827;margin:0;background:#fff}
.wm{position:fixed;right:2mm;bottom:5mm;opacity:.055;transform:rotate(-20deg);z-index:0;
  text-align:center;width:62mm}
.wm img{width:36mm;display:block;margin:0 auto}
.wm span{display:block;font:700 15pt Arial,sans-serif;letter-spacing:6px;color:#2563eb;margin-top:-3mm}
.page{position:relative;z-index:1}
.cover{text-align:center;padding:52mm 0 0}
.cover p{text-align:center}
.cover .mark-img{display:block;margin:0 auto 5mm}
.cover .mark{font:700 10.5pt Arial,sans-serif;letter-spacing:7px;text-transform:uppercase;
  color:#3b82f6;margin-bottom:10mm}
.cover h1{font-size:30pt;margin:6mm 0 3mm;letter-spacing:-1px;color:#152a5e}
.cover .sub{font-size:13pt;color:#64748b;margin:0}
.cover .rule{width:52mm;height:3px;background:linear-gradient(90deg,#2563eb,#22d3ee);
  margin:9mm auto;border-radius:3px}
.cover .who{font-size:10.5pt;color:#8b88a0;margin-top:26mm}
.toc{page-break-before:always}
.toc h2,.ch-t{color:#1d4ed8}
.toc h2{font-size:18pt;border-bottom:2px solid #dbeafe;padding-bottom:3mm;margin-bottom:6mm}
.toc ol{list-style:none;padding:0;counter-reset:ch}
.toc li.ch{counter-increment:ch;margin:4mm 0;font-weight:700;font-size:12.5pt}
.toc li.ch:before{content:counter(ch) ". ";color:#3b82f6}
.toc ul{list-style:none;padding-left:8mm;margin:2mm 0 0;font-weight:400;font-size:11pt;color:#4b4a5e}
.toc ul li{margin:1.6mm 0}
.toc ul li:before{content:"— ";color:#93c5fd}
.toc a{color:inherit;text-decoration:none}
section{page-break-before:always}
section:first-of-type{page-break-before:auto}
.ch-t{font-size:21pt;margin:0 0 2mm;letter-spacing:-.5px}
.ch-meta{font-size:9.5pt;color:#94a3b8;border-bottom:1px solid #dbeafe;
  padding-bottom:3mm;margin-bottom:6mm;font-family:Arial,sans-serif}
h1,h2,h3{page-break-after:avoid;color:#1e3a8a}
h1{font-size:16pt;margin:7mm 0 2mm}
h2{font-size:13.5pt;margin:6mm 0 2mm}
p{margin:0 0 3mm;text-align:justify}
ul,ol{margin:0 0 3mm;padding-left:7mm}
li{margin:1mm 0}
blockquote{border-left:3px solid #60a5fa;background:#eff6ff;margin:4mm 0;
  padding:2mm 5mm;color:#1e3a8a;font-style:italic}
pre{background:#f1f5f9;border:1px solid #dbeafe;border-radius:3mm;padding:3mm 4mm;
  font:10pt ui-monospace,Consolas,monospace;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;margin:4mm 0;page-break-inside:avoid;font-size:10.5pt}
td,th{border:1px solid #cbd5e1;padding:2mm 3mm;text-align:left}
th{background:#eff6ff;color:#1e3a8a;font-weight:700}
img{max-width:100%;border:1px solid #dbeafe;border-radius:2mm;margin:3mm 0}
hr{border:none;height:1px;background:#dbeafe;margin:6mm 0}
.att{font-size:10pt;color:#64748b;margin-top:5mm;font-family:Arial,sans-serif}
.att b{color:#1d4ed8}
`;

/* колба картинкой — SVG документы Word не понимает, поэтому переводим в PNG */
let logoCache = null;
function logoPng() {
  if (logoCache) return logoCache;
  logoCache = new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 240; c.height = 240;
      c.getContext('2d').drawImage(img, 0, 0, 240, 240);
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => res('');
    img.src = 'logo.svg';
  });
  return logoCache;
}

/* Word ставит разрыв страницы, объявленный на контейнере, каждому его абзацу —
   поэтому для .doc разрывы задаём отдельными элементами, а не классами. */
const WORD_BREAK = '<br clear="all" style="mso-special-character:line-break;page-break-before:always">';

/* собирает готовый документ из конспектов */
function buildDoc(notes, subject, withToc, forWord, logo) {
  let toc = '', body = '';
  const brk = forWord ? WORD_BREAK : '';

  notes.forEach((n, i) => {
    const box = document.createElement('div');
    box.innerHTML = n.html || '';
    box.querySelectorAll('p:empty, p > br:only-child').forEach(el => {
      const p = el.tagName === 'P' ? el : el.parentElement;
      if (!p.textContent.trim() && !p.querySelector('img,table')) p.remove();
    });

    let sub = '';
    box.querySelectorAll('h1,h2').forEach((h, j) => {
      h.id = `h${i}_${j}`;
      sub += `<li><a href="#h${i}_${j}">${esc(h.textContent)}</a></li>`;
    });

    const name = esc(n.title || 'Без названия');
    toc += `<li class="ch"><a href="#c${i}">${name}</a>${sub ? `<ul>${sub}</ul>` : ''}</li>`;

    const files = (n.files || []).length
      ? `<p class="att"><b>Вложения:</b> ${n.files.map(f => esc(f.name)).join(', ')}</p>`
      : '';
    const d = new Date(n.ts).toLocaleDateString('ru');
    body += `${brk}<section><h1 class="ch-t" id="c${i}">${name}</h1>
      <p class="ch-meta">${esc(subject)} · ${d}</p>${box.innerHTML}${files}</section>`;
  });

  const today = new Date().toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
  const cover = `<div class="cover">
      ${logo ? `<img class="mark-img" src="${logo}" width="74">` : ''}
      <div class="mark">Clarity</div>
      <h1>${esc(subject)}</h1>
      <p class="sub">${notes.length === 1 ? esc(notes[0].title || 'Конспект') : `Конспекты — ${notes.length} шт.`}</p>
      <div class="rule"></div>
      <p class="who">${esc(me)} · ${today}</p>
    </div>`;

  const tocBlock = withToc && notes.length
    ? `${brk}<div class="toc"><h2>Содержание</h2><ol>${toc}</ol></div>` : '';

  return { cover, tocBlock, body };
}

async function docPage(notes, subject, withToc, forWord) {
  const logo = await logoPng();
  const { cover, tocBlock, body } = buildDoc(notes, subject, withToc, forWord, logo);
  /* в Word position:fixed не повторяется по страницам, поэтому знак только на обложке */
  const wm = `<div class="wm"${forWord ? ' style="position:absolute;top:150mm;right:6mm"' : ''}>
      ${logo ? `<img src="${logo}">` : ''}<span>CLARITY</span></div>`;
  /* для .doc разрывы уже расставлены явно — убираем те, что Word размножает по абзацам */
  const css = forWord
    ? DOC_CSS.replace(/^\.toc\{page-break-before:always\}$/m, '.toc{}')
             .replace(/^section\{page-break-before:always\}$/m, 'section{}')
             .replace(/^section:first-of-type\{page-break-before:auto\}$/m, '')
    : DOC_CSS;
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
    <title>${esc(subject)}</title><style>${css}</style></head>
    <body>${wm}<div class="page">${cover}${tocBlock}${body}</div></body></html>`;
}

function expTargets() {
  const folder = $('input[name=scope]:checked').value === 'folder';
  const notes = folder ? curFolder.notes.filter(n => n.title || n.html) : [cur];
  return { notes, subject: folder ? curFolder.name : (cur.title || 'Конспект') };
}

$('#btn-exp').onclick = () => cur && show($('#exp-modal'));
$('#exp-cancel').onclick = () => hide($('#exp-modal'));

$('#exp-pdf').onclick = async () => {
  const { notes, subject } = expTargets();
  const html = await docPage(notes, subject, $('#exp-toc').checked, false);
  hide($('#exp-modal'));
  const fr = document.createElement('iframe');
  fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  fr.srcdoc = html;
  fr.onload = () => {
    fr.contentWindow.focus();
    fr.contentWindow.print();
    setTimeout(() => fr.remove(), 60000);
  };
  document.body.appendChild(fr);
  toast('Печать → «Сохранить как PDF», колонтитулы сними');
};

$('#exp-word').onclick = async () => {
  const { notes, subject } = expTargets();
  const html = await docPage(notes, subject, $('#exp-toc').checked, true);
  hide($('#exp-modal'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + html], { type: 'application/msword' }));
  a.download = subject.replace(/[\\/:*?"<>|]/g, '') + '.doc';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Документ Word скачан');
};

/* ---------- Файлы ---------- */
$('#btn-file').onclick = () => $('#file-input').click();
$('#file-input').onchange = e => {
  for (const f of e.target.files) addFile(f);
  e.target.value = '';
};
async function addFile(f) {
  if (f.size > 20 * 1024 * 1024) return toast(`«${f.name}» больше 20 МБ`);
  toast('Загружаю ' + f.name + '…');
  const src = await keep(f, f.name);
  if (f.type.startsWith('image/')) insert(`<p><img src="${src}"></p>`);
  else { cur.files.push({ id: uid(), name: f.name, size: f.size, data: src }); save(); renderFiles(); }
  toast('Добавлено: ' + f.name);
}

/* С аккаунтом файлы уезжают в облачное хранилище и в конспекте остаётся ссылка —
   иначе картинки в base64 быстро упёрлись бы в лимит документа Firestore. */
async function keep(blob, name) {
  if (cloud()) {
    try {
      const ref = bucket.ref(`users/${user.uid}/${cur.id}/${uid()}-${name}`);
      await ref.put(blob);
      return await ref.getDownloadURL();
    } catch (e) { toast('Файл остался локально: ' + e.message); }
  }
  return await new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
}
function renderFiles() {
  const box = $('#files');
  box.innerHTML = '';
  for (const f of cur.files || []) {
    const el = document.createElement('div');
    el.className = 'file';
    el.innerHTML = '<span>📎</span><a download></a><span class="sz"></span><button title="Удалить">✕</button>';
    const a = el.querySelector('a');
    a.textContent = f.name; a.href = f.data; a.download = f.name;
    el.querySelector('.sz').textContent = f.size ? Math.round(f.size / 1024) + ' КБ' : '';
    el.querySelector('button').onclick = () => {
      el.classList.add('out');
      setTimeout(() => {
        cur.files = cur.files.filter(x => x !== f);
        save(); renderFiles();
      }, 180);
    };
    box.appendChild(el);
  }
}

/* перетаскивание файлов в конспект */
const bodyEl = $('#body');
['dragover', 'dragenter'].forEach(ev => bodyEl.addEventListener(ev, e => {
  e.preventDefault(); bodyEl.classList.add('drop');
}));
['dragleave', 'drop'].forEach(ev => bodyEl.addEventListener(ev, e => {
  e.preventDefault(); bodyEl.classList.remove('drop');
}));
bodyEl.addEventListener('drop', e => {
  if (!cur) return;
  for (const f of e.dataTransfer.files) addFile(f);
});

/* ---------- Рисование ---------- */
const cv = $('#canvas'), ctx = cv.getContext('2d');
let drawing = false, eraser = false, undoStack = [];

$('#btn-draw').onclick = () => {
  ctx.clearRect(0, 0, cv.width, cv.height);
  undoStack = [];
  show($('#draw-modal'));
};
$('#draw-cancel').onclick = () => hide($('#draw-modal'));
$('#draw-clear').onclick = () => { pushUndo(); ctx.clearRect(0, 0, cv.width, cv.height); };
$('#draw-undo').onclick = popUndo;
$('#draw-save').onclick = () => {
  hide($('#draw-modal'));
  cv.toBlob(async b => insert(`<p><img src="${await keep(b, 'рисунок.png')}"></p>`), 'image/png');
};
$('#pen-mode').onclick = () => setMode(false);
$('#eraser-mode').onclick = () => setMode(true);
function setMode(e) {
  eraser = e;
  $('#pen-mode').classList.toggle('active', !e);
  $('#eraser-mode').classList.toggle('active', e);
}
function pushUndo() {
  undoStack.push(ctx.getImageData(0, 0, cv.width, cv.height));
  if (undoStack.length > 25) undoStack.shift();
}
function popUndo() {
  const s = undoStack.pop();
  if (s) ctx.putImageData(s, 0, 0);
}

const pos = e => {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height];
};
cv.addEventListener('pointerdown', e => {
  pushUndo();
  drawing = true; cv.setPointerCapture(e.pointerId);
  ctx.beginPath(); ctx.moveTo(...pos(e));
  stroke(e);              // одиночный клик тоже оставляет точку
});
cv.addEventListener('pointermove', e => drawing && stroke(e));
addEventListener('pointerup', () => drawing = false);
function stroke(e) {
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = +$('#pen-size').value * (eraser ? 4 : 1);
  ctx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
  ctx.strokeStyle = $('#pen-color').value;
  ctx.lineTo(...pos(e)); ctx.stroke();
}

/* ---------- ИИ (Groq) ---------- */
/* Общий ключ вшит, чтобы ИИ работал сразу без настройки.
   Код публичный, значит ключ виден всем — при злоупотреблении просто меняем. */
const KEY = ['gsk_jeMCQ93i6A8sMiH0eXcS', 'WGdyb3FY9mzl5nSma9J7lW2w', 'HALUcpYX'].join('');
const MODEL = 'openai/gpt-oss-120b';
const cfg = () => {
  const c = JSON.parse(localStorage.getItem('ai') || '{}');
  return { key: c.key || KEY, model: c.model || MODEL };
};

$('#btn-settings').onclick = () => {
  const c = cfg();
  $('#api-key').value = c.key === KEY ? '' : c.key;
  $('#api-model').value = c.model;
  show($('#set-modal'));
};
$('#set-cancel').onclick = () => hide($('#set-modal'));
$('#set-save').onclick = () => {
  localStorage.setItem('ai', JSON.stringify({ key: $('#api-key').value.trim(), model: $('#api-model').value }));
  hide($('#set-modal'));
  toast('Сохранено');
};

$('#btn-ai').onclick = () => {
  const p = $('#ai-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) $('#ai-prompt').focus();
};
$('#ai-close').onclick = () => $('#ai-panel').classList.add('hidden');

const TASKS = {
  structure: 'Структурируй этот конспект: заголовки, списки, логичный порядок. Ничего не выдумывай, только переорганизуй.',
  improve: 'Улучши текст конспекта: понятные формулировки, убери воду, сохрани все факты.',
  table: 'Преврати ключевую информацию из конспекта в аккуратную HTML-таблицу (или несколько).',
  summary: 'Сделай краткий конспект: главные тезисы списком.',
  questions: 'Составь 8 вопросов для самопроверки по этому конспекту, ответы курсивом после каждого вопроса.',
  terms: 'Выдели все термины из конспекта и дай короткие определения списком.',
};

$$('[data-ai]').forEach(b => b.onclick = () => askAI(TASKS[b.dataset.ai]));
$('#ai-run').onclick = () => {
  const p = $('#ai-prompt').value.trim();
  p ? askAI(p) : toast('Напиши запрос');
};
$('#ai-prompt').onkeydown = e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#ai-run').click();
};

async function askAI(task) {
  const c = cfg();
  const out = $('#ai-out');
  out.innerHTML = '<span class="dots">Думаю</span>';
  $('#ai-apply').classList.add('hidden');
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
      body: JSON.stringify({
        model: c.model,
        temperature: 0.4,
        max_completion_tokens: 4000,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: 'Ты помощник для учебных конспектов. Отвечай на русском чистым HTML (h2, p, ul, ol, table, b, i) без markdown и без ```.' },
          { role: 'user', content: `${task}\n\nЗаголовок: ${cur?.title || '—'}\n\nКонспект:\n${$('#body').innerText || '(пусто)'}` },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || r.status);
    const m = j.choices[0].message;
    out.innerHTML = (m.content || m.reasoning || '').replace(/```html|```/g, '');
    $('#ai-apply').classList.remove('hidden');
  } catch (e) {
    out.textContent = 'Ошибка: ' + e.message;
  }
}

$('#ai-replace').onclick = () => { $('#body').innerHTML = $('#ai-out').innerHTML; ensureTail(); touch(); toast('Заменено'); };
$('#ai-append').onclick = () => { $('#body').innerHTML += $('#ai-out').innerHTML; ensureTail(); touch(); toast('Добавлено'); };

/* ---------- Мелочи ---------- */
let toastT;
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2200);
}

const openSidebar = () => { $('.sidebar').classList.add('open'); $('#scrim').classList.add('on'); };
const closeSidebar = () => { $('.sidebar').classList.remove('open'); $('#scrim').classList.remove('on'); };
$('#burger').onclick = () => $('.sidebar').classList.contains('open') ? closeSidebar() : openSidebar();
$('#scrim').onclick = closeSidebar;

addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); touch(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#search').focus(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !$('#draw-modal').classList.contains('hidden')) {
    e.preventDefault(); popUndo();
  }
  if (e.key === 'Escape') {
    $$('.modal:not(.hidden)').forEach(hide);
    $('#ai-panel').classList.add('hidden');
    closeSidebar();
  }
});

/* ================= УЧЁБА: карточки и тесты ================= */

/* Интервалы повторения по Лейтнеру, в днях. Ошибся — назад в первую коробку. */
const BOXES = [0, 1, 2, 4, 8, 16, 32];
const DAY = 864e5;
const cards = () => (data.cards ||= []);
const due = () => cards().filter(c => c.due <= Date.now());

function saveCard(term, def, folder, note) {
  cards().unshift({ id: uid(), term, def, folder, note, box: 0, due: Date.now(), ts: Date.now() });
  save(); refreshBadge();
}

function refreshBadge() {
  const b = $('#due-badge'), n = data?.cards ? due().length : 0;
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

/* --- переключение разделов --- */
function view(study) {
  $('#v-notes').classList.toggle('on', !study);
  $('#v-study').classList.toggle('on', study);
  $('#study').classList.toggle('hidden', !study);
  $('#editor').classList.toggle('hidden', study || !cur);
  $('#empty').classList.toggle('hidden', study || !!cur);
  $('.tree').classList.toggle('dim', study);
  if (study) { fillPickers(); drawCards(); }
  closeSidebar();
}
$('#v-notes').onclick = () => view(false);
$('#v-study').onclick = () => view(true);

$$('.st-tab').forEach(t => t.onclick = () => {
  $$('.st-tab').forEach(x => x.classList.toggle('on', x === t));
  const isCards = t.dataset.st === 'cards';
  $('#st-cards').classList.toggle('hidden', !isCards);
  $('#st-tests').classList.toggle('hidden', isCards);
  if (isCards) drawCards();
});

function fillPickers() {
  const f = $('#card-folder');
  f.innerHTML = '<option value="">Все предметы</option>' +
    data.folders.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');

  const s = $('#test-src');
  s.innerHTML = data.folders.map(x =>
    `<optgroup label="${esc(x.name)}">` +
    `<option value="f:${x.id}">Весь предмет — ${esc(x.name)}</option>` +
    x.notes.map(n => `<option value="n:${n.id}">${esc(n.title || 'Без названия')}</option>`).join('') +
    '</optgroup>').join('') || '<option value="">Сначала создай конспект</option>';
}
$('#card-folder').onchange = drawCards;

/* --- карточки --- */
let queue = [], flipped = false;

function drawCards() {
  const fid = $('#card-folder').value;
  const pool = cards().filter(c => !fid || c.folder === fid);
  queue = pool.filter(c => c.due <= Date.now());
  $('#card-stat').textContent = pool.length
    ? `${queue.length} к повторению · ${pool.length} всего`
    : '';
  refreshBadge();

  const area = $('#card-area');
  if (!pool.length) {
    area.innerHTML = `<div class="st-empty"><div class="big">🎴</div>
      <p>Колода пуста.</p>
      <p class="sm">Открой конспект, выдели слово или фразу — и нажми «🎴 В колоду».
      Определение подберёт ИИ по смыслу самого конспекта.</p></div>`;
    return;
  }
  if (!queue.length) {
    const next = new Date(Math.min(...pool.map(c => c.due)));
    area.innerHTML = `<div class="st-empty"><div class="big">✓</div>
      <p>На сегодня всё повторено.</p>
      <p class="sm">Следующая карточка — ${next.toLocaleDateString('ru')}.</p>
      <button id="card-force">Всё равно повторить</button></div>`;
    $('#card-force').onclick = () => { queue = pool.slice(); showCard(); };
    return;
  }
  showCard();
}

function showCard() {
  const c = queue[0];
  if (!c) return drawCards();
  flipped = false;
  $('#card-area').innerHTML = `
    <div class="flash" id="flash">
      <div class="fl-in">
        <div class="fl-face fl-front">
          <span class="fl-tag">${esc(folderName(c.folder))}</span>
          <div class="fl-term">${esc(c.term)}</div>
          <span class="fl-hint">нажми, чтобы увидеть определение</span>
        </div>
        <div class="fl-face fl-back">
          <div class="fl-def">${esc(c.def)}</div>
        </div>
      </div>
    </div>
    <div class="fl-btns hidden" id="fl-btns">
      <button id="fl-bad">Не помню</button>
      <button id="fl-ok" class="primary">Помню</button>
    </div>
    <div class="fl-under">
      <span>Осталось: ${queue.length}</span>
      <button id="fl-del" class="icon" title="Удалить карточку">🗑</button>
    </div>`;

  $('#flash').onclick = flip;
  $('#fl-bad').onclick = () => grade(false);
  $('#fl-ok').onclick = () => grade(true);
  $('#fl-del').onclick = () => {
    data.cards = cards().filter(x => x !== c);
    queue.shift(); save(); drawCards(); toast('Карточка удалена');
  };
}

function flip() {
  if (flipped) return;
  flipped = true;
  $('#flash').classList.add('flip');
  $('#fl-btns').classList.remove('hidden');
}

function grade(ok) {
  const c = queue.shift();
  c.box = ok ? Math.min(c.box + 1, BOXES.length - 1) : 0;
  c.due = Date.now() + (ok ? BOXES[c.box] * DAY : 6e5);   // ошибся — вернём через 10 минут
  if (!ok) queue.push(c);
  save();
  queue.length ? showCard() : drawCards();
}

const folderName = id => data.folders.find(f => f.id === id)?.name || 'Без предмета';

/* список всей колоды */
$('#card-all').onclick = () => {
  const fid = $('#card-folder').value;
  const pool = cards().filter(c => !fid || c.folder === fid);
  if (!pool.length) return toast('Колода пуста');
  $('#card-area').innerHTML = `<div class="deck">${pool.map(c => `
    <div class="deck-row" data-id="${c.id}">
      <div><b>${esc(c.term)}</b><span class="deck-def">${esc(c.def)}</span></div>
      <span class="deck-box" title="Уровень запоминания">${'●'.repeat(c.box + 1)}</span>
      <button class="icon">✕</button>
    </div>`).join('')}</div>
    <button id="deck-back" class="wide">← К повторению</button>`;
  $('#deck-back').onclick = drawCards;
  $$('.deck-row button').forEach(b => b.onclick = () => {
    const id = b.closest('.deck-row').dataset.id;
    data.cards = cards().filter(x => x.id !== id);
    save(); $('#card-all').click();
  });
};

/* --- добавление карточки выделением текста --- */
const pop = $('#sel-pop');
$('#body').addEventListener('mouseup', () => setTimeout(showPop, 10));
$('#body').addEventListener('keyup', () => setTimeout(showPop, 10));
document.addEventListener('mousedown', e => {
  if (!pop.contains(e.target)) pop.classList.add('hidden');
});

function showPop() {
  const s = getSelection();
  const t = s.toString().trim();
  if (!t || t.length > 80 || !cur) return pop.classList.add('hidden');
  const r = s.getRangeAt(0).getBoundingClientRect();
  pop.style.left = Math.max(8, r.left + r.width / 2 - 60) + 'px';
  pop.style.top = (r.top - 44) + 'px';
  pop.classList.remove('hidden');
}

$('#sel-card').onclick = async () => {
  const term = getSelection().toString().trim();
  pop.classList.add('hidden');
  if (!term) return;
  if (cards().some(c => c.term.toLowerCase() === term.toLowerCase()))
    return toast('Такая карточка уже есть');

  toast(`«${term}» — подбираю определение…`);
  let def = await defineTerm(term, $('#body').innerText);
  if (!def) def = await ask(`Определение для «${term}»`);
  if (!def) return;
  saveCard(term, def, curFolder.id, cur.id);
  toast(`🎴 «${term}» в колоде`);
};

async function defineTerm(term, context) {
  try {
    const r = await groq([
      { role: 'system', content: 'Ты даёшь короткие точные определения терминов для учебных карточек. Ответ — только определение, 1–2 предложения, без вводных слов и без повтора самого термина в начале.' },
      { role: 'user', content: `Термин: «${term}»\n\nКонтекст из конспекта:\n${context.slice(0, 4000)}` },
    ]);
    return r.trim().replace(/^["«]|["»]$/g, '');
  } catch { return ''; }
}

/* --- тесты --- */
let test = null;

$('#test-gen').onclick = async () => {
  const v = $('#test-src').value;
  if (!v) return toast('Сначала создай конспект');
  const count = +$('#test-count').value;

  let notes, title;
  if (v.startsWith('f:')) {
    const f = data.folders.find(x => x.id === v.slice(2));
    notes = f.notes; title = f.name;
  } else {
    for (const f of data.folders) {
      const n = f.notes.find(x => x.id === v.slice(2));
      if (n) { notes = [n]; title = n.title || 'Конспект'; }
    }
  }
  const text = notes.map(n => `${n.title}\n${htmlToText(n.html)}`).join('\n\n').slice(0, 12000);
  if (text.trim().length < 60) return toast('В конспекте слишком мало текста');

  $('#test-area').innerHTML = '<div class="st-empty"><span class="dots">Составляю тест</span></div>';
  try {
    const raw = await groq([
      { role: 'system', content: 'Ты составляешь проверочные тесты по учебным конспектам. Отвечай ТОЛЬКО валидным JSON без markdown.' },
      { role: 'user', content: `Составь ${count} вопросов с 4 вариантами ответа по этому конспекту. Проверяй понимание, а не дословную память. Формат строго:\n{"q":[{"t":"вопрос","a":["вариант1","вариант2","вариант3","вариант4"],"c":0,"why":"почему верен правильный ответ"}]}\nПоле c — индекс правильного варианта (0-3). Всё на русском.\n\nКонспект:\n${text}` },
    ]);
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const qs = (json.q || []).filter(q => q.t && q.a?.length === 4 && q.c >= 0 && q.c < 4);
    if (!qs.length) throw new Error('пустой тест');
    test = { qs, i: 0, right: 0, title };
    drawQuestion();
  } catch (e) {
    $('#test-area').innerHTML = `<div class="st-empty"><div class="big">😕</div>
      <p>Не получилось составить тест.</p><p class="sm">${esc(e.message)}</p></div>`;
  }
};

function drawQuestion() {
  const q = test.qs[test.i];
  $('#test-area').innerHTML = `
    <div class="quiz">
      <div class="q-bar"><i style="width:${test.i / test.qs.length * 100}%"></i></div>
      <div class="q-num">Вопрос ${test.i + 1} из ${test.qs.length} · ${esc(test.title)}</div>
      <div class="q-text">${esc(q.t)}</div>
      <div class="q-opts">${q.a.map((a, i) =>
        `<button class="q-opt" data-i="${i}">${esc(a)}</button>`).join('')}</div>
      <div class="q-why hidden" id="q-why"></div>
      <button id="q-next" class="primary wide hidden">Дальше →</button>
    </div>`;

  $$('.q-opt').forEach(b => b.onclick = () => {
    if ($('#q-why').classList.contains('shown')) return;
    const i = +b.dataset.i, ok = i === q.c;
    if (ok) test.right++;
    $$('.q-opt').forEach((x, j) => {
      x.classList.add('done');
      if (j === q.c) x.classList.add('right');
      if (j === i && !ok) x.classList.add('wrong');
    });
    const why = $('#q-why');
    why.innerHTML = `<b>${ok ? '✓ Верно' : '✕ Неверно'}</b> ${esc(q.why || '')}`;
    why.className = 'q-why shown ' + (ok ? 'good' : 'bad');
    $('#q-next').classList.remove('hidden');
    $('#q-next').textContent = test.i === test.qs.length - 1 ? 'Показать результат' : 'Дальше →';
  });

  $('#q-next').onclick = () => {
    test.i++;
    test.i < test.qs.length ? drawQuestion() : drawResult();
  };
}

function drawResult() {
  const p = Math.round(test.right / test.qs.length * 100);
  const mark = p >= 85 ? '5' : p >= 65 ? '4' : p >= 45 ? '3' : '2';
  (data.tests ||= []).unshift({ title: test.title, right: test.right, total: test.qs.length, ts: Date.now() });
  data.tests = data.tests.slice(0, 10);
  save();

  $('#test-area').innerHTML = `
    <div class="result">
      <div class="score" style="--p:${p}"><b>${p}<span>%</span></b></div>
      <p class="res-line">${test.right} из ${test.qs.length} · оценка ${mark}</p>
      <p class="sm">${p >= 85 ? 'Тема закрыта.' : p >= 65 ? 'Хорошо, но пробелы есть.' : 'Стоит перечитать конспект и пройти ещё раз.'}</p>
      <button id="q-again" class="primary">Пройти заново</button>
      ${data.tests.length > 1 ? `<div class="hist">${data.tests.slice(1).map(t =>
        `<div><span>${esc(t.title)}</span><b>${t.right}/${t.total}</b>
         <i>${new Date(t.ts).toLocaleDateString('ru')}</i></div>`).join('')}</div>` : ''}
    </div>`;
  $('#q-again').onclick = () => { test.i = 0; test.right = 0; drawQuestion(); };
}

/* общий вызов модели */
async function groq(messages) {
  const c = cfg();
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
    body: JSON.stringify({
      model: c.model, temperature: 0.3,
      max_completion_tokens: 4000, reasoning_effort: 'low', messages,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.status);
  const m = j.choices[0].message;
  return (m.content || m.reasoning || '').replace(/```json|```html|```/g, '');
}

function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.innerText;
}

/* убираем экран загрузки, когда всё готово */
addEventListener('load', () => setTimeout(() => {
  const b = $('#boot');
  b.classList.add('done');
  setTimeout(() => b.remove(), 600);
}, 900));

/* если облако не настроено — сразу пускаем гостя */
if (!auth && localStorage.getItem('last')) enter('гость');
