/**
 * Canvas Colaborativo Simplificado
 * - mode=draw | mode=view
 * - room obrigatório
 * - ws param opcional (wss://...)
 * - x/y normalizados [0..1]
 * - throttle (ms) default ~33 (≈30 msgs/s)
 * - warmup para ignorar backlog
 * - DPR-aware canvas scaling
 * - requestAnimationFrame para render
 * - reconexão com backoff
 *
 * Query params:
 * ?mode=draw|view
 * ?room=ROOM_ID
 * ?ws=wss://host:port
 * ?throttle=33
 * ?warmup=800
 * ?accent=#60a5fa
 */

const params = new URLSearchParams(window.location.search);
const mode = (params.get('mode') || 'view').toLowerCase(); // draw or view
const room = params.get('room') || null;
const wsUrl = params.get('ws') || null;
const throttleMs = Math.max(10, parseInt(params.get('throttle') || '33', 10));
const warmupMs = Math.max(0, parseInt(params.get('warmup') || '800', 10));
const accent = params.get('accent') || null;

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const toolbar = document.getElementById('toolbar');
const colorInput = document.getElementById('color');
const widthInput = document.getElementById('width');
const clearBtn = document.getElementById('clearBtn');

if (accent) document.documentElement.style.setProperty('--accent', accent);
titleEl.textContent = mode === 'draw' ? 'Canvas Colaborativo — Draw' : 'Canvas Colaborativo — View';

// Canvas setup
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: true });
let dpr = Math.max(1, window.devicePixelRatio || 1);

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  redrawAll(); // re-render strokes if any
}
window.addEventListener('resize', debounce(resizeCanvas, 120));
resizeCanvas();

// In-memory stroke buffer for view mode (keeps last N strokes)
const STROKE_BUFFER_LIMIT = 1000;
let strokes = []; // each stroke: {color, width, points: [{x,y}], id}
function pushStroke(s) {
  strokes.push(s);
  if (strokes.length > STROKE_BUFFER_LIMIT) strokes.shift();
}

// Simple redraw
function redrawAll() {
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  for (const s of strokes) {
    drawStrokeOnCtx(s, ctx);
  }
}

// Draw stroke helper (points in normalized coords)
function drawStrokeOnCtx(stroke, ctxRef) {
  if (!stroke || !stroke.points || stroke.points.length === 0) return;
  ctxRef.save();
  ctxRef.strokeStyle = stroke.color || '#ffffff';
  ctxRef.lineWidth = (stroke.width || 6);
  ctxRef.beginPath();
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const p0 = stroke.points[0];
  ctxRef.moveTo(p0.x * w, p0.y * h);
  for (let i = 1; i < stroke.points.length; i++) {
    const p = stroke.points[i];
    ctxRef.lineTo(p.x * w, p.y * h);
  }
  ctxRef.stroke();
  ctxRef.restore();
}

// Networking: WebSocket client with reconnection/backoff and warmup
let ws = null;
let reconnectTimer = null;
let warmup = true;
let warmupTimer = null;

function connectWS() {
  if (!wsUrl) {
    statusEl.textContent = 'Sem WS';
    return;
  }
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error('WS create error', e);
    statusEl.textContent = 'Erro WS';
    scheduleReconnect();
    return;
  }

  statusEl.textContent = 'A ligar (WebSocket)…';
  warmup = true;
  if (warmupTimer) clearTimeout(warmupTimer);
  warmupTimer = setTimeout(() => { warmup = false; statusEl.textContent = 'A ler eventos…'; }, warmupMs);

  ws.onopen = () => {
    console.log('WS open', wsUrl);
    statusEl.textContent = 'Ligado (WebSocket)';
    if (room) {
      try { ws.send(JSON.stringify({ type: 'subscribe', room })); } catch (e) {}
    }
  };

  ws.onmessage = (evt) => {
    const raw = evt.data;
    handleIncoming(raw);
  };

  ws.onerror = (e) => {
    console.error('WS error', e);
  };

  ws.onclose = () => {
    console.warn('WS closed');
    statusEl.textContent = 'WS fechado — a tentar reconectar…';
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 2000 + Math.random() * 3000);
}

if (wsUrl) connectWS();

// Parsing incoming messages (expects JSON with protocol)
function parseIncoming(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // Expected types: stroke_begin, stroke_move, stroke_end, clear
    if (!obj.type) return null;
    // Validate room
    if (room && obj.room && String(obj.room) !== String(room)) return null;
    return obj;
  } catch (e) {
    // ignore non-JSON
    return null;
  }
}

// Handle incoming events (apply only in view mode)
function handleIncoming(raw) {
  const obj = parseIncoming(raw);
  if (!obj) return;
  if (warmup) return; // ignore backlog during warmup

  switch (obj.type) {
    case 'stroke_begin':
      // create new stroke with id
      const s = { id: obj.id || generateId(), color: obj.c || '#ffffff', width: obj.w || 6, points: [] };
      if (Array.isArray(obj.points)) {
        s.points = obj.points.slice();
      } else if (typeof obj.x === 'number' && typeof obj.y === 'number') {
        s.points.push({ x: obj.x, y: obj.y });
      }
      pushStroke(s);
      redrawAll();
      break;

    case 'stroke_move':
      // append to last stroke with same id
      if (!obj.id) break;
      const last = strokes.find(st => st.id === obj.id);
      if (last) {
        if (typeof obj.x === 'number' && typeof obj.y === 'number') {
          last.points.push({ x: obj.x, y: obj.y });
          // incremental draw for performance
          drawStrokeOnCtx({ color: last.color, width: last.width, points: [ last.points[last.points.length - 2], last.points[last.points.length - 1] ] }, ctx);
        }
      }
      break;

    case 'stroke_end':
      // finalize stroke (already in buffer)
      redrawAll();
      break;

    case 'clear':
      strokes = [];
      redrawAll();
      break;

    default:
      // ignore unknown
      break;
  }
}

// DRAW MODE: capture pointer/touch, throttle, send normalized events
if (mode === 'draw') {
  toolbar.setAttribute('aria-hidden', 'false');
  toolbar.style.display = 'flex';
  canvas.style.cursor = 'crosshair';
  enableDrawing();
} else {
  toolbar.setAttribute('aria-hidden', 'true');
  toolbar.style.display = 'none';
  canvas.style.cursor = 'default';
}

// Drawing implementation
function enableDrawing() {
  let drawing = false;
  let currentStroke = null;
  let lastSent = 0;
  let sendBuffer = []; // accumulate points to send in throttled batches

  function pointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = clientToNormalized(e.clientX, e.clientY);
    currentStroke = { id: generateId(), color: colorInput.value || '#ffffff', width: parseInt(widthInput.value || '6', 10), points: [p] };
    pushStroke(currentStroke);
    redrawAll();
    // send stroke_begin
    sendEvent({ type: 'stroke_begin', room, id: currentStroke.id, c: currentStroke.color, w: currentStroke.width, x: p.x, y: p.y });
  }

  function pointerMove(e) {
    if (!drawing || !currentStroke) return;
    const p = clientToNormalized(e.clientX, e.clientY);
    currentStroke.points.push(p);
    // incremental draw
    drawStrokeOnCtx({ color: currentStroke.color, width: currentStroke.width, points: [ currentStroke.points[currentStroke.points.length - 2], currentStroke.points[currentStroke.points.length - 1] ] }, ctx);
    // buffer point for sending
    sendBuffer.push({ id: currentStroke.id, x: p.x, y: p.y });
    maybeFlushBuffer();
  }

  function pointerUp(e) {
    if (!drawing) return;
    drawing = false;
    canvas.releasePointerCapture(e.pointerId);
    // send remaining buffered points and stroke_end
    flushBuffer();
    sendEvent({ type: 'stroke_end', room, id: currentStroke.id });
    currentStroke = null;
  }

  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  canvas.addEventListener('pointerleave', pointerUp);

  clearBtn.addEventListener('click', () => {
    strokes = [];
    redrawAll();
    sendEvent({ type: 'clear', room });
  });

  // Throttle/flush logic
  let flushTimer = null;
  function maybeFlushBuffer() {
    const now = Date.now();
    if (now - lastSent >= throttleMs) {
      flushBuffer();
    } else {
      if (!flushTimer) {
        flushTimer = setTimeout(() => { flushTimer = null; flushBuffer(); }, throttleMs - (now - lastSent));
      }
    }
  }

  function flushBuffer() {
    if (sendBuffer.length === 0) return;
    // send as batch to reduce messages
    const batch = sendBuffer.splice(0, sendBuffer.length);
    // send as single message with points array
    sendEvent({ type: 'stroke_move', room, points: batch.map(p => ({ id: p.id, x: p.x, y: p.y })) });
    lastSent = Date.now();
  }
}

// Helpers

function clientToNormalized(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return { x, y };
}

function sendEvent(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    console.error('sendEvent error', e);
  }
}

function generateId() {
  return 's_' + Math.random().toString(36).slice(2, 9);
}

// Debounce utility
function debounce(fn, wait) {
  let t = null;
  return function(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Simple polyfill: if no WS provided, allow local simulation via console
if (!wsUrl) {
  statusEl.textContent = 'Sem WS (modo local)';
  warmup = false;
  // expose handleIncoming for manual testing in console
  window._handleIncoming = handleIncoming;
}

// Keep strokes bounded periodically
setInterval(() => {
  if (strokes.length > 2000) strokes = strokes.slice(-1000);
}, 60000);
