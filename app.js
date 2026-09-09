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

/* ---------- Авторизация (локальная, пароль хранится хешем) ---------- */
const sha = async t => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
};
const users = () => JSON.parse(localStorage.getItem('users') || '{}');

let me = null;          // логин текущего пользователя
let data = null;        // { folders: [{id,name,open,notes:[{id,title,html,files,ts}]}] }
let cur = null;         // текущая заметка
let curFolder = null;

const save = () => db.set('data:' + me, data);

async function enter(login) {
  me = login;
  localStorage.setItem('last', login);
  data = (await db.get('data:' + login)) || { folders: [] };
  $('#who').textContent = login;
  const a = $('#auth');
  a.classList.add('gone');
  setTimeout(() => a.classList.add('hidden'), 340);
  $('#app').classList.remove('hidden');
  $('#burger').classList.remove('hidden');
  render();
}

$('#btn-register').onclick = async () => {
  const l = $('#auth-login').value.trim(), p = $('#auth-pass').value;
  if (l.length < 2 || p.length < 4) return err('Логин от 2 символов, пароль от 4');
  const u = users();
  if (u[l]) return err('Такой логин уже занят');
  u[l] = await sha(p);
  localStorage.setItem('users', JSON.stringify(u));
  enter(l);
};

$('#btn-login').onclick = async () => {
  const l = $('#auth-login').value.trim(), p = $('#auth-pass').value;
  const u = users();
  if (!u[l]) return err('Нет такого пользователя');
  if (u[l] !== await sha(p)) return err('Неверный пароль');
  enter(l);
};

$('#btn-guest').onclick = () => enter('гость');

/* переключение Вход / Регистрация */
$$('.tab').forEach(t => t.onclick = () => {
  const reg = t.dataset.tab === 'reg';
  $('.tabs').classList.toggle('reg', reg);
  $$('.tab').forEach(x => x.classList.toggle('on', x === t));
  $('#btn-login').classList.toggle('hidden', reg);
  $('#btn-register').classList.toggle('hidden', !reg);
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

$('#btn-logout').onclick = () => {
  localStorage.removeItem('last');
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
  f.notes = f.notes.filter(x => x !== n);
  save();
  if (cur === n) closeNote();
  render();
}

/* ---------- Редактор ---------- */
function openNote(f, n) {
  curFolder = f; cur = n;
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
  document.execCommand('hiliteColor', false, '#8b5cf655');
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
  const r = new FileReader();
  r.onload = () => insert(`<p><img src="${r.result}"></p>`);
  r.readAsDataURL(img.getAsFile());
});

/* ---------- Файлы ---------- */
$('#btn-file').onclick = () => $('#file-input').click();
$('#file-input').onchange = e => {
  for (const f of e.target.files) addFile(f);
  e.target.value = '';
};
function addFile(f) {
  if (f.size > 20 * 1024 * 1024) return toast(`«${f.name}» больше 20 МБ`);
  const r = new FileReader();
  r.onload = () => {
    if (f.type.startsWith('image/')) insert(`<p><img src="${r.result}"></p>`);
    else { cur.files.push({ id: uid(), name: f.name, size: f.size, data: r.result }); save(); renderFiles(); }
    toast('Добавлено: ' + f.name);
  };
  r.readAsDataURL(f);
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
  insert(`<p><img src="${cv.toDataURL('image/png')}"></p>`);
  hide($('#draw-modal'));
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
const cfg = () => JSON.parse(localStorage.getItem('ai') || '{}');

$('#btn-settings').onclick = () => {
  const c = cfg();
  $('#api-key').value = c.key || '';
  $('#api-model').value = c.model || 'llama-3.3-70b-versatile';
  show($('#set-modal'));
};
$('#set-cancel').onclick = () => hide($('#set-modal'));
$('#set-save').onclick = () => {
  localStorage.setItem('ai', JSON.stringify({ key: $('#api-key').value.trim(), model: $('#api-model').value }));
  hide($('#set-modal'));
  toast('Ключ сохранён');
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
  if (!c.key) { show($('#set-modal')); return toast('Сначала укажи ключ Groq'); }
  const out = $('#ai-out');
  out.innerHTML = '<span class="dots">Думаю</span>';
  $('#ai-apply').classList.add('hidden');
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
      body: JSON.stringify({
        model: c.model || 'llama-3.3-70b-versatile',
        temperature: 0.4,
        messages: [
          { role: 'system', content: 'Ты помощник для учебных конспектов. Отвечай на русском чистым HTML (h2, p, ul, ol, table, b, i) без markdown и без ```.' },
          { role: 'user', content: `${task}\n\nЗаголовок: ${cur?.title || '—'}\n\nКонспект:\n${$('#body').innerText || '(пусто)'}` },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || r.status);
    out.innerHTML = (j.choices[0].message.content || '').replace(/```html|```/g, '');
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

/* автовход */
const last = localStorage.getItem('last');
if (last && (last === 'гость' || users()[last])) enter(last);
