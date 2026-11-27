import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

import db

BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Alpaca Padel Americano API", lifespan=lifespan)


class CreateSessionRequest(BaseModel):
    played_date: str = ""
    location: str = ""
    players: List[str] = Field(..., min_length=4)
    target_points: int = 11
    title: str = ""


class UpdateSessionRequest(BaseModel):
    title: Optional[str] = None
    played_date: Optional[str] = None
    location: Optional[str] = None
    players: Optional[List[str]] = None
    target_points: Optional[int] = None
    current_match: Optional[Dict[str, Any]] = None
    status: Optional[str] = None


class AddRoundRequest(BaseModel):
    buzzPlayer: str = ""
    team1: List[str]
    team2: List[str]
    score1: int
    score2: int


class UpdateRoundRequest(BaseModel):
    score1: int
    score2: int


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/api/sessions")
def api_list_sessions():
    return {"sessions": db.list_sessions()}


@app.post("/api/sessions")
def api_create_session(body: CreateSessionRequest):
    clean_players = [p.strip() for p in body.players if p.strip()]
    if len(clean_players) < 4:
        raise HTTPException(status_code=400, detail="Mindestens 4 Spieler erforderlich.")
    session = db.create_session(
        played_date=body.played_date,
        location=body.location,
        players=clean_players,
        target_points=body.target_points,
        title=body.title,
    )
    return {
        "session": session,
        "url": f"https://padel.alpacaspace.xyz/?session={session['id']}",
    }


@app.get("/api/sessions/{session_id}")
def api_get_session(session_id: str):
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Spieltag nicht gefunden.")
    return {"session": session}


@app.patch("/api/sessions/{session_id}")
def api_update_session(session_id: str, body: UpdateSessionRequest):
    payload = body.model_dump(exclude_unset=True)
    session = db.update_session(session_id, payload)
    if not session:
        raise HTTPException(status_code=404, detail="Spieltag nicht gefunden.")
    return {"session": session}


@app.delete("/api/sessions/{session_id}")
def api_delete_session(session_id: str):
    if not db.delete_session(session_id):
        raise HTTPException(status_code=404, detail="Spieltag nicht gefunden.")
    return {"deleted": True}


@app.post("/api/sessions/{session_id}/rounds")
def api_add_round(session_id: str, body: AddRoundRequest):
    session = db.add_round(
        session_id=session_id,
        buzz_player=body.buzzPlayer,
        team1=body.team1,
        team2=body.team2,
        score1=body.score1,
        score2=body.score2,
    )
    if not session:
        raise HTTPException(status_code=404, detail="Spieltag nicht gefunden.")
    return {"session": session}


@app.patch("/api/sessions/{session_id}/rounds/{round_id}")
def api_update_round(session_id: str, round_id: str, body: UpdateRoundRequest):
    session = db.update_round(session_id, round_id, body.score1, body.score2)
    if not session:
        raise HTTPException(status_code=404, detail="Runde oder Spieltag nicht gefunden.")
    return {"session": session}


@app.delete("/api/sessions/{session_id}/rounds/{round_id}")
def api_delete_round(session_id: str, round_id: str):
    session = db.delete_round(session_id, round_id)
    if not session:
        raise HTTPException(status_code=404, detail="Runde oder Spieltag nicht gefunden.")
    return {"session": session}


@app.post("/api/sessions/{session_id}/reset")
def api_reset_session(session_id: str):
    session = db.reset_session_rounds(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Spieltag nicht gefunden.")
    return {"session": session}


@app.get("/api/stats/overall")
def api_overall_stats():
    return db.get_overall_stats()


def _static_file(filename: str, media_type: str):
    path = BASE_DIR / filename
    if not path.exists():
        return JSONResponse({"error": "Not found"}, status_code=404)
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-cache"})


@app.get("/")
def serve_index():
    return _static_file("index.html", "text/html; charset=utf-8")


@app.get("/index.html")
def serve_index_html():
    return _static_file("index.html", "text/html; charset=utf-8")


@app.get("/styles.css")
def serve_css():
    return _static_file("styles.css", "text/css; charset=utf-8")


@app.get("/app.js")
def serve_js():
    return _static_file("app.js", "application/javascript; charset=utf-8")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
