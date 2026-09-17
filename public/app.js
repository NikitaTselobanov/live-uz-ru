import { GoogleGenAI, Modality } from 'https://esm.sh/@google/genai@^1';

const MODEL = 'gemini-3.5-live-translate-preview';
const TARGET_LANG = 'ru';
const RECONNECT_AFTER_MS = 12 * 60 * 1000; // лимит аудио-сессии 15 мин — переподключаемся заранее

const el = (id) => document.getElementById(id);
const ui = {
  start: el('start'), stop: el('stop'), source: el('source'), code: el('code'),
  codeRow: el('codeRow'), status: el('status'), dot: el('dot'), subs: el('subs'),
  showOrig: el('showOrig'), fontMinus: el('fontMinus'), fontPlus: el('fontPlus'),
  mute: el('mute'), volume: el('volume'), save: el('save'), level: el('level'),
  clock: el('clock'), hint: el('hint'),
};

let running = false;
let session = null;
let stream = null;
let inCtx = null, outCtx = null, workletNode = null, srcNode = null, gainNode = null;
let playNode = null;
let reconnectTimer = null, clockTimer = null, startedAt = 0;
let transcript = [];            // [{t, ru, uz}]
let cur = { ru: '', uz: '' };   // текущая реплика
let curEl = null;

function setStatus(text, state) {
  ui.status.textContent = text;
  ui.dot.className = 'dot ' + (state || '');
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- субтитры ----------

function newLine() {
  if (cur.ru.trim() || cur.uz.trim()) transcript.push({ t: Date.now(), ...cur });
  cur = { ru: '', uz: '' };
  curEl = null;
  saveDraft();
}

function paint() {
  if (!curEl) {
    curEl = document.createElement('div');
    curEl.className = 'line';
    curEl.innerHTML = '<div class="ru"></div><div class="uz"></div>';
    ui.subs.appendChild(curEl);
    while (ui.subs.children.length > 120) ui.subs.removeChild(ui.subs.firstChild);
  }
  curEl.querySelector('.ru').textContent = cur.ru;
  const uz = curEl.querySelector('.uz');
  uz.textContent = cur.uz;
  uz.style.display = ui.showOrig.checked && cur.uz ? 'block' : 'none';
  ui.subs.scrollTop = ui.subs.scrollHeight;
}

function saveDraft() {
  try {
    localStorage.setItem('lecture-draft', JSON.stringify(transcript.slice(-500)));
  } catch { /* приватный режим — не страшно */ }
}

// ---------- воспроизведение перевода ----------

function playPcm(base64) {
  if (!playNode) return;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  playNode.port.postMessage({ pcm: f.buffer }, [f.buffer]);
}

function applyVolume() {
  if (gainNode) gainNode.gain.value = ui.mute.checked ? 0 : Number(ui.volume.value);
}

// ---------- подключение ----------

async function getToken() {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: ui.code.value.trim() }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ошибка сервера');
  localStorage.setItem('access-code', ui.code.value.trim());
  const j = await res.json();
  if (j.version) preferVersion = j.version;
  return j.token;
}

// всё, что здесь пишется, уходит в server.log рядом с проектом
function rlog(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log('[live]', line);
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: line })
    .catch(() => {});
}

// Перебираем варианты: модель × версия API. Рабочий запоминаем.
const CANDIDATES = [
  // через собственный сервер: регион считается по хостингу, VPN не нужен
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1beta', translate: true,
    lang: 'ru', raw: true, relay: true, tag: 'релей-v1beta/ru' },
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1alpha', translate: true,
    lang: 'ru', raw: true, relay: true, tag: 'релей/ru' },
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1alpha', translate: true,
    lang: 'ru-RU', raw: true, relay: true, tag: 'релей/ru-RU' },
  // свой WebSocket — setup уходит ровно таким, каким мы его написали
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1alpha', translate: true,
    lang: 'ru-RU', raw: true, tag: 'напрямую/ru-RU' },
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1alpha', translate: true,
    lang: 'ru', raw: true, tag: 'напрямую/ru' },
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1beta', translate: true,
    lang: 'ru-RU', raw: true, tag: 'напрямую-v1beta/ru-RU' },
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1alpha', translate: true,
    lang: 'ru-RU', raw: true, auth: 'access_token', tag: 'напрямую-token/ru-RU' },
  { model: 'gemini-live-2.5-flash-preview', apiVersion: 'v1beta', translate: false,
    lang: 'ru-RU', raw: true, tag: 'напрямую/промпт' },
  // запасные через SDK
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1alpha', translate: true,
    lang: 'ru-RU', speech: true,  tag: 'sdk/ru-RU+speechConfig' },
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1alpha', translate: true,
    lang: 'ru-RU', speech: false, tag: 'sdk/ru-RU' },
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1alpha', translate: true,
    lang: 'ru',    speech: true,  tag: 'sdk/ru+speechConfig' },
  { model: 'gemini-3.5-live-translate-preview', apiVersion: 'v1beta', translate: true },
  { model: 'gemini-live-2.5-flash-preview', apiVersion: 'v1beta', translate: false },
  { model: 'gemini-2.0-flash-live-001', apiVersion: 'v1beta', translate: false },
];

let preferVersion = null;  // версия API, которой сервер выпустил токен

const PROMPT = 'Ты синхронный переводчик на лекции. Всё, что слышишь, немедленно переводи ' +
  'на русский язык и произноси вслух. Ничего не добавляй от себя, не комментируй, ' +
  'не отвечай на вопросы из речи, не здоровайся. Если речь уже на русском — повтори её как есть.';

function buildConfig(cand) {
  const base = {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},   // текст оригинала (узбекский)
    outputAudioTranscription: {},  // текст перевода (русский)
  };
  if (cand.translate) {
    base.translationConfig = {
      targetLanguageCode: cand.lang || TARGET_LANG,
      echoTargetLanguage: true,
    };
    if (cand.speech) base.speechConfig = { languageCode: cand.lang || TARGET_LANG };
  } else {
    base.systemInstruction = PROMPT;
    base.speechConfig = { languageCode: 'ru-RU' };
  }
  return base;
}

let loggedFirst = false;
const badLanguage = new Set();   // варианты, которые переводили не на русский

function callbacks(label) {
  return {
    onopen: () => rlog(label, 'соединение открыто'),
    onmessage: (msg) => {
      const sc = msg.serverContent;
      if (sc?.outputTranscription?.text) {
        cur.ru += sc.outputTranscription.text;
        if (!loggedFirst) {
          loggedFirst = true;
          const sample = sc.outputTranscription.text.slice(0, 80);
          const cyrillic = /[а-яё]/i.test(cur.ru);
          rlog(label, cyrillic ? 'первый перевод (русский):' : 'НЕ РУССКИЙ, меняю вариант:', sample);
          if (!cyrillic) {
            localStorage.removeItem('working-candidate-v2');
            badLanguage.add(label);
            setStatus('Перевод шёл не на русском — пробую другой вариант', 'warn');
            reconnect('перевод не на русском');
          }
        }
        paint();
      }
      if (sc?.inputTranscription?.text) { cur.uz += sc.inputTranscription.text; paint(); }

      const audio = msg.data
        || sc?.modelTurn?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
      if (audio) playPcm(audio);

      if (sc?.turnComplete || sc?.generationComplete) newLine();
      if (msg.goAway) { rlog(label, 'goAway', msg.goAway); reconnect('сервер попросил переподключиться'); }
    },
    onerror: (e) => {
      rlog(label, 'ОШИБКА:', e?.message || String(e));
      if (running) reconnect('сбой соединения');
    },
    onclose: (e) => {
      rlog(label, 'закрыто, код=' + (e?.code ?? '?'), 'причина=' + (e?.reason || 'не указана'));
      if (running) reconnect('соединение закрыто');
    },
  };
}


// Прямое подключение к Live API по WebSocket. SDK с CDN не знает про translationConfig
// и вырезает его из setup — поэтому setup собираем сами.
function rawConnect(cand, token, cb) {
  return new Promise((resolve, reject) => {
    const host = 'wss://generativelanguage.googleapis.com/ws';
    const method = `google.ai.generativelanguage.${cand.apiVersion}.GenerativeService.BidiGenerateContent`;
    let url;
    if (cand.relay) {
      // свой сервер: ключа в браузере нет вообще
      const base = location.origin.replace(/^http/, 'ws');
      url = `${base}/live?v=${cand.apiVersion}&code=${encodeURIComponent(ui.code.value.trim())}`;
    } else {
      const auth = (cand.auth || 'key') + '=' + encodeURIComponent(token);
      url = `${host}/${method}?${auth}`;
    }
    const ws = new WebSocket(url);

    const setup = {
      model: 'models/' + cand.model,
      generationConfig: { responseModalities: ['AUDIO'] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (cand.translate) {
      // по документации Live Translate поле живёт внутри generationConfig;
      // в корне setup Google его не видит и переводит на язык по умолчанию — английский
      setup.generationConfig.translationConfig = {
        targetLanguageCode: cand.lang || TARGET_LANG,
        echoTargetLanguage: true,
      };
    } else {
      setup.systemInstruction = { parts: [{ text: PROMPT }] };
      setup.speechConfig = { languageCode: cand.lang || 'ru-RU' };
    }

    const session = {
      sendRealtimeInput: ({ audio }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ realtimeInput: { audio } }));
        }
      },
      close: () => { try { ws.close(); } catch {} },
    };

    let opened = false;
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ setup }));
      cb.onopen?.();
      resolve(session);
    };
    ws.onmessage = async (ev) => {
      let text;
      if (typeof ev.data === 'string') text = ev.data;
      else if (ev.data instanceof Blob) text = await ev.data.text();
      else text = new TextDecoder().decode(ev.data);
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.error) rlog('ответ с ошибкой:', JSON.stringify(msg.error).slice(0, 300));
      cb.onmessage?.(msg);
    };
    ws.onerror = () => rlog('ws error до открытия:', cand.tag || cand.model);
    ws.onclose = (e) => {
      cb.onclose?.(e);
      // причина всегда приходит в onclose, поэтому reject только здесь
      if (!opened) reject(new Error(`не открылся: код=${e.code} причина=${e.reason || 'не указана'}`));
    };
    setTimeout(() => { if (!opened) { try { ws.close(); } catch {} } }, 8000);
  });
}

// Открывает сессию и убеждается, что она не отвалилась сразу.
async function tryCandidate(cand, token) {
  const label = `${cand.model}@${cand.apiVersion}${cand.tag ? '/' + cand.tag : ''}`;
  const ai = cand.raw ? null : new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: cand.apiVersion } });

  let closedWith = null;
  const cb = callbacks(label);
  const probe = {
    ...cb,
    onclose: (e) => {
      closedWith = `код=${e?.code ?? '?'} причина=${e?.reason || 'не указана'}`;
      cb.onclose(e);
    },
  };

  loggedFirst = false;
  const s = cand.raw
    ? await rawConnect(cand, token, probe)
    : await ai.live.connect({ model: cand.model, config: buildConfig(cand), callbacks: probe });
  await new Promise((r) => setTimeout(r, 2500)); // сессия должна прожить хотя бы пару секунд
  if (closedWith) throw new Error(closedWith);
  rlog('РАБОТАЕТ:', label);
  return s;
}

async function openSession() {
  const saved = localStorage.getItem('working-candidate-v2');
  const order = saved
    ? [...CANDIDATES.filter((c) => `${c.model}@${c.apiVersion}${c.tag ? '/' + c.tag : ''}` === saved),
       ...CANDIDATES.filter((c) => `${c.model}@${c.apiVersion}${c.tag ? '/' + c.tag : ''}` !== saved)]
    : CANDIDATES;

  const ordered = preferVersion
    ? [...order.filter((c) => c.apiVersion === preferVersion),
       ...order.filter((c) => c.apiVersion !== preferVersion)]
    : order;

  const fresh = ordered.filter((c) => !badLanguage.has(`${c.model}@${c.apiVersion}${c.tag ? '/' + c.tag : ''}`));
  const list = fresh.length ? fresh : ordered;

  const failures = [];
  for (const cand of list) {
    const label = `${cand.model}@${cand.apiVersion}${cand.tag ? '/' + cand.tag : ''}`;
    try {
      setStatus('Пробую ' + cand.model + '…', 'warn');
      const s = await tryCandidate(cand, cand.relay ? '' : await getToken()); // релею токен не нужен
      localStorage.setItem('working-candidate-v2', label);
      setStatus('Слушаю лекцию (' + cand.model + ')', 'ok');
      return s;
    } catch (e) {
      failures.push(`${label} → ${e?.message || e}`);
      rlog('не подошло:', label, '|', e?.message || String(e));
    }
  }
  rlog('НИ ОДИН вариант не подошёл:', failures.join(' ;; '));
  throw new Error('Не удалось подключиться. Подробности в server.log: ' + failures[0]);
}

let reconnecting = false;
let failStreak = 0;
async function reconnect(why) {
  if (!running || reconnecting) return;
  reconnecting = true;
  setStatus('Переподключаюсь… (' + why + ')', 'warn');
  const old = session;
  try {
    session = await openSession();
    failStreak = 0;
    setTimeout(() => { try { old?.close(); } catch {} }, 1500); // дослушать остаток фразы
    newLine();
    scheduleReconnect();
  } catch (e) {
    failStreak++;
    if (failStreak >= 8) {
      setStatus('Подключиться не удаётся. Смотрите server.log', 'err');
      rlog('сдаюсь после 8 неудачных попыток подряд');
      running = false; reconnecting = false;
      await cleanup();
      ui.start.disabled = false; ui.stop.disabled = true;
      return;
    }
    const wait = Math.min(30000, 3000 * failStreak); // пауза растёт, чтобы не долбить API
    setStatus(`Попытка ${failStreak}: не вышло, жду ${Math.round(wait / 1000)} с…`, 'warn');
    setTimeout(() => { reconnecting = false; reconnect('повтор'); }, wait);
    return;
  }
  reconnecting = false;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => reconnect('плановое обновление сессии'), RECONNECT_AFTER_MS);
}

// ---------- захват звука ----------

async function getStream() {
  if (ui.source.value === 'mic') {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  }
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // @ts-ignore — подсказка Chrome: предлагать «Весь экран» и делиться звуком
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
  });
  if (s.getAudioTracks().length === 0) {
    s.getTracks().forEach((t) => t.stop());
    throw new Error('Звук не расшарен. В окне выбора поставьте галочку «Также передать звук системы».');
  }
  s.getVideoTracks().forEach((t) => (t.onended = () => stop()));
  return s;
}

async function start() {
  ui.start.disabled = true;
  try {
    setStatus('Прошу доступ к звуку…', 'warn');
    stream = await getStream();

    inCtx = new AudioContext({ sampleRate: 16000 });
    await inCtx.audioWorklet.addModule('capture-worklet.js?v=6');
    srcNode = inCtx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(inCtx, 'capture-processor');
    srcNode.connect(workletNode);
    const silent = inCtx.createGain();       // ворклет должен быть подключён к выходу,
    silent.gain.value = 0;                   // но оригинал в колонки не пускаем
    workletNode.connect(silent);
    silent.connect(inCtx.destination);
    workletNode.port.onmessage = ({ data }) => {
      if (!session) return;
      const bytes = new Uint8Array(data.pcm);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      try {
        session.sendRealtimeInput({
          audio: { data: btoa(bin), mimeType: 'audio/pcm;rate=16000' },
        });
      } catch (e) { /* сессия пересоздаётся */ }
      ui.level.style.width = Math.min(100, Math.round(data.peak * 180)) + '%';
    };

    outCtx = new AudioContext({ sampleRate: 24000 });
    await outCtx.audioWorklet.addModule('playback-worklet.js?v=6');
    playNode = new AudioWorkletNode(outCtx, 'playback-processor');
    gainNode = outCtx.createGain();
    playNode.connect(gainNode);
    gainNode.connect(outCtx.destination);
    applyVolume();

    setStatus('Подключаюсь к переводчику…', 'warn');
    session = await openSession();

    running = true;
    startedAt = Date.now();
    scheduleReconnect();
    clockTimer = setInterval(() => (ui.clock.textContent = fmt(Date.now() - startedAt)), 1000);
    ui.stop.disabled = false;
    ui.hint.style.display = 'none';
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Не удалось запустить', 'err');
    ui.start.disabled = false;
    await cleanup();
  }
}

async function cleanup() {
  clearTimeout(reconnectTimer);
  clearInterval(clockTimer);
  try { session?.close(); } catch {}
  session = null;
  try { workletNode?.disconnect(); srcNode?.disconnect(); playNode?.disconnect(); } catch {}
  try { await inCtx?.close(); } catch {}
  try { await outCtx?.close(); } catch {}
  inCtx = outCtx = workletNode = srcNode = gainNode = playNode = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ui.level.style.width = '0%';
}

async function stop() {
  running = false;
  newLine();
  await cleanup();
  setStatus('Остановлено', '');
  ui.start.disabled = false;
  ui.stop.disabled = true;
}

function download() {
  newLine();
  const lines = transcript.map((r) => {
    const time = new Date(r.t).toLocaleTimeString('ru-RU');
    return `[${time}] ${r.ru}${r.uz ? `\n    (оригинал: ${r.uz})` : ''}`;
  });
  const blob = new Blob([`Конспект лекции — ${new Date().toLocaleString('ru-RU')}\n\n${lines.join('\n\n')}\n`],
    { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `лекция-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- мелкая обвязка ----------

let fontSize = Number(localStorage.getItem('font-size') || 34);
function applyFont() {
  ui.subs.style.setProperty('--ru-size', fontSize + 'px');
  localStorage.setItem('font-size', String(fontSize));
}
ui.fontPlus.onclick = () => { fontSize = Math.min(72, fontSize + 4); applyFont(); };
ui.fontMinus.onclick = () => { fontSize = Math.max(18, fontSize - 4); applyFont(); };
ui.volume.oninput = applyVolume;
ui.mute.onchange = applyVolume;
ui.showOrig.onchange = () => {
  localStorage.setItem('show-orig', ui.showOrig.checked ? '1' : '0');
  ui.subs.querySelectorAll('.uz').forEach((n) => {
    n.style.display = ui.showOrig.checked && n.textContent ? 'block' : 'none';
  });
};
ui.start.onclick = start;
ui.stop.onclick = stop;
ui.save.onclick = download;
window.addEventListener('beforeunload', (e) => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

rlog('страница загружена, версия v6');
applyFont();
ui.showOrig.checked = localStorage.getItem('show-orig') !== '0';
ui.code.value = localStorage.getItem('access-code') || '';
fetch('/api/config').then((r) => r.json()).then((c) => {
  ui.codeRow.style.display = c.needCode ? 'flex' : 'none';
}).catch(() => {});

// пусть сервер запишет в лог, какие live-модели доступны ключу
fetch('/api/models').then((r) => r.json()).then((m) => {
  console.log('[live] доступные модели:', m.live || m.error);
}).catch(() => {});
