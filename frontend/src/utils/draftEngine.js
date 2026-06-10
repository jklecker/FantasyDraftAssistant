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

// Positions that should never appear in skill-position recommendations (bestPick, upsidePick).
// DST and K are always drafted in the final rounds — surfacing them as "best pick" is misleading.
const LATE_ROUND_POSITIONS = new Set(['DST', 'K']);

/**
 * Primary sort score: ADP when stats are synthetic, VBD when real projections exist.
 * DST/K are capped to a low score so they never surface above skill positions in top10.
 */
function primaryScore(player) {
  // Hard cap: DST/K should never outrank skill positions in overall recommendations.
  if (LATE_ROUND_POSITIONS.has(player.position)) return -1;

  const hasRealStats = Object.keys(player.projections?.rawStats ?? {}).length > 0;
  if (hasRealStats) {
    return player.vbd ?? player.projections?.fantasyPoints ?? 0;
  }
  // Synthetic/no stats — sort by consensus ADP ascending (invert so higher score = better)
  const adp = player.adp ?? player.rankings?.overall ?? 999;
  return 10000 - adp * 10;
}

/**
 * Expected overall ADP for a player given their position and positional rank.
 * Mirrors ESPN Top 300 distribution: RBs scarce early, QBs/Ks wait til late.
 * These multipliers match the backend MarkdownRankingsService.estimateOverall().
 */
function expectedAdp(position, posRank) {
  switch (position) {
    case 'RB':  return posRank * 3;         // RB1≈3,  RB5≈15, RB10≈30
    case 'WR':  return posRank * 3 + 2;     // WR1≈5,  WR5≈17, WR10≈32
    case 'QB':  return posRank * 8;         // QB1≈8,  QB2≈16  (wait on QB)
    case 'TE':  return posRank * 9 + 1;     // TE1≈10, TE2≈19
    case 'K':   return posRank * 2 + 170;   // Ks go very late
    case 'DST': return posRank * 2 + 160;
    default:    return posRank * 6;
  }
}

/**
 * Value score = how many picks LATER than positionally expected this player is sitting.
 * Positive = steal/value — they should have gone earlier based on their position rank.
 * e.g. WR5 sitting at ADP 35 when WR5s typically go at pick 17 → score = +18
 * PFF grade bonus rewards players with strong analytics to break ties.
 */
function computeValueScore(player) {
  const adp = player.adp ?? 999;
  const posRank = player.rankings?.position ?? 999;
  const expected = expectedAdp(player.position, posRank);
  const base = adp - expected;
  const pffBonus = player.pff?.overallGrade ? player.pff.overallGrade * 0.1 : 0;
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

  // 1. Top 10 available skill positions — DST/K excluded (they go in the final rounds)
  const top10 = [...pool]
    .filter(p => !LATE_ROUND_POSITIONS.has(p.position))
    .sort((a, b) => primaryScore(b) - primaryScore(a))
    .slice(0, 10);

  // 2. Top players by position
  const topByPosition = {};
  for (const pos of positions) {
    topByPosition[pos] = getTopPlayersByPosition(pool, pos, 5);
  }

  // 3A. Best Pick — highest VBD among skill positions only (QB/RB/WR/TE).
  // DST and K are always late-round picks; never recommend them as "best pick".
  const bestPick = [...pool]
    .filter(p => !LATE_ROUND_POSITIONS.has(p.position))
    .sort((a, b) => primaryScore(b) - primaryScore(a))
    .slice(0, 3);

  // 3B. Best Value — players sitting significantly later in ADP than their positional
  // tier suggests. A WR5 available at pick 35 when WR5s typically go at pick 17 = +18 value.
  // Scoped to within ~3 rounds of the current pick so late sleepers don't surface early.
  const valueWindow = currentPick + teamSize * 3;
  const bestValue = [...pool]
    .filter(p => (p.adp ?? 999) <= valueWindow)
    .map(p => ({ ...p, _valueScore: computeValueScore(p) }))
    .filter(p => p._valueScore > 8)   // at least ~1 round later than expected
    .sort((a, b) => b._valueScore - a._valueScore)
    .slice(0, 3)
    .map(({ _valueScore, ...p }) => ({ ...p, valueScore: _valueScore }));

  // 3C. Won't Make It Back — ADP < nextPick (will be gone before you pick again).
  // Skill positions only — no point warning about DST/K going early (they shouldn't).
  const effectiveNextPick = nextPick ?? currentPick + 1;
  const wontMakeItBack = [...pool]
    .filter(p => !LATE_ROUND_POSITIONS.has(p.position))
    .filter(p => (p.adp ?? 999) < effectiveNextPick && (p.adp ?? 999) >= currentPick)
    .sort((a, b) => primaryScore(b) - primaryScore(a))
    .slice(0, 5);

  // 3D. Upside Pick — high breakout score among skill positions only
  const withBreakout = pool
    .filter(p => !LATE_ROUND_POSITIONS.has(p.position))
    .map(p => ({ ...p, _breakout: computeBreakoutScore(p) }));
  const breakoutThreshold = 5;
  const upsidePick = withBreakout
    .filter(p => p._breakout > breakoutThreshold)
    .sort((a, b) => b._breakout - a._breakout)
    .slice(0, 3)
    .map(({ _breakout, ...p }) => ({ ...p, breakoutScore: _breakout }));

  return { top10, topByPosition, bestPick, bestValue, wontMakeItBack, upsidePick };
}
