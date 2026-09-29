/* Texas Hold'em — client UI. Server is authoritative (poker_engine.py). */
(function () {
  const SUIT = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const $ = (id) => document.getElementById(id);
  const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };
  let mySid = null;
  let last = null;

  function setSid(sid) { mySid = sid; }

  function cardEl(code, small) {
    const el = document.createElement("div");
    if (code === "??") { el.className = "card back" + (small ? " sm" : ""); return el; }
    const r = code[0] === "T" ? "10" : code[0];
    const s = code[1];
    const red = s === "h" || s === "d";
    el.className = "card deal-in" + (small ? " sm" : "") + (red ? " red" : "");
    el.innerHTML = `<span class="rank">${r}</span><span class="suit-c">${SUIT[s]}</span><span class="rank2">${r}</span>`;
    return el;
  }

  function seatPositions(n) {
    // returns [{x%,y%}] around an ellipse, index 0 = bottom (viewer)
    const pos = [];
    for (let i = 0; i < n; i++) {
      const angle = Math.PI / 2 + (i / n) * Math.PI * 2; // start at bottom, go clockwise
      const x = 50 + 40 * Math.cos(angle);
      const y = 52 + 38 * Math.sin(angle);
      pos.push({ x, y });
    }
    return pos;
  }

  function render(st) {
    last = st;
    $("pk-pot").textContent = st.pot;

    // board
    const board = $("pk-board");
    board.innerHTML = "";
    st.board.forEach((c) => board.appendChild(cardEl(c, false)));
    for (let i = st.board.length; i < 5; i++) {
      const ph = document.createElement("div");
      ph.className = "card back";
      ph.style.opacity = ".18";
      board.appendChild(ph);
    }
    const stageNames = { waiting: "waiting for deal", preflop: "pre-flop", flop: "the flop",
      turn: "the turn", river: "the river", showdown: "showdown" };
    $("pk-community-label").textContent = stageNames[st.stage] || "";

    // reorder players so my seat is at the bottom
    let players = st.players.slice();
    const myIdx = players.findIndex((p) => p.sid === mySid);
    if (myIdx > 0) players = players.slice(myIdx).concat(players.slice(0, myIdx));

    const seats = $("pk-seats");
    seats.innerHTML = "";
    const pos = seatPositions(players.length);
    players.forEach((p, i) => {
      const seat = document.createElement("div");
      seat.className = "seat" + (p.folded ? " folded" : "") + (st.current === p.sid ? " active" : "");
      seat.style.left = pos[i].x + "%";
      seat.style.top = pos[i].y + "%";

      const hole = document.createElement("div");
      hole.className = "hole";
      (p.hole || []).forEach((c) => hole.appendChild(cardEl(c, true)));

      let status = "";
      if (p.folded) status = "folded";
      else if (p.all_in) status = "ALL IN";
      else if (p.sitting_out) status = "sitting out";
      else if (st.current === p.sid) status = "thinking…";

      const card = document.createElement("div");
      card.className = "seat-card";
      card.innerHTML =
        `<div class="nm">${p.sid === mySid ? "★ " : ""}${escapeHtml(p.name)}</div>` +
        `<div class="chips">${p.chips} ◈</div>` +
        `<div class="status">${status}</div>`;
      card.prepend(hole);

      if (st.button === p.sid) {
        const d = document.createElement("div");
        d.className = "dealer-btn"; d.textContent = "D";
        card.appendChild(d);
      }
      seat.appendChild(card);

      if (p.bet > 0) {
        const bp = document.createElement("div");
        bp.className = "bet-pill"; bp.textContent = p.bet + " ◈";
        seat.appendChild(bp);
      }
      seats.appendChild(seat);
    });

    // result banner
    const resEl = $("pk-result");
    if (st.stage === "showdown" && st.last_result) {
      const r = st.last_result;
      const wtext = r.winners.map((w) =>
        `${escapeHtml(w.name)} +${w.amount}${w.hand ? " · " + w.hand : ""}`).join("<br>");
      resEl.innerHTML = `<h3>${r.winners.length > 1 ? "Split Pot" : "Winner"}</h3><p>${wtext}</p>`;
      resEl.classList.remove("hidden");
    } else {
      resEl.classList.add("hidden");
    }

    renderControls(st, players);
  }

  function renderControls(st, players) {
    const me = st.players.find((p) => p.sid === mySid);
    const isHost = window.App && window.App.isHost();
    const canDeal = (st.stage === "waiting" || st.stage === "showdown");

    $("pk-host-setup").classList.toggle("hidden", !(isHost && canDeal));
    $("pk-deal").textContent = st.stage === "showdown" ? "Next Hand" : "Deal Hand";

    const myTurn = st.current === mySid && me && !me.folded && !me.all_in &&
      ["preflop", "flop", "turn", "river"].includes(st.stage);
    $("pk-actions").classList.toggle("hidden", !myTurn);
    $("pk-wait").classList.toggle("hidden", myTurn || (isHost && canDeal));

    if (canDeal) {
      $("pk-wait").textContent = isHost ? "" : "Waiting for host to deal…";
    } else if (!myTurn) {
      const cur = st.players.find((p) => p.sid === st.current);
      $("pk-wait").textContent = cur ? `${cur.name} is acting…` : "…";
    }

    if (myTurn) {
      const toCall = st.current_bet - me.bet;
      $("pk-check").classList.toggle("hidden", toCall > 0);
      $("pk-call").classList.toggle("hidden", toCall <= 0);
      $("pk-call").textContent = toCall > 0 ? `Call ${Math.min(toCall, me.chips)}` : "Call";

      const slider = $("pk-slider");
      const minTarget = Math.min(me.chips + me.bet, st.current_bet + st.min_raise);
      const maxTarget = me.chips + me.bet;
      slider.min = minTarget;
      slider.max = maxTarget;
      slider.step = st.bb;
      if (+slider.value < minTarget || +slider.value > maxTarget) slider.value = minTarget;
      updateRaiseLabel();
      const canRaise = maxTarget > st.current_bet;
      $("pk-raise").disabled = !canRaise;
      $("pk-slider").disabled = !canRaise;
      $("pk-raise").textContent = maxTarget <= minTarget ? "All In" : "Raise";
    }
  }

  function updateRaiseLabel() {
    $("pk-raise-amt").textContent = $("pk-slider").value;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function bind() {
    on("pk-deal", "click", () => window.socket.emit("poker_start", {}));
    on("pk-fold", "click", () => act("fold"));
    on("pk-check", "click", () => act("check"));
    on("pk-call", "click", () => act("call"));
    on("pk-raise", "click", () => act("raise", +$("pk-slider").value));
    on("pk-slider", "input", updateRaiseLabel);
  }

  function act(action, amount) {
    window.socket.emit("poker_action", { action, amount: amount || 0 });
  }

  window.Poker = { bind, render, setSid };
})();
