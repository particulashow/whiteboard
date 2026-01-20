// ================= CONFIG =================
const params = new URLSearchParams(location.search);
const mode = (params.get("mode") || "view").toLowerCase();
const room = params.get("room") || "default";
const bg = params.get("bg") || "transparent";
document.body.dataset.mode = mode;

// ================= CANVAS =================
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d",{alpha:true});

function resize(){
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  redraw();
}
window.addEventListener("resize",resize);

// ================= STATE =================
let strokes = [];
function redraw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  for(const s of strokes){
    for(let i=1;i<s.points.length;i++){
      drawSeg(s.points[i-1],s.points[i],s);
    }
  }
}

// ================= DRAW STYLE =================
function drawSeg(a,b,s){
  ctx.save();
  ctx.globalAlpha = s.opacity;
  ctx.lineWidth = s.size;
  ctx.lineCap="round";
  ctx.lineJoin="round";
  ctx.setLineDash(s.tool==="dashed"?[10,6]:[]);
  ctx.strokeStyle = s.color;

  if(s.tool==="neon"){
    ctx.shadowBlur=20;
    ctx.shadowColor=s.color;
  }
  if(s.tool==="eraser"){
    ctx.globalCompositeOperation="destination-out";
    ctx.strokeStyle="#000";
    ctx.globalAlpha=1;
  }

  ctx.beginPath();
  ctx.moveTo(a.x,a.y);
  ctx.lineTo(b.x,b.y);
  ctx.stroke();
  ctx.restore();
}

// ================= MQTT =================
const mqtt = window.mqtt;
const clientId = "wb_"+Math.random().toString(16).slice(2);
const ORIGIN = clientId;

const TOPIC_EVENTS = `pi/whiteboard/${room}/events`;
const TOPIC_STATE  = `pi/whiteboard/${room}/state`;

const client = mqtt.connect("wss://broker.emqx.io:8084/mqtt",{clientId});
let stateV=0,lastV=0;

function pubEvents(type,payload){
  client.publish(TOPIC_EVENTS,JSON.stringify({type,origin:ORIGIN,payload}),{qos:1});
}
function pubState(){
  stateV++;
  client.publish(TOPIC_STATE,JSON.stringify({origin:ORIGIN,v:stateV,strokes}),{qos:1,retain:true});
}

client.on("connect",()=>{
  client.subscribe([TOPIC_EVENTS,TOPIC_STATE]);
  if(mode==="draw") pubState();
  if(mode==="view") pubEvents("req",{});
  document.getElementById("dot").style.background="lime";
  document.getElementById("statusText").textContent="live";
  document.getElementById("roomLabel").textContent=room;
});

client.on("message",(topic,msg)=>{
  const d = JSON.parse(msg.toString());
  if(d.origin===ORIGIN && mode==="draw") return;

  if(topic===TOPIC_STATE){
    if(d.v<=lastV) return;
    lastV=d.v;
    strokes=d.strokes;
    redraw();
  }

  if(topic===TOPIC_EVENTS){
    if(d.type==="stroke"){
      strokes.push(d.payload);
      redraw();
    }
    if(d.type==="clear"){ strokes=[]; redraw(); }
    if(d.type==="undo"){ strokes.pop(); redraw(); }
    if(d.type==="req" && mode==="draw") pubState();
  }
});

// ================= UI =================
let tool="pen", color="#ff3b30", size=5, opacity=1;

document.querySelectorAll(".tool-btn").forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll(".tool-btn").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    tool=b.dataset.tool;
  };
});

document.querySelectorAll(".swatch").forEach(s=>{
  s.onclick=()=>color=s.dataset.color;
});
document.getElementById("color").oninput=e=>color=e.target.value;
document.getElementById("size").oninput=e=>size=+e.target.value;
document.getElementById("opacity").oninput=e=>opacity=+e.target.value;

document.getElementById("btnClear").onclick=()=>{
  strokes=[]; redraw();
  pubEvents("clear",{});
  pubState();
};
document.getElementById("btnUndo").onclick=()=>{
  strokes.pop(); redraw();
  pubEvents("undo",{});
  pubState();
};
document.getElementById("btnMin").onclick=()=>{
  document.getElementById("toolbar").classList.toggle("min");
};

// ================= DRAW INPUT =================
if(mode==="draw"){
  let drawing=false, cur=null;

  canvas.onpointerdown=e=>{
    drawing=true;
    cur={_id:Date.now()+Math.random(),tool,color,size,opacity,points:[{x:e.clientX,y:e.clientY}]};
    strokes.push(cur);
  };

  canvas.onpointermove=e=>{
    if(!drawing) return;
    cur.points.push({x:e.clientX,y:e.clientY});
    redraw();
  };

  canvas.onpointerup=()=>{
    if(!drawing) return;
    drawing=false;
    pubEvents("stroke",cur);
    pubState();
  };
}

resize();
