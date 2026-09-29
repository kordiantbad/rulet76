/* Blackjack — singleplayer minigame. Pure client-side, persistent bankroll. */
(function () {
  const SUITS = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

  const state = {
    bank: 1000,
    bet: 0,
    deck: [],
    player: [],
    dealer: [],
    phase: "bet",   // bet, play, dealer, done
    doubled: false,
    hiddenDealer: true,
  };

  const $ = (id) => document.getElementById(id);

  function loadBank() {
    const v = parseInt(localStorage.getItem("bar76_bj_bank") || "1000", 10);
    state.bank = isNaN(v) || v <= 0 ? 1000 : v;
  }
  function saveBank() { localStorage.setItem("bar76_bj_bank", String(state.bank)); }

  function newDeck() {
    const d = [];
    for (const s of Object.keys(SUITS)) for (const r of RANKS) d.push({ r, s });
    // multi-deck shoe (4 decks) for realism
    const shoe = [...d, ...d, ...d, ...d];
    for (let i = shoe.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
    return shoe;
  }

  function cardVal(c) {
    if (c.r === "A") return 11;
    if (["K","Q","J"].includes(c.r)) return 10;
    return parseInt(c.r, 10);
  }
  function handValue(cards) {
    let total = 0, aces = 0;
    for (const c of cards) { total += cardVal(c); if (c.r === "A") aces++; }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }
  function isBlackjack(cards) { return cards.length === 2 && handValue(cards) === 21; }

  function cardEl(c, faceDown) {
    const el = document.createElement("div");
    el.className = "card deal-in" + (faceDown ? " back" : "") + (!faceDown && (c.s === "h" || c.s === "d") ? " red" : "");
    if (!faceDown) {
      el.innerHTML = `<span class="rank">${c.r}</span><span class="suit-c">${SUITS[c.s]}</span><span class="rank2">${c.r}</span>`;
    }
    return el;
  }

  function render() {
    $("bj-bank").textContent = state.bank;
    $("bj-bet").textContent = state.bet;

    const pEl = $("bj-player"); pEl.innerHTML = "";
    state.player.forEach((c) => pEl.appendChild(cardEl(c, false)));
    const dEl = $("bj-dealer"); dEl.innerHTML = "";
    state.dealer.forEach((c, i) => dEl.appendChild(cardEl(c, i === 1 && state.hiddenDealer)));

    $("bj-player-score").textContent = state.player.length ? handValue(state.player) : "";
    if (state.dealer.length) {
      $("bj-dealer-score").textContent = state.hiddenDealer ? cardVal(state.dealer[0]) + " + ?" : handValue(state.dealer);
    } else $("bj-dealer-score").textContent = "";

    $("bj-bet-panel").classList.toggle("hidden", state.phase !== "bet");
    $("bj-play-panel").classList.toggle("hidden", state.phase !== "play");
    $("bj-double").disabled = state.player.length !== 2 || state.bank < state.bet;
  }

  function msg(t) { $("bj-message").textContent = t; }

  function addChip(v) {
    if (state.phase !== "bet") return;
    if (state.bet + v > state.bank) { msg("Not enough in the bank"); return; }
    state.bet += v; render();
  }
  function clearBet() { if (state.phase === "bet") { state.bet = 0; render(); } }

  function deal() {
    if (state.bet <= 0) { msg("Place a bet first"); return; }
    if (state.deck.length < 20) state.deck = newDeck();
    state.bank -= state.bet;
    state.player = [state.deck.pop(), state.deck.pop()];
    state.dealer = [state.deck.pop(), state.deck.pop()];
    state.doubled = false;
    state.hiddenDealer = true;
    state.phase = "play";
    render();

    if (isBlackjack(state.player) || isBlackjack(state.dealer)) {
      state.hiddenDealer = false;
      if (isBlackjack(state.player) && isBlackjack(state.dealer)) {
        state.bank += state.bet; settle("Push — both blackjack");
      } else if (isBlackjack(state.player)) {
        state.bank += Math.floor(state.bet * 2.5); settle("BLACKJACK! Pays 3:2 ♠");
      } else {
        settle("Dealer has blackjack");
      }
      return;
    }
    msg("Hit or stand?");
  }

  function hit() {
    if (state.phase !== "play") return;
    state.player.push(state.deck.pop());
    render();
    const v = handValue(state.player);
    if (v > 21) { state.hiddenDealer = false; render(); settle("BUST! You went over 21"); }
    else if (v === 21) stand();
  }

  function double() {
    if (state.phase !== "play" || state.player.length !== 2) return;
    if (state.bank < state.bet) { msg("Can't cover the double"); return; }
    state.bank -= state.bet; state.bet *= 2; state.doubled = true;
    state.player.push(state.deck.pop());
    render();
    if (handValue(state.player) > 21) { state.hiddenDealer = false; render(); settle("BUST on the double!"); }
    else stand();
  }

  function stand() {
    if (state.phase !== "play") return;
    state.phase = "dealer";
    state.hiddenDealer = false;
    render();
    const step = () => {
      if (handValue(state.dealer) < 17) {
        state.dealer.push(state.deck.pop());
        render();
        setTimeout(step, 550);
      } else {
        finish();
      }
    };
    setTimeout(step, 550);
  }

  function finish() {
    const p = handValue(state.player), d = handValue(state.dealer);
    if (d > 21) { state.bank += state.bet * 2; settle("Dealer busts — you win!"); }
    else if (p > d) { state.bank += state.bet * 2; settle(`You win ${p} vs ${d}`); }
    else if (p < d) { settle(`Dealer wins ${d} vs ${p}`); }
    else { state.bank += state.bet; settle(`Push — ${p} each`); }
  }

  function settle(text) {
    state.phase = "done";
    if (state.bank <= 0) { state.bank = 1000; text += " · House stakes you to 1000"; }
    saveBank();
    msg(text);
    render();
    setTimeout(() => {
      if (state.phase === "done") {
        state.phase = "bet"; state.bet = 0; state.player = []; state.dealer = [];
        msg("Place your bet"); render();
      }
    }, 2600);
  }

  function reset() {
    loadBank();
    state.bet = 0; state.player = []; state.dealer = []; state.phase = "bet";
    state.deck = newDeck();
    msg("Place your bet");
    render();
  }

  function bind() {
    document.querySelectorAll("#bj-bet-panel .chip").forEach((b) =>
      b.addEventListener("click", () => addChip(parseInt(b.dataset.chip, 10))));
    $("bj-clear").addEventListener("click", clearBet);
    $("bj-deal").addEventListener("click", deal);
    $("bj-hit").addEventListener("click", hit);
    $("bj-stand").addEventListener("click", stand);
    $("bj-double").addEventListener("click", double);
  }

  window.Blackjack = { bind, reset };
})();
