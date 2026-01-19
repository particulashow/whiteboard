// =====================================================
// OBS Whiteboard (Cloud) - MQTT over WebSockets (EMQX)
// VIEW (OBS):  ?mode=view&room=abc123
// DRAW (tab):  ?mode=draw&room=abc123&bg=white
//
// Broker WSS (HTTPS):
// wss://broker.emqx.io:8084/mqtt
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

// ---------- Canvas sizing ----------
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

// coords normalizadas pelo rect do canvas (mais consistente OBS vs tablet)
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

// tablet: fundo branco opcional
if (mode === "draw" && bg === "white") {
  document.body.style.background = "#111";
  canvas.style.background = "#fff";
}

// ---------- MQTT ----------
if (!window.mqtt) {
  showFatal("mqtt.js não carregou.\nConfirma o script no index.html.");
}

const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const TOPIC = `pi/whiteboard/${room}`;

// Client ID (único)
const clientId = `wb_${mode}_${Math.random().toString(16).slice(2)}`;

let client = null;

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

function publish(type, payload) {
  if (!client || !client.connected) return;
  // qos 0 é mais leve; a consistência vem do "commit"
  client.publish(TOPIC, JSON.stringify({ type, payload }), { qos: 0, retain: false });
}

function findStroke(id) {
  return strokes.find(s => s._id === id) || null;
}

function upsertStroke(fullStroke) {
  const existing = findStroke(fullStroke._id);
  if (!existing) {
    strokes.push(fullStroke);
  } else {
    existing.color = fullStroke.color;
    existing.size = fullStroke.size;
    existing.points = fullStroke.points;
  }
}

// Handler de mensagens
function onMessage(msg) {
  let data;
  try { data = JSON.parse(msg.toString()); } catch { return; }
  if (!data?.type) return;

  // 1) realtime points (pode falhar, ok)
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

    // desenha só o que entrou agora
    for (let i = Math.max(1, startIdx); i < s.points.length; i++) {
      drawSegment(s.points[i - 1], s.points[i], s.color, s.size);
    }
    return;
  }

  // 2) commit do stroke (isto corrige tudo)
  if (data.type === "stroke_commit") {
    const s = data.payload;
    if (!s?._id || !Array.isArray(s.points) || s.points.length < 2) return;
    upsertStroke(s);
    redrawAll();
    return;
  }

  // 3) clear / undo (com sync)
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

  // 4) viewer pede estado
  if (data.type === "req_state") {
    // só o tablet responde (é o “autor”)
    if (mode === "draw") {
      publish("state", { strokes });
    }
    return;
  }

  // 5) resposta com estado completo
  if (data.type === "state") {
    const st = data.payload?.strokes;
    if (!Array.isArray(st)) return;
    strokes = st;
    redrawAll();
    return;
  }
}

if (client) {
  client.on("connect", () => {
    setStatus(true);
    client.subscribe(TOPIC, { qos: 0 }, (err) => {
      if (err) showFatal("Erro ao subscrever tópico:\n" + String(err));
    });

    // se for VIEW, pede estado ao entrar
    if (mode === "view") {
      publish("req_state", { t: Date.now() });
    }
  });

  client.on("reconnect", () => setStatus(false));
  client.on("close", () => setStatus(false));
  client.on("offline", () => setStatus(false));
  client.on("error", (err) => {
    setStatus(false);
    showFatal("MQTT error:\n" + String(err?.message || err));
  });

  client.on("message", (_topic, msg) => onMessage(msg));
}

// ---------- DRAW logic: batching realtime + commit final ----------
if (mode === "draw") {
  let drawing = false;
  let activeId = null;

  // buffer realtime
  let buffer = [];
  let lastSentAt = 0;

  // tuning
  const SEND_EVERY_MS = 33;         // 30 fps
  const MAX_POINTS_PER_PACKET = 30; // chunk
  const strokeId = () => Math.random().toString(16).slice(2);

  function flushRealtime(force = false) {
    const now = performance.now();
    if (!force && (now - lastSentAt) < SEND_EVERY_MS) return;
    if (buffer.length < 2) return;

    const chunk = buffer.slice(0, MAX_POINTS_PER_PACKET);
    buffer = buffer.slice(MAX_POINTS_PER_PACKET);

    publish("stroke_points", {
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
        publish("stroke_points", {
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

    // cria stroke local
    strokes.push({
      _id: activeId,
      color: colorEl.value,
      size: sizeEl.value,
      points: [p],
    });

    buffer.push(p);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;

    const p = normPoint(e.clientX, e.clientY);

    // local: adiciona e desenha
    const s = strokes[strokes.length - 1];
    s.points.push(p);
    const len = s.points.length;
    drawSegment(s.points[len - 2], s.points[len - 1], s.color, s.size);

    // realtime buffer
    buffer.push(p);
    flushRealtime(false);
  });

  function stop() {
    if (!drawing) return;
    drawing = false;

    // envia o resto realtime
    flushRealtime(true);

    // COMMIT: envia o stroke completo (isto garante que o OBS fica igual ao tablet)
    const s = strokes[strokes.length - 1];
    if (s && s.points.length >= 2) {
      publish("stroke_commit", s);
    }

    buffer = [];
    activeId = null;
  }

  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", stop);

  btnClear.addEventListener("click", () => {
    strokes = [];
    redrawAll();
    publish("clear", {});
  });

  btnUndo.addEventListener("click", () => {
    strokes.pop();
    redrawAll();
    publish("undo", {});
    // depois do undo, manda estado para corrigir viewers
    publish("state", { strokes });
  });
}

resizeCanvas();
