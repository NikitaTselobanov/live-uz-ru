// Мини-сервер без зависимостей: раздаёт страницу и выдаёт токен для Gemini Live API.
// Запуск:  GEMINI_API_KEY=ключ node server.js
//
// Обычный режим: сервер меняет постоянный ключ на одноразовый короткоживущий токен,
// сам ключ в браузер не уходит. Если у проекта нет доступа к ephemeral-токенам,
// поднимите ALLOW_DIRECT_KEY=1 — тогда ключ отдаётся странице напрямую
// (нормально для домашнего запуска, не для публичной ссылки).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.GEMINI_API_KEY;
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const ALLOW_DIRECT_KEY = process.env.ALLOW_DIRECT_KEY === '1';
const TOKENS_PER_HOUR = Number(process.env.TOKENS_PER_HOUR || 40);

if (!API_KEY) {
  console.error('\n  Не задан GEMINI_API_KEY.\n  Запускайте так:  GEMINI_API_KEY=ваш_ключ node server.js\n');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let lastTokenVersion = null;  // какой версией API удалось выпустить токен
const hits = new Map();
function rateLimited(ip) {
  const windowStart = Date.now() - 3600_000;
  const list = (hits.get(ip) || []).filter((t) => t > windowStart);
  list.push(Date.now());
  hits.set(ip, list);
  return list.length > TOKENS_PER_HOUR;
}

// Пробуем обе версии API: в разных проектах ephemeral-токены живут то в v1alpha, то в v1beta.
async function mintToken() {
  const now = Date.now();
  const body = JSON.stringify({
    uses: 1,
    expireTime: new Date(now + 35 * 60_000).toISOString(),
    newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
  });

  const errors = [];
  for (const version of ['v1alpha', 'v1beta']) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/${version}/auth_tokens?key=${API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      );
      const text = await res.text();
      if (res.ok) {
        const name = JSON.parse(text).name;
        if (name) { lastTokenVersion = version; return { token: name, mode: 'ephemeral', version }; }
        errors.push(`${version}: ответ без поля name`);
      } else {
        errors.push(`${version}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
    } catch (e) {
      errors.push(`${version}: ${e.message}`);
    }
  }

  if (ALLOW_DIRECT_KEY) {
    console.warn('Токен не выдан, отдаю ключ напрямую (ALLOW_DIRECT_KEY=1).', errors.join(' | '));
    return { token: API_KEY, mode: 'direct' };
  }
  throw new Error(errors.join(' | '));
}

function send(res, code, data, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

// Релей: браузер ↔ этот сервер ↔ Google. Регион считается по хостингу,
// поэтому клиенту не нужен ни VPN, ни «подходящая» страна.
let WS = null;
try {
  WS = await import('ws');
} catch {
  console.log('  модуль ws не установлен — релей выключен (страница пойдёт в Google напрямую)');
}

const MAX_RELAYS = Number(process.env.MAX_RELAYS || 3);
let activeRelays = 0;

function startRelay(client, params) {
  const version = /^v1(alpha|beta)$/.test(params.get('v') || '') ? params.get('v') : 'v1alpha';
  const method = `google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent`;
  const upstream = new WS.WebSocket(
    `wss://generativelanguage.googleapis.com/ws/${method}?key=${API_KEY}`,
  );

  activeRelays++;
  console.log(`[релей] сессия открыта (${version}), активных: ${activeRelays}`);

  const pending = [];
  upstream.on('open', () => { while (pending.length) upstream.send(pending.shift()); });
  let sawSetup = false, sawReply = false;
  client.on('message', (data) => {
    const text = data.toString();
    if (!sawSetup) {
      sawSetup = true;
      // первое сообщение — setup: видно в логах, какой язык реально ушёл в Google
      console.log('[релей] setup →', text.slice(0, 500));
    }
    if (upstream.readyState === 1) upstream.send(text); else pending.push(text);
  });
  upstream.on('message', (data) => {
    if (!sawReply) { sawReply = true; console.log('[релей] ответ Google ←', data.toString().slice(0, 300)); }
    if (client.readyState === 1) client.send(data.toString());
  });

  let closed = false;
  const shutdown = (who) => (code, reason) => {
    const r = reason ? reason.toString() : '';
    if (!closed) {
      closed = true;
      activeRelays--;
      console.log(`[релей] закрыл ${who}: код=${code} причина=${r || 'не указана'}; активных: ${activeRelays}`);
    }
    try { client.close(); } catch {}
    try { upstream.close(); } catch {}
  };
  upstream.on('close', shutdown('Google'));
  client.on('close', shutdown('страница'));
  upstream.on('error', (e) => {
    console.error('[релей] ошибка соединения с Google:', e.message);
    try { client.close(1011, 'upstream error'); } catch {}
  });
  client.on('error', () => { try { upstream.close(); } catch {} });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/config') {
    return send(res, 200, { needCode: Boolean(ACCESS_CODE), tokenVersion: lastTokenVersion });
  }

  if (url.pathname === '/api/token' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let code = '';
    try { code = JSON.parse(raw || '{}').code || ''; } catch {}

    if (ACCESS_CODE && code !== ACCESS_CODE) return send(res, 403, { error: 'Неверный код доступа' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return send(res, 429, { error: 'Слишком много подключений, подождите' });

    try {
      const { token, mode, version } = await mintToken();
      console.log(`токен выдан (${mode}${version ? ', ' + version : ''})`);
      return send(res, 200, { token, mode, version: version || null });
    } catch (e) {
      console.error('Не удалось выдать токен:', e.message);
      return send(res, 500, {
        error: 'Не удалось получить токен. ' + e.message +
          (ALLOW_DIRECT_KEY ? '' : ' — можно запустить с ALLOW_DIRECT_KEY=1'),
      });
    }
  }

  // какие live-модели доступны этому ключу
  if (url.pathname === '/api/models') {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}&pageSize=1000`,
      );
      const j = await r.json();
      if (j.error) {
        console.error(`[модели] ОШИБКА ${j.error.status}: ${j.error.message}`);
        return send(res, 200, { error: `${j.error.status}: ${j.error.message}` });
      }
      const all = (j.models || []).map((m) => m.name.replace('models/', ''));
      const live = (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'))
        .map((m) => m.name.replace('models/', ''));
      console.log(`[модели] всего ${all.length}; live: ${live.join(', ') || 'НИ ОДНОЙ'}`);
      const interesting = all.filter((n) => /translate|live|audio/.test(n));
      console.log(`[модели] похожие на нужные: ${interesting.join(', ') || '—'}`);
      return send(res, 200, { live, interesting });
    } catch (e) {
      console.error('[модели] запрос не прошёл:', e.message);
      return send(res, 200, { error: e.message });
    }
  }

  // страница присылает сюда свои ошибки, чтобы они попали в server.log
  if (url.pathname === '/api/log' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    console.log('[страница] ' + raw.slice(0, 2000));
    return send(res, 200, { ok: true });
  }

  // статика
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'нет', 'text/plain');

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'не найдено', 'text/plain; charset=utf-8');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',  // иначе браузер держит старый app.js
    });
    res.end(buf);
  });
});

let port = PORT;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < PORT + 20) {
    console.log(`  порт ${port} занят, пробую ${port + 1}`);
    port += 1;
    server.listen(port);
    return;
  }
  console.error('\n  Сервер не смог стартовать:', e.message, '\n');
  process.exit(1);
});

// Пульс: пока сервер жив, файл обновляется каждые 5 секунд.
const beatFile = path.join(__dirname, 'server-alive.txt');
function beat() {
  try {
    fs.writeFileSync(beatFile, `${new Date().toISOString()} порт=${port} pid=${process.pid}\n`);
  } catch {}
}

if (WS) {
  const wss = new WS.WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://local');
    if (u.pathname !== '/live') return socket.destroy();
    if (ACCESS_CODE && u.searchParams.get('code') !== ACCESS_CODE) {
      console.log('[релей] отказ: неверный код доступа');
      return socket.destroy();
    }
    if (activeRelays >= MAX_RELAYS) {
      console.log('[релей] отказ: слишком много одновременных сессий');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (client) => startRelay(client, u.searchParams));
  });
}

server.listen(port, () => {
  beat();
  setInterval(beat, 5000);
  const link = `http://localhost:${port}`;
  console.log(`\n  Переводчик запущен:  ${link}`);
  console.log(`  Код доступа: ${ACCESS_CODE || 'не задан'}`);
  console.log(`  Прямой ключ в браузер: ${ALLOW_DIRECT_KEY ? 'разрешён' : 'нет'}`);
  console.log(`  Релей через сервер: ${WS ? 'включён' : 'выключен (нет модуля ws)'}`);
  console.log('  Остановить — Ctrl+C (или просто закрыть это окно)\n');

  if (process.env.OPEN_BROWSER !== '0') {
    const cmd = process.platform === 'win32' ? `start "" "${link}"`
      : process.platform === 'darwin' ? `open "${link}"`
      : `xdg-open "${link}"`;
    setTimeout(() => exec(cmd, () => {}), 800);
  }
});
