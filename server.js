// =====================================================================
//  STUDY TABLE — tiny relay server
//  This file does NOT run the game. It only passes messages between the
//  host laptop and the phones in the same room (like a post office).
//  Deploy once on Render (free) and forget about it.
// =====================================================================

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const HOST_GRACE_MS = 5 * 60 * 1000; // keep a room alive 5 min if the host drops

// ---------------------------------------------------------------------
// PART 1 — Plain web page (open it in a browser to "wake up" the server)
// ---------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
  res.end("Study Table relay is awake. Rooms open: " + rooms.size);
});

const wss = new WebSocketServer({ server });

// rooms: code -> { host: ws|null, players: Map<clientId, {ws, name}>, hostGone: timer }
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function newRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  } while (rooms.has(code));
  return code;
}

// ---------------------------------------------------------------------
// PART 2 — Message routing
// ---------------------------------------------------------------------
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // ---- Host opens (or re-opens) a room ----
    if (msg.type === "host") {
      let code = (msg.room || "").toUpperCase();
      let room = rooms.get(code);
      if (!room) {
        code = code && /^[A-Z]{4}$/.test(code) ? code : newRoomCode();
        room = { host: null, players: new Map(), hostGone: null };
        rooms.set(code, room);
      }
      if (room.hostGone) { clearTimeout(room.hostGone); room.hostGone = null; }
      if (room.host && room.host !== ws) { try { room.host.close(); } catch (e) {} }
      room.host = ws;
      ws.role = "host"; ws.room = code;
      send(ws, { type: "hosted", room: code });
      // tell the (re)connected host who is already here
      for (const [clientId, p] of room.players) {
        if (p.ws && p.ws.readyState === 1) send(ws, { type: "player_join", clientId, name: p.name });
      }
      for (const p of room.players.values()) send(p.ws, { type: "host_online" });
      return;
    }

    // ---- Phone joins (or re-joins) a room ----
    if (msg.type === "join") {
      const code = (msg.room || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: "error", msg: "Room " + code + " not found" }); return; }
      const clientId = String(msg.clientId || "").slice(0, 40);
      const name = String(msg.name || "Player").slice(0, 14);
      const old = room.players.get(clientId);
      if (old && old.ws && old.ws !== ws) { old.ws.replaced = true; try { old.ws.close(); } catch (e) {} }
      room.players.set(clientId, { ws, name });
      ws.role = "player"; ws.room = code; ws.clientId = clientId;
      send(ws, { type: "joined", room: code, hostOnline: !!(room.host && room.host.readyState === 1) });
      send(room.host, { type: "player_join", clientId, name });
      return;
    }

    const room = rooms.get(ws.room);
    if (!room) return;

    // ---- Phone -> host ----
    if (msg.type === "to_host" && ws.role === "player") {
      send(room.host, { type: "from_player", clientId: ws.clientId, data: msg.data });
      return;
    }
    // ---- Host -> one phone ----
    if (msg.type === "to_player" && ws.role === "host") {
      const p = room.players.get(msg.clientId);
      if (p) send(p.ws, { type: "from_host", data: msg.data });
      return;
    }
    // ---- Host -> every phone ----
    if (msg.type === "broadcast" && ws.role === "host") {
      for (const p of room.players.values()) send(p.ws, { type: "from_host", data: msg.data });
      return;
    }
    // ---- Host removes a player ----
    if (msg.type === "kick" && ws.role === "host") {
      const p = room.players.get(msg.clientId);
      if (p) { send(p.ws, { type: "kicked" }); room.players.delete(msg.clientId); }
      return;
    }
  });

  // -------------------------------------------------------------------
  // PART 3 — Disconnects
  // -------------------------------------------------------------------
  ws.on("close", () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    if (ws.role === "host" && room.host === ws) {
      room.host = null;
      for (const p of room.players.values()) send(p.ws, { type: "host_offline" });
      room.hostGone = setTimeout(() => {
        for (const p of room.players.values()) send(p.ws, { type: "error", msg: "Room closed" });
        rooms.delete(ws.room);
      }, HOST_GRACE_MS);
    }
    if (ws.role === "player" && !ws.replaced) {
      const p = room.players.get(ws.clientId);
      if (p && p.ws === ws) send(room.host, { type: "player_leave", clientId: ws.clientId });
    }
  });
});

// ---------------------------------------------------------------------
// PART 4 — Keep-alive (drops dead phones, stops idle connections closing)
// ---------------------------------------------------------------------
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 20000);

server.listen(PORT, () => console.log("Study Table relay listening on " + PORT));
