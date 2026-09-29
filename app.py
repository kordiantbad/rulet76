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
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # always revalidate static assets


def asset_version():
    """Cache-busting token derived from newest static/template mtime."""
    newest = 0.0
    for root in (os.path.join(BASE_DIR, "static"), os.path.join(BASE_DIR, "templates")):
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(dirpath, f)))
                except OSError:
                    pass
    return str(int(newest))
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
        self.order = []           # seating order (sids)
        self.alive = {}           # sid -> bool
        self.chambers = 6
        self.bullets = 1
        self.bullet_set = set()   # chamber indices that are live
        self.position = 0         # current chamber pointer
        self.turn = None          # sid holding the gun
        self.aim = None           # sid currently being aimed at
        self.state = "lobby"      # lobby, playing, over
        self.winner = None
        self.last_action = None

    def public(self, names):
        return {
            "order": [{"sid": s, "name": names.get(s, "?"), "alive": self.alive.get(s, False)} for s in self.order],
            "chambers": self.chambers,
            "bullets": self.bullets,
            "turn": self.turn,
            "aim": self.aim,
            "state": self.state,
            "winner": self.winner,
            "last_action": self.last_action,
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
    resp = app.make_response(render_template("index.html", v=asset_version()))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


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
            was_turn = r.turn == sid
            if r.state == "playing" and r.alive.get(sid):
                r.alive[sid] = False
            r.order = [s for s in r.order if s in room.members]
            r.alive = {s: r.alive.get(s, True) for s in r.order}
            if r.state == "playing" and not _check_roulette_winner(room):
                if was_turn or r.turn not in r.order:
                    _roulette_pass_turn(room, sid)
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
    want = (data.get("code") or "").strip().upper()
    with LOCK:
        _leave(request.sid)
        if want and len(want) == 4 and want not in ROOMS:
            code = want
        else:
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
def _roulette_reload(r):
    """Fresh cylinder: new random live rounds, pointer at the top."""
    r.bullet_set = set(random.sample(range(r.chambers), min(r.bullets, r.chambers)))
    r.position = 0


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
        chambers = max(2, min(8, int(data.get("chambers", 6))))
        bullets = max(1, min(chambers - 1, int(data.get("bullets", 1))))
        r.chambers = chambers
        r.bullets = bullets
        r.order = list(room.members.keys())
        random.shuffle(r.order)
        r.alive = {s: True for s in r.order}
        r.state = "playing"
        r.winner = None
        r.aim = None
        r.last_action = None
        _roulette_reload(r)
        first = random.choice(r.order)
        r.turn = first
        room.chat.append({"sys": True, "msg": f"Round on — {chambers} chambers, {bullets} live"})
    push_room(room)
    push_roulette(room)
    socketio.emit("roulette_fx", {"type": "handoff", "from": None, "to": first}, to=room.code)


@socketio.on("roulette_aim")
def roulette_aim(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "roulette":
            return
        r = room.r
        if r.state != "playing" or r.turn != request.sid:
            return
        target = data.get("target")
        if target not in r.alive or not r.alive.get(target):
            return
        r.aim = target
    push_roulette(room)
    socketio.emit("roulette_fx", {"type": "aim", "shooter": request.sid, "target": target}, to=room.code)


@socketio.on("roulette_shoot")
def roulette_shoot(data):
    with LOCK:
        room = room_of(request.sid)
        if not room or room.game != "roulette":
            return
        r = room.r
        if r.state != "playing" or r.turn != request.sid:
            emit("error_msg", {"msg": "Not your turn."})
            return
        sid = request.sid
        target = data.get("target") or r.aim or sid
        if target not in r.alive or not r.alive.get(target):
            emit("error_msg", {"msg": "Pick a living target."})
            return
        r.aim = target

        fired = r.position in r.bullet_set
        r.position = (r.position + 1) % r.chambers
        self_shot = target == sid
        sname = room.members[sid].name if sid in room.members else "?"
        tname = room.members[target].name if target in room.members else "?"

        socketio.emit("roulette_fx",
                      {"type": "bang" if fired else "click",
                       "shooter": sid, "target": target, "self": self_shot},
                      to=room.code)

        if fired:
            r.alive[target] = False
            r.last_action = {"type": "bang", "shooter": sid, "target": target}
            if self_shot:
                room.chat.append({"sys": True, "msg": f"💥 {sname} took their own life. Out."})
            else:
                room.chat.append({"sys": True, "msg": f"💥 {sname} shot {tname} dead."})
            if not _check_roulette_winner(room):
                _roulette_pass_turn(room, sid)
        else:
            r.last_action = {"type": "click", "shooter": sid, "target": target}
            if self_shot:
                room.chat.append({"sys": True, "msg": f"*click* — {sname} survives and goes again."})
                r.aim = None  # keep the turn, keep the cylinder rolling
            else:
                room.chat.append({"sys": True, "msg": f"*click* — {sname} missed {tname}."})
                _roulette_pass_turn(room, sid)
    push_roulette(room)
    push_room(room)


def _roulette_pass_turn(room, prev):
    """Put the gun down; spin to a new shooter (never the one who put it down)."""
    r = room.r
    alive = [s for s in r.order if r.alive.get(s)]
    if len(alive) <= 1:
        _check_roulette_winner(room)
        return
    candidates = [s for s in alive if s != prev] or alive
    nxt = random.choice(candidates)
    r.turn = nxt
    r.aim = None
    _roulette_reload(r)
    socketio.emit("roulette_fx", {"type": "handoff", "from": prev, "to": nxt}, to=room.code)


def _check_roulette_winner(room):
    r = room.r
    alive_order = [s for s in r.order if r.alive.get(s)]
    if len(alive_order) <= 1:
        r.state = "over"
        r.winner = alive_order[0] if alive_order else None
        r.turn = None
        r.aim = None
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
