# Alpaca Padel Americano

Mobile-first Padel Americano scorekeeper with SQLite persistence and multi-game (Spieltage) management.

## API (Local / Ranch Access)

Base URL on Mac host: `http://localhost:30309`  
Public URL (Cloudflare Access): `https://padel.alpacaspace.xyz`

### Create a new game (Spieltag)
```bash
curl -sS -X POST http://localhost:30309/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "played_date": "2026-11-27",
    "location": "Padel Club Alzey",
    "players": ["Simon", "Tim", "Adrian", "Andre", "Michael"],
    "target_points": 11,
    "title": "Freitagsrunde"
  }'
```
Returns `{ "session": {...}, "url": "https://padel.alpacaspace.xyz/?session=<id>" }`.
