# 🍸 BAR 76 — Underground Lounge

A high-detail, web-based **party game lounge** you host yourself and play with friends
over the network. Step into a moody speakeasy and pick your poison:

| Game | Mode | Notes |
|------|------|-------|
| 🔫 **Russian Roulette** | 2–8 players, online | A **3D bar scene** with a **realistic revolver** (Three.js). Spin the cylinder, pull the trigger, last soul standing wins. |
| 🂡 **Texas Hold'em Poker** | 2–8 players, online | Full betting rounds, blinds, all-in side pots, showdown — server-authoritative. |
| ♠ **Blackjack** | solo minigame | You vs. the house. Hit, stand, double down, 3:2 blackjacks, persistent bankroll. |

Multiplayer tables share a **4-letter code** — friends join from their own browsers.

---

## Requirements

* Python 3.9+
* Internet on the **player's browser** (Three.js & Socket.IO load from CDN)

## Run it

The host/port is read from **`port.txt`** (one number, e.g. `8080`).

```bash
./run.sh
```

`run.sh` creates a virtualenv, installs dependencies, and launches the server.
Prefer to do it by hand?

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Then open **`http://<your-ip>:<port>/`** (e.g. `http://localhost:8080`).
The server binds to `0.0.0.0`, so friends on your network/tunnel can reach it too.

### Changing the port

```bash
echo 5000 > port.txt   # then restart
```

---

## How to play

1. Type a name at the bar.
2. Click a game card.
   * **Roulette / Poker** → *Host a new table* (share the 4-letter code) or *Join* with a code.
   * **Blackjack** → jumps straight in (solo).
3. The **host** starts each round (loads the revolver / deals the hand).
4. Chat with the table using the 💬 dock.

**Roulette:** on your turn, optionally **Spin** the cylinder to re-randomise, then **Pull Trigger**.
Survive the click, or... 💥. Configure chambers (2–8) and live rounds before starting.

**Poker:** standard Texas Hold'em. Fold / Check / Call, or use the slider to Raise / go All-In.

---

## Project layout

```
app.py            Flask + Socket.IO server: lobby, rooms, roulette + poker events
poker_engine.py   Texas Hold'em state machine + 7-card hand evaluator
port.txt          host port (read at startup)
templates/
  index.html      single-page shell (all screens)
static/
  css/styles.css  the speakeasy theme
  js/main.js      router, socket wiring, roulette HUD, chat
  js/roulette.js  Three.js 3D bar + revolver model & FX (ES module)
  js/poker.js     poker table UI
  js/blackjack.js solo blackjack (pure client)
```

## Tech

* **Backend:** Flask + Flask-SocketIO (threading async mode) — authoritative game state.
* **Frontend:** vanilla JS, **Three.js** for the 3D revolver & bar, WebSocket realtime.

Enjoy responsibly. 🥃
