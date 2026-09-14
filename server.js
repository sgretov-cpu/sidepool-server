"use strict";

/**
 * Sidepool — public multiplayer prototype of a pooled binary ("Versus")
 * betting round. Balances are shown as virtual USDT for realism, but
 * every unit is fake, free to top up, and moves no real funds — no real
 * crypto or blockchain is involved yet. Winner is decided by momentum:
 * whichever side holds the larger pool when betting locks wins and
 * splits the total pool proportionally; a tied or empty round voids and
 * refunds everyone. One authoritative game loop lives on this server;
 * every connected browser is a thin client synced over WebSocket.
 */

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");
const { verifyMessage, Wallet } = require("ethers");
const QRCode = require("qrcode");

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "state.json");
const SAVE_INTERVAL_MS = 15000;
const TICK_MS = 500;

const OPEN_MS = 14000;
const LOCK_MS = 2200;
const REVEAL_MS = 4200;

const STARTING_BALANCE = 1000;
const TOPUP_AMOUNT = 500;
const TOPUP_COOLDOWN_MS = 5000;
const MAX_NAME_LEN = 24;
const MAX_HISTORY = 200;
const HISTORY_SENT_TO_CLIENT = 12;
const KEEP_ROUND_DETAIL = 5; // how many past rounds' bet breakdowns we retain in memory

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// Lets the connect screen demo a QR-code / mobile-wallet-style flow with no
// real wallet on the other end. Off switch for whenever this stops being a
// prototype: set SIMULATE_WALLET_ENABLED=false in the environment.
const SIMULATE_WALLET_ENABLED = process.env.SIMULATE_WALLET_ENABLED !== "false";

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
/**
 * Players are keyed by lowercased wallet address — the wallet IS the
 * account, there is no separate signup. `id` mirrors `address` (kept as
 * a field so the rest of the game logic doesn't care how identity works).
 * @type {Map<string, {id:string,address:string,name:string,balance:number,createdAt:number,lastTopupAt:number,autoplay:{active:boolean,side:string,stake:number,roundsLeft:number}}>}
 */
const players = new Map();
let history = []; // settled round summaries, newest first
let roundCounter = 0;
let round = null; // current live round
let botTimers = [];
let dirty = false;

/** address(lowercase) -> {nonce, message, expiresAt} — one pending sign-in message per address. */
const nonces = new Map();
/** opaque session token -> {address, expiresAt} — stands in for "logged in" after a verified signature. */
const sessions = new Map();

function markDirty() { dirty = true; }

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.players)) {
      for (const p of parsed.players) {
        if (p && typeof p.id === "string") {
          const address = typeof p.address === "string" ? p.address : p.id;
          players.set(p.id, {
            id: p.id,
            address,
            name: typeof p.name === "string" ? p.name : shortAddr(address),
            balance: typeof p.balance === "number" ? p.balance : STARTING_BALANCE,
            createdAt: p.createdAt || Date.now(),
            lastTopupAt: p.lastTopupAt || 0,
            autoplay: p.autoplay && typeof p.autoplay === "object"
              ? { active: false, side: p.autoplay.side === "B" ? "B" : "A", stake: p.autoplay.stake || 50, roundsLeft: 0 }
              : { active: false, side: "A", stake: 50, roundsLeft: 0 },
          });
        }
      }
    }
    if (Array.isArray(parsed.history)) history = parsed.history.slice(0, MAX_HISTORY);
    if (typeof parsed.roundCounter === "number") roundCounter = parsed.roundCounter;
    console.log(`Loaded state: ${players.size} player(s), ${history.length} past round(s).`);
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("Could not load saved state:", e.message);
  }
}

function saveState() {
  if (!dirty) return;
  const payload = {
    players: Array.from(players.values()),
    history,
    roundCounter,
  };
  fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, () => {
    fs.writeFile(DATA_FILE, JSON.stringify(payload), (err) => {
      if (err) console.warn("Could not save state:", err.message);
      else dirty = false;
    });
  });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(/[<>&"'`]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, MAX_NAME_LEN);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Momentum/majority model: whichever side holds the larger pool when
// betting locks is declared the winner. A tie (or an empty round) has no
// majority, so it voids and every stake is refunded rather than assigning
// a winner. This intentionally replaces a random draw — the outcome is a
// function of where the crowd's money actually went, not chance.
function decideWinner(poolA, poolB) {
  if (poolA === poolB) return null;
  return poolA > poolB ? "A" : "B";
}

function publicPlayer(p) {
  return { id: p.id, address: p.address, name: p.name, balance: p.balance, autoplay: p.autoplay };
}

function shortAddr(a) {
  return typeof a === "string" && a.length > 10 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
}

function newPlayer(address) {
  return {
    id: address,
    address,
    name: shortAddr(address),
    balance: STARTING_BALANCE,
    createdAt: Date.now(),
    lastTopupAt: 0,
    autoplay: { active: false, side: "A", stake: 50, roundsLeft: 0 },
  };
}

function siweMessage(address, nonce, host) {
  return (
    `Sidepool wants you to sign in with your Ethereum account:\n${address}\n\n` +
    `This signature only proves you control this wallet. It is free, sends no ` +
    `transaction, and moves no funds — Sidepool plays with virtual USDT only.\n\n` +
    `URI: ${host}\n` +
    `Version: 1\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${new Date().toISOString()}`
  );
}

function sweepExpired() {
  const now = Date.now();
  for (const [addr, entry] of nonces) if (entry.expiresAt < now) nonces.delete(addr);
  for (const [tok, entry] of sessions) if (entry.expiresAt < now) sessions.delete(tok);
}

function botName(n) {
  const adjectives = ["Quiet", "Brisk", "Lucky", "Steady", "Bold", "Calm", "Sharp", "Wry", "Loose", "Keen"];
  const nouns = ["Otter", "Falcon", "Ember", "Maple", "Comet", "Pebble", "Harbor", "Willow", "Drift", "Lantern"];
  return adjectives[n % adjectives.length] + " " + nouns[(n * 7) % nouns.length];
}

// ---------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------
function clearBotTimers() {
  botTimers.forEach((t) => clearTimeout(t));
  botTimers = [];
}

function addBet(round_, playerId, side, amount, meta = {}) {
  // Players can wager more than once per round, as long as every wager in
  // a round stays on the side they first picked — repeat wagers add to
  // their existing stake rather than opening a second position.
  const existing = round_.bets.get(playerId);
  if (existing) {
    existing.amount += amount;
  } else {
    round_.bets.set(playerId, {
      side,
      amount,
      name: meta.name || "Player",
      isBot: !!meta.isBot,
    });
  }
  if (side === "A") {
    round_.poolA += amount;
    if (!existing) round_.playersA += 1;
  } else {
    round_.poolB += amount;
    if (!existing) round_.playersB += 1;
  }
}

function scheduleBots(round_) {
  const count = randInt(4, 9);
  const skew = 0.3 + Math.random() * 0.4;
  for (let i = 0; i < count; i++) {
    const delay = randInt(500, Math.max(600, OPEN_MS - 800));
    const timer = setTimeout(() => {
      if (!round || round.id !== round_.id || round.phase !== "open") return;
      const side = Math.random() < skew ? "A" : "B";
      const stake = randInt(15, 180);
      addBet(round_, `bot-${round_.id}-${i}`, side, stake, { isBot: true, name: botName(i + round_.id) });
      broadcastRoundState();
    }, delay);
    botTimers.push(timer);
  }
}

function applyAutoplayBets(round_) {
  for (const p of players.values()) {
    if (!p.autoplay || !p.autoplay.active) continue;
    if (p.autoplay.roundsLeft <= 0) {
      stopAutoplay(p, "finished");
      continue;
    }
    if (p.balance < p.autoplay.stake) {
      stopAutoplay(p, "insufficient");
      continue;
    }
    p.balance -= p.autoplay.stake;
    addBet(round_, p.id, p.autoplay.side, p.autoplay.stake, { name: p.name });
    p.autoplay.roundsLeft -= 1;
    markDirty();
    sendPlayerUpdate(p.id);
  }
}

function stopAutoplay(p, reason) {
  p.autoplay.active = false;
  p.autoplay.roundsLeft = 0;
  markDirty();
  sendTo(p.id, { type: "autoplayStopped", reason });
}

function newRound() {
  roundCounter += 1;
  clearBotTimers();
  round = {
    id: roundCounter,
    phase: "open",
    phaseStart: Date.now(),
    phaseEnds: Date.now() + OPEN_MS,
    bets: new Map(),
    poolA: 0,
    poolB: 0,
    playersA: 0,
    playersB: 0,
    settled: null,
  };
  applyAutoplayBets(round);
  scheduleBots(round);
  broadcastRoundState();
}

function settleRound() {
  const total = round.poolA + round.poolB;
  const winner = decideWinner(round.poolA, round.poolB);
  const winnerPool = winner === "A" ? round.poolA : winner === "B" ? round.poolB : 0;
  const voided = winner === null;
  const mult = !voided && winnerPool > 0 ? total / winnerPool : 0;

  const perPlayer = new Map(); // playerId -> {side, amount, payout}
  for (const [pid, bet] of round.bets.entries()) {
    if (bet.isBot) continue;
    const p = players.get(pid);
    if (!p) continue;
    let payout = 0;
    if (voided) {
      payout = bet.amount;
      p.balance += payout;
    } else if (bet.side === winner && winnerPool > 0) {
      payout = Math.round(bet.amount * mult);
      p.balance += payout;
    }
    perPlayer.set(pid, { side: bet.side, amount: bet.amount, payout });
  }

  round.settled = { winner, total, winnerPool, mult, voided };

  history.unshift({
    round: round.id,
    poolA: round.poolA,
    poolB: round.poolB,
    playersA: round.playersA,
    playersB: round.playersB,
    winner: voided ? "void" : winner,
    mult,
    voided,
    settledAt: Date.now(),
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  markDirty();

  return perPlayer;
}

function tick() {
  if (!round) {
    newRound();
    return;
  }
  const now = Date.now();
  if (now < round.phaseEnds) return;

  if (round.phase === "open") {
    round.phase = "locked";
    round.phaseStart = now;
    round.phaseEnds = now + LOCK_MS;
    broadcastRoundState();
  } else if (round.phase === "locked") {
    const perPlayer = settleRound();
    round.phase = "reveal";
    round.phaseStart = now;
    round.phaseEnds = now + REVEAL_MS;
    broadcastSettlement(perPlayer);
  } else {
    newRound();
  }
}

// ---------------------------------------------------------------------
// WebSocket wiring
// ---------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// --- Wallet auth: sign-in-with-Ethereum style, verification only -------
// No transaction is ever requested and no funds move. A verified
// signature just proves control of the address, which becomes the
// player's identity (there is no separate account/signup).
app.get("/api/nonce", (req, res) => {
  const address = typeof req.query.address === "string" ? req.query.address.toLowerCase() : "";
  if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: "That doesn't look like a wallet address." });
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = siweMessage(address, nonce, req.get("host"));
  nonces.set(address, { nonce, message, expiresAt: Date.now() + NONCE_TTL_MS });
  res.json({ message });
});

app.post("/api/verify", (req, res) => {
  const address = typeof req.body.address === "string" ? req.body.address.toLowerCase() : "";
  const signature = typeof req.body.signature === "string" ? req.body.signature : "";
  if (!ADDRESS_RE.test(address) || !signature) {
    return res.status(400).json({ error: "Missing wallet address or signature." });
  }
  const entry = nonces.get(address);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(400).json({ error: "That sign-in request expired — connect again to get a fresh one." });
  }
  let recovered;
  try {
    recovered = verifyMessage(entry.message, signature).toLowerCase();
  } catch (e) {
    return res.status(400).json({ error: "Couldn't verify that signature." });
  }
  if (recovered !== address) {
    return res.status(401).json({ error: "Signature doesn't match the wallet address." });
  }
  nonces.delete(address); // single use

  let p = players.get(address);
  if (!p) {
    p = newPlayer(address);
    players.set(address, p);
    markDirty();
  }

  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { address, expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ token, player: publicPlayer(p) });
});

// --- Simulated QR / mobile-wallet connect (demo only, no real wallet) --
// Mirrors what a WalletConnect-style QR flow feels like without pulling in
// the real SDK (which needs a paid-for project ID). A throwaway wallet is
// generated and signs its own sign-in message server-side, standing in for
// "the phone that scanned the code" — the browser then runs that address +
// signature through the exact same /api/verify path a real wallet would.
// Nothing here is a real wallet, a real relay, or a real signature from the
// visitor; it just proves the rest of the pipeline end to end.
app.get("/api/simulate/start", async (req, res) => {
  if (!SIMULATE_WALLET_ENABLED) {
    return res.status(404).json({ error: "Simulated connect is disabled on this deployment." });
  }
  try {
    const wallet = Wallet.createRandom();
    const address = wallet.address.toLowerCase();
    const nonce = crypto.randomBytes(16).toString("hex");
    const message = siweMessage(address, nonce, req.get("host"));
    nonces.set(address, { nonce, message, expiresAt: Date.now() + NONCE_TTL_MS });
    const signature = await wallet.signMessage(message);

    // Cosmetic only — shaped like a real WalletConnect URI so the QR code
    // looks right, but nothing is listening on the other end of it.
    const topic = crypto.randomBytes(32).toString("hex");
    const symKey = crypto.randomBytes(32).toString("hex");
    const wcUri = `wc:${topic}@2?relay-protocol=irn&symKey=${symKey}`;
    const qrDataUrl = await QRCode.toDataURL(wcUri, { margin: 1, width: 280 });

    res.json({ address, signature, wcUri, qrDataUrl });
  } catch (e) {
    res.status(500).json({ error: "Could not prepare a simulated connection." });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** ws -> playerId */
const socketPlayer = new Map();
/** playerId -> Set<ws> (a player may have several tabs open) */
const playerSockets = new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

function sendTo(playerId, obj) {
  const set = playerSockets.get(playerId);
  if (!set) return;
  for (const ws of set) send(ws, obj);
}

function broadcastAllExcept(obj) {
  wss.clients.forEach((ws) => send(ws, obj));
}

function onlineCount() {
  return playerSockets.size;
}

function broadcastPresence() {
  broadcastAllExcept({ type: "presence", online: onlineCount() });
}

function roundPublicFields() {
  if (!round) return null;
  return {
    id: round.id,
    phase: round.phase,
    phaseEnds: round.phaseEnds,
    poolA: round.poolA,
    poolB: round.poolB,
    playersA: round.playersA,
    playersB: round.playersB,
  };
}

function broadcastRoundState() {
  const base = roundPublicFields();
  wss.clients.forEach((ws) => {
    const pid = socketPlayer.get(ws);
    const mine = pid && round ? round.bets.get(pid) : null;
    send(ws, {
      type: "state",
      round: base,
      yourBet: mine && !mine.isBot ? { side: mine.side, amount: mine.amount } : null,
    });
  });
}

function sendPlayerUpdate(playerId) {
  const p = players.get(playerId);
  if (!p) return;
  sendTo(playerId, { type: "playerUpdate", player: publicPlayer(p) });
}

function broadcastSettlement(perPlayer) {
  const base = roundPublicFields();
  const s = round.settled;
  wss.clients.forEach((ws) => {
    const pid = socketPlayer.get(ws);
    const mine = pid ? perPlayer.get(pid) : null;
    const p = pid ? players.get(pid) : null;
    send(ws, {
      type: "roundSettled",
      round: base,
      result: {
        winner: s.winner,
        mult: s.mult,
        voided: s.voided,
        poolA: round.poolA,
        poolB: round.poolB,
      },
      yours: mine || null,
      balance: p ? p.balance : undefined,
    });
  });
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;
    handleMessage(ws, msg);
  });

  ws.on("close", () => {
    const pid = socketPlayer.get(ws);
    socketPlayer.delete(ws);
    if (pid) {
      const set = playerSockets.get(pid);
      if (set) {
        set.delete(ws);
        if (set.size === 0) playerSockets.delete(pid);
      }
    }
    broadcastPresence();
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case "hello": {
      const token = typeof msg.token === "string" ? msg.token : null;
      const session = token ? sessions.get(token) : null;
      if (!session || session.expiresAt < Date.now()) {
        if (token) sessions.delete(token);
        return send(ws, { type: "authRequired" });
      }
      const address = session.address;
      let p = players.get(address);
      if (!p) {
        p = newPlayer(address);
        players.set(address, p);
        markDirty();
      }
      const nickname = sanitizeName(msg.name);
      if (nickname && nickname !== p.name) {
        p.name = nickname;
        markDirty();
      }
      socketPlayer.set(ws, address);
      if (!playerSockets.has(address)) playerSockets.set(address, new Set());
      playerSockets.get(address).add(ws);

      const mine = round ? round.bets.get(address) : null;
      send(ws, {
        type: "welcome",
        player: publicPlayer(p),
        round: roundPublicFields(),
        yourBet: mine && !mine.isBot ? { side: mine.side, amount: mine.amount } : null,
        history: history.slice(0, HISTORY_SENT_TO_CLIENT),
        online: onlineCount(),
      });
      broadcastPresence();
      break;
    }

    case "setName": {
      const pid = socketPlayer.get(ws);
      const p = pid && players.get(pid);
      if (!p) return;
      const name = sanitizeName(msg.name);
      if (!name) return;
      p.name = name;
      markDirty();
      sendPlayerUpdate(pid);
      break;
    }

    case "placeBet": {
      const pid = socketPlayer.get(ws);
      const p = pid && players.get(pid);
      if (!p) return send(ws, { type: "error", message: "Not connected yet — try again." });
      if (!round || round.phase !== "open") return send(ws, { type: "error", message: "This round is no longer open for bets." });
      const side = msg.side === "B" ? "B" : msg.side === "A" ? "A" : null;
      if (!side) return send(ws, { type: "error", message: "Pick Side A or Side B." });
      // Multiple wagers per round are allowed, but every wager in a round
      // has to stay on the side you first picked — no switching mid-round.
      const existingBet = round.bets.get(pid);
      if (existingBet && existingBet.side !== side) {
        return send(ws, { type: "error", message: `You're already backing Side ${existingBet.side} this round — add more there, or wait for the next round to switch.` });
      }
      let amount = Math.floor(Number(msg.amount));
      if (!Number.isFinite(amount) || amount < 1) return send(ws, { type: "error", message: "Enter a stake of at least 1 USDT." });
      if (amount > p.balance) amount = p.balance;
      if (amount < 1) return send(ws, { type: "error", message: "You're out of USDT — top up first." });
      p.balance -= amount;
      addBet(round, pid, side, amount, { name: p.name });
      markDirty();
      sendPlayerUpdate(pid);
      broadcastRoundState();
      break;
    }

    case "topup": {
      const pid = socketPlayer.get(ws);
      const p = pid && players.get(pid);
      if (!p) return;
      const now = Date.now();
      if (now - p.lastTopupAt < TOPUP_COOLDOWN_MS) {
        return send(ws, { type: "error", message: "Give it a moment before topping up again." });
      }
      p.lastTopupAt = now;
      p.balance += TOPUP_AMOUNT;
      markDirty();
      sendPlayerUpdate(pid);
      break;
    }

    case "resetBalance": {
      const pid = socketPlayer.get(ws);
      const p = pid && players.get(pid);
      if (!p) return;
      p.balance = STARTING_BALANCE;
      p.autoplay = { active: false, side: "A", stake: 50, roundsLeft: 0 };
      markDirty();
      sendPlayerUpdate(pid);
      break;
    }

    case "setAutoplay": {
      const pid = socketPlayer.get(ws);
      const p = pid && players.get(pid);
      if (!p) return;
      if (msg.active === false) {
        p.autoplay.active = false;
        p.autoplay.roundsLeft = 0;
        markDirty();
        sendPlayerUpdate(pid);
        return;
      }
      const side = msg.side === "B" ? "B" : "A";
      const stake = Math.max(1, Math.floor(Number(msg.stake) || 0));
      const rounds = Math.max(1, Math.min(200, Math.floor(Number(msg.rounds) || 0)));
      p.autoplay = { active: true, side, stake, roundsLeft: rounds };
      markDirty();
      sendPlayerUpdate(pid);
      if (round && round.phase === "open" && !round.bets.has(pid) && p.balance >= stake) {
        p.balance -= stake;
        addBet(round, pid, side, stake, { name: p.name });
        p.autoplay.roundsLeft -= 1;
        markDirty();
        sendPlayerUpdate(pid);
        broadcastRoundState();
      }
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
loadState();
setInterval(tick, TICK_MS);
setInterval(saveState, SAVE_INTERVAL_MS);
setInterval(sweepExpired, 10 * 60 * 1000);

process.on("SIGTERM", () => { dirty = true; saveState(); process.exit(0); });
process.on("SIGINT", () => { dirty = true; saveState(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`Sidepool server listening on port ${PORT}`);
});
