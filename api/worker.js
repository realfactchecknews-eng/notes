/* Clarity API — аккаунты и синхронизация конспектов.
   Пароли хранятся как PBKDF2-хеш с солью, сессия — подписанный токен. */

const ITER = 100_000;              // потолок PBKDF2 в Workers; выше платформа не даёт
const TTL = 60 * 60 * 24 * 30;     // токен живёт месяц

const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  },
});
const bad = (msg, status = 400) => json({ error: msg }, status);

/* --- пароли --- */
async function hash(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, key, 256);
  return `${b64(salt)}:${b64(bits)}`;
}
async function verify(password, stored) {
  if (!stored || !stored.includes(':')) return false;   // аккаунт без пароля, только Google
  const [salt] = stored.split(':');
  const again = await hash(password, unb64(salt));
  /* сравнение без раннего выхода, чтобы не подсказывать время ответа */
  let diff = again.length ^ stored.length;
  for (let i = 0; i < again.length; i++) diff |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

/* --- токены --- */
async function sign(payload, secret) {
  const body = b64(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64(sig)}`;
}
async function open(token, secret) {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, unb64(sig), enc.encode(body));
  if (!ok) return null;
  const p = JSON.parse(new TextDecoder().decode(unb64(body)));
  return p.exp > Date.now() / 1000 ? p : null;
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

/* --- проверка токена Google --- */
/* Google подписывает свой токен ключом из общего набора; сверяем подпись сами,
   чтобы чужой токен нельзя было выдать за свой. */
let jwks = { at: 0, keys: [] };
async function googleKeys() {
  if (Date.now() - jwks.at < 3600e3 && jwks.keys.length) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const j = await r.json();
  jwks = { at: Date.now(), keys: j.keys || [] };
  return jwks.keys;
}

const fromB64Url = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/')
  .padEnd(s.length + (4 - s.length % 4) % 4, '='));

async function checkGoogle(idToken, clientId) {
  const [h, p, s] = String(idToken || '').split('.');
  if (!h || !p || !s) throw new Error('Неполный токен Google');
  const head = JSON.parse(new TextDecoder().decode(fromB64Url(h)));
  const body = JSON.parse(new TextDecoder().decode(fromB64Url(p)));

  const jwk = (await googleKeys()).find(k => k.kid === head.kid);
  if (!jwk) throw new Error('Ключ Google не найден');

  const key = await crypto.subtle.importKey('jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    fromB64Url(s), enc.encode(`${h}.${p}`));

  if (!ok) throw new Error('Подпись Google не сходится');
  if (body.aud !== clientId) throw new Error('Токен выдан другому приложению');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(body.iss))
    throw new Error('Неизвестный отправитель токена');
  if (body.exp < Date.now() / 1000) throw new Error('Токен Google просрочен');
  if (!body.email_verified) throw new Error('Почта в Google не подтверждена');
  return body;
}
const clean = s => String(s || '').trim().toLowerCase();

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return json({});

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    const secret = env.SECRET;

    try {
      /* ---- регистрация ---- */
      if (path === '/register' && req.method === 'POST') {
        const { email, password } = await req.json();
        const mail = clean(email);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return bad('Неправильная почта');
        if (String(password || '').length < 6) return bad('Пароль от 6 символов');

        const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first();
        if (exists) return bad('На эту почту уже есть аккаунт');

        const id = uid();
        await env.DB.prepare('INSERT INTO users (id, email, hash, made) VALUES (?, ?, ?, ?)')
          .bind(id, mail, await hash(password), Date.now()).run();
        return json({ token: await sign({ id, email: mail, exp: Date.now() / 1000 + TTL }, secret), email: mail });
      }

      /* ---- вход ---- */
      if (path === '/login' && req.method === 'POST') {
        const { email, password } = await req.json();
        const mail = clean(email);
        const u = await env.DB.prepare('SELECT id, hash FROM users WHERE email = ?').bind(mail).first();
        if (!u || !await verify(password, u.hash)) return bad('Неверная почта или пароль', 401);
        return json({ token: await sign({ id: u.id, email: mail, exp: Date.now() / 1000 + TTL }, secret), email: mail });
      }

      /* ---- вход через Google ---- */
      if (path === '/google' && req.method === 'POST') {
        if (!env.GOOGLE_CLIENT_ID) return bad('Вход через Google пока не включён', 503);
        const { credential } = await req.json();
        const g = await checkGoogle(credential, env.GOOGLE_CLIENT_ID);
        const mail = clean(g.email);

        let u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first();
        if (!u) {
          const id = uid();
          await env.DB.prepare('INSERT INTO users (id, email, hash, made, google) VALUES (?, ?, ?, ?, ?)')
            .bind(id, mail, '', Date.now(), g.sub).run();
          u = { id };
        } else {
          await env.DB.prepare('UPDATE users SET google = ? WHERE id = ?').bind(g.sub, u.id).run();
        }
        return json({ token: await sign({ id: u.id, email: mail, exp: Date.now() / 1000 + TTL }, secret), email: mail });
      }

      /* ---- включён ли вход через Google ---- */
      if (path === '/config' && req.method === 'GET') {
        return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
      }

      /* ---- дальше только со своим токеном ---- */
      const me = await open((req.headers.get('authorization') || '').replace('Bearer ', ''), secret);
      if (!me) return bad('Нужно войти заново', 401);

      /* ---- забрать всё ---- */
      if (path === '/data' && req.method === 'GET') {
        const [m, ns] = await Promise.all([
          env.DB.prepare('SELECT json FROM meta WHERE uid = ?').bind(me.id).first(),
          env.DB.prepare('SELECT id, title, html, files, ts FROM notes WHERE uid = ?').bind(me.id).all(),
        ]);
        const bodies = {};
        for (const n of ns.results || []) {
          bodies[n.id] = { title: n.title, html: n.html, files: JSON.parse(n.files || '[]'), ts: n.ts };
        }
        return json({ meta: m ? JSON.parse(m.json) : null, notes: bodies });
      }

      /* ---- сохранить изменения ---- */
      if (path === '/data' && req.method === 'PUT') {
        const { meta, notes = {}, drop = [] } = await req.json();
        const q = [];
        if (meta) q.push(env.DB.prepare(
          'INSERT INTO meta (uid, json, ts) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET json = ?, ts = ?')
          .bind(me.id, JSON.stringify(meta), Date.now(), JSON.stringify(meta), Date.now()));

        for (const [id, n] of Object.entries(notes)) {
          q.push(env.DB.prepare(
            `INSERT INTO notes (id, uid, title, html, files, ts) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(uid, id) DO UPDATE SET title = ?, html = ?, files = ?, ts = ?`)
            .bind(id, me.id, n.title || '', n.html || '', JSON.stringify(n.files || []), n.ts || Date.now(),
              n.title || '', n.html || '', JSON.stringify(n.files || []), n.ts || Date.now()));
        }
        for (const id of drop) {
          q.push(env.DB.prepare('DELETE FROM notes WHERE uid = ? AND id = ?').bind(me.id, id));
        }
        if (q.length) await env.DB.batch(q);
        return json({ ok: true });
      }

      /* ---- смена пароля ---- */
      if (path === '/password' && req.method === 'POST') {
        const { old, fresh } = await req.json();
        if (String(fresh || '').length < 6) return bad('Пароль от 6 символов');
        const u = await env.DB.prepare('SELECT hash FROM users WHERE id = ?').bind(me.id).first();
        if (!u || !await verify(old, u.hash)) return bad('Старый пароль неверен', 401);
        await env.DB.prepare('UPDATE users SET hash = ? WHERE id = ?').bind(await hash(fresh), me.id).run();
        return json({ ok: true });
      }

      return bad('Нет такого адреса', 404);
    } catch (e) {
      return bad('Сервер не справился: ' + e.message, 500);
    }
  },
};
