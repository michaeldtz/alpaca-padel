import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

DB_PATH = os.environ.get("PADEL_DB_PATH", "/app/data/padel.db")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_db_dir() -> None:
    db_dir = os.path.dirname(os.path.abspath(DB_PATH))
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)


@contextmanager
def get_conn():
    ensure_db_dir()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                played_date TEXT NOT NULL,
                location TEXT NOT NULL DEFAULT '',
                players_json TEXT NOT NULL,
                target_points INTEGER NOT NULL DEFAULT 11,
                current_match_json TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS rounds (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                round_num INTEGER NOT NULL,
                buzz_player TEXT NOT NULL,
                team1_json TEXT NOT NULL,
                team2_json TEXT NOT NULL,
                score1 INTEGER NOT NULL,
                score2 INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_rounds_session_num
                ON rounds(session_id, round_num);
            """
        )

        count = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        if count == 0:
            _seed_initial_session(conn)


def _seed_initial_session(conn: sqlite3.Connection) -> None:
    """Seed the 2026-11-26 opening session with its 7 recorded rounds."""
    now = _now_iso()
    session_id = "game_20261126_initial"
    players = ["Simon", "Tim", "Adrian", "Andre", "Michael"]
    seed_rounds = [
        ("round_1", 1, "Simon", ["Adrian", "Tim"], ["Michael", "Andre"], 11, 9),
        ("round_2", 2, "Tim", ["Adrian", "Michael"], ["Andre", "Simon"], 11, 5),
        ("round_3", 3, "Michael", ["Adrian", "Andre"], ["Tim", "Simon"], 11, 6),
        ("round_4", 4, "Adrian", ["Michael", "Simon"], ["Tim", "Andre"], 11, 5),
        ("round_5", 5, "Andre", ["Michael", "Tim"], ["Adrian", "Simon"], 11, 6),
        ("round_6", 6, "Simon", ["Adrian", "Tim"], ["Michael", "Andre"], 11, 8),
        ("round_7", 7, "Tim", ["Adrian", "Michael"], ["Andre", "Simon"], 11, 6),
    ]
    current_match = {
        "buzzPlayer": "Michael",
        "team1": ["Adrian", "Andre"],
        "team2": ["Tim", "Simon"],
        "score1": 0,
        "score2": 0,
    }
    conn.execute(
        """
        INSERT INTO sessions (
            id, title, played_date, location, players_json,
            target_points, current_match_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            "Auftakt-Runde",
            "2026-11-26",
            "Padel Court",
            json.dumps(players),
            11,
            json.dumps(current_match),
            "active",
            now,
            now,
        ),
    )
    for rid, rnum, buzz, t1, t2, s1, s2 in seed_rounds:
        conn.execute(
            """
            INSERT INTO rounds (
                id, session_id, round_num, buzz_player, team1_json, team2_json, score1, score2, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (rid, session_id, rnum, buzz, json.dumps(t1), json.dumps(t2), s1, s2, now),
        )


def generate_next_match(players: List[str], rounds: List[Dict[str, Any]], custom_buzz: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if len(players) < 4:
        return None

    # Repeat 5-round cycle when 5 players are active and >= 5 rounds were played
    if not custom_buzz and len(players) == 5 and len(rounds) >= 5:
        template = rounds[-5]
        tpl_players = [template["buzzPlayer"], *template["team1"], *template["team2"]]
        if len(tpl_players) == 5 and all(p in players for p in tpl_players):
            return {
                "buzzPlayer": template["buzzPlayer"],
                "team1": list(template["team1"]),
                "team2": list(template["team2"]),
                "score1": 0,
                "score2": 0,
            }

    buzz_player = custom_buzz
    if not buzz_player:
        if len(players) == 4:
            buzz_player = ""
        else:
            rest_counts = {p: 0 for p in players}
            for r in rounds:
                bp = r.get("buzzPlayer")
                if bp in rest_counts:
                    rest_counts[bp] += 1
            min_rest = min(rest_counts.values())
            candidates = [p for p in players if rest_counts[p] == min_rest]
            if len(candidates) == 1:
                buzz_player = candidates[0]
            else:
                best = candidates[0]
                max_since = -1
                for cand in candidates:
                    last_idx = -1
                    for i in range(len(rounds) - 1, -1, -1):
                        if rounds[i].get("buzzPlayer") == cand:
                            last_idx = i
                            break
                    since = len(rounds) - last_idx
                    if since > max_since:
                        max_since = since
                        best = cand
                buzz_player = best

    active = [p for p in players if p != buzz_player]
    games_played = {
        p: sum(1 for r in rounds if p in r["team1"] or p in r["team2"])
        for p in active
    }
    four = sorted(active, key=lambda p: games_played[p])[:4]

    partner_count: Dict[str, int] = {}
    opponent_count: Dict[str, int] = {}

    def pair_key(a: str, b: str) -> str:
        return "::".join(sorted([a, b]))

    for r in rounds:
        t1k = pair_key(r["team1"][0], r["team1"][1])
        t2k = pair_key(r["team2"][0], r["team2"][1])
        partner_count[t1k] = partner_count.get(t1k, 0) + 1
        partner_count[t2k] = partner_count.get(t2k, 0) + 1
        for p1 in r["team1"]:
            for p2 in r["team2"]:
                ok = pair_key(p1, p2)
                opponent_count[ok] = opponent_count.get(ok, 0) + 1

    options = [
        ([four[0], four[1]], [four[2], four[3]]),
        ([four[0], four[2]], [four[1], four[3]]),
        ([four[0], four[3]], [four[1], four[2]]),
    ]

    best_opt = options[0]
    min_pen = float("inf")
    for t1, t2 in options:
        p_pen = partner_count.get(pair_key(t1[0], t1[1]), 0) * 10 + partner_count.get(pair_key(t2[0], t2[1]), 0) * 10
        o_pen = sum(opponent_count.get(pair_key(p1, p2), 0) for p1 in t1 for p2 in t2)
        if p_pen + o_pen < min_pen:
            min_pen = p_pen + o_pen
            best_opt = (t1, t2)

    return {
        "buzzPlayer": buzz_player,
        "team1": best_opt[0],
        "team2": best_opt[1],
        "score1": 0,
        "score2": 0,
    }


def _row_to_round(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "roundNum": row["round_num"],
        "buzzPlayer": row["buzz_player"],
        "team1": json.loads(row["team1_json"]),
        "team2": json.loads(row["team2_json"]),
        "score1": row["score1"],
        "score2": row["score2"],
        "timestamp": row["created_at"],
    }


def _row_to_session_summary(row: sqlite3.Row, round_count: int) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "played_date": row["played_date"],
        "location": row["location"],
        "players": json.loads(row["players_json"]),
        "targetPoints": row["target_points"],
        "status": row["status"],
        "roundCount": round_count,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_sessions() -> List[Dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT s.*, COUNT(r.id) AS round_count
            FROM sessions s
            LEFT JOIN rounds r ON r.session_id = s.id
            GROUP BY s.id
            ORDER BY s.played_date DESC, s.created_at DESC
            """
        ).fetchall()
        return [_row_to_session_summary(row, row["round_count"]) for row in rows]


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return None
        round_rows = conn.execute(
            "SELECT * FROM rounds WHERE session_id = ? ORDER BY round_num ASC",
            (session_id,),
        ).fetchall()
        rounds = [_row_to_round(r) for r in round_rows]
        players = json.loads(row["players_json"])
        current_match = json.loads(row["current_match_json"]) if row["current_match_json"] else None
        if not current_match and len(players) >= 4:
            current_match = generate_next_match(players, rounds)
        return {
            "id": row["id"],
            "title": row["title"],
            "played_date": row["played_date"],
            "location": row["location"],
            "players": players,
            "targetPoints": row["target_points"],
            "currentMatch": current_match,
            "status": row["status"],
            "rounds": rounds,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }


def create_session(
    played_date: str,
    location: str,
    players: List[str],
    target_points: int = 11,
    title: str = "",
) -> Dict[str, Any]:
    now = _now_iso()
    clean_date = played_date.strip() or datetime.now().strftime("%Y-%m-%d")
    session_id = f"game_{clean_date.replace('-', '')}_{uuid.uuid4().hex[:6]}"
    current_match = generate_next_match(players, [])
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO sessions (
                id, title, played_date, location, players_json,
                target_points, current_match_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
            """,
            (
                session_id,
                title.strip(),
                clean_date,
                location.strip(),
                json.dumps(players),
                target_points,
                json.dumps(current_match) if current_match else None,
                now,
                now,
            ),
        )
    return get_session(session_id)  # type: ignore[return-value]


def update_session(session_id: str, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return None

        title = fields["title"].strip() if "title" in fields and fields["title"] is not None else row["title"]
        played_date = fields["played_date"].strip() if "played_date" in fields and fields["played_date"] is not None else row["played_date"]
        location = fields["location"].strip() if "location" in fields and fields["location"] is not None else row["location"]
        players_json = json.dumps(fields["players"]) if "players" in fields and fields["players"] is not None else row["players_json"]
        target_points = int(fields["target_points"]) if "target_points" in fields and fields["target_points"] is not None else row["target_points"]
        if "current_match" in fields:
            cm_json = json.dumps(fields["current_match"]) if fields["current_match"] is not None else None
        else:
            cm_json = row["current_match_json"]
        status = fields["status"] if "status" in fields and fields["status"] is not None else row["status"]
        now = _now_iso()

        conn.execute(
            """
            UPDATE sessions
            SET title = ?, played_date = ?, location = ?, players_json = ?,
                target_points = ?, current_match_json = ?, status = ?, updated_at = ?
            WHERE id = ?
            """,
            (title, played_date, location, players_json, target_points, cm_json, status, now, session_id),
        )
    return get_session(session_id)


def delete_session(session_id: str) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        return cur.rowcount > 0


def add_round(
    session_id: str,
    buzz_player: str,
    team1: List[str],
    team2: List[str],
    score1: int,
    score2: int,
) -> Optional[Dict[str, Any]]:
    session = get_session(session_id)
    if not session:
        return None
    now = _now_iso()
    round_num = len(session["rounds"]) + 1
    round_id = f"round_{uuid.uuid4().hex[:10]}"

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO rounds (
                id, session_id, round_num, buzz_player, team1_json, team2_json, score1, score2, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (round_id, session_id, round_num, buzz_player, json.dumps(team1), json.dumps(team2), score1, score2, now),
        )

    updated_session = get_session(session_id)
    if updated_session:
        next_match = generate_next_match(updated_session["players"], updated_session["rounds"])
        return update_session(session_id, {"current_match": next_match})
    return None


def update_round(session_id: str, round_id: str, score1: int, score2: int) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE rounds SET score1 = ?, score2 = ? WHERE id = ? AND session_id = ?",
            (score1, score2, round_id, session_id),
        )
        if cur.rowcount == 0:
            return None
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (_now_iso(), session_id))
    return get_session(session_id)


def delete_round(session_id: str, round_id: str) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM rounds WHERE id = ? AND session_id = ?", (round_id, session_id))
        if cur.rowcount == 0:
            return None
        remaining = conn.execute(
            "SELECT id FROM rounds WHERE session_id = ? ORDER BY round_num ASC",
            (session_id,),
        ).fetchall()
        for idx, r in enumerate(remaining, start=1):
            conn.execute("UPDATE rounds SET round_num = ? WHERE id = ?", (idx, r["id"]))
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (_now_iso(), session_id))
    return get_session(session_id)


def reset_session_rounds(session_id: str) -> Optional[Dict[str, Any]]:
    session = get_session(session_id)
    if not session:
        return None
    with get_conn() as conn:
        conn.execute("DELETE FROM rounds WHERE session_id = ?", (session_id,))
    next_match = generate_next_match(session["players"], [])
    return update_session(session_id, {"current_match": next_match})


def get_overall_stats() -> Dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM rounds").fetchall()
        sessions_count = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        known_players = set()
        locations = set()
        for s in conn.execute("SELECT players_json, location FROM sessions").fetchall():
            for p in json.loads(s["players_json"]):
                known_players.add(p)
            if s["location"]:
                locations.add(s["location"])

    stats: Dict[str, Dict[str, Any]] = {}
    for p in known_players:
        stats[p] = {
            "name": p,
            "points": 0,
            "conceded": 0,
            "diff": 0,
            "played": 0,
            "wins": 0,
            "losses": 0,
            "avg": "0.0",
        }

    for r in rows:
        s1 = int(r["score1"] or 0)
        s2 = int(r["score2"] or 0)
        t1 = json.loads(r["team1_json"])
        t2 = json.loads(r["team2_json"])
        for team, own, opp in [(t1, s1, s2), (t2, s2, s1)]:
            for p in team:
                if p not in stats:
                    stats[p] = {
                        "name": p,
                        "points": 0,
                        "conceded": 0,
                        "diff": 0,
                        "played": 0,
                        "wins": 0,
                        "losses": 0,
                        "avg": "0.0",
                    }
                stats[p]["points"] += own
                stats[p]["conceded"] += opp
                stats[p]["played"] += 1
                if own > opp:
                    stats[p]["wins"] += 1
                elif opp > own:
                    stats[p]["losses"] += 1

    leaderboard = []
    for item in stats.values():
        item["diff"] = item["points"] - item["conceded"]
        item["avg"] = f"{item['points'] / item['played']:.1f}" if item["played"] > 0 else "0.0"
        leaderboard.append(item)

    leaderboard.sort(key=lambda x: (-x["points"], -x["diff"], -x["wins"], x["name"]))
    return {
        "sessionsCount": sessions_count,
        "roundsCount": len(rows),
        "knownPlayers": sorted(known_players),
        "knownLocations": sorted(locations),
        "leaderboard": leaderboard,
    }
