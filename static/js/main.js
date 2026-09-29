/* BAR 76 — router, socket wiring, lobby + roulette HUD, chat. */
(function () {
  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ["websocket", "polling"] });
  window.socket = socket;

  const App = {
    sid: null,
    code: null,
    game: null,
    host: null,
    members: [],
    isHost() { return App.sid && App.sid === App.host; },
  };
  window.App = App;

  let pendingGame = null;
  let rlInited = false;

  // ---------- name persistence ----------
  const savedName = localStorage.getItem("bar76_name") || "";
  $("playerName").value = savedName;
  $("playerName").addEventListener("input", () =>
    localStorage.setItem("bar76_name", $("playerName").value.trim()));
  function myName() { return ($("playerName").value.trim() || "Stranger").slice(0, 16); }

  // ---------- screen routing ----------
  function showScreen(name) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $("screen-" + name).classList.add("active");
    const multiplayer = name === "roulette" || name === "poker";
    $("chat-dock").classList.toggle("hidden", !multiplayer);

    if (name === "roulette") {
      requestAnimationFrame(() => {
        if (!rlInited && window.RL) { window.RL.init($("rl-canvas")); rlInited = true; }
        if (window.RL) window.RL.show();
      });
    } else if (window.RL) {
      window.RL.hide();
    }

    if (name === "blackjack") window.Blackjack.reset();
  }
  window.showScreen = showScreen;

  // ---------- toast ----------
  let toastT = null;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- flash big text ----------
  function flash(elId, text, color) {
    const el = $(elId);
    el.textContent = text;
    el.style.color = color || "#fff";
    el.style.textShadow = `0 0 30px ${color || "#fff"}`;
    el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
  }

  // ---------- home cards ----------
  document.querySelectorAll(".gcard").forEach((c) => {
    c.addEventListener("click", () => {
      const game = c.dataset.game;
      if (game === "blackjack") { showScreen("blackjack"); return; }
      pendingGame = game;
      $("modalTitle").textContent = game === "roulette" ? "Russian Roulette" : "Texas Hold'em";
      $("joinCode").value = "";
      $("modal").classList.remove("hidden");
    });
  });
  $("modal").querySelector("[data-close]").addEventListener("click", () => $("modal").classList.add("hidden"));
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("modal").classList.add("hidden"); });

  $("btnHost").addEventListener("click", () => {
    socket.emit("create_room", { name: myName(), game: pendingGame });
    $("modal").classList.add("hidden");
  });
  $("btnJoin").addEventListener("click", () => {
    const code = $("joinCode").value.trim().toUpperCase();
    if (code.length !== 4) { toast("Enter a 4-letter code"); return; }
    socket.emit("join_room", { name: myName(), code });
    $("modal").classList.add("hidden");
  });

  // ---------- leave buttons ----------
  document.querySelectorAll("[data-leave]").forEach((b) =>
    b.addEventListener("click", () => {
      socket.emit("leave_table");
      App.code = null; App.game = null;
      showScreen("home");
    }));

  // ---------- socket: connection ----------
  socket.on("connected", (d) => { App.sid = d.sid; if (window.Poker) window.Poker.setSid(d.sid); });
  socket.on("connect", () => { /* reconnect noop */ });
  socket.on("error_msg", (d) => toast(d.msg || "Something went wrong"));

  socket.on("joined", (d) => {
    App.code = d.code; App.game = d.game; App.sid = d.sid;
    if (window.Poker) window.Poker.setSid(d.sid);
    showScreen(d.game);
    if (d.game === "roulette") $("rl-code").textContent = d.code;
    if (d.game === "poker") $("pk-code").textContent = d.code;
  });
  socket.on("left", () => showScreen("home"));

  socket.on("room_update", (r) => {
    App.host = r.host; App.members = r.members; App.game = r.game;
    renderChat(r.chat);
    if (r.game === "roulette") renderRouletteHud();
    // poker controls depend on host — re-render handled by poker_state; nudge:
    if (r.game === "poker" && lastPoker) window.Poker.render(lastPoker);
  });

  // ---------- ROULETTE ----------
  let rlState = null;
  socket.on("roulette_state", (st) => { rlState = st; renderRouletteHud(); });
  socket.on("roulette_fx", (fx) => {
    if (window.RL) window.RL.onFx(fx);
    if (fx.type === "bang") flash("rl-flash", "BANG!", "#e2404a");
    else if (fx.type === "click") flash("rl-flash", "*click*", "#28e0d0");
    else if (fx.type === "win") flash("rl-flash", "WINNER", "#e9c46a");
  });

  function renderRouletteHud() {
    if (!rlState) return;
    const st = rlState;
    // players
    const pl = $("rl-players"); pl.innerHTML = "";
    st.order.forEach((p) => {
      const div = document.createElement("div");
      div.className = "pl-chip" + (p.alive ? "" : " dead") + (st.turn === p.sid ? " turn" : "");
      div.innerHTML = `<span class="dot"></span><span class="nm">${escapeHtml(p.name)}</span>` +
        (p.sid === App.host ? '<span class="crown">👑</span>' : "");
      pl.appendChild(div);
    });

    const isHost = App.isHost();
    const myTurn = st.turn === App.sid;
    const turnName = (st.order.find((p) => p.sid === st.turn) || {}).name || "";

    // turn banner
    const tb = $("rl-turn");
    if (st.state === "lobby") tb.textContent = "Lobby — waiting to start";
    else if (st.state === "over") tb.textContent = "Round over";
    else tb.textContent = myTurn ? "★ YOUR TURN" : `${turnName}'s turn`;

    // panels
    const hostSetup = $("rl-host-setup"), controls = $("rl-controls"),
      over = $("rl-over"), wait = $("rl-wait");
    [hostSetup, controls, over].forEach((e) => e.classList.add("hidden"));
    wait.classList.add("hidden");

    if (st.state === "lobby") {
      if (isHost) hostSetup.classList.remove("hidden");
      else { wait.classList.remove("hidden"); wait.textContent = "Waiting for host to start…"; }
    } else if (st.state === "over") {
      over.classList.remove("hidden");
      const w = st.winner ? (st.order.find((p) => p.sid === st.winner) || {}).name : "Nobody";
      $("rl-winner").textContent = `🏆 ${w} survives!`;
      $("rl-again").classList.toggle("hidden", !isHost);
    } else {
      if (myTurn) controls.classList.remove("hidden");
      else { wait.classList.remove("hidden"); wait.textContent = `${turnName} is at the table…`; }
    }
  }

  $("rl-start").addEventListener("click", () => {
    socket.emit("roulette_start", {
      chambers: parseInt($("rl-chambers").value, 10) || 6,
      bullets: parseInt($("rl-bullets").value, 10) || 1,
    });
  });
  $("rl-spin").addEventListener("click", () => socket.emit("roulette_spin", {}));
  $("rl-pull").addEventListener("click", () => socket.emit("roulette_pull", {}));
  $("rl-again").addEventListener("click", () => socket.emit("roulette_reset", {}));

  // ---------- POKER ----------
  let lastPoker = null;
  socket.on("poker_state", (st) => { lastPoker = st; window.Poker.render(st); });
  socket.on("poker_fx", () => {});

  // ---------- CHAT ----------
  function renderChat(chat) {
    const log = $("chat-log"); log.innerHTML = "";
    (chat || []).forEach((m) => {
      const d = document.createElement("div");
      if (m.sys) { d.className = "msg sys"; d.textContent = "— " + m.msg; }
      else { d.className = "msg"; d.innerHTML = `<span class="who">${escapeHtml(m.name)}:</span>${escapeHtml(m.msg)}`; }
      log.appendChild(d);
    });
    log.scrollTop = log.scrollHeight;
  }
  $("chat-toggle").addEventListener("click", () =>
    $("chat-panel").classList.toggle("collapsed"));
  function sendChat() {
    const inp = $("chat-msg"); const msg = inp.value.trim();
    if (msg) { socket.emit("chat", { msg }); inp.value = ""; }
  }
  $("chat-send").addEventListener("click", sendChat);
  $("chat-msg").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  // ---------- misc ----------
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // init sub-modules
  window.Blackjack.bind();
  window.Poker.bind();

  // enter animation
  $("joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnJoin").click(); });
})();
