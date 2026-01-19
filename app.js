// public/app.js
// =====================================================
// OBS Whiteboard (Opção 2 - Cloud) com Supabase Broadcast
// Modo:
//   ?mode=view&room=abc123            -> VIEW (OBS) transparente
//   ?mode=draw&room=abc123&bg=white   -> DRAW (tablet) com fundo branco opcional
//
// Opcional (passar credenciais via URL):
//   &supabaseUrl=...&supabaseKey=...
// =====================================================

const params = new URLSearchParams(window.location.search);

const mode = (params.get("mode") || "view").toLowerCase();   // view | draw
const room = params.get("room") || "default-room";
const bg = (params.get("bg") || "transparent").toLowerCase(); // transparent | white

// Recomendo hardcode no repo (mais simples). Se preferires, passa por URL.
const SUPABASE_URL =
  params.get("supabaseUrl") || "COLOCA_AQUI_A_TUA_SUPABASE_URL";
const SUPABASE_KEY =
  params.get("supabaseKey") || "COLOCA_AQUI_A_TUA_SUPABASE_ANON_KEY";

// --------- DOM ---------
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d", { alpha: true });

const ui = document.getElementById("ui");
const hint = document.getElementById("hint");
const btnClear = document.getElementById("btnClear");
const btnUndo = document.getElementById("btnUndo");
const colorEl = document.getElementById("color");
const sizeEl = document.getElementById("size");

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const roomLabel = document.getElementById("roomLabel");

// UI só no DRAW
if (mode === "draw") {
  ui.classList.remove("hidden");
  ui.setAttribute("aria-hidden", "false");
  roomLabel.textContent = `room: ${room}`;
  hint.textContent = `Link VIEW (OBS): ?mode=view&room=${room}\nLink DRAW (tablet): ?mode=draw&room=${room}&bg=white`;
} else {
  ui.classList.add("hidden");
  ui.setAttribute("aria-hidden", "true");
}

// --------- Helpers canvas (normalização 0..1) ---------
function normPoint(x, y) {
  return { x: x / window.innerWidth, y: y / window.innerHeight };
}

function denormPoint(p) {
  return { x: p.x * window.innerWidth, y: p.y * window.innerHeight };
}

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

// --------- Estado (undo/redraw) ---------
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

// --------- Supabase Realtime Broadcast ---------
if (!window.supabase) {
  console.error("Supabase JS não carregou. Confirma o script CDN no index.html.");
}

const placeholders =
  SUPABASE_URL.includes("COLOCA_AQUI") || SUPABASE_KEY.includes("COLOCA_AQUI");

if (placeholders && mode === "draw") {
  hint.textContent =
    "Faltam SUPABASE_URL e SUPABASE_ANON_KEY.\nSubstitui os placeholders no app.js (ou passa via URL).";
}

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const channel = supabase.channel(`whiteboard:${room}`, {
  config: { broadcast: { ack: false } },
});

// Receber
channel
  .on("broadcast", { event: "stroke" }, ({ payload }) => {
    if (!payload?.from || !payload?.to) return;

    if (payload.append) {
      if (!currentStroke || currentStroke._id !== payload._id) {
        currentStroke = {
          _id: payload._id,
          color: payload.color,
          size: payload.size,
          points: [payload.from, payload.to],
        };
        strokes.push(currentStroke);
      } else {
        currentStroke.points.push(payload.to);
      }
    } else {
      currentStroke = null;
    }

    drawSegment(payload.from, payload.to, payload.color, payload.size);
  })
  .on("broadcast", { event: "clear" }, () => {
    strokes = [];
    currentStroke = null;
    redrawAll();
  })
  .on("broadcast", { event: "undo" }, () => {
    strokes.pop();
    currentStroke = null;
    redrawAll();
  });

// subscribe status -> indicador LIVE/OFFLINE
channel.subscribe((status) => {
  console.log("[Realtime]", status);

  if (mode !== "draw") return;

  const online =
    status === "SUBSCRIBED" || status === "CHANNEL_JOINED" || status === "CONNECTED";

  if (online) {
    dot.style.background = "#3ad65b";
    statusText.textContent = "LIVE";
  } else {
    dot.style.background = "#ff4d4d";
    statusText.textContent = "OFFLINE";
  }
});

// Enviar
function send(event, payload) {
  channel.send({
    type: "broadcast",
    event,
    payload,
  });
}

// --------- DRAW (tablet) ---------
if (mode === "draw") {
  // fundo branco opcional só no tablet
  if (bg === "white") {
    document.body.style.background = "#111";
    canvas.style.background = "#fff";
  }

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
      append: true,
    };

    // 1) desenhar imediatamente no tablet
    drawSegment(payload.from, payload.to, payload.color, payload.size);

    // 2) guardar localmente para undo/redraw no tablet
    if (!currentStroke || currentStroke._id !== payload._id) {
      currentStroke = {
        _id: payload._id,
        color: payload.color,
        size: payload.size,
        points: [payload.from, payload.to],
      };
      strokes.push(currentStroke);
    } else {
      currentStroke.points.push(payload.to);
    }

    // 3) enviar para OBS/viewers
    send("stroke", payload);

    lastN = nowN;
  });

  function stopDrawing() {
    drawing = false;
    lastN = null;
    activeId = null;
    currentStroke = null;
  }

  canvas.addEventListener("pointerup", stopDrawing);
  canvas.addEventListener("pointercancel", stopDrawing);
  canvas.addEventListener("pointerleave", stopDrawing);

  btnClear.addEventListener("click", () => {
    strokes = [];
    currentStroke = null;
    redrawAll();
    send("clear", {});
  });

  btnUndo.addEventListener("click", () => {
    strokes.pop();
    currentStroke = null;
    redrawAll();
    send("undo", {});
  });
}

// --------- init ---------
resizeCanvas();
