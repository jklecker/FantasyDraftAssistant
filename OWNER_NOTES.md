or # Owner Notes — Fantasy Baseball Draft Assistant

> **This file is gitignored and never committed.**  
> Personal deployment steps, account links, and config notes live here.

---

## Accounts needed

| Service | Purpose | Link | Free? |
|---------|---------|------|-------|
| **GitHub** | Hosts the code, triggers deploys | https://github.com | ✅ |
| **Render** | Hosts the live app | https://render.com | ✅ no card needed |

---

## How the hosted version works

The `Dockerfile` does a 3-stage build:
1. **Node 20** builds the React frontend into static files using the committed lockfile
2. **Gradle** bakes those static files into the Spring Boot JAR so everything runs on a single port
3. A **tiny JRE image** runs the JAR

Render deploys that image and gives you a public URL like:  
`https://fantasy-draft-assistant.onrender.com`

Anyone with the URL can open it in a browser — desktop or phone, no setup required.

> ⚠️ **Draft state is in-memory.** If Render restarts the container (happens after ~15 min of
> inactivity on the free tier) the state is wiped. For a real draft, run locally instead.
> For casual testing sessions among friends this is totally fine — just re-initialize.

---

## First-time Render deployment

### Step 1 — Push the repo to GitHub

```powershell
# From the project root (first time)
git remote add origin https://github.com/jklecker/FantasyDraftAssistant.git
git push -u origin main
```

If the repo already exists on GitHub, just push any pending changes:

```powershell
git add -A
git commit -m "your message"
git push
```

### Step 2 — Connect Render to GitHub

1. Go to https://render.com and sign in (or create a free account).
2. Click **New +** → **Web Service**.
3. Choose **Build and deploy from a Git repository** → connect your GitHub account if not already.
4. Select the **FantasyDraftAssistant** repo.
5. Render will detect `render.yaml` automatically and pre-fill all settings.
6. Click **Create Web Service** and wait ~5 minutes for the first build.

That's it. Your live URL will show on the Render dashboard once it's up.

> If a deploy fails with an npm / `ajv-keywords` error, use **Manual Deploy → Clear build cache & deploy** once after pushing the latest commit. That forces Render to reinstall from the new `frontend/package-lock.json`.

### Step 3 — Share the URL

Copy the URL from the Render dashboard and share it with whoever you want to test with.  
No accounts or setup needed on their end — just open the link.

---

## Subsequent deployments (updating the app)

Every `git push` to `main` triggers an automatic redeploy on Render.

```powershell
git add -A
git commit -m "update player projections"
git push
```

Render will rebuild and deploy. Takes ~5 minutes. The old version stays live until the new one is ready.

---

## Player pool

Player stats are fetched **automatically on startup** from the MLB Stats API (`statsapi.mlb.com`) — free, no auth, no manual steps needed. The season is controlled by `mlb.stats.season` in `application.properties` (currently `2025`). Update that value each year before your draft and redeploy.

> ⚠️ These are **last season's actual stats**, not forward projections. They're a solid baseline, but for sharper projections see the optional FanGraphs section below.

### Changing the season

```properties
# src/main/resources/application.properties
mlb.stats.season=2026   # once the 2026 season has enough data
```

Commit, push, Render redeploys automatically.

---

### Optional: use FanGraphs Steamer projections instead

If you want forward projections rather than last year's actuals, you can override the player pool with a CSV. The app falls back to `src/main/resources/players.csv` if the MLB API is unreachable, but you can also force CSV use by pointing the config at a pre-built file.

**Step 1 — Download free projections from FanGraphs**

1. Go to **https://www.fangraphs.com/projections** (free account required)
2. Set Type = **Steamer**, click Batting tab → **Export Data** → save as `fangraphs_batting.csv`
3. Pitching tab → **Export Data** → save as `fangraphs_pitching.csv`

**Step 2 — Run the conversion script** (Python 3.9+ required, no extra packages)

```powershell
python tools/import_fangraphs.py `
    --batters  fangraphs_batting.csv `
    --pitchers fangraphs_pitching.csv `
    --out      src\main\resources\players.csv
```

**Step 3 — Disable the MLB API fetch** so the CSV is used instead

```properties
# application.properties — comment out the API season to force CSV
# mlb.stats.season=2025
```

Then commit, push, and Render will redeploy with the projection data.

---

### Optional: use ESPN Fantasy Baseball projections instead

Pulls directly from the same projections page ESPN uses for their fantasy drafts:
`https://fantasy.espn.com/baseball/players/projections`

**Step 1 — Get your ESPN cookies (one-time, ~60 seconds)**

1. Open Chrome/Edge/Firefox → go to **https://fantasy.espn.com/baseball/players/projections**
2. Log in with any free ESPN account.
3. Press **F12** → **Application** tab → **Cookies** → `https://fantasy.espn.com`
4. Copy the value of `SWID` (looks like `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`)
5. Copy the value of `espn_s2` (long string starting with `AE…`)

**Step 2 — Run the import script**

```powershell
python tools/import_espn.py `
    --swid    "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" `
    --espn-s2 "AE4longstringhere..." `
    --season  2026 `
    --out     src\main\resources\players.csv
```

Default filters (adjust with `--min-pa` / `--min-ip`):
- Batters: projected plate appearances ≥ 80
- Pitchers: projected innings pitched ≥ 20

**Step 3 — Verify stat mappings (first run only)**

ESPN occasionally renumbers their internal stat IDs between seasons. Run with `--probe` once to dump the raw keys and compare them to the mapping table at the top of `tools/import_espn.py`:

```powershell
python tools/import_espn.py --swid "..." --espn-s2 "..." --probe
```

If any keys differ, update the constants at the top of the script (the section labelled `ESPN stat IDs`).

**Step 4 — Disable the MLB API fetch** so the CSV is used instead

```properties
# application.properties
# mlb.stats.season=2026
```

Then commit, push, and Render redeploys automatically.

---

## Render free tier limits

| Limit | Value |
|-------|-------|
| RAM | 512 MB (Spring Boot uses ~250 MB) |
| CPU | Shared |
| Spin-down | After 15 min of no requests |
| Wake-up time | ~30–60 seconds |
| Hours/month | 750 (enough for always-on if active) |
| Custom domain | Supported on free tier |

---

## Useful Render dashboard actions

| Task | Where |
|------|-------|
| See live logs | Service → Logs tab |
| Trigger a manual redeploy | Service → Manual Deploy → Deploy latest commit |
| Restart the service | Service → Settings → Restart |
| Change the service name / URL | Service → Settings → Name |

---

## Local dev reminder

```powershell
# From project root — opens backend (:8080) and frontend (:3000) in separate windows
.\start-dev.ps1
```

Local state persists as long as both windows stay open. Safe to use for actual draft day.
