# FantasyDraftAssistant

Personal project — multi-sport fantasy draft assistant supporting baseball and football. Baseball: 12-team H2H weekly-categories league with live pick tracking, positional scarcity scoring, and MLB Stats API integration. Football: mock player data with ESPN Standard / PPR / Half-PPR / Custom JSON scoring and a frontend draft engine (bestPick, bestValue, wontMakeItBack, upsidePick).

## Tech Stack

- Backend: Java 17, Spring Boot 3.2.4, Gradle
- Frontend: React 18, Vite 5, Fuse.js (client-side search)
- Deployment: Docker multi-stage → Render

## Build & Run

```bash
# Local dev (opens two terminal windows — backend :8080, frontend :3000)
.\start-dev.ps1

# Backend only
./gradlew bootRun

# Frontend only
cd frontend && npm run dev

# Tests
./gradlew test                                        # backend
cd frontend && npm ci && npm test -- --watchAll=false  # frontend

# Production Docker build
docker build -t fantasy-baseball:latest .
```

## Structure

```
src/main/java/com/example/fantasybaseball/
├── controller/   # REST endpoints
├── service/      # Scoring, recommendations, draft state, FootballPlayerService
├── model/        # Player (sport, adp, pff, nextGen fields), Team, Draft, Pick
├── dto/          # API request/response DTOs
├── config/       # Spring config
└── util/         # Helpers

src/main/resources/
├── scoring-config.json      # Baseball scoring presets
└── football-players.json    # Mock NFL player pool

frontend/src/
├── config/
│   ├── sportConfig.js       # Per-sport positions, roster slots, scoring source
│   └── scoringSystems.js    # Football scoring presets (ESPN Standard, PPR, Half-PPR)
├── adapters/
│   ├── baseballAdapter.js   # Normalizes backend Player → universal model
│   └── footballAdapter.js   # Normalizes mock football data → universal model
├── utils/
│   ├── calculateFantasyPoints.js  # calculateFantasyPoints(stats, settings)
│   └── draftEngine.js             # bestPick, bestValue, wontMakeItBack, upsidePick
├── data/
│   └── footballPlayers.js   # Mock NFL player pool with PFF + Next Gen Stats
└── App.jsx                  # Main app — sport selector, all tabs
```

## Key Notes

- **Player pool**: fetched from MLB Stats API on startup (`statsapi.mlb.com`); season in `application.properties`; fallback: `src/main/resources/players.csv`
- **Draft state is in-memory** — resets on container restart (Render free tier idles after ~15 min)
- **Scoring model**: base weights for 15 MLB stats + team-need bonuses + positional scarcity bonuses (up to +50 pts) + late-round upside weighting (round 11+)
- **Render deployment**: auto-detected via `render.yaml`; uses committed `package-lock.json` for reproducible builds

## Memory (automatic)
A `memory` MCP server is available at `http://localhost:8002/mcp`. Use it proactively â€” do not wait for the user to ask.
- **Start of session**: Call `recall` with a query relevant to what you're working on.
- **When the user corrects you** or you discover a project convention: Call `remember` immediately.
- **End of session**: If significant decisions were made, call `save_session` with a summary.
