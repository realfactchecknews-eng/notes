/* Конспекты — локальное приложение на GitHub Pages.
   Данные лежат в IndexedDB браузера, по одному документу на пользователя. */

const $ = s => document.querySelector(s);
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
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
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

$('#auth-pass').onkeydown = e => e.key === 'Enter' && $('#btn-login').click();
const err = m => { $('#auth-err').textContent = m; };

$('#btn-logout').onclick = () => {
  localStorage.removeItem('last');
  location.reload();
};

/* ---------- Дерево папок ---------- */
function render() {
  const q = $('#search').value.trim().toLowerCase();
  const tree = $('#tree');
  tree.innerHTML = '';
  for (const f of data.folders) {
    const notes = q
      ? f.notes.filter(n => (n.title + ' ' + n.html).toLowerCase().includes(q))
      : f.notes;
    if (q && !notes.length && !f.name.toLowerCase().includes(q)) continue;

    const el = document.createElement('div');
    el.className = 'folder' + (f.open || q ? ' open' : '');
    el.innerHTML = `
      <div class="f-row">
        <span class="arw">▶</span>
        <span class="f-name"></span>
        <span class="f-act">
          <button class="icon" data-a="add" title="Новый конспект">＋</button>
          <button class="icon" data-a="ren" title="Переименовать">✎</button>
          <button class="icon" data-a="del" title="Удалить">🗑</button>
        </span>
      </div>
      <div class="notes"></div>`;
    el.querySelector('.f-name').textContent = f.name;

    el.querySelector('.f-row').onclick = e => {
      const a = e.target.dataset.a;
      if (a === 'add') return newNote(f);
      if (a === 'ren') {
        const n = prompt('Название предмета', f.name);
        if (n) { f.name = n.trim(); save(); render(); }
        return;
      }
      if (a === 'del') {
        if (confirm(`Удалить «${f.name}» со всеми конспектами?`)) {
          data.folders = data.folders.filter(x => x !== f);
          if (curFolder === f) closeNote();
          save(); render();
        }
        return;
      }
      f.open = !f.open; save(); render();
    };

    const box = el.querySelector('.notes');
    for (const n of notes) {
      const ne = document.createElement('div');
      ne.className = 'note' + (cur === n ? ' active' : '');
      ne.innerHTML = '<span>📄</span><span class="n-name"></span>';
      ne.querySelector('.n-name').textContent = n.title || 'Без названия';
      ne.onclick = () => openNote(f, n);
      box.appendChild(ne);
    }
    tree.appendChild(el);
  }
}

$('#search').oninput = render;

$('#btn-folder').onclick = () => {
  const n = prompt('Название предмета');
  if (!n) return;
  data.folders.push({ id: uid(), name: n.trim(), open: true, notes: [] });
  save(); render();
};

function newNote(f) {
  const n = { id: uid(), title: '', html: '', files: [], ts: Date.now() };
  f.notes.unshift(n);
  f.open = true;
  save(); openNote(f, n);
  $('#title').focus();
}

/* ---------- Редактор ---------- */
function openNote(f, n) {
  curFolder = f; cur = n;
  $('#empty').classList.add('hidden');
  $('#editor').classList.remove('hidden');
  $('#title').value = n.title;
  $('#body').innerHTML = n.html;
  renderFiles();
  render();
}
function closeNote() {
  cur = curFolder = null;
  $('#editor').classList.add('hidden');
  $('#empty').classList.remove('hidden');
}

let timer;
function touch() {
  if (!cur) return;
  cur.title = $('#title').value;
  cur.html = $('#body').innerHTML;
  cur.ts = Date.now();
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await save();
    $('#saved').classList.add('show');
    setTimeout(() => $('#saved').classList.remove('show'), 1200);
    render();
  }, 600);
}
$('#title').oninput = touch;
$('#body').oninput = touch;

$('#btn-del').onclick = () => {
  if (!cur || !confirm('Удалить конспект?')) return;
  curFolder.notes = curFolder.notes.filter(n => n !== cur);
  save(); closeNote(); render();
};

/* форматирование */
document.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => {
  document.execCommand(b.dataset.cmd, false, null);
  $('#body').focus(); touch();
});
document.querySelectorAll('[data-block]').forEach(b => b.onclick = () => {
  document.execCommand('formatBlock', false, b.dataset.block);
  $('#body').focus(); touch();
});
$('#btn-hl').onclick = () => {
  document.execCommand('hiliteColor', false, '#8b5cf655');
  $('#body').focus(); touch();
};
$('#btn-table').onclick = () => {
  const c = +prompt('Столбцов?', 3), r = +prompt('Строк?', 3);
  if (!c || !r) return;
  const row = t => '<tr>' + `<${t}><br></${t}>`.repeat(c) + '</tr>';
  insert(`<table><thead>${row('th')}</thead><tbody>${row('td').repeat(r)}</tbody></table><p><br></p>`);
};

function insert(html) {
  $('#body').focus();
  document.execCommand('insertHTML', false, html);
  touch();
}

/* вставка картинок из буфера */
$('#body').addEventListener('paste', e => {
  const img = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (!img) return;
  e.preventDefault();
  const r = new FileReader();
  r.onload = () => insert(`<img src="${r.result}">`);
  r.readAsDataURL(img.getAsFile());
});

/* ---------- Файлы ---------- */
$('#btn-file').onclick = () => $('#file-input').click();
$('#file-input').onchange = e => {
  for (const f of e.target.files) {
    if (f.size > 20 * 1024 * 1024) { toast(`«${f.name}» больше 20 МБ`); continue; }
    const r = new FileReader();
    r.onload = () => {
      cur.files.push({ id: uid(), name: f.name, data: r.result });
      save(); renderFiles();
    };
    r.readAsDataURL(f);
  }
  e.target.value = '';
};
function renderFiles() {
  const box = $('#files');
  box.innerHTML = '';
  for (const f of cur.files || []) {
    const el = document.createElement('div');
    el.className = 'file';
    el.innerHTML = '<span>📎</span><a download></a><button>✕</button>';
    const a = el.querySelector('a');
    a.textContent = f.name; a.href = f.data; a.download = f.name;
    el.querySelector('button').onclick = () => {
      cur.files = cur.files.filter(x => x !== f);
      save(); renderFiles();
    };
    box.appendChild(el);
  }
}

/* ---------- Рисование ---------- */
const cv = $('#canvas'), ctx = cv.getContext('2d');
let drawing = false, eraser = false;

$('#btn-draw').onclick = () => {
  ctx.clearRect(0, 0, cv.width, cv.height);
  $('#draw-modal').classList.remove('hidden');
};
$('#draw-cancel').onclick = () => $('#draw-modal').classList.add('hidden');
$('#draw-clear').onclick = () => ctx.clearRect(0, 0, cv.width, cv.height);
$('#draw-save').onclick = () => {
  insert(`<img src="${cv.toDataURL('image/png')}">`);
  $('#draw-modal').classList.add('hidden');
};
$('#pen-mode').onclick = () => setMode(false);
$('#eraser-mode').onclick = () => setMode(true);
function setMode(e) {
  eraser = e;
  $('#pen-mode').classList.toggle('active', !e);
  $('#eraser-mode').classList.toggle('active', e);
}

const pos = e => {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height];
};
cv.addEventListener('pointerdown', e => {
  drawing = true; cv.setPointerCapture(e.pointerId);
  ctx.beginPath(); ctx.moveTo(...pos(e));
});
cv.addEventListener('pointermove', e => {
  if (!drawing) return;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = +$('#pen-size').value * (eraser ? 4 : 1);
  ctx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
  ctx.strokeStyle = $('#pen-color').value;
  ctx.lineTo(...pos(e)); ctx.stroke();
});
addEventListener('pointerup', () => drawing = false);

/* ---------- ИИ (Groq) ---------- */
const cfg = () => JSON.parse(localStorage.getItem('ai') || '{}');

$('#btn-settings').onclick = () => {
  const c = cfg();
  $('#api-key').value = c.key || '';
  $('#api-model').value = c.model || 'llama-3.3-70b-versatile';
  $('#set-modal').classList.remove('hidden');
};
$('#set-cancel').onclick = () => $('#set-modal').classList.add('hidden');
$('#set-save').onclick = () => {
  localStorage.setItem('ai', JSON.stringify({ key: $('#api-key').value.trim(), model: $('#api-model').value }));
  $('#set-modal').classList.add('hidden');
  toast('Сохранено');
};

$('#btn-ai').onclick = () => $('#ai-panel').classList.toggle('hidden');
$('#ai-close').onclick = () => $('#ai-panel').classList.add('hidden');

const TASKS = {
  structure: 'Структурируй этот конспект: заголовки, списки, логичный порядок. Ничего не выдумывай, только переорганизуй и дополни очевидным.',
  improve: 'Улучши текст конспекта: понятные формулировки, убери воду, сохрани все факты.',
  table: 'Преврати ключевую информацию из конспекта в аккуратную HTML-таблицу (или несколько).',
  summary: 'Сделай краткий конспект: главные тезисы списком.',
  questions: 'Составь 8 вопросов для самопроверки по этому конспекту, с ответами под спойлером-курсивом.',
  terms: 'Выдели все термины из конспекта и дай короткие определения списком.',
};

document.querySelectorAll('[data-ai]').forEach(b => b.onclick = () => ask(TASKS[b.dataset.ai]));
$('#ai-run').onclick = () => {
  const p = $('#ai-prompt').value.trim();
  if (p) ask(p);
};

async function ask(task) {
  const c = cfg();
  if (!c.key) { $('#set-modal').classList.remove('hidden'); return toast('Сначала укажи ключ Groq'); }
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

$('#ai-replace').onclick = () => { $('#body').innerHTML = $('#ai-out').innerHTML; touch(); };
$('#ai-append').onclick = () => { $('#body').innerHTML += $('#ai-out').innerHTML; touch(); };

/* ---------- Мелочи ---------- */
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); touch(); }
});

/* мобильное меню */
if (matchMedia('(max-width:760px)').matches) {
  const b = document.createElement('button');
  b.textContent = '☰';
  b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:40;font-size:18px';
  b.onclick = () => $('.sidebar').classList.toggle('open');
  $('#app').appendChild(b);
}

/* автовход */
const last = localStorage.getItem('last');
if (last && users()[last]) enter(last);
