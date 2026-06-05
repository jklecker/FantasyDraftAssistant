# 2026 Fantasy Football — Data Sources Reference

> Created: June 5, 2026  
> **Refresh this doc before the draft (target: early August 2026).**  
> Draft season typically opens ~Aug 1. Leagues usually draft late August to early September.

---

## Active Scrapers (wired into `NflDataMergeService`)

| # | Service Class | Source | URL | Scoring | Cache | Reliability |
|---|---------------|--------|-----|---------|-------|-------------|
| 1 | `NflPlayerService` | Sleeper API | `https://api.sleeper.app/v1/players/nfl` | N/A (player pool) | 6h | ✅ Very stable JSON API |
| 2 | `FantasyProsService` | FantasyPros ECR + Projections | `https://www.fantasypros.com/nfl/rankings/ppr-cheatsheet.php` | PPR/Std/Half | 6h | ✅ Stable — primary consensus source |
| 3 | `EspnAdpService` | ESPN ADP | `https://fantasy.espn.com/apis/v3/games/ffl/seasons/2026/players?view=kona_player_info` | PPR/Std | 6h | ✅ Stable JSON endpoint |
| 4 | `CbsRankingsService` | CBS Sports | `https://www.cbssports.com/fantasy/football/rankings/` | PPR/Std | 8h | ⚠️ Scraped HTML — may break if CBS redesigns |
| 5 | `MarkdownRankingsService` | Matthew Berry / local file | `src/main/resources/rankings-2026.md` | PPR | ∞ | ✅ Local file — always available; manually updated |
| 6 | `DraftSharksService` | DraftSharks | `https://www.draftsharks.com/rankings/ppr` | PPR/Std/Half | 12h | ⚠️ Scraped HTML — 3-strategy parser |
| 7 | `FantasyLifeService` | Fantasy Life | `https://www.fantasylife.com/fantasy-football-rankings` | Overall | 12h | ⚠️ Next.js SPA — tries __NEXT_DATA__ first |
| 8 | `YahooBooneService` | Yahoo / Justin Boone | See URL below | Overall | 24h | ⚠️ Article-based — URL changes yearly |

**Composite rank** = mean of all available per-source ranks. `sourceCount` (0–7) stored in player's `nextGen` map.  
UI shows ●●●●●●● dots: green ≥ 5, orange 2–4, gray 1.

---

## Yearly Renewal Checklist (do before August drafts)

### August tasks

- [ ] **Update `YahooBooneService.ARTICLE_URL`** — Justin Boone publishes a new Top 300 article each July/August. Search "Justin Boone top 300 2026" on Yahoo Sports to get the new URL. File: `src/main/java/.../service/YahooBooneService.java` line ~35.
- [ ] **Update `rankings-2026.md`** (or create `rankings-2027.md`) — Copy the Matthew Berry positional rankings from `https://www.nbcsports.com/nfl/matthew-berry` once he publishes his pre-draft version. Update the classpath copy at `src/main/resources/rankings-2026.md`.
- [ ] **Update `MarkdownRankingsService`** — If you rename the md file, update `RANKINGS_FILE` constant.
- [ ] **Update `EspnAdpService` season year** — The ESPN ADP URL contains `/seasons/2026/`. Change to 2027 next year.
- [ ] **Verify CBS scraper still works** — CBS often tweaks HTML structure. Check `CbsRankingsService` table selectors against a real page request.
- [ ] **Verify FantasyPros URL** — FP URL slugs sometimes change format. Test `/nfl/status` endpoint and check `fpRankingsPpr` count.
- [ ] **Test `/nfl/status`** — Should return counts > 0 for all 7 active sources. If any are 0, debug that scraper first.
- [ ] **POST `/nfl/refresh`** — Bust all caches before the draft to get fresh data.

---

## Source Deep-Dives

### 1. Sleeper API
- **Endpoint**: `https://api.sleeper.app/v1/players/nfl`
- **Format**: JSON, ~2,000+ NFL players with `full_name`, `team`, `position`, `injury_status`, `bye_week`
- **Notes**: No auth required. Returns ALL NFL players including practice squad. We filter to active positions (QB/RB/WR/TE/K/DST).
- **Stability**: Very reliable — Sleeper has not changed this endpoint in years.

### 2. FantasyPros ECR
- **Rankings URL**: `https://www.fantasypros.com/nfl/rankings/ppr-cheatsheet.php` (PPR)
  - Standard: `/nfl/rankings/consensus-cheatsheet.php`
  - Half-PPR: `/nfl/rankings/half-point-ppr-cheatsheet.php`
- **Projections URL**: `https://www.fantasypros.com/nfl/projections/qb.php?week=draft` (per position)
- **Format**: HTML table with embedded JSON data
- **Notes**: Industry-standard ECR (Expert Consensus Rankings). Aggregates 100+ expert opinions. Also provides stat projections per position.
- **Stability**: Reliable but FP sometimes adds paywall restrictions mid-season.

### 3. ESPN ADP
- **Endpoint**: `https://fantasy.espn.com/apis/v3/games/ffl/seasons/2026/players?view=kona_player_info`
- **Format**: JSON — `onTeamId`, `defaultPositionId`, `ownership.averageDraftPosition`
- **Notes**: Live crowd-sourced ADP from millions of ESPN draft rooms. Update year in URL annually.
- **Stability**: Stable JSON API. Year parameter is the only thing that changes.

### 4. CBS Sports Rankings
- **URL**: `https://www.cbssports.com/fantasy/football/rankings/`
- **Format**: HTML table — scraped with Jsoup
- **Notes**: CBS publishes their own expert consensus. Good cross-check against FP.
- **Stability**: Medium — CBS has redesigned their rankings page 1–2x in recent years.

### 5. Matthew Berry (Local File)
- **Live URL**: `https://www.nbcsports.com/nfl/matthew-berry`
- **Local copy**: `src/main/resources/rankings-2026.md` (also at `src/Docs/football-2026/rankings-2026.md`)
- **Format**: Markdown table with positional ranks (QB/RB/WR/TE), age data, trade values
- **Notes**: Berry is the most recognizable name in fantasy football. His rankings carry strong signaling weight. Also includes age/ADP data used to patch player age in the merge pipeline.
- **Stability**: Always available — local file. Update manually each offseason.
- **Parsing**: `MarkdownRankingsService` uses regex to parse rank tables. Ranks converted to estimated overall rank using: QB×18, RB×5, WR×posRank×5+6, TE×posRank×12+40.

### 6. DraftSharks
- **PPR URL**: `https://www.draftsharks.com/rankings/ppr`
- **Standard**: `https://www.draftsharks.com/rankings/standard`
- **Half-PPR**: `https://www.draftsharks.com/rankings/half-ppr`
- **Format**: HTML — 3-strategy parser (table → data-rank attrs → embedded JSON)
- **Notes**: Consensus ranking aggregator. Good as a 5th validation point.
- **Stability**: Medium. Off-season pages may be empty/stale — handled gracefully.

### 7. Fantasy Life
- **Rankings URL**: `https://www.fantasylife.com/fantasy-football-rankings`
- **ADP URL**: `https://www.fantasylife.com/tools/nfl-adp` (not currently scraped — could add)
- **Trade Analyzer**: `https://www.fantasylife.com/tools/rate-my-trade`
- **Format**: Next.js SPA — tries `__NEXT_DATA__` JSON first, then table, then embedded JSON, then data attributes
- **Notes**: Fantasy Life aggregates ESPN, Yahoo, Underdog, Sleeper, and NFL.com ADP. Very useful ADP signal. May require updating parsing logic if they change their Next.js page structure.
- **Stability**: Medium. SPA scraping is brittle if they change their data serialization format.

### 8. Yahoo / Justin Boone Top 300
- **2026 URL**: `https://sports.yahoo.com/fantasy/article/2026-fantasy-football-rankings-justin-boone-top-300-players-155300098.html`
- **Format**: Article HTML with numbered player list (parsed by `YahooBooneService`)
- **Notes**: Justin Boone is Yahoo's lead fantasy analyst. Top 300 covers all skill positions. Article typically publishes mid-July to early August.
- **Stability**: Low — article URL changes every year and prose format can vary. Currently returns empty until the 2026 article is published.
- **Update**: Change `ARTICLE_URL` in `YahooBooneService.java` once the article publishes.

---

## Potential Future Sources

| Source | URL | Notes |
|--------|-----|-------|
| Fantasy Life ADP (JSON) | `https://www.fantasylife.com/tools/nfl-adp` | Crowd-sourced ADP from FL app users — very high signal |
| Underdog ADP | `https://underdogfantasy.com/rankings` | Best-ball ADP; strong signal for WR/TE value |
| FantasyPros ADP | `https://www.fantasypros.com/nfl/adp/overall.php` | FP's own ADP separate from ECR |
| NFL.com Rankings | `https://fantasy.nfl.com/research/rankings` | Default for casual leagues — useful for tier calibration |
| PFF Rankings | `https://www.pff.com/fantasy/rankings` | Premium analytics; page may require login |
| The Athletic | `https://theathletic.com/fantasy/` | Paywalled — not scrapeable |

---

## Scoring Format Reference

| Format | FP slug | ESPN ID | Notes |
|--------|---------|---------|-------|
| PPR | `ppr-cheatsheet` | scoring=0 | 1 pt/reception — most common |
| Standard | `consensus-cheatsheet` | scoring=2 | 0 pts/reception |
| Half-PPR | `half-point-ppr-cheatsheet` | scoring=4 | 0.5 pts/reception |
| ESPN Standard | same as Standard | — | Non-PPR; ESPN default for older leagues |

---

## API Health Check

After the draft date approaches, hit this endpoint to verify all sources are loading:

```
GET /nfl/status
```

Expected response (all counts > 0 = healthy):
```json
{
  "sleeperPlayerCount": 2100,
  "fpRankingsPpr": 280,
  "fpProjectionsPpr": 220,
  "espnRankingsPpr": 300,
  "cbsRankingsPpr": 200,
  "berryRankings": 69,
  "berryAgeData": 12,
  "draftSharksRankings": 200,
  "fantasyLifeRankings": 250,
  "yahooBooneRankings": 300
}
```

To bust all caches and pull fresh data: `POST /nfl/refresh`
