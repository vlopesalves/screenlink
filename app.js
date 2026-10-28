// ScreenLink — protótipo WebRTC para um transmissor e um espectador.
// Configure as credenciais públicas do seu projeto Supabase abaixo.
// NUNCA coloque uma chave service_role no frontend.
const SUPABASE_URL = "https://otipqykhxpqkwbspbnme.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hnibWDwIpz_gSsXsQTi8Pg_CaVxDXV_";

const $ = (id) => document.getElementById(id);
const supabaseConfigured = SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("COLE_AQUI") &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.includes("COLE_AQUI");
const sb = supabaseConfigured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

let mode = "host";
let channel = null;
let pc = null;
let localStream = null;
let roomId = null;
let isHost = false;
let pendingCandidates = [];
let remoteDescriptionSet = false;
let toastTimer = null;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3400);
}
function setStatus(message, connected = false) {
  $("status").textContent = "";
  const dot = document.createElement("span");
  dot.className = "dot";
  $("status").append(dot, document.createTextNode(" " + message));
  $("status").classList.toggle("connected", connected);
}
function setMode(next) {
  mode = next;
  $("hostTab").classList.toggle("active", next === "host");
  $("watchTab").classList.toggle("active", next === "watch");
  $("hostPane").classList.toggle("hidden", next !== "host");
  $("watchPane").classList.toggle("hidden", next !== "watch");
}
function randomRoom() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}
function roomUrl(id) {
  const url = new URL(location.href);
  url.searchParams.set("room", id);
  return url.toString();
}
function showRoom(id, host) {
  $("setup").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("roomCode").textContent = id;
  $("roomTitle").textContent = host ? "Sua transmissão" : "Assistindo à transmissão";
  $("roomHelp").textContent = host
    ? "Envie o link para uma pessoa. Nesta versão inicial, a sala aceita um espectador por vez."
    : "Você está conectado como espectador. A qualidade depende da conexão de ambas as pessoas.";
}
function showVideo(stream) {
  const video = $("screenVideo");
  video.srcObject = stream;
  video.classList.add("visible");
  $("videoPlaceholder").classList.add("hidden");
  video.play().catch(() => {});
}
function makePeer() {
  pc = new RTCPeerConnection(rtcConfig);
  pc.onicecandidate = event => {
    if (event.candidate) sendSignal("ice", event.candidate.toJSON());
  };
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") setStatus("Conectado", true);
    else if (state === "failed") setStatus("Falha na conexão");
    else if (state === "disconnected") setStatus("Conexão interrompida");
    else if (state === "connecting") setStatus("Conectando…");
  };
  pc.ontrack = event => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    showVideo(stream);
  };
  return pc;
}
async function subscribeRoom(id, host) {
  if (!sb) throw new Error("Configure o Supabase em app.js antes de iniciar.");
  roomId = id;
  isHost = host;
  channel = sb.channel("screenlink-" + id, {
    config: { broadcast: { self: false, ack: true } }
  });
  channel.on("broadcast", { event: "signal" }, async ({ payload }) => {
    // Ignore messages sent by this same browser instance.
    if (!payload || payload.sender === sessionId) return;
    await handleSignal(payload);
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Tempo esgotado ao conectar ao serviço de sinalização.")), 12000);
    channel.subscribe(status => {
      if (status === "SUBSCRIBED") { clearTimeout(timeout); resolve(); }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(timeout); reject(new Error("Não foi possível entrar na sala. Verifique a configuração do Supabase Realtime.")); }
    });
  });
}
const sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
async function sendSignal(type, data = {}) {
  if (!channel) return;
  const result = await channel.send({
    type: "broadcast",
    event: "signal",
    payload: { type, data, sender: sessionId, sentAt: Date.now() }
  });
  if (result !== "ok") console.warn("Sinalização:", result);
}
async function flushCandidates() {
  if (!pc || !remoteDescriptionSet) return;
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of queued) {
    try { await pc.addIceCandidate(candidate); } catch (err) { console.warn("ICE candidate ignorado:", err); }
  }
}
async function handleSignal(message) {
  try {
    if (message.type === "viewer-ready" && isHost) {
      if (!localStream) throw new Error("A captura de tela não está ativa. Encerre a sala e tente novamente.");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal("offer", pc.localDescription);
      setStatus("Aguardando conexão…");
    } else if (message.type === "offer" && !isHost) {
      await pc.setRemoteDescription(message.data);
      remoteDescriptionSet = true;
      await flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal("answer", pc.localDescription);
      setStatus("Conectando…");
    } else if (message.type === "answer" && isHost) {
      await pc.setRemoteDescription(message.data);
      remoteDescriptionSet = true;
      await flushCandidates();
    } else if (message.type === "ice" && message.data) {
      if (remoteDescriptionSet && pc.remoteDescription) {
        try { await pc.addIceCandidate(message.data); } catch (err) { console.warn(err); }
      } else pendingCandidates.push(message.data);
    } else if (message.type === "host-ended" && !isHost) {
      stopRoom("A pessoa que transmitia encerrou a sala.");
    }
  } catch (err) {
    console.error(err);
    toast(err.message || "Não foi possível negociar a conexão.");
    setStatus("Erro na conexão");
  }
}
async function createRoom() {
  if (!supabaseConfigured) {
    $("configWarning").classList.remove("hidden");
    toast("Configure o Supabase em app.js para ativar as salas.");
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("Seu navegador não suporta captura de tela. Use uma versão atual do Chrome, Edge ou Firefox.");
    return;
  }
  try {
    // getDisplayMedia must run directly from the user's click gesture.
    // Asking for capture later from a Realtime callback is rejected by browsers.
    try {
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: true
      });
    } catch (err) {
      if (err.name === "NotAllowedError") throw err;
      localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      toast("Seu navegador não disponibilizou áudio do sistema; a tela será transmitida sem áudio.");
    }
    const id = randomRoom();
    showRoom(id, true);
    showVideo(localStream);
    setStatus("Criando sala…");
    await subscribeRoom(id, true);
    makePeer();
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
      track.onended = () => stopRoom("O compartilhamento de tela foi encerrado.");
    });
    $("audioBtn").disabled = !localStream.getAudioTracks().length;
    $("audioBtn").textContent = localStream.getAudioTracks().length ? "♫ Áudio incluído" : "♫ Sem áudio do sistema";
    const url = roomUrl(id);
    history.replaceState({}, "", url);
    setStatus("Aguardando espectador");
    await navigator.clipboard?.writeText(url).catch(() => {});
    toast("Sala criada. O link está pronto para compartilhar.");
  } catch (err) {
    console.error(err);
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    if (pc) { pc.close(); pc = null; }
    if (channel && sb) { try { await sb.removeChannel(channel); } catch (_) {} channel = null; }
    $("screenVideo").srcObject = null;
    $("screenVideo").classList.remove("visible");
    $("videoPlaceholder").classList.remove("hidden");
    $("room").classList.add("hidden");
    $("setup").classList.remove("hidden");
    toast(err.message || "Não foi possível criar a sala.");
    setStatus("Erro ao criar sala");
  }
}
async function joinRoom(id) {
  if (!supabaseConfigured) {
    $("configWarning").classList.remove("hidden");
    toast("Configure o Supabase em app.js para ativar as salas.");
    return;
  }
  const cleanId = (id || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (cleanId.length !== 6) { toast("Digite um código de sala válido com 6 caracteres."); return; }
  try {
    showRoom(cleanId, false);
    setStatus("Entrando na sala…");
    await subscribeRoom(cleanId, false);
    makePeer();
    history.replaceState({}, "", roomUrl(cleanId));
    await sendSignal("viewer-ready");
    setStatus("Aguardando transmissão");
  } catch (err) {
    console.error(err);
    toast(err.message || "Não foi possível entrar na sala.");
    setStatus("Erro ao entrar");
  }
}
async function stopRoom(message = "Sala encerrada.") {
  if (isHost && channel) await sendSignal("host-ended");
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  if (pc) { pc.close(); pc = null; }
  if (channel && sb) { try { await sb.removeChannel(channel); } catch (_) {} channel = null; }
  localStream = null;
  pendingCandidates = [];
  remoteDescriptionSet = false;
  $("screenVideo").srcObject = null;
  $("screenVideo").classList.remove("visible");
  $("videoPlaceholder").classList.remove("hidden");
  $("audioBtn").disabled = true;
  $("setup").classList.remove("hidden");
  $("room").classList.add("hidden");
  history.replaceState({}, "", location.pathname);
  toast(message);
}
$("hostTab").addEventListener("click", () => setMode("host"));
$("watchTab").addEventListener("click", () => setMode("watch"));
$("createBtn").addEventListener("click", createRoom);
$("joinBtn").addEventListener("click", () => joinRoom($("roomInput").value));
$("roomInput").addEventListener("keydown", e => { if (e.key === "Enter") joinRoom($("roomInput").value); });
$("copyBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(roomUrl(roomId)); toast("Link copiado!"); }
  catch (_) { prompt("Copie o link da sala:", roomUrl(roomId)); }
});
$("stopBtn").addEventListener("click", () => stopRoom());
$("audioBtn").addEventListener("click", () => toast("O áudio do sistema é capturado quando o navegador permite e você seleciona essa opção ao compartilhar."));
const initialRoom = new URLSearchParams(location.search).get("room");
if (initialRoom) { setMode("watch"); $("roomInput").value = initialRoom; }
if (!supabaseConfigured) $("configWarning").classList.remove("hidden");
