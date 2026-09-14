(function () {
  "use strict";

  var STORE_KEY = "sidepool_session_v2";

  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(n) { return Math.round(n || 0).toLocaleString("en-US"); }
  function shortAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }

  // EIP-1193 personal_sign expects the message as a hex-encoded string —
  // encoding it ourselves (rather than passing raw text) keeps this
  // working across wallets that are strict about the parameter format.
  function hexEncode(str) {
    var bytes = new TextEncoder().encode(str);
    var out = "0x";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  var dom = {
    onlinePill: el("onlinePill"), onlineCount: el("onlineCount"),
    walletBar: el("walletBar"), walletAddress: el("walletAddress"), nicknameInput: el("nicknameInput"),
    balance: el("balanceDisplay"),
    topupBtn: el("topupBtn"), inviteBtn: el("inviteBtn"), resetBtn: el("resetBtn"), disconnectBtn: el("disconnectBtn"),
    toast: el("toast"),
    connectCard: el("connectCard"), connectBtn: el("connectBtn"), connectHint: el("connectHint"),
    qrConnectBtn: el("qrConnectBtn"), qrPanel: el("qrPanel"), qrImage: el("qrImage"),
    qrStatus: el("qrStatus"), qrUri: el("qrUri"), qrSimulateBtn: el("qrSimulateBtn"), qrCancelBtn: el("qrCancelBtn"),
    game: el("game"),
    roundNum: el("roundNum"), phasePill: el("phasePill"), countdownText: el("countdownText"),
    timebar: el("timebar"), splitBar: el("splitBar"),
    sideA: el("sideA"), sideB: el("sideB"),
    playersA: el("playersA"), playersB: el("playersB"),
    poolA: el("poolA"), poolB: el("poolB"),
    multA: el("multA"), multB: el("multB"),
    yourBetA: el("yourBetA"), yourBetB: el("yourBetB"),
    backA: el("backA"), backB: el("backB"),
    stakeRow: el("stakeRow"), stakeInput: el("stakeInput"), maxStakeBtn: el("maxStakeBtn"),
    autoplayStatus: el("autoplayStatus"), resultBanner: el("resultBanner"),
    apSideA: el("apSideA"), apSideB: el("apSideB"), apStake: el("apStake"), apRounds: el("apRounds"), apToggle: el("apToggle"),
    historyBody: el("historyBody")
  };

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { saved = null; }

  // `session` is the proof-of-wallet token from /api/verify; `me` is the
  // player record the server sends back once that token is accepted.
  var session = saved && saved.token && saved.address ? saved : null;
  var me = null;
  var round = null;
  var yourBet = null;
  var history = [];
  var toastTimer = null;

  function persistSession() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(session)); } catch (e) { /* ignore */ }
  }
  function clearSession() {
    session = null;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  }

  function showToast(msg, tone) {
    dom.toast.textContent = msg;
    dom.toast.className = "toast" + (tone === "good" ? "" : "");
    dom.toast.hidden = false;
    dom.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.hidden = true; }, 3600);
  }

  // ---------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------
  var ws = null;
  var reconnectDelay = 1000;

  function wsUrl() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/ws";
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    ws.addEventListener("open", function () {
      reconnectDelay = 1000;
      if (session) ws.send(JSON.stringify({ type: "hello", token: session.token }));
    });
    ws.addEventListener("message", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(msg);
    });
    ws.addEventListener("close", function () {
      dom.onlinePill.hidden = true;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
    });
    ws.addEventListener("error", function () { try { ws.close(); } catch (e) {} });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "welcome":
        me = msg.player;
        round = msg.round;
        yourBet = msg.yourBet;
        history = (msg.history || []).map(function (h) { return Object.assign({ yours: null }, h); });
        dom.onlineCount.textContent = msg.online;
        dom.onlinePill.hidden = false;
        showApp();
        renderAll();
        break;
      case "authRequired":
        clearSession();
        me = null;
        showConnectCard("Your session expired — connect your wallet again.");
        break;
      case "state":
        round = msg.round;
        yourBet = msg.yourBet;
        renderAll();
        break;
      case "playerUpdate":
        me.balance = msg.player.balance;
        me.autoplay = msg.player.autoplay;
        renderWallet();
        renderAutoplayControls();
        renderAll();
        break;
      case "roundSettled":
        round = msg.round;
        if (typeof msg.balance === "number") me.balance = msg.balance;
        history.unshift({
          round: round.id, poolA: msg.result.poolA, poolB: msg.result.poolB,
          winner: msg.result.voided ? "void" : msg.result.winner, mult: msg.result.mult, voided: msg.result.voided,
          yours: msg.yours
        });
        if (history.length > 40) history.length = 40;
        showResult(msg.result, msg.yours);
        renderAll();
        break;
      case "autoplayStopped":
        showToast(msg.reason === "finished" ? "Autoplay finished." : "Autoplay stopped — insufficient balance.");
        break;
      case "presence":
        dom.onlineCount.textContent = msg.online;
        break;
      case "error":
        showToast(msg.message);
        break;
    }
  }

  // ---------------------------------------------------------------
  // Wallet connect flow (sign-in-with-Ethereum style)
  // ---------------------------------------------------------------
  function showApp() {
    dom.connectCard.hidden = true;
    dom.walletBar.hidden = false;
    dom.game.hidden = false;
  }
  function showConnectCard(hint) {
    dom.walletBar.hidden = true;
    dom.game.hidden = true;
    dom.connectCard.hidden = false;
    dom.connectBtn.disabled = false;
    dom.connectBtn.textContent = "Connect Wallet";
    pendingSimulation = null;
    dom.qrPanel.hidden = true;
    dom.connectCard.querySelector(".join-row").hidden = false;
    if (hint) {
      dom.connectHint.textContent = hint;
      dom.connectHint.hidden = false;
    } else {
      dom.connectHint.hidden = true;
    }
  }

  dom.connectBtn.addEventListener("click", function () { connectWallet(); });

  // Shared by the real wallet flow and the simulated QR flow — both end the
  // same way: an address + a signature over the server's challenge message,
  // handed to /api/verify.
  function verifyAndConnect(address, signature) {
    return fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: address, signature: signature })
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || "Signature verification failed.");
        session = { token: res.data.token, address: address };
        persistSession();
        if (ws && ws.readyState === WebSocket.OPEN) {
          send({ type: "hello", token: session.token });
        }
      });
  }

  function connectWallet() {
    if (!window.ethereum) {
      dom.connectHint.textContent = "No wallet found in this browser — install MetaMask (or another browser wallet extension), then reload.";
      dom.connectHint.hidden = false;
      return;
    }
    dom.connectBtn.disabled = true;
    dom.connectBtn.textContent = "Check your wallet…";

    window.ethereum.request({ method: "eth_requestAccounts" })
      .then(function (accounts) {
        var address = (accounts && accounts[0] ? accounts[0] : "").toLowerCase();
        if (!address) throw new Error("No account was returned by the wallet.");
        return fetch("/api/nonce?address=" + encodeURIComponent(address))
          .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.data.error || "Could not start a sign-in request.");
            dom.connectBtn.textContent = "Confirm the signature in your wallet…";
            return window.ethereum.request({
              method: "personal_sign",
              params: [hexEncode(res.data.message), address]
            });
          })
          .then(function (signature) { return verifyAndConnect(address, signature); });
      })
      .catch(function (err) {
        var msg = err && err.code === 4001 ? "Connection request was rejected." : (err && err.message) || "Wallet connection failed.";
        showConnectCard(msg);
      });
  }

  // ---------------------------------------------------------------
  // Simulated QR / mobile-wallet connect (demo only)
  // ---------------------------------------------------------------
  var pendingSimulation = null;

  dom.qrConnectBtn.addEventListener("click", function () {
    dom.qrConnectBtn.disabled = true;
    dom.qrConnectBtn.textContent = "Generating code…";
    fetch("/api/simulate/start")
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || "Could not start the simulated connect.");
        pendingSimulation = res.data;
        dom.qrImage.src = res.data.qrDataUrl;
        dom.qrUri.textContent = res.data.wcUri;
        dom.qrStatus.textContent = "Waiting for a mobile wallet to scan this code…";
        dom.connectCard.querySelector(".join-row").hidden = true;
        dom.qrPanel.hidden = false;
      })
      .catch(function (err) {
        showConnectCard((err && err.message) || "Could not start the simulated connect.");
      })
      .finally(function () {
        dom.qrConnectBtn.disabled = false;
        dom.qrConnectBtn.textContent = "Connect via QR code";
      });
  });

  dom.qrSimulateBtn.addEventListener("click", function () {
    if (!pendingSimulation) return;
    dom.qrSimulateBtn.disabled = true;
    dom.qrStatus.textContent = "Scan received — verifying signature…";
    verifyAndConnect(pendingSimulation.address, pendingSimulation.signature)
      .catch(function (err) {
        showConnectCard((err && err.message) || "Simulated connect failed.");
      })
      .finally(function () {
        pendingSimulation = null;
        dom.qrSimulateBtn.disabled = false;
      });
  });

  dom.qrCancelBtn.addEventListener("click", function () {
    pendingSimulation = null;
    dom.qrPanel.hidden = true;
    dom.connectCard.querySelector(".join-row").hidden = false;
  });

  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on("accountsChanged", function (accounts) {
      var newAddr = accounts && accounts[0] ? accounts[0].toLowerCase() : null;
      if (session && (!newAddr || newAddr !== session.address)) {
        clearSession();
        me = null;
        showConnectCard(newAddr ? "Wallet account changed — connect again to sign in as the new address." : "Wallet disconnected.");
      }
    });
  }

  // ---------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------
  dom.backA.addEventListener("click", function () { placeBet("A"); });
  dom.backB.addEventListener("click", function () { placeBet("B"); });
  dom.maxStakeBtn.addEventListener("click", function () { dom.stakeInput.value = me ? me.balance : 0; });
  dom.topupBtn.addEventListener("click", function () { send({ type: "topup" }); });
  dom.resetBtn.addEventListener("click", function () { send({ type: "resetBalance" }); });
  dom.disconnectBtn.addEventListener("click", function () {
    clearSession();
    me = null;
    round = null;
    yourBet = null;
    history = [];
    showConnectCard(null);
  });
  dom.nicknameInput.addEventListener("change", function () {
    var name = dom.nicknameInput.value.trim().slice(0, 24);
    if (name) send({ type: "setName", name: name });
  });
  dom.nicknameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") dom.nicknameInput.blur(); });
  dom.inviteBtn.addEventListener("click", function () {
    var url = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        showToast("Invite link copied — send it to whoever's joining.");
      }, function () { showToast("Couldn't copy automatically — the link is " + url); });
    } else {
      showToast("Copy this link: " + url);
    }
  });

  function placeBet(side) {
    if (!round || round.phase !== "open" || yourBet || (me.autoplay && me.autoplay.active)) return;
    var amount = Math.floor(Number(dom.stakeInput.value));
    if (!amount || amount < 1) return;
    send({ type: "placeBet", side: side, amount: amount });
  }

  dom.apSideA.addEventListener("click", function () { setApSide("A"); });
  dom.apSideB.addEventListener("click", function () { setApSide("B"); });
  var apSideChoice = "A";
  function setApSide(side) {
    apSideChoice = side;
    dom.apSideA.classList.toggle("on", side === "A");
    dom.apSideB.classList.toggle("on", side === "B");
  }

  dom.apToggle.addEventListener("click", function () {
    if (me.autoplay && me.autoplay.active) {
      send({ type: "setAutoplay", active: false });
      return;
    }
    var stake = Math.max(1, Math.floor(Number(dom.apStake.value) || 0));
    var rounds = Math.max(1, Math.floor(Number(dom.apRounds.value) || 0));
    send({ type: "setAutoplay", active: true, side: apSideChoice, stake: stake, rounds: rounds });
  });

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  function renderWallet() {
    if (!me) return;
    dom.walletAddress.textContent = shortAddr(me.address);
    if (document.activeElement !== dom.nicknameInput) {
      dom.nicknameInput.value = me.name && me.name !== shortAddr(me.address) ? me.name : "";
    }
    dom.balance.textContent = fmt(me.balance) + " cr";
  }

  function renderAutoplayControls() {
    if (!me) return;
    var active = me.autoplay && me.autoplay.active;
    dom.apToggle.textContent = active ? "Stop autoplay" : "Start autoplay";
    dom.apToggle.classList.toggle("stop", !!active);
    dom.autoplayStatus.hidden = !active;
    if (active) {
      dom.autoplayStatus.textContent = "Autoplay backing Side " + me.autoplay.side + " for " + fmt(me.autoplay.stake) + " cr — " + me.autoplay.roundsLeft + " round(s) left.";
    }
  }

  function showResult(result, yours) {
    dom.resultBanner.hidden = false;
    if (result.voided) {
      dom.resultBanner.className = "result-banner neutral";
      dom.resultBanner.innerHTML = "Round voided — no stakes landed on the drawn side, stakes refunded.<span class='seed'>seed " + escapeHtml(result.seed) + "</span>";
      return;
    }
    var won = yours && yours.side === result.winner;
    var lost = yours && yours.side !== result.winner;
    dom.resultBanner.className = "result-banner " + (won ? "win" : lost ? "lose" : "neutral");
    var headline = "Side " + result.winner + " wins the pool";
    var sub;
    if (won) sub = "You backed the winning side — paid out " + fmt(yours.payout) + " cr at " + result.mult.toFixed(2) + "x.";
    else if (lost) sub = "You backed Side " + yours.side + " — that stake stays in the pool.";
    else sub = "You sat this round out.";
    dom.resultBanner.innerHTML = headline + "<br>" + sub + "<span class='seed'>seed " + escapeHtml(result.seed) + "</span>";
  }

  function renderAll() {
    if (!round || !me) return;
    renderWallet();
    renderAutoplayControls();

    dom.roundNum.textContent = round.id;
    dom.phasePill.className = "phase-pill phase-" + round.phase;
    dom.phasePill.textContent = round.phase === "open" ? "Open" : round.phase === "locked" ? "Locked" : "Settled";
    if (round.phase !== "reveal") dom.resultBanner.hidden = true;

    var total = round.poolA + round.poolB;
    var pctA = total > 0 ? (round.poolA / total) * 100 : 50;
    var pctB = 100 - pctA;
    dom.splitBar.children[0].style.width = pctA + "%";
    dom.splitBar.children[1].style.width = pctB + "%";
    dom.splitBar.children[0].textContent = total > 0 ? Math.round(pctA) + "%" : "—";
    dom.splitBar.children[1].textContent = total > 0 ? Math.round(pctB) + "%" : "—";

    dom.poolA.textContent = fmt(round.poolA) + " cr";
    dom.poolB.textContent = fmt(round.poolB) + " cr";
    dom.playersA.textContent = round.playersA + (round.playersA === 1 ? " backer" : " backers");
    dom.playersB.textContent = round.playersB + (round.playersB === 1 ? " backer" : " backers");
    dom.multA.textContent = round.poolA > 0 ? "~" + (total / round.poolA).toFixed(2) + "x if A wins" : "First backer sets the pool";
    dom.multB.textContent = round.poolB > 0 ? "~" + (total / round.poolB).toFixed(2) + "x if B wins" : "First backer sets the pool";

    var canBet = round.phase === "open" && !yourBet && !(me.autoplay && me.autoplay.active);
    dom.backA.disabled = !canBet;
    dom.backB.disabled = !canBet;
    dom.stakeRow.style.opacity = canBet ? "1" : ".55";
    dom.stakeInput.disabled = !canBet;
    dom.maxStakeBtn.disabled = !canBet;

    dom.sideA.classList.toggle("picked", !!yourBet && yourBet.side === "A");
    dom.sideB.classList.toggle("picked", !!yourBet && yourBet.side === "B");
    dom.yourBetA.hidden = !(yourBet && yourBet.side === "A");
    dom.yourBetB.hidden = !(yourBet && yourBet.side === "B");
    if (yourBet && yourBet.side === "A") dom.yourBetA.textContent = "You: " + fmt(yourBet.amount) + " cr";
    if (yourBet && yourBet.side === "B") dom.yourBetB.textContent = "You: " + fmt(yourBet.amount) + " cr";

    renderHistory();
  }

  function renderHistory() {
    if (!history.length) {
      dom.historyBody.innerHTML = "<tr class='empty-row'><td colspan='7'>No rounds settled yet — the first result lands in a few seconds.</td></tr>";
      return;
    }
    var rows = history.slice(0, 12).map(function (h) {
      var youCell = h.yours ? (fmt(h.yours.amount) + " cr on " + h.yours.side) : "—";
      var youClass = h.yours ? (h.yours.side === "A" ? "you-a" : "you-b") : "";
      var payoutCell = h.yours ? (h.yours.payout > 0 ? "+" + fmt(h.yours.payout) + " cr" : "0 cr") : "—";
      var payoutClass = h.yours ? (h.yours.payout > 0 ? "pnl-pos" : (h.winner !== "void" ? "pnl-neg" : "")) : "";
      var winnerLabel = h.winner === "void" ? "Void" : "Side " + h.winner;
      return "<tr>" +
        "<td class='mono'>#" + h.round + "</td>" +
        "<td class='mono'>" + fmt(h.poolA) + "</td>" +
        "<td class='mono'>" + fmt(h.poolB) + "</td>" +
        "<td>" + winnerLabel + "</td>" +
        "<td class='mono'>" + (h.mult ? h.mult.toFixed(2) + "x" : "—") + "</td>" +
        "<td class='mono " + youClass + "'>" + youCell + "</td>" +
        "<td class='mono " + payoutClass + "'>" + payoutCell + "</td>" +
        "</tr>";
    }).join("");
    dom.historyBody.innerHTML = rows;
  }

  // ---------------------------------------------------------------
  // Local countdown ticker (server only pushes on phase change)
  // ---------------------------------------------------------------
  setInterval(function () {
    if (!round) return;
    var remaining = round.phaseEnds - Date.now();
    var secs = Math.max(0, Math.ceil(remaining / 1000));
    dom.countdownText.textContent = secs + "s";
    var totalMs = round.phase === "open" ? 14000 : round.phase === "locked" ? 2200 : 4200;
    var pct = Math.max(0, Math.min(100, (remaining / totalMs) * 100));
    dom.timebar.className = "timebar" + (round.phase === "locked" ? " locked" : round.phase === "reveal" ? " reveal" : "");
    dom.timebar.firstElementChild.style.width = pct + "%";
  }, 200);

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  connect();
})();
