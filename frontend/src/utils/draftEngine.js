/**
 * Frontend draft engine — sport-agnostic.
 * Produces the four recommendation categories from the universal player model.
 *
 * Inputs:
 *   availablePlayers  - array of universal player objects (isDrafted === false)
 *   draftedPlayers    - array of universal player objects already drafted
 *   currentPick       - current overall pick number (1-based)
 *   nextPick          - your next pick number (used for "Won't Make It Back")
 *
 * Outputs: { bestPick, bestValue, wontMakeItBack, upsidePick, topByPosition }
 */

/**
 * Primary sort score: ADP when stats are synthetic, VBD when real projections exist.
 * When stats are null (off-season or API gaps), VBD is computed from ADP-synthetic pts
 * which inflates TEs due to low replacement baselines. Use ADP directly in that case
 * since it already encodes consensus expert opinion across position groups.
 */
function primaryScore(player) {
  const hasRealStats = Object.keys(player.projections?.rawStats ?? {}).length > 0;
  if (hasRealStats) {
    // Real projections — use VBD (positional scarcity-adjusted value)
    return player.vbd ?? player.projections?.fantasyPoints ?? 0;
  }
  // Synthetic/no stats — sort by consensus ADP ascending (invert so higher score = better)
  const adp = player.adp ?? player.rankings?.overall ?? 999;
  return 10000 - adp * 10;
}

/**
 * Compute a value score from adp vs overall ranking.
 * Positive = player available later than expected (good value).
 */
function computeValueScore(player) {
  const adp = player.adp ?? 999;
  const overall = player.rankings?.overall ?? 999;
  const base = adp - overall;
  const pffBonus = player.pff?.overallGrade ? player.pff.overallGrade * 0.2 : 0;
  return base + pffBonus;
}

/**
 * Compute a breakout/upside score from Next Gen Stats + PFF.
 * Safe to call when fields are missing.
 */
function computeBreakoutScore(player) {
  const ng = player.nextGen ?? {};
  const pff = player.pff ?? {};

  let score = 0;
  score += (ng.targetShare ?? 0) * 50;
  score += (ng.airYards ?? 0) * 0.1;
  score += pff.yardsPerRouteRun != null ? pff.yardsPerRouteRun * 2 : 0;
  score += pff.overallGrade != null ? pff.overallGrade * 0.3 : 0;
  // Rush upside
  score += (ng.rushShare ?? 0) * 30;
  score += (ng.redZoneTouches ?? 0) * 2;

  return score;
}

/**
 * Return top N available players at a given position.
 * @param {Array}  players
 * @param {string} position
 * @param {number} limit
 */
export function getTopPlayersByPosition(players, position, limit = 5) {
  return players
    .filter(p => !p.isDrafted && p.position === position)
    .sort((a, b) => (b.projections?.fantasyPoints ?? 0) - (a.projections?.fantasyPoints ?? 0))
    .slice(0, limit);
}

/**
 * Main draft engine.
 */
export function runDraftEngine({ availablePlayers, draftedPlayers = [], currentPick = 1, nextPick = null, positions = [], teamSize = 12 }) {
  const pool = availablePlayers.filter(p => !p.isDrafted);

  // 1. Top 10 available overall — ranked by VBD (positional scarcity-adjusted)
  const top10 = [...pool]
    .sort((a, b) => primaryScore(b) - primaryScore(a))
    .slice(0, 10);

  // 2. Top players by position
  const topByPosition = {};
  for (const pos of positions) {
    topByPosition[pos] = getTopPlayersByPosition(pool, pos, 5);
  }

  // 3A. Best Pick — highest VBD (scarcity-adjusted value), not raw projected points.
  // A QB at 400 pts loses to an RB at 350 if the RB's positional drop-off is steeper.
  const bestPick = [...pool]
    .sort((a, b) => primaryScore(b) - primaryScore(a))
    .slice(0, 3);

  // 3B. Best Value — players available later than their VBD rank suggests,
  // scoped to within ~2 rounds of the current pick so round-1 picks don't surface
  // round-10 sleepers as "value" (e.g. Justin Fields at ADP 120 is irrelevant at pick 1).
  const valueWindow = currentPick + teamSize * 2;
  const bestValue = [...pool]
    .filter(p => (p.vbd ?? 0) > 0)
    .filter(p => (p.adp ?? 999) <= valueWindow)
    .map(p => ({ ...p, _valueScore: computeValueScore(p) }))
    .filter(p => p._valueScore > 5)
    .sort((a, b) => b._valueScore - a._valueScore)
    .slice(0, 3)
    .map(({ _valueScore, ...p }) => ({ ...p, valueScore: _valueScore }));

  // 3C. Won't Make It Back — ADP < nextPick (will be gone before you pick again)
  const effectiveNextPick = nextPick ?? currentPick + 1;
  const wontMakeItBack = [...pool]
    .filter(p => (p.adp ?? 999) < effectiveNextPick && (p.adp ?? 999) >= currentPick)
    .sort((a, b) => primaryScore(b) - primaryScore(a))
    .slice(0, 5);

  // 3D. Upside Pick — high breakout score
  const withBreakout = pool.map(p => ({ ...p, _breakout: computeBreakoutScore(p) }));
  const breakoutThreshold = 5; // only flag meaningful upside
  const upsidePick = withBreakout
    .filter(p => p._breakout > breakoutThreshold)
    .sort((a, b) => b._breakout - a._breakout)
    .slice(0, 3)
    .map(({ _breakout, ...p }) => ({ ...p, breakoutScore: _breakout }));

  return { top10, topByPosition, bestPick, bestValue, wontMakeItBack, upsidePick };
}
