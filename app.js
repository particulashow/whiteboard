// URL params:
// mode=view|draw
// room=abc123
// bg=transparent|white (white só recomendado no draw, se quiseres)
// supabaseUrl=...
// supabaseKey=...

const params = new URLSearchParams(window.location.search);

const mode = (params.get("mode") || "view").toLowerCase();
const room = params.get("room") || "default-room";
const bg = (params.get("bg") || "transparent").toLowerCase();

// Mete aqui em hardcode OU passa por URL (eu recomendo hardcode no repo)
const SUPABASE_URL = params.get("supabaseUrl") || "COLOCA_AQUI_A_TUA_SUPABASE_URL";
const SUPABASE_KEY = params.get("supabaseKey") || "COLOCA_AQUI_A_TUA_SUPABASE_ANON_KEY";

// Canvas
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d", { alpha: true });

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (bg === "white" && mode === "draw") {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  } else {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  redrawAll();
}
window.addEventListener("resize", resizeCanvas);

// Estado para undo/redraw
let strokes = []; // [{color,size,points:[{x,y}..] coords normalizadas 0..1}]
let currentStroke = null;

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

function redrawAll() {
  if (bg === "white" && mode === "draw") {
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

// UI (só draw)
const ui = document.getElementById("ui");
const hint = document.getElementById("hint");
const btnClear = document.getElementById("btnClear");
const btnUndo = document.getElementById("btnUndo");
const colorEl = document.getElementById("color");
const sizeEl = document.getElementById("size");

if (mode === "draw") {
  ui.classList.remove("hidden");
  hint.textContent = `DRAW | room=${room}`;
} else {
  ui.classList.add("hidden");
}

// Supabase Realtime Broadcast
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const channel = supabase.channel(`whiteboard:${room}`, {
  config: { broadcast: { ack: false } }
});

// Receber eventos
channel
  .on("broadcast", { event: "stroke" }, ({ payload }) => {
    if (!payload?.from || !payload?.to) return;

    // atualizar state local (para undo/redraw)
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
    resizeCanvas();
  })
  .on("broadcast", { event: "undo" }, () => {
    strokes.pop();
    currentStroke = null;
    redrawAll();
  });

channel.subscribe((status) => {
  // ajuda a diagnosticar no browser (inclui OBS se abrirem devtools)
  console.log("[Realtime]", status);
});

// Publicar eventos
function send(event, payload) {
  channel.send({
    type: "broadcast",
    event,
    payload
  });
}

// Drawing (apenas draw)
if (mode === "draw") {
  // opcional: fundo branco só no tablet
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
    const rect = canvas.getBoundingClientRect();
    lastN = normPoint(e.clientX - rect.left, e.clientY - rect.top);
    currentStroke = null;
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

    // enviar para todos (inclui OBS)
    send("stroke", payload);

    lastN = nowN;
  });

  function stop() {
    drawing = false;
    lastN = null;
    activeId = null;
    currentStroke = null;
  }

  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", stop);

  btnClear.addEventListener("click", () => send("clear", {}));
  btnUndo.addEventListener("click", () => send("undo", {}));
}

resizeCanvas();
