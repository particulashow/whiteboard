// ====== Config por URL ======
// mode=view|draw
// room=nomeDaSala
// key=PUShER_KEY (opcional se preferires hardcode)
// cluster=eu (ou o teu)
// bg=transparent|white (default: transparent)
// tip: usa room aleatória para evitar trolls

const params = new URLSearchParams(window.location.search);

const mode = (params.get("mode") || "view").toLowerCase(); // view | draw
const room = params.get("room") || "default-room";
const bg = (params.get("bg") || "transparent").toLowerCase();

const PUSHER_KEY = params.get("key") || "COLOCA_AQUI_A_TUA_PUSHER_KEY";
const PUSHER_CLUSTER = params.get("cluster") || "eu"; // troca para o teu cluster

// Canal e evento
const channelName = `presence-whiteboard-${room}`; // presença dá jeito para "ligado"
const eventStroke = "client-stroke"; // client events requerem presence/private
const eventClear = "client-clear";
const eventUndo  = "client-undo";

// ====== Canvas setup ======
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d", { alpha: true });

function resizeCanvas() {
  // resolução real do canvas (não só CSS)
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (bg === "white" && mode === "draw") {
    // no tablet podes querer fundo branco para ver bem
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  } else {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  redrawAll();
}
window.addEventListener("resize", resizeCanvas);

// Guardamos strokes para redraw/undo
let strokes = []; // cada stroke: {color,size,points:[{x,y}...]} coords normalizadas 0..1
let currentStroke = null;

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

function redrawAll() {
  // reconstroi tudo a partir de strokes
  if (!(bg === "white" && mode === "draw")) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  }

  for (const s of strokes) {
    for (let i = 1; i < s.points.length; i++) {
      drawSegment(s.points[i-1], s.points[i], s.color, s.size);
    }
  }
}

// ====== UI (só no draw) ======
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

// ====== Pusher setup ======
// NOTA IMPORTANTE:
// Para poderes usar "client events" (client-*) sem servidor,
// precisas de um canal private/presence com auth.
// A forma mais simples sem backend é usar um provider que aceite "public broadcast"
// mas no Pusher, private/presence pedem endpoint de auth.
//
// Solução "sem backend" aqui:
// - usar canais PUBLIC e eventos normais (não client-*)
// - mas isso implica que qualquer pessoa pode publicar com a key (que é pública).
// Para diretos controlados, resolve-se com room random e link só para o tablet.
//
// Implementação: usamos evento normal "stroke"/"clear"/"undo".

const pusher = new Pusher(PUSHER_KEY, {
  cluster: PUSHER_CLUSTER,
  // força TLS (boa prática)
  forceTLS: true,
});

const channel = pusher.subscribe(`whiteboard-${room}`);

channel.bind("stroke", (data) => {
  // data: {color,size,from,to,append}
  if (!data || !data.from || !data.to) return;

  // atualiza state local para undo/redraw
  if (data.append) {
    // continuar stroke atual (se possível)
    if (!currentStroke || currentStroke._id !== data._id) {
      currentStroke = { _id: data._id, color: data.color, size: data.size, points: [data.from, data.to] };
      strokes.push(currentStroke);
    } else {
      currentStroke.points.push(data.to);
    }
  } else {
    currentStroke = null;
  }

  drawSegment(data.from, data.to, data.color, data.size);
});

channel.bind("clear", () => {
  strokes = [];
  currentStroke = null;
  resizeCanvas();
});

channel.bind("undo", () => {
  strokes.pop();
  currentStroke = null;
  redrawAll();
});

function publish(event, payload) {
  // Pusher Channels: para publicar do browser em canais públicos sem backend,
  // usa Webhooks/server normalmente. No entanto, podes usar a REST API com um "proxy"
  // ... mas isso é backend.
  //
  // Para ficar 100% sem backend, recomendo Supabase Realtime (broadcast) ou Ably,
  // que suportam publish do cliente de forma mais direta.
  //
  // Aqui deixo o whiteboard pronto, mas para publicar sem backend tens duas opções:
  // A) trocar para Supabase Realtime Broadcast (recomendado)
  // B) adicionar uma micro API route (qualquer host) para assinar/publish
  console.warn("Publicar sem backend no Pusher não é ideal. Usa Supabase Broadcast para 100% client-side.");
}

// ====== Drawing (apenas no draw) ======
if (mode === "draw") {
  // Fundo branco opcional no tablet
  if (bg === "white") {
    document.body.style.background = "#111";
    canvas.style.background = "#fff";
  }

  let drawing = false;
  let lastN = null;
  const strokeId = () => Math.random().toString(16).slice(2);

  let activeId = null;

  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    activeId = strokeId();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    lastN = normPoint(x, y);
    currentStroke = null;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const nowN = normPoint(x, y);

    const payload = {
      _id: activeId,
      color: colorEl.value,
      size: sizeEl.value,
      from: lastN,
      to: nowN,
      append: true
    };

    // Aqui é onde precisamos de publish realtime sem backend.
    // Para ficares já a funcionar, recomendo troca para Supabase Broadcast (abaixo).
    // publish("stroke", payload);

    // preview local (tablet)
    drawSegment(payload.from, payload.to, payload.color, payload.size);

    lastN = nowN;
  });

  canvas.addEventListener("pointerup", () => {
    drawing = false;
    lastN = null;
    activeId = null;
  });

  canvas.addEventListener("pointercancel", () => {
    drawing = false;
    lastN = null;
    activeId = null;
  });

  btnClear.addEventListener("click", () => {
    // publish("clear", {});
    strokes = [];
    currentStroke = null;
    resizeCanvas();
  });

  btnUndo.addEventListener("click", () => {
    // publish("undo", {});
    strokes.pop();
    currentStroke = null;
    redrawAll();
  });
}

resizeCanvas();
