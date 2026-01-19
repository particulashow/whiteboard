const params = new URLSearchParams(window.location.search);
const mode = (params.get('mode') || 'view').toLowerCase();
const room = params.get('room') || null;
const wsUrl = params.get('ws') || null;
const throttleMs = Math.max(10, parseInt(params.get('throttle') || '33', 10));
const warmupMs = Math.max(0, parseInt(params.get('warmup') || '800', 10));

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const toolbar = document.getElementById('toolbar');
const colorInput = document.getElementById('color');
const widthInput = document.getElementById('width');
const clearBtn = document.getElementById('clearBtn');

titleEl.textContent = mode === 'draw' ? 'Canvas — Draw' : 'Canvas — View';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: true });
let dpr = Math.max(1, window.devicePixelRatio || 1);

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  redrawAll();
}
window.addEventListener('resize', () => setTimeout(resizeCanvas, 120));
resizeCanvas();

let strokes = [];
function pushStroke(s) {
  strokes.push(s);
  if (strokes.length > 1000) strokes.shift();
}

function redrawAll() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of strokes) drawStroke(s);
}

function drawStroke(s) {
  if (!s.points.length) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.beginPath();
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  ctx.moveTo(s.points[0].x * w, s.points[0].y * h);
  for (let i = 1; i < s.points.length; i++) {
    ctx.lineTo(s.points[i].x * w, s.points[i].y * h);
  }
  ctx.stroke();
}

let ws = null;
let reconnectTimer = null;
let warmup = true;

function connectWS() {
  if (!wsUrl) return;

  try { ws = new WebSocket(wsUrl); }
  catch { scheduleReconnect(); return; }

  statusEl.textContent = "A ligar…";

  setTimeout(() => { warmup = false; }, warmupMs);

  ws.onopen = () => {
    statusEl.textContent = "Ligado";
    if (room) ws.send(JSON.stringify({ type: "subscribe", room }));
  };

  ws.onmessage = evt => handleIncoming(evt.data);

  ws.onclose = () => {
    statusEl.textContent = "A reconectar…";
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 2000 + Math.random() * 2000);
}

connectWS();

function parseIncoming(raw) {
  try {
    const obj = JSON.parse(raw);
    if (room && obj.room && obj.room !== room) return null;
    return obj;
  } catch { return null; }
}

function handleIncoming(raw) {
  const obj = parseIncoming(raw);
  if (!obj || warmup) return;

  switch (obj.type) {
    case "stroke_begin":
      pushStroke({ id: obj.id, color: obj.c, width: obj.w, points: [{ x: obj.x, y: obj.y }] });
      redrawAll();
      break;

    case "stroke_move":
      const s = strokes.find(st => st.id === obj.id);
      if (!s) break;
      if (obj.points) {
        for (const p of obj.points) s.points.push({ x: p.x, y: p.y });
      }
      redrawAll();
      break;

    case "stroke_end":
      redrawAll();
      break;

    case "clear":
      strokes = [];
      redrawAll();
      break;
  }
}

if (mode === "draw") enableDrawing();

function enableDrawing() {
  toolbar.style.display = "flex";
  canvas.style.cursor = "crosshair";

  let drawing = false;
  let current = null;
  let sendBuffer = [];
  let lastSent = 0;

  canvas.addEventListener("pointerdown", e => {
    drawing = true;
    const p = norm(e);
    current = { id: id(), color: colorInput.value, width: parseInt(widthInput.value), points: [p] };
    pushStroke(current);
    redrawAll();
    send({ type: "stroke_begin", room, id: current.id, c: current.color, w: current.width, x: p.x, y: p.y });
  });

  canvas.addEventListener("pointermove", e => {
    if (!drawing) return;
    const p = norm(e);
    current.points.push(p);
    drawStroke(current);
    sendBuffer.push({ id: current.id, x: p.x, y: p.y });
    maybeFlush();
  });

  canvas.addEventListener("pointerup", () => {
    drawing = false;
    flush();
    send({ type: "stroke_end", room, id: current.id });
  });

  clearBtn.onclick = () => {
    strokes = [];
    redrawAll();
    send({ type: "clear", room });
  };

  function maybeFlush() {
    const now = Date.now();
    if (now - lastSent >= throttleMs) flush();
  }

  function flush() {
    if (!sendBuffer.length) return;
    send({ type: "stroke_move", room, points: sendBuffer });
    sendBuffer = [];
    lastSent = Date.now();
  }
}

function norm(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function id() {
  return "s_" + Math.random().toString(36).slice(2, 9);
}
