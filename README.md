# Fantasy Draft Assistant 🏟️

A **Spring Boot + React** multi-sport draft assistant supporting fantasy baseball and football.  
Baseball: 12-team H2H weekly-categories league with snake draft, keeper support, live pick tracking, positional scarcity scoring, and MLB Stats API integration.  
Football: PPR / Standard / Half-PPR / Custom JSON scoring with VBD-based recommendations.

---

## Prerequisites

Install these once on any PC you want to run the app on:

| Tool | Min Version | Download |
|------|-------------|---------|
| **Git** | any | https://git-scm.com/downloads |
| **Java JDK** | 17 | https://adoptium.net (grab the LTS installer) |
| **Node.js** | 20 | https://nodejs.org (LTS version) |

> Gradle is **bundled** — no separate install needed.  
> After installing Java and Node, close and reopen any terminal so the new PATH takes effect.

---

## First-time setup

```powershell
# 1. Clone the repo
git clone https://github.com/jklecker/FantasyDraftAssistant.git
cd FantasyDraftAssistant

# 2. Install frontend dependencies (one-time only)
cd frontend
npm ci
cd ..
```

---

## Running locally

From the project root in PowerShell:

```powershell
.\start-dev.ps1
```

This opens **two terminal windows** — one for the backend, one for the frontend:

| | URL |
|--|-----|
| Backend (Spring Boot) | http://localhost:8080 |
| Frontend (React) | http://localhost:3000 |

Open **http://localhost:3000** in your browser.  
> The frontend runs on port 3000 (configured in `frontend/vite.config.js`).  
> First boot takes ~30 seconds while Gradle warms up. Subsequent starts are faster.

---

## Typical draft workflow

### 1 — Initialize the draft

Send team names in snake-order pick position (first team listed picks first in round 1).

```bash
curl -s -X POST http://localhost:8080/draft/initialize \
  -H "Content-Type: application/json" \
  -d '{
    "teamNames": ["The Lumber Co.", "Ace Factory", "Speed Demons"],
    "snakeOrder": true
  }'
```

### 2 — Load keepers (optional)

Use the **🔒 Keepers** tab in the UI, or curl.  Up to 2 keepers per team; specify the round the keeper slot occupies.

```bash
curl -s -X POST http://localhost:8080/draft/load-keepers \
  -H "Content-Type: application/json" \
  -d '{
    "keepers": [
      {"teamName": "The Lumber Co.", "playerId": 1, "round": 2},
      {"teamName": "Ace Factory",    "playerId": 5, "round": 1}
    ]
  }'
```

### 3 → N — Draft players

Use the **📋 Draft Board** tab:
- **On the Clock** shows the current team, round/pick, and which positions they still need.
- **Recommendations** shows the top 5 players by BPA score + positional urgency. After round 10 upside/ceiling is also weighted.
- Search any player by name → click **Submit Pick**.
- **Team Rosters** tracks every team's picks in real time.

---

## API reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/draft/initialize` | Start a draft — team names + snake-order flag |
| `POST` | `/draft/load-keepers` | Assign keepers before drafting |
| `POST` | `/draft/pick?playerId=` | Submit the next pick |
| `GET`  | `/draft/current-team` | Team currently on the clock |
| `GET`  | `/draft/recommendations?teamId=&round=` | Top 5 picks for a team |
| `GET`  | `/draft/positional-needs?teamId=` | Positions still needed e.g. `{"C":1,"OF":2}` |
| `GET`  | `/draft/players?q=` | Search available players by name |
| `GET`  | `/draft/state` | Full draft state |

---

## Player pool

Player stats are fetched automatically from the **MLB Stats API** (`statsapi.mlb.com`) on startup — no account, no key, no manual download needed.  The app pulls the most recent completed season (configured via `mlb.stats.season` in `application.properties`, default `2025`).

If the API is unreachable the app falls back to the bundled `src/main/resources/players.csv`.  That file contains a small set of sample players and is only there as a safety net.

---

## Scoring model (H2H weekly categories)

**Base weights:** R +1.0, H +0.8, HR +1.5, RBI +1.0, SB +1.2, BB +0.3, K −0.7, IP +0.5, W +1.0, SV +1.5, pK +0.7, L −1.0, pBB −0.5, ERA −2.0 (if IP>0), WHIP −3.0 (if IP>0)

**Team-need bonuses:** SB boost if team SB < 10 · K penalty if team K > 100 · SV boost if team SV = 0 · HR boost if team HR < 10

**Positional scarcity:** players at positions your team still needs get an urgency bonus scaled by how few remain in the pool (up to +50 pts for the last one standing)

**Late-round upside (round 11+):** ceiling score grows linearly each round past 10 — favours high HR/SB batters and high K-rate pitchers

---

## Running tests

```powershell
# Backend
.\gradlew.bat test

# Frontend
cd frontend
npm ci
npm test -- --watchAll=false
```

## Render / Docker note

The frontend Docker build is pinned to **Node 20** and now uses the committed `frontend/package-lock.json` so Render resolves the same dependency tree as local development. If Render previously cached a bad install, trigger a **Clear build cache & deploy** from the Render dashboard once after pulling the latest commit.

---

## Project structure

```
FantasyDraftAssistant/
├── start-dev.ps1              ← run this to start everything locally
├── Dockerfile                 ← production build
├── render.yaml                ← Render deployment config
├── frontend/
│   └── src/
│       ├── App.js
│       ├── App.test.js
│       └── index.css
└── src/main/
    ├── java/com/example/fantasybaseball/
    │   ├── controller/
    │   ├── service/
    │   ├── model/
    │   └── util/
    └── resources/
        ├── application.properties
        └── players.csv        ← fallback sample data if MLB API fetch is unavailable
```
