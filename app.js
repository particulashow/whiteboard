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

// -------- Canvas resize (usa o tamanho real do canvas no layout atual) --------
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  redrawAll();
}
window.addEventListener("resize", resizeCanvas);

// coords normalizadas no referencial do canvas (rect)
function getCanvasRect() {
  return canvas.getBoundingClientRect();
}
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

// -------- Estado para undo/redraw --------
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

// fundo branco opcional no tablet
if (mode === "draw" && bg === "white") {
  document.body.style.background = "#111";
  canvas.style.background = "#fff";
}

// -------- MQTT --------
if (!window.mqtt) showFatal("mqtt.js não carregou. Confirma o script no index.html.");

const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const TOPIC = `pi/whiteboard/${room}`;
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
  });
} catch (e) {
  showFatal("Erro ao iniciar MQTT:\n" + String(e));
}

if (client) {
  client.on("connect", () => {
    setStatus(true);
    client.subscribe(TOPIC, { qos: 0 }, (err) => {
      if (err) showFatal("Erro ao subscrever tópico:\n" + String(err));
    });
  });

  client.on("reconnect", () => setStatus(false));
  client.on("close", () => setStatus(false));
  client.on("offline", () => setStatus(false));
  client.on("error", (err) => {
    setStatus(false);
    showFatal("MQTT error:\n" + String(err?.message || err));
  });

  client.on("message", (_topic, msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    if (!data?.type) return;

    if (data.type === "stroke_points") {
      const p = data.payload;
      if (!p?._id || !Array.isArray(p.points) || p.points.length < 2) return;

      // encontra stroke existente ou cria
      let s = strokes.find(x => x._id === p._id);
      if (!s) {
        s = { _id: p._id, color: p.color, size: p.size, points: [] };
        strokes.push(s);
      }

      // acrescenta pontos e desenha só os novos
      const startIdx = s.points.length;
      for (const pt of p.points) s.points.push(pt);

      for (let i = Math.max(1, startIdx); i < s.points.length; i++) {
        drawSegment(s.points[i - 1], s.points[i], s.color, s.size);
      }
    }

    if (data.type === "clear") {
      strokes = [];
      redrawAll();
    }

    if (data.type === "undo") {
      strokes.pop();
      redrawAll();
    }
  });
}

function publish(type, payload) {
  if (!client || !client.connected) return;
  client.publish(TOPIC, JSON.stringify({ type, payload }), { qos: 0, retain: false });
}

// -------- DRAW: batching + throttling --------
if (mode === "draw") {
  let drawing = false;
  let activeId = null;

  // buffer de pontos a enviar
  let buffer = [];
  let lastSentAt = 0;

  // tuning:
  const SEND_EVERY_MS = 33;      // ~30 fps (suficiente e muito mais fiável)
  const MAX_POINTS_PER_PACKET = 25; // evita pacotes gigantes

  const strokeId = () => Math.random().toString(16).slice(2);

  function flush(force = false) {
    const now = performance.now();
    if (!force && (now - lastSentAt) < SEND_EVERY_MS) return;
    if (buffer.length < 2) return;

    // corta em chunks
    const chunk = buffer.slice(0, MAX_POINTS_PER_PACKET);
    buffer = buffer.slice(MAX_POINTS_PER_PACKET);

    publish("stroke_points", {
      _id: activeId,
      color: colorEl.value,
      size: sizeEl.value,
      points: chunk,
    });

    lastSentAt = now;

    // se ainda houver muitos pontos, manda mais já (mas respeitando limite de pacote)
    if (buffer.length >= 2 && force) {
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

    const p = normPoint(e.clientX, e.clientY);

    // cria stroke local imediatamente
    strokes.push({ _id: activeId, color: colorEl.value, size: sizeEl.value, points: [p] });

    buffer = [p];
    lastSentAt = 0;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;

    const p = normPoint(e.clientX, e.clientY);

    // local: adicionar e desenhar já
    const s = strokes[strokes.length - 1];
    s.points.push(p);

    const len = s.points.length;
    if (len >= 2) {
      drawSegment(s.points[len - 2], s.points[len - 1], s.color, s.size);
    }

    // buffer para envio
    buffer.push(p);

    // tenta enviar (throttle)
    flush(false);
  });

  function stop() {
    if (!drawing) return;
    drawing = false;

    // força envio do que sobrou
    flush(true);

    // limpa
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
  });
}

resizeCanvas();
