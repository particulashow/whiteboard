// =====================================================
// OBS Whiteboard (Cloud) - MQTT over WebSockets (EMQX)
// 2 tópicos:
//   events: realtime (pode falhar, ok)
//   state : estado completo (retained) para corrigir sempre
//
// VIEW (OBS):  ?mode=view&room=abc123
// DRAW (tab):  ?mode=draw&room=abc123&bg=white
//
// Broker WSS (HTTPS):
//   wss://broker.emqx.io:8084/mqtt
// =====================================================

const params = new URLSearchParams(window.location.search);
const mode = (params.get("mode") || "view").toLowerCase();
const room = params.get("room") || "default-room";
const bg = (params.get("bg") || "transparent").toLowerCase();

document.body.dataset.mode = mode;

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d", { alpha: true });

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const roomLabel = document.getElementById("roomLabel");
const hint = document.getElementById("hint");
const fatal = document.getElementById("fatal");

const btnClear = document.getElementById("btnClear");
const btnUndo = document.getElementById("btnUndo");
const colorEl = document.getElementById("color");
const sizeEl = document.getElementById("size");

function showFatal(msg) {
  if (!fatal) return;
  fatal.textContent = msg;
  fatal.classList.remove("hidden");
}

if (roomLabel) roomLabel.textContent = `room: ${room}`;
if (mode === "draw" && hint) {
  hint.textContent =
    `VIEW (OBS): ?mode=view&room=${room}\n` +
    `DRAW (tablet): ?mode=draw&room=${room}&bg=white`;
}

// ---------- Canvas sizing + coords ----------
function getCanvasRect() {
  return canvas.getBoundingClientRect();
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = getCanvasRect();
  canvas.width = Math.floor(r.width * dpr);
  canvas.height = Math.floor(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawAll();
}
window.addEventListener("resize", resizeCanvas);

function normPoint(clientX, clientY) {
  const r = getCanvasRect();
  return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
}
function denormPoint(p) {
  const r = getCanvasRect();
  return { x: p.x * r.width, y: p.y * r.height };
}

function drawSegment(aN, bN, color, size) {
  const a = denormPoint(aN);
  const b = denormPoint(bN);

  ctx.strokeStyle = color;
  ctx.lineWidth = Number(size);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

// ---------- State ----------
let strokes = []; // [{_id,color,size,points:[{x,y}...]}]

function redrawAll() {
  const r = getCanvasRect();

  if (bg === "white" && mode === "draw") {
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, r.width, r.height);
  } else {
    ctx.clearRect(0, 0, r.width, r.height);
  }

  for (const s of strokes) {
    for (let i = 1; i < s.points.length; i++) {
      drawSegment(s.points[i - 1], s.points[i], s.color, s.size);
    }
  }
}

if (mode === "draw" && bg === "white") {
  document.body.style.background = "#111";
  canvas.style.background = "#fff";
}

function findStroke(id) {
  return strokes.find(s => s._id === id) || null;
}

function upsertStroke(fullStroke) {
  const ex = findStroke(fullStroke._id);
  if (!ex) strokes.push(fullStroke);
  else {
    ex.color = fullStroke.color;
    ex.size = fullStroke.size;
    ex.points = fullStroke.points;
  }
}

// ---------- MQTT ----------
if (!window.mqtt) {
  showFatal("mqtt.js não carregou.\nConfirma o script no index.html.");
}

const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";

// 2 tópicos: eventos + estado
const TOPIC_EVENTS = `pi/whiteboard/${room}/events`;
const TOPIC_STATE  = `pi/whiteboard/${room}/state`;

// ID único + ORIGIN (para filtrar eco)
const clientId = `wb_${mode}_${Math.random().toString(16).slice(2)}`;
const ORIGIN = clientId;

let client = null;

// versao do state (para evitar regressões no VIEW)
let stateVersion = 0;
let lastStateVSeen = 0;

function setStatus(online) {
  if (mode !== "draw" || !dot || !statusText) return;
  dot.style.background = online ? "#3ad65b" : "#ff4d4d";
  statusText.textContent = online ? "LIVE" : "OFFLINE";
}

try {
  client = window.mqtt.connect(BROKER_URL, {
    clientId,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 1200,
    keepalive: 30,
  });
} catch (e) {
  showFatal("Erro ao iniciar MQTT:\n" + String(e));
}

function publishEvents(type, payload) {
  if (!client || !client.connected) return;
  client.publish(
    TOPIC_EVENTS,
    JSON.stringify({ type, origin: ORIGIN, payload }),
    { qos: 1, retain: false }
  );
}

function publishStateRetained() {
  if (!client || !client.connected) return;
  stateVersion++;

  client.publish(
    TOPIC_STATE,
    JSON.stringify({ origin: ORIGIN, v: stateVersion, strokes }),
    { qos: 1, retain: true }
  );
}

function handleEventsMessage(msg) {
  let data;
  try { data = JSON.parse(msg.toString()); } catch { return; }
  if (!data?.type) return;

  // ✅ no DRAW ignora o eco das próprias mensagens (evita “multiplicar” traços)
  if (mode === "draw" && data.origin === ORIGIN) {
    // deixa passar pedidos de estado (útil se tiveres mais viewers)
    if (data.type !== "req_state") return;
  }

  // Realtime (pode falhar, mas dá sensação de "ao vivo")
  if (data.type === "stroke_points") {
    const p = data.payload;
    if (!p?._id || !Array.isArray(p.points) || p.points.length < 2) return;

    let s = findStroke(p._id);
    if (!s) {
      s = { _id: p._id, color: p.color, size: p.size, points: [] };
      strokes.push(s);
    }

    const startIdx = s.points.length;
    for (const pt of p.points) s.points.push(pt);

    for (let i = Math.max(1, startIdx); i < s.points.length; i++) {
      drawSegment(s.points[i - 1], s.points[i], s.color, s.size);
    }
    return;
  }

  // Commit: acelera correção no fim do traço
  if (data.type === "stroke_commit") {
    const s = data.payload;
    if (!s?._id || !Array.isArray(s.points) || s.points.length < 2) return;
    upsertStroke(s);
    redrawAll();
    return;
  }

  if (data.type === "clear") {
    strokes = [];
    redrawAll();
    return;
  }

  if (data.type === "undo") {
    strokes.pop();
    redrawAll();
    return;
  }

  // Viewer pode pedir estado; tablet responde com retained
  if (data.type === "req_state") {
    if (mode === "draw") publishStateRetained();
  }
}

function handleStateMessage(msg) {
  let data;
  try { data = JSON.parse(msg.toString()); } catch { return; }
  if (!Array.isArray(data.strokes)) return;

  // ✅ no DRAW ignora o state publicado por si próprio (não precisa dele)
  if (mode === "draw" && data.origin === ORIGIN) return;

  // ✅ no VIEW evita aplicar states antigos (retained atrasado / reorder)
  if (mode === "view") {
    const v = Number(data.v || 0);
    if (v && v <= lastStateVSeen) return;
    lastStateVSeen = v || lastStateVSeen;
  }

  strokes = data.strokes;
  redrawAll();
}

if (client) {
  client.on("connect", () => {
    setStatus(true);

    client.subscribe(TOPIC_EVENTS, { qos: 1 }, (err) => {
      if (err) showFatal("Erro ao subscrever events:\n" + String(err));
    });
    client.subscribe(TOPIC_STATE, { qos: 1 }, (err) => {
      if (err) showFatal("Erro ao subscrever state:\n" + String(err));
    });

    if (mode === "view") {
      publishEvents("req_state", { t: Date.now() });
    }

    if (mode === "draw") {
      publishStateRetained();
    }
  });

  client.on("reconnect", () => setStatus(false));
  client.on("close", () => setStatus(false));
  client.on("offline", () => setStatus(false));
  client.on("error", (err) => {
    setStatus(false);
    showFatal("MQTT error:\n" + String(err?.message || err));
  });

  client.on("message", (topic, msg) => {
    if (topic === TOPIC_EVENTS) return handleEventsMessage(msg);
    if (topic === TOPIC_STATE)  return handleStateMessage(msg);
  });
}

// ---------- DRAW: batching + checkpoints + filtro de distância ----------
if (mode === "draw") {
  let drawing = false;
  let activeId = null;

  // buffer realtime
  let buffer = [];
  let lastSentAt = 0;

  // checkpoints
  let checkpointTimer = null;

  // tuning
  const SEND_EVERY_MS = 33;          // 30fps
  const MAX_POINTS_PER_PACKET = 30;  // chunks
  const CHECKPOINT_MS = 500;         // corrige OBS 2x por segundo
  const strokeId = () => Math.random().toString(16).slice(2);

  // filtro por distância mínima
  const MIN_DIST2 = 0.000004;

  function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx*dx + dy*dy;
  }

  function startCheckpointing() {
    if (checkpointTimer) return;
    checkpointTimer = setInterval(() => {
      publishStateRetained();
    }, CHECKPOINT_MS);
  }

  function stopCheckpointing() {
    if (!checkpointTimer) return;
    clearInterval(checkpointTimer);
    checkpointTimer = null;
    publishStateRetained();
  }

  function flushRealtime(force = false) {
    const now = performance.now();
    if (!force && (now - lastSentAt) < SEND_EVERY_MS) return;
    if (buffer.length < 2) return;

    const chunk = buffer.slice(0, MAX_POINTS_PER_PACKET);
    buffer = buffer.slice(MAX_POINTS_PER_PACKET);

    publishEvents("stroke_points", {
      _id: activeId,
      color: colorEl.value,
      size: sizeEl.value,
      points: chunk,
    });

    lastSentAt = now;

    if (force) {
      while (buffer.length >= 2) {
        const c = buffer.slice(0, MAX_POINTS_PER_PACKET);
        buffer = buffer.slice(MAX_POINTS_PER_PACKET);
        publishEvents("stroke_points", {
          _id: activeId,
          color: colorEl.value,
          size: sizeEl.value,
          points: c,
        });
      }
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    activeId = strokeId();
    buffer = [];
    lastSentAt = 0;

    const p = normPoint(e.clientX, e.clientY);

    strokes.push({
      _id: activeId,
      color: colorEl.value,
      size: sizeEl.value,
      points: [p],
    });

    buffer.push(p);
    startCheckpointing();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;

    const p = normPoint(e.clientX, e.clientY);
    const s = strokes[strokes.length - 1];
    const last = s.points[s.points.length - 1];

    if (last && dist2(p, last) < MIN_DIST2) return;

    s.points.push(p);
    drawSegment(s.points[s.points.length - 2], s.points[s.points.length - 1], s.color, s.size);

    buffer.push(p);
    flushRealtime(false);
  });

  function stop() {
    if (!drawing) return;
    drawing = false;

    flushRealtime(true);

    const s = strokes[strokes.length - 1];
    if (s && s.points.length >= 2) {
      publishEvents("stroke_commit", s);
    }

    stopCheckpointing();

    buffer = [];
    activeId = null;
  }

  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", stop);

  btnClear.addEventListener("click", () => {
    strokes = [];
    redrawAll();
    publishEvents("clear", {});
    publishStateRetained();
  });

  btnUndo.addEventListener("click", () => {
    strokes.pop();
    redrawAll();
    publishEvents("undo", {});
    publishStateRetained();
  });
}

// init
resizeCanvas();
