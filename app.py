"""
BAR 76 — a web party-game lounge.

Games:
  * Russian Roulette  — real-time multiplayer, server-authoritative revolver
  * Texas Hold'em Poker — real-time multiplayer
  * Blackjack          — singleplayer minigame (client side)

Runs on the host/port defined in port.txt (default 0.0.0.0:8080).
"""
import os
import random
import string
import threading

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

from poker_engine import PokerTable

# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def read_port(default=8080):
    path = os.path.join(BASE_DIR, "port.txt")
    try:
        with open(path) as f:
            return int(f.read().strip())
    except Exception:
        return default


PORT = read_port()
HOST = "0.0.0.0"

app = Flask(__name__)
app.config["SECRET_KEY"] = "bar76-" + "".join(random.choices(string.ascii_letters, k=16))
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

LOCK = threading.RLock()

# --------------------------------------------------------------------------
# room model
# --------------------------------------------------------------------------
ROOMS = {}          # code -> Room
SID_ROOM = {}       # sid -> code


class Member:
    def __init__(self, sid, name):
        self.sid = sid
        self.name = name
        self.ready = False


class Room:
    def __init__(self, code, game, host_sid):
        self.code = code
        self.game = game          # 'roulette' or 'poker'
        self.host = host_sid
        self.members = {}         # sid -> Member
        self.chat = []
        # roulette state
        self.r = None
        # poker state
        self.poker = None

    def public_members(self):
        return [
            {"sid": m.sid, "name": m.name, "ready": m.ready, "host": m.sid == self.host}
            for m in self.members.values()
        ]


# ---- roulette state ------------------------------------------------------
class Roulette:
    def __init__(self):
        self.order = []           # list of sids (seating)
        self.alive = {}           # sid -> bool
        self.chambers = 6
        self.bullet_pos = None    # index in cylinder that holds the bullet
        self.position = 0         # current chamber pointer
        self.turn = None          # sid whose turn it is
        self.state = "lobby"      # lobby, ready, spinning, playing, over
        self.spun = False
        self.winner = None
        self.last_action = None
        self.round_no = 0

    def public(self, names):
        return {
            "order": [{"sid": s, "name": names.get(s, "?"), "alive": self.alive.get(s, False)} for s in self.order],
            "chambers": self.chambers,
            "position": self.position,
            "turn": self.turn,
            "state": self.state,
            "spun": self.spun,
            "winner": self.winner,
            "last_action": self.last_action,
            "round_no": self.round_no,
        }


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def gen_code():
    while True:
        code = "".join(random.choices("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", k=4))
        if code not in ROOMS:
            return code


def room_of(sid):
    code = SID_ROOM.get(sid)
    return ROOMS.get(code) if code else None


def push_room(room):
    payload = {
        "code": room.code,
        "game": room.game,
        "host": room.host,
        "members": room.public_members(),
        "chat": room.chat[-40:],
    }
    socketio.emit("room_update", payload, to=room.code)


def push_roulette(room):
    names = {m.sid: m.name for m in room.members.values()}
    socketio.emit("roulette_state", room.r.public(names), to=room.code)


def push_poker(room):
    # per-viewer state (hole cards hidden from others)
    for m in list(room.members.values()):
        socketio.emit("poker_state", room.poker.state(viewer_sid=m.sid), to=m.sid)


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return {"ok": True, "rooms": len(ROOMS)}


# --------------------------------------------------------------------------
# socket: connection / lobby
# --------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    emit("connected", {"sid": request.sid})


@socketio.on("disconnect")
def on_disconnect(*args):
    with LOCK:
        _leave(request.sid)


def _leave(sid):
    room = room_of(sid)
    if not room:
        return
    was_host = room.host == sid
    name = room.members[sid].name if sid in room.members else "?"
    room.members.pop(sid, None)
    SID_ROOM.pop(sid, None)
    try:
        leave_room(room.code, sid=sid)
    except Exception:
        pass

    if not room.members:
        ROOMS.pop(room.code, None)
        return

    if was_host:
        room.host = next(iter(room.members))

    room.chat.append({"sys": True, "msg": f"{name} left"})

    # roulette cleanup
    if room.game == "roulette" and room.r:
        r = room.r
        if sid in r.order:
            if r.state in ("playing", "spinning") and r.alive.get(sid):
                r.alive[sid] = False
                if r.turn == sid:
                    _roulette_next_turn(room)
                _check_roulette_winner(room)
            r.order = [s for s in r.order if s in room.members]
            r.alive = {s: r.alive.get(s, True) for s in r.order}
        push_roulette(room)

    # poker cleanup
    if room.game == "poker" and room.poker:
        room.poker.remove_player(sid)
        if room.poker.stage not in ("waiting", "showdown"):
            room.poker._advance()
        push_poker(room)

    push_room(room)


@socketio.on("create_room")
def on_create(data):
    name = (data.get("name") or "Player").strip()[:16] or "Player"
    game = data.get("game", "roulette")
    if game not in ("roulette", "poker"):
        game = "roulette"
    with LOCK:
        _leave(request.sid)
        code = gen_code()
        room = Room(code, game, request.sid)
        room.members[request.sid] = Member(request.sid, name)
        if game == "roulette":
            room.r = Roulette()
        else:
            room.poker = PokerTable()
            room.poker.add_player(request.sid, name)
        ROOMS[code] = room
        SID_ROOM[request.sid] = code
        join_room(code)
        room.chat.append({"sys": True, "msg": f"{name} opened the table"})
    emit("joined", {"code": code, "game": game, "sid": request.sid})
    push_room(room)
    if game == "roulette":
        push_roulette(room)
    else:
        push_poker(room)


@socketio.on("join_room")
def on_join(data):
    name = (data.get("name") or "Player").strip()[:16] or "Player"
    code = (data.get("code") or "").strip().upper()
    with LOCK:
        room = ROOMS.get(code)
        if not room:
            emit("error_msg", {"msg": "No table with that code."})
            return
        if len(room.members) >= 8:
            emit("error_msg", {"msg": "That table is full (8 max)."})
            return
        _leave(request.sid)
        room.members[request.sid] = Member(request.sid, name)
        SID_ROOM[request.sid] = code
        join_room(code)
        room.chat.append({"sys": True, "msg": f"{name} joined"})
        if room.game == "poker":
            room.poker.add_player(request.sid, name)
    emit("joined", {"code": code, "game": room.game, "sid": request.sid})
    push_room(room)
    if room.game == "roulette":
        push_roulette(room)
    else:
        push_poker(room)


@socketio.on("leave_table")
def on_leave_table():
    with LOCK:
        _leave(request.sid)
    emit("left", {})


@socketio.on("chat")
def on_chat(data):
    with LOCK:
        room = room_of(request.sid)
        if not room:
            return
        name = room.members[request.sid].name
        msg = (data.get("msg") or "").strip()[:200]
        if msg:
            room.chat.append({"name": name, "msg": msg})
    if room:
        push_room(room)


# --------------------------------------------------------------------------
# socket: ROULETTE
# --------------------------------------------------------------------------
@socketio.on("roulette_start")
def roulette_start(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "roulette":
            return
        if request.sid != room.host:
            emit("error_msg", {"msg": "Only the host can start."})
            return
        if len(room.members) < 2:
            emit("error_msg", {"msg": "Need at least 2 players."})
            return
        r = room.r
        chambers = int(data.get("chambers", 6))
        bullets = int(data.get("bullets", 1))
        chambers = max(2, min(8, chambers))
        bullets = max(1, min(chambers - 1, bullets))
        r.chambers = chambers
        r.bullets = bullets
        r.order = list(room.members.keys())
        random.shuffle(r.order)
        r.alive = {s: True for s in r.order}
        r.turn = r.order[0]
        r.state = "ready"
        r.spun = False
        r.winner = None
        r.round_no = 1
        r.last_action = None
        _roulette_load(r)
        room.chat.append({"sys": True, "msg": f"Round 1 — {chambers} chambers, {bullets} live"})
    push_room(room)
    push_roulette(room)


def _roulette_load(r):
    r.bullet_set = set(random.sample(range(r.chambers), getattr(r, "bullets", 1)))
    r.position = 0
    r.spun = False


@socketio.on("roulette_spin")
def roulette_spin(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "roulette":
            return
        r = room.r
        if r.state not in ("ready", "playing"):
            return
        if r.turn != request.sid:
            emit("error_msg", {"msg": "Not your turn."})
            return
        r.bullet_set = set(random.sample(range(r.chambers), getattr(r, "bullets", 1)))
        r.position = random.randrange(r.chambers)
        r.spun = True
        r.state = "playing"
        r.last_action = {"type": "spin", "sid": request.sid}
        name = room.members[request.sid].name
        room.chat.append({"sys": True, "msg": f"{name} spins the cylinder"})
    push_roulette(room)
    socketio.emit("roulette_fx", {"type": "spin", "sid": request.sid}, to=room.code)
    push_room(room)


@socketio.on("roulette_pull")
def roulette_pull(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "roulette":
            return
        r = room.r
        if r.state not in ("ready", "playing"):
            return
        if r.turn != request.sid:
            emit("error_msg", {"msg": "Not your turn."})
            return
        r.state = "playing"
        fired = r.position in getattr(r, "bullet_set", set())
        name = room.members[request.sid].name
        chamber = r.position
        r.position = (r.position + 1) % r.chambers
        r.spun = False

        if fired:
            r.alive[request.sid] = False
            r.last_action = {"type": "bang", "sid": request.sid, "chamber": chamber}
            room.chat.append({"sys": True, "msg": f"💥 BANG! {name} is out."})
            socketio.emit("roulette_fx", {"type": "bang", "sid": request.sid}, to=room.code)
            over = _check_roulette_winner(room)
            if not over:
                _roulette_next_turn(room)
                # reload for the next victim
                r.bullet_set = set(random.sample(range(r.chambers), getattr(r, "bullets", 1)))
                r.position = 0
                r.round_no += 1
        else:
            r.last_action = {"type": "click", "sid": request.sid, "chamber": chamber}
            room.chat.append({"sys": True, "msg": f"*click* — {name} survives."})
            socketio.emit("roulette_fx", {"type": "click", "sid": request.sid}, to=room.code)
            _roulette_next_turn(room)
    push_roulette(room)
    push_room(room)


def _roulette_next_turn(room):
    r = room.r
    alive_order = [s for s in r.order if r.alive.get(s)]
    if not alive_order:
        return
    if r.turn not in alive_order:
        # pick next after current position in order
        try:
            idx = r.order.index(r.turn)
        except ValueError:
            idx = -1
        nxt = None
        for step in range(1, len(r.order) + 1):
            cand = r.order[(idx + step) % len(r.order)]
            if r.alive.get(cand):
                nxt = cand
                break
        r.turn = nxt or alive_order[0]
    else:
        idx = r.order.index(r.turn)
        for step in range(1, len(r.order) + 1):
            cand = r.order[(idx + step) % len(r.order)]
            if r.alive.get(cand):
                r.turn = cand
                break


def _check_roulette_winner(room):
    r = room.r
    alive_order = [s for s in r.order if r.alive.get(s)]
    if len(alive_order) <= 1:
        r.state = "over"
        r.winner = alive_order[0] if alive_order else None
        wname = room.members[r.winner].name if r.winner in room.members else "Nobody"
        room.chat.append({"sys": True, "msg": f"🏆 {wname} is the last one standing!"})
        socketio.emit("roulette_fx", {"type": "win", "sid": r.winner}, to=room.code)
        return True
    return False


@socketio.on("roulette_reset")
def roulette_reset(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "roulette":
            return
        if request.sid != room.host:
            emit("error_msg", {"msg": "Only the host can reset."})
            return
        room.r = Roulette()
        room.chat.append({"sys": True, "msg": "Table reset. Ready for a new round."})
    push_room(room)
    push_roulette(room)


# --------------------------------------------------------------------------
# socket: POKER
# --------------------------------------------------------------------------
@socketio.on("poker_start")
def poker_start(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "poker":
            return
        if request.sid != room.host:
            emit("error_msg", {"msg": "Only the host can deal."})
            return
        if not room.poker.can_start():
            emit("error_msg", {"msg": "Need at least 2 players with chips."})
            return
        room.poker.start_hand()
        room.chat.append({"sys": True, "msg": f"Hand #{room.poker.hand_no} dealt"})
    push_poker(room)
    push_room(room)


@socketio.on("poker_action")
def poker_action(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "poker":
            return
        action = data.get("action")
        amount = data.get("amount", 0)
        ok, err = room.poker.act(request.sid, action, amount)
        if not ok:
            emit("error_msg", {"msg": err or "Invalid action."})
            return
    push_poker(room)
    push_room(room)


@socketio.on("poker_sitout")
def poker_sitout(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "poker":
            return
        p = room.poker.get(request.sid)
        if p:
            p.sitting_out = bool(data.get("out"))
    push_poker(room)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
if __name__ == "__main__":
    print(f"  BAR 76 open for business at http://{HOST}:{PORT}")
    socketio.run(app, host=HOST, port=PORT, allow_unsafe_werkzeug=True)
