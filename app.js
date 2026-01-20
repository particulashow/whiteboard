// =====================================================
// OBS Whiteboard (Cloud) - MQTT over WebSockets (EMQX)
// 2 tópicos: events + state (retained)
// DRAW: ?mode=draw&room=abc123&bg=white
// VIEW: ?mode=view&room=abc123
// =====================================================

(() => {
  const params = new URLSearchParams(window.location.search);
  const mode = (params.get("mode") || "view").toLowerCase();
  const room = params.get("room") || "default-room";
  const bg = (params.get("bg") || "transparent").toLowerCase();

  document.body.dataset.mode = mode;

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d", { alpha: true });

  const toolbar = document.getElementById("toolbar");
  const fatal = document.getElementById("fatal");
  const dot = document.getElementById("dot");
  const statusText = document.getElementById("statusText");
  const roomLabel = document.getElementById("roomLabel");

  const btnMin = document.getElementById("btnMin");
  const btnClear = document.getElementById("btnClear");
  const btnUndo = document.getElementById("btnUndo");
  const colorEl = document.getElementById("color");
  const sizeEl = document.getElementById("size");
  const opacityEl = document.getElementById("opacity");
  const palette = document.getElementById("palette");

  function showFatal(msg) {
    if (!fatal) return;
    fatal.textContent = msg;
    fatal.classList.remove("hidden");
  }

  if (roomLabel) roomLabel.textContent = `room: ${room}`;

  // ---------- Canvas sizing + coords ----------
  function getCanvasRect() { return canvas.getBoundingClientRect(); }

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

  // ---------- Tools / style ----------
  let currentTool = "pen";     // pen | highlighter | neon | dashed | eraser
  let currentColor = "#ff3b30";
  let currentSize = 5;
  let currentOpacity = 1;

  function effectiveOpacity(tool, op) {
    if (tool === "highlighter") return Math.min(op, 0.35);
    if (tool === "neon") return Math.min(op, 0.85);
    return op;
  }

  function applyStrokeStyle(stroke) {
    ctx.globalAlpha = effectiveOpacity(stroke.tool, stroke.opacity ?? 1);
    ctx.lineWidth = Number(stroke.size || 5);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color || "#ffffff";

    if (stroke.tool === "dashed") {
      const w = ctx.lineWidth;
      ctx.setLineDash([Math.max(6, w * 2), Math.max(6, w * 1.4)]);
    }

    if (stroke.tool === "neon") {
      ctx.shadowBlur = Math.max(10, ctx.lineWidth * 2.5);
      ctx.shadowColor = stroke.color || "#00ffff";
    }

    if (stroke.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }
  }

  function drawSegment(aN, bN, stroke) {
    const a = denormPoint(aN);
    const b = denormPoint(bN);

    ctx.save();
    applyStrokeStyle(stroke);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- State ----------
  let strokes = []; // [{_id, tool, color, size, opacity, points:[{x,y}...]}]

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
        drawSegment(s.points[i - 1], s.points[i], s);
      }
    }
  }

  if (mode === "draw" && bg === "white") {
    document.body.style.background = "#111";
    canvas.style.background = "#fff";
  }

  function findStroke(id) { return strokes.find(s => s._id === id) || null; }

  function upsertStroke(fullStroke) {
    const ex = findStroke(fullStroke._id);
    if (!ex) strokes.push(fullStroke);
    else {
      ex.tool = fullStroke.tool;
      ex.color = fullStroke.color;
      ex.size = fullStroke.size;
      ex.opacity = fullStroke.opacity;
      ex.points = fullStroke.points;
    }
  }

  // ---------- MQTT ----------
  if (!window.mqtt) {
    showFatal("mqtt.js não carregou. Confirma o script no index.html.");
  }

  const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
  const TOPIC_EVENTS = `pi/whiteboard/${room}/events`;
  const TOPIC_STATE  = `pi/whiteboard/${room}/state`;

  const clientId = `wb_${mode}_${Math.random().toString(16).slice(2)}`;
  const ORIGIN = clientId;

  let client = null;
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

    // DRAW ignora eco das próprias mensagens
    if (mode === "draw" && data.origin === ORIGIN) {
      if (data.type !== "req_state") return;
    }

    if (data.type === "stroke_points") {
      const p = data.payload;
      if (!p?._id || !Array.isArray(p.points) || p.points.length < 2) return;

      let s = findStroke(p._id);
      if (!s) {
        s = {
          _id: p._id,
          tool: p.tool || "pen",
          color: p.color || "#ffffff",
          size: p.size || 5,
          opacity: p.opacity ?? 1,
          points: []
        };
        strokes.push(s);
      }

      const startIdx = s.points.length;
      for (const pt of p.points) s.points.push(pt);

      for (let i = Math.max(1, startIdx); i < s.points.length; i++) {
        drawSegment(s.points[i - 1], s.points[i], s);
      }
      return;
    }

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

    if (data.type === "req_state") {
      if (mode === "draw") publishStateRetained();
    }
  }

  function handleStateMessage(msg) {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    if (!Array.isArray(data.strokes)) return;

    if (mode === "draw" && data.origin === ORIGIN) return;

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

      if (mode === "view") publishEvents("req_state", { t: Date.now() });
      if (mode === "draw") publishStateRetained();
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

  // ---------- UI wiring (só no draw) ----------
  function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll(".tool-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tool === tool);
    });

    if (tool === "highlighter") {
      currentOpacity = Math.min(currentOpacity, 0.35);
      if (opacityEl) opacityEl.value = String(currentOpacity);
    }

    if (tool === "eraser") {
      currentSize = Math.max(currentSize, 12);
      if (sizeEl) sizeEl.value = String(currentSize);
    }
  }

  function setColor(hex) {
    currentColor = hex;
    if (colorEl) colorEl.value = hex;
    document.querySelectorAll(".swatch").forEach(s => {
      s.classList.toggle("active", (s.dataset.color || "").toLowerCase() === hex.toLowerCase());
    });
  }

  function setSize(n) {
    currentSize = Number(n);
    if (sizeEl) sizeEl.value = String(currentSize);
  }

  function setOpacity(v) {
    currentOpacity = Number(v);
    if (opacityEl) opacityEl.value = String(currentOpacity);
  }

  if (mode === "draw") {
    // Impede que interações na toolbar “escorram” para o canvas
    if (toolbar) {
      ["pointerdown","pointermove","pointerup","touchstart","touchmove","touchend","click"].forEach(ev => {
        toolbar.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
      });
    }

    document.querySelectorAll(".tool-btn").forEach(btn => {
      btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });

    if (palette) {
      palette.querySelectorAll(".swatch").forEach(sw => {
        sw.addEventListener("click", () => setColor(sw.dataset.color));
      });
    }

    if (colorEl) colorEl.addEventListener("input", (e) => setColor(e.target.value));
    if (sizeEl) sizeEl.addEventListener("input", (e) => setSize(e.target.value));
    if (opacityEl) opacityEl.addEventListener("input", (e) => setOpacity(e.target.value));

    if (btnMin && toolbar) {
      btnMin.addEventListener("click", () => toolbar.classList.toggle("min"));
    }

    setTool("pen");
    setColor(currentColor);
    setSize(currentSize);
    setOpacity(currentOpacity);
  }

  // ---------- DRAW: batching + checkpoints + filtro + interpolação ----------
  if (mode === "draw") {
    let drawing = false;
    let activeId = null;

    let buffer = [];
    let lastSentAt = 0;

    let checkpointTimer = null;

    const SEND_EVERY_MS = 33;
    const MAX_POINTS_PER_PACKET = 30;
    const CHECKPOINT_MS = 250;

    const MIN_DIST2 = 0.0000015;
    const MAX_STEP = 0.012;

    const strokeId = () => Math.random().toString(16).slice(2);

    function dist2(a, b) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx*dx + dy*dy;
    }
    function lerp(a, b, t) {
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    function pushInterpolatedPoints(stroke, from, to) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx*dx + dy*dy);

      if (dist <= MAX_STEP) {
        stroke.points.push(to);
        buffer.push(to);
        drawSegment(from, to, stroke);
        return;
      }

      const steps = Math.ceil(dist / MAX_STEP);
      let prev = from;

      for (let i = 1; i <= steps; i++) {
        const p = lerp(from, to, i / steps);
        stroke.points.push(p);
        buffer.push(p);
        drawSegment(prev, p, stroke);
        prev = p;
      }
    }

    function startCheckpointing() {
      if (checkpointTimer) return;
      checkpointTimer = setInterval(() => publishStateRetained(), CHECKPOINT_MS);
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
        tool: currentTool,
        color: currentColor,
        size: currentSize,
        opacity: currentOpacity,
        points: chunk,
      });

      lastSentAt = now;

      if (force) {
        while (buffer.length >= 2) {
          const c = buffer.slice(0, MAX_POINTS_PER_PACKET);
          buffer = buffer.slice(MAX_POINTS_PER_PACKET);
          publishEvents("stroke_points", {
            _id: activeId,
            tool: currentTool,
            color: currentColor,
            size: currentSize,
            opacity: currentOpacity,
            points: c,
          });
        }
      }
    }

    // pointer capture: melhora consistência no tablet quando arrastas rápido
    canvas.addEventListener("pointerdown", (e) => {
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);

      drawing = true;
      activeId = strokeId();
      buffer = [];
      lastSentAt = 0;

      const p = normPoint(e.clientX, e.clientY);

      const stroke = {
        _id: activeId,
        tool: currentTool,
        color: currentColor,
        size: currentSize,
        opacity: currentOpacity,
        points: [p],
      };

      strokes.push(stroke);
      buffer.push(p);
      startCheckpointing();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;

      const p = normPoint(e.clientX, e.clientY);
      const stroke = strokes[strokes.length - 1];
      const last = stroke.points[stroke.points.length - 1];

      if (last && dist2(p, last) < MIN_DIST2) return;

      if (last) pushInterpolatedPoints(stroke, last, p);
      else {
        stroke.points.push(p);
        buffer.push(p);
      }

      flushRealtime(false);
    });

    function stop(e) {
      if (!drawing) return;
      drawing = false;

      flushRealtime(true);

      const stroke = strokes[strokes.length - 1];
      if (stroke && stroke.points.length >= 2) {
        publishEvents("stroke_commit", stroke);
      }

      stopCheckpointing();

      buffer = [];
      activeId = null;

      if (e && canvas.releasePointerCapture) {
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
      }
    }

    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("pointerleave", stop);

    if (btnClear) {
      btnClear.addEventListener("click", () => {
        strokes = [];
        redrawAll();
        publishEvents("clear", {});
        publishStateRetained();
      });
    }

    if (btnUndo) {
      btnUndo.addEventListener("click", () => {
        strokes.pop();
        redrawAll();
        publishEvents("undo", {});
        publishStateRetained();
      });
    }
  }

  // init
  resizeCanvas();
})();
