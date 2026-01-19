// =====================================================
// OBS Whiteboard (Cloud) - MQTT over WebSockets (EMQX)
// VIEW (OBS):  ?mode=view&room=abc123
// DRAW (tab):  ?mode=draw&room=abc123&bg=white
//
// Broker (HTTPS -> usa WSS):
// wss://broker.emqx.io:8084/mqtt  (path /mqtt) :contentReference[oaicite:2]{index=2}
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
  fatal.textContent = msg;
  fatal.classList.remove("hidden");
}

roomLabel.textContent = `room: ${room}`;

if (mode === "draw") {
  hint.textContent =
    `VIEW (OBS): ?mode=view&room=${room}\n` +
    `DRAW (tablet): ?mode=draw&room=${room}&bg=white`;
}

// -------- Canvas helpers (coords normalizadas) --------
function normPoint(x, y) { return { x: x / window.innerWidth, y: y / window.innerHeight }; }
function denormPoint(p) { return { x: p.x * window.innerWidth, y: p.y * window.innerHeight }; }

function drawSegment(fromN, toN, color, size) {
  const a = denormPoint(fromN);
  const b = denormPoint(toN);

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
let strokes = [];
let currentStroke = null;

function redrawAll() {
  if (bg === "white" && mode === "draw") {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  } else {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  for (const s of strokes) {
    for (let i = 1; i < s.points.length; i++) {
      drawSegment(s.points[i - 1], s.points[i], s.color, s.size);
    }
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawAll();
}
window.addEventListener("resize", resizeCanvas);

// fundo branco opcional no tablet
if (mode === "draw" && bg === "white") {
  document.body.style.background = "#111";
  canvas.style.background = "#fff";
}

// -------- MQTT setup --------
if (!window.mqtt) {
  showFatal("mqtt.js não carregou.\nConfirma o script no index.html.");
}

const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";

// IMPORTANTÍSSIMO: tópico único por room (evita interferência)
const TOPIC = `pi/whiteboard/${room}`;

// Cliente MQTT (ID aleatório)
const clientId = `wb_${mode}_${Math.random().toString(16).slice(2)}`;

let client = null;

try {
  client = window.mqtt.connect(BROKER_URL, {
    clientId,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 1500,
  });
} catch (e) {
  showFatal("Erro ao iniciar MQTT:\n" + String(e));
}

function setStatus(online) {
  if (mode !== "draw") return;
  dot.style.background = online ? "#3ad65b" : "#ff4d4d";
  statusText.textContent = online ? "LIVE" : "OFFLINE";
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
    let data = null;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    if (!data || !data.type) return;

    if (data.type === "stroke") {
      const p = data.payload;
      if (!p?.from || !p?.to) return;

      if (p.append) {
        if (!currentStroke || currentStroke._id !== p._id) {
          currentStroke = { _id: p._id, color: p.color, size: p.size, points: [p.from, p.to] };
          strokes.push(currentStroke);
        } else {
          currentStroke.points.push(p.to);
        }
      } else {
        currentStroke = null;
      }

      drawSegment(p.from, p.to, p.color, p.size);
    }

    if (data.type === "clear") {
      strokes = [];
      currentStroke = null;
      redrawAll();
    }

    if (data.type === "undo") {
      strokes.pop();
      currentStroke = null;
      redrawAll();
    }
  });
}

function publish(type, payload) {
  if (!client || !client.connected) return;
  client.publish(TOPIC, JSON.stringify({ type, payload }), { qos: 0, retain: false });
}

// -------- DRAW: desenhar local + publicar --------
if (mode === "draw") {
  let drawing = false;
  let lastN = null;
  let activeId = null;
  const strokeId = () => Math.random().toString(16).slice(2);

  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    activeId = strokeId();
    currentStroke = null;

    const rect = canvas.getBoundingClientRect();
    lastN = normPoint(e.clientX - rect.left, e.clientY - rect.top);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;

    const rect = canvas.getBoundingClientRect();
    const nowN = normPoint(e.clientX - rect.left, e.clientY - rect.top);

    const payload = {
      _id: activeId,
      color: colorEl.value,
      size: sizeEl.value,
      from: lastN,
      to: nowN,
      append: true
    };

    // 1) desenha já no tablet
    drawSegment(payload.from, payload.to, payload.color, payload.size);

    // 2) guarda local para undo/redraw
    if (!currentStroke || currentStroke._id !== payload._id) {
      currentStroke = { _id: payload._id, color: payload.color, size: payload.size, points: [payload.from, payload.to] };
      strokes.push(currentStroke);
    } else {
      currentStroke.points.push(payload.to);
    }

    // 3) publica para o OBS/viewers
    publish("stroke", payload);

    lastN = nowN;
  });

  const stop = () => {
    drawing = false;
    lastN = null;
    activeId = null;
    currentStroke = null;
  };

  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", stop);

  btnClear.addEventListener("click", () => {
    strokes = [];
    currentStroke = null;
    redrawAll();
    publish("clear", {});
  });

  btnUndo.addEventListener("click", () => {
    strokes.pop();
    currentStroke = null;
    redrawAll();
    publish("undo", {});
  });
}

resizeCanvas();
