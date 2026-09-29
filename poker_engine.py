"""Texas Hold'em engine: deck, hand evaluation, and a table state machine.

Server-authoritative. Handles blinds, betting rounds, all-in side pots,
and showdown with a fast 7-card evaluator.
"""
import random
from itertools import combinations

RANKS = "23456789TJQKA"
SUITS = "shdc"  # spades, hearts, diamonds, clubs
RANK_VAL = {r: i for i, r in enumerate(RANKS, start=2)}  # 2..14

HAND_NAMES = [
    "High Card", "Pair", "Two Pair", "Three of a Kind", "Straight",
    "Flush", "Full House", "Four of a Kind", "Straight Flush",
]


def make_deck():
    return [r + s for r in RANKS for s in SUITS]


def _eval5(cards):
    """Evaluate exactly 5 cards -> comparable tuple (category, tiebreakers)."""
    vals = sorted((RANK_VAL[c[0]] for c in cards), reverse=True)
    suits = [c[1] for c in cards]
    is_flush = len(set(suits)) == 1

    # straight detection (handle wheel A-2-3-4-5)
    uniq = sorted(set(vals), reverse=True)
    is_straight = False
    straight_high = None
    if len(uniq) == 5:
        if uniq[0] - uniq[4] == 4:
            is_straight = True
            straight_high = uniq[0]
        elif uniq == [14, 5, 4, 3, 2]:
            is_straight = True
            straight_high = 5

    # counts of each rank
    counts = {}
    for v in vals:
        counts[v] = counts.get(v, 0) + 1
    # sort by (count, value) descending
    by_count = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    count_pattern = tuple(c for _, c in by_count)
    ordered_vals = tuple(v for v, _ in by_count)

    if is_straight and is_flush:
        return (8, straight_high)
    if count_pattern == (4, 1):
        return (7,) + ordered_vals
    if count_pattern == (3, 2):
        return (6,) + ordered_vals
    if is_flush:
        return (5,) + tuple(vals)
    if is_straight:
        return (4, straight_high)
    if count_pattern == (3, 1, 1):
        return (3,) + ordered_vals
    if count_pattern == (2, 2, 1):
        return (2,) + ordered_vals
    if count_pattern == (2, 1, 1, 1):
        return (1,) + ordered_vals
    return (0,) + tuple(vals)


def best_hand(cards):
    """Return (score_tuple, category_index) for best 5 of up to 7 cards."""
    best = None
    for combo in combinations(cards, 5):
        s = _eval5(combo)
        if best is None or s > best:
            best = s
    return best


def hand_name(score):
    return HAND_NAMES[score[0]]


class Player:
    def __init__(self, sid, name, chips):
        self.sid = sid
        self.name = name
        self.chips = chips
        self.hole = []
        self.in_hand = False       # dealt into the current hand
        self.folded = False
        self.all_in = False
        self.bet = 0               # amount put in during current betting round
        self.total_committed = 0   # total across the whole hand (for side pots)
        self.acted = False         # acted since last raise this round
        self.sitting_out = False

    def public(self, reveal=False):
        return {
            "sid": self.sid,
            "name": self.name,
            "chips": self.chips,
            "bet": self.bet,
            "folded": self.folded,
            "all_in": self.all_in,
            "in_hand": self.in_hand,
            "sitting_out": self.sitting_out,
            "hole": self.hole if reveal else (["??", "??"] if self.in_hand and not self.folded else []),
        }


class PokerTable:
    def __init__(self, small_blind=10, big_blind=20, starting_chips=1000):
        self.players = []          # seat order
        self.deck = []
        self.board = []
        self.pot = 0
        self.sb = small_blind
        self.bb = big_blind
        self.starting_chips = starting_chips
        self.button = 0
        self.stage = "waiting"     # waiting, preflop, flop, turn, river, showdown
        self.current = None        # sid to act
        self.current_bet = 0       # highest bet this round
        self.min_raise = big_blind
        self.last_result = None    # showdown summary
        self.hand_no = 0
        self.log = []

    # ---- seating ----
    def add_player(self, sid, name):
        if any(p.sid == sid for p in self.players):
            return
        self.players.append(Player(sid, name, self.starting_chips))

    def remove_player(self, sid):
        p = self.get(sid)
        if not p:
            return
        # if in an active hand, treat as fold
        if p.in_hand and not p.folded:
            p.folded = True
        self.players = [x for x in self.players if x.sid != sid]
        # keep the dealer button within bounds
        if self.players:
            self.button %= len(self.players)
        else:
            self.button = 0

    def get(self, sid):
        for p in self.players:
            if p.sid == sid:
                return p
        return None

    def _log(self, msg):
        self.log.append(msg)
        self.log = self.log[-30:]

    # ---- hand lifecycle ----
    def can_start(self):
        eligible = [p for p in self.players if p.chips > 0 and not p.sitting_out]
        return self.stage in ("waiting", "showdown") and len(eligible) >= 2

    def start_hand(self):
        eligible = [p for p in self.players if p.chips > 0 and not p.sitting_out]
        if len(eligible) < 2:
            return False
        self.hand_no += 1
        self.deck = make_deck()
        random.shuffle(self.deck)
        self.board = []
        self.pot = 0
        self.last_result = None
        self.log = []
        for p in self.players:
            p.hole = []
            p.folded = False
            p.all_in = False
            p.bet = 0
            p.total_committed = 0
            p.acted = False
            p.in_hand = p.chips > 0 and not p.sitting_out

        active = self.active_seats()
        # move button
        self.button = self._next_index(self.button, active)
        heads_up = len(active) == 2

        # blinds
        if heads_up:
            sb_i = self.button
            bb_i = self._next_index(self.button, active)
        else:
            sb_i = self._next_index(self.button, active)
            bb_i = self._next_index(sb_i, active)

        self._post_blind(self.players[sb_i], self.sb)
        self._post_blind(self.players[bb_i], self.bb)
        self.current_bet = self.bb
        self.min_raise = self.bb

        # deal two hole cards each
        for _ in range(2):
            for p in self.players:
                if p.in_hand:
                    p.hole.append(self.deck.pop())

        self.stage = "preflop"
        # first to act
        if heads_up:
            first = self.button  # SB/button acts first preflop
        else:
            first = self._next_index(bb_i, active)
        self.current = self.players[first].sid
        self._log(f"Hand #{self.hand_no} started")
        return True

    def _post_blind(self, p, amount):
        amt = min(amount, p.chips)
        p.chips -= amt
        p.bet += amt
        p.total_committed += amt
        self.pot += amt
        if p.chips == 0:
            p.all_in = True
        self._log(f"{p.name} posts {amt}")

    def active_seats(self):
        return [i for i, p in enumerate(self.players) if p.in_hand]

    def _next_index(self, idx, pool=None):
        n = len(self.players)
        for step in range(1, n + 1):
            j = (idx + step) % n
            if pool is None or j in pool:
                return j
        return idx

    def _players_in(self):
        return [p for p in self.players if p.in_hand and not p.folded]

    def _players_can_act(self):
        return [p for p in self.players if p.in_hand and not p.folded and not p.all_in]

    # ---- betting ----
    def act(self, sid, action, amount=0):
        p = self.get(sid)
        if not p or self.current != sid or self.stage in ("waiting", "showdown"):
            return False, "Not your turn"
        to_call = self.current_bet - p.bet

        if action == "fold":
            p.folded = True
            p.acted = True
            self._log(f"{p.name} folds")
        elif action == "check":
            if to_call > 0:
                return False, "Cannot check facing a bet"
            p.acted = True
            self._log(f"{p.name} checks")
        elif action == "call":
            call_amt = min(to_call, p.chips)
            self._move_chips(p, call_amt)
            p.acted = True
            if p.chips == 0:
                p.all_in = True
            self._log(f"{p.name} calls {call_amt}")
        elif action in ("raise", "bet"):
            # amount = total bet size for this round (target)
            target = int(amount)
            if target <= self.current_bet:
                # allow all-in shove smaller than min raise
                if p.chips + p.bet <= self.current_bet:
                    target = p.chips + p.bet
                else:
                    return False, "Raise must exceed current bet"
            need = target - p.bet
            if need > p.chips:
                return False, "Not enough chips"
            # enforce min raise unless all-in
            raise_by = target - self.current_bet
            if raise_by < self.min_raise and need < p.chips:
                return False, f"Min raise is {self.min_raise}"
            self._move_chips(p, need)
            if raise_by >= self.min_raise:
                self.min_raise = raise_by
            self.current_bet = max(self.current_bet, p.bet)
            if p.chips == 0:
                p.all_in = True
            # reopen action: everyone else must act again
            for o in self.players:
                if o is not p and o.in_hand and not o.folded and not o.all_in:
                    o.acted = False
            p.acted = True
            self._log(f"{p.name} {'bets' if action=='bet' else 'raises to'} {p.bet}")
        else:
            return False, "Unknown action"

        self._advance()
        return True, None

    def _move_chips(self, p, amt):
        amt = min(amt, p.chips)
        p.chips -= amt
        p.bet += amt
        p.total_committed += amt
        self.pot += amt

    def _betting_complete(self):
        actors = self._players_can_act()
        # everyone who can act has matched current bet and acted
        for p in actors:
            if not p.acted or p.bet != self.current_bet:
                return False
        return True

    def _advance(self):
        # hand ends if only one player left
        if len(self._players_in()) == 1:
            self._end_hand_no_showdown()
            return

        if self._betting_complete():
            self._next_stage()
        else:
            # find next player who can act (tolerate a vanished current player)
            cur_i = next((i for i, p in enumerate(self.players) if p.sid == self.current),
                         self.button % max(len(self.players), 1))
            n = len(self.players)
            for step in range(1, n + 1):
                j = (cur_i + step) % n
                q = self.players[j]
                if q.in_hand and not q.folded and not q.all_in:
                    self.current = q.sid
                    return
            # nobody can act -> proceed
            self._next_stage()

    def _reset_round_bets(self):
        for p in self.players:
            p.bet = 0
            p.acted = False
        self.current_bet = 0
        self.min_raise = self.bb

    def _next_stage(self):
        self._reset_round_bets()
        # if <=1 can act (rest all-in), run out the board to showdown
        if len(self._players_can_act()) <= 1:
            while self.stage in ("preflop", "flop", "turn"):
                self._deal_next_street()
            self._showdown()
            return

        if self.stage == "preflop":
            self._deal_next_street()  # flop
        elif self.stage == "flop":
            self._deal_next_street()  # turn
        elif self.stage == "turn":
            self._deal_next_street()  # river
        elif self.stage == "river":
            self._showdown()
            return
        # set first to act after button (left of button)
        self.current = self._first_to_act_postflop()

    def _deal_next_street(self):
        if self.stage == "preflop":
            self.deck.pop()  # burn
            self.board += [self.deck.pop() for _ in range(3)]
            self.stage = "flop"
        elif self.stage == "flop":
            self.deck.pop()
            self.board.append(self.deck.pop())
            self.stage = "turn"
        elif self.stage == "turn":
            self.deck.pop()
            self.board.append(self.deck.pop())
            self.stage = "river"

    def _first_to_act_postflop(self):
        n = len(self.players)
        for step in range(1, n + 1):
            j = (self.button + step) % n
            q = self.players[j]
            if q.in_hand and not q.folded and not q.all_in:
                return q.sid
        return None

    def _end_hand_no_showdown(self):
        winner = self._players_in()[0]
        winner.chips += self.pot
        self.last_result = {
            "winners": [{"sid": winner.sid, "name": winner.name, "amount": self.pot, "hand": None}],
            "board": self.board,
            "reveal": {},
        }
        self._log(f"{winner.name} wins {self.pot} (everyone folded)")
        self.pot = 0
        self.stage = "showdown"
        self.current = None

    def _showdown(self):
        contenders = self._players_in()
        # evaluate
        scores = {}
        reveal = {}
        for p in contenders:
            sc = best_hand(p.hole + self.board)
            scores[p.sid] = sc
            reveal[p.sid] = {"hole": p.hole, "hand": hand_name(sc)}

        # build side pots based on total_committed
        # collect all committed amounts among everyone who put money in
        committed = [(p, p.total_committed) for p in self.players if p.total_committed > 0]
        levels = sorted(set(c for _, c in committed if c > 0))
        pots = []  # list of (amount, [eligible sids])
        prev = 0
        for lvl in levels:
            layer_players = [p for p, c in committed if c >= lvl]
            amount = (lvl - prev) * len(layer_players)
            eligible = [p.sid for p in layer_players if p in contenders]
            pots.append((amount, eligible))
            prev = lvl

        winners_summary = {}
        for amount, eligible in pots:
            if not eligible:
                # no contender eligible (all folded) -> give to best among committed? shouldn't happen
                continue
            best_score = max(scores[s] for s in eligible)
            winners = [s for s in eligible if scores[s] == best_score]
            share = amount // len(winners)
            rem = amount - share * len(winners)
            for i, s in enumerate(winners):
                pay = share + (1 if i < rem else 0)
                pl = self.get(s)
                pl.chips += pay
                winners_summary[s] = winners_summary.get(s, 0) + pay

        result_winners = []
        for s, amt in winners_summary.items():
            pl = self.get(s)
            result_winners.append({
                "sid": s, "name": pl.name, "amount": amt,
                "hand": reveal[s]["hand"],
            })
        result_winners.sort(key=lambda x: -x["amount"])
        self.last_result = {
            "winners": result_winners,
            "board": self.board,
            "reveal": reveal,
        }
        for w in result_winners:
            self._log(f"{w['name']} wins {w['amount']} with {w['hand']}")
        self.pot = 0
        self.stage = "showdown"
        self.current = None

    # ---- serialization ----
    def state(self, viewer_sid=None):
        reveal_all = self.stage == "showdown"
        btn_sid = None
        if self.players:
            btn_sid = self.players[self.button % len(self.players)].sid
        return {
            "stage": self.stage,
            "board": self.board,
            "pot": self.pot,
            "current": self.current,
            "current_bet": self.current_bet,
            "min_raise": self.min_raise,
            "button": btn_sid,
            "sb": self.sb, "bb": self.bb,
            "hand_no": self.hand_no,
            "last_result": self.last_result,
            "log": self.log[-8:],
            "players": [
                p.public(reveal=(reveal_all and not p.folded) or (viewer_sid == p.sid))
                for p in self.players
            ],
        }
