// =====================================================
// OBS Whiteboard (Cloud) - Supabase Broadcast
// URLs:
//  VIEW: ?mode=view&room=abc123
//  DRAW: ?mode=draw&room=abc123&bg=white
// =====================================================

const params = new URLSearchParams(window.location.search);

const mode = (params.get("mode") || "view").toLowerCase();
const room = params.get("room") || "default-room";
const bg = (params.get("bg") || "transparent").toLowerCase();

document.body.dataset.mode = mode; // <- isto controla a UI por CSS

const SUPABASE_URL =
  params.get("supabaseUrl") || "COLOCA_AQUI_A_TUA_SUPABASE_URL";
const SUPABASE_KEY =
  params.get("supabaseKey") || "COLOCA_AQUI_A_TUA_SUPABASE_ANON_KEY";

// DOM
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

if (!window.supabase) {
  showFatal("Supabase JS não carregou.\nConfirma o <script> no index.html.");
}

// Validar credenciais
const missingKeys =
  SUPABASE_URL.includes("COLOCA_AQUI") || SUPABASE_KEY.includes("COLOCA_AQUI");

if (missingKeys) {
  showFatal(
    "Faltam as credenciais do Supabase.\n" +
    "Substitui SUPABASE_URL e SUPABASE_KEY no app.js (ou passa via URL)."
  );
}

// Canvas helpers (coords normalizadas)
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

// Estado (undo/redraw)
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

// Fundo branco opcional no tablet
if (mode === "draw" && bg === "white") {
  document.body.style.background = "#111";
  canvas.style.background = "#fff";
}

// Supabase Realtime
const supabase = window.supabase?.createClient?.(SUPABASE_URL, SUPABASE_KEY);
if (!supabase) {
  showFatal("Não foi possível criar o cliente Supabase.\nConfirma URL/KEY.");
} else {
  const channel = supabase.channel(`whiteboard:${room}`, {
    config: { broadcast: { ack: false } },
  });

  channel
    .on("broadcast", { event: "stroke" }, ({ payload }) => {
      if (!payload?.from || !payload?.to) return;

      if (payload.append) {
        if (!currentStroke || currentStroke._id !== payload._id) {
          currentStroke = { _id: payload._id, color: payload.color, size: payload.size, points: [payload.from, payload.to] };
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

  channel.subscribe((status) => {
    const online = status === "SUBSCRIBED";

    if (mode === "draw") {
      dot.style.background = online ? "#3ad65b" : "#ff4d4d";
      statusText.textContent = online ? "LIVE" : "OFFLINE";
    }
    console.log("[Realtime]", status);
  });

  function send(event, payload) {
    channel.send({ type: "broadcast", event, payload });
  }

  // DRAW: desenhar local + enviar
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

      // desenha já no tablet
      drawSegment(payload.from, payload.to, payload.color, payload.size);

      // guarda para undo/redraw
      if (!currentStroke || currentStroke._id !== payload._id) {
        currentStroke = { _id: payload._id, color: payload.color, size: payload.size, points: [payload.from, payload.to] };
        strokes.push(currentStroke);
      } else {
        currentStroke.points.push(payload.to);
      }

      // envia para o OBS/viewers
      send("stroke", payload);

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
      send("clear", {});
    });

    btnUndo.addEventListener("click", () => {
      strokes.pop();
      currentStroke = null;
      redrawAll();
      send("undo", {});
    });
  }

  resizeCanvas();
}
