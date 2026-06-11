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
 * Value score = how far a player has slipped past their consensus ADP relative to the
 * current pick. If you're at pick 12 and Bijan (ADP 2) is still on the board, he has
 * slipped 10 spots → score = +10. This is true draft-day value: a player ranked higher
 * than where you're picking who is somehow still available.
 *
 * @param {object} player
 * @param {number} currentPick  the overall pick number you are about to make
 */
/**
 * Wheel-Turn Value score — how much positional quality you LOSE by waiting.
 *
 * tierGap = (this player's pts) - (best same-position player whose ADP > nextPick)
 *
 * Example: Pick 11, Mahomes available (470pts). Next surviving QB after the turn
 * has 380pts → tierGap = 90. You need a QB (needed=true) → wheelScore = 90 * 1.5 = 135.
 * Meanwhile RB8 (280pts) vs RB10 (265pts, survives turn) → tierGap = 15 → score = 22.
 * Result: take Mahomes, RBs are fine to wait on.
 *
 * @param {object} player
 * @param {Array}  pool           - all available (not drafted) players
 * @param {number} nextPick       - your next snake pick (null = currentPick+24)
 * @param {object} positionCounts - { QB:1, RB:2, ... } for my current roster
 * @param {object} rosterReq      - { QB:1, RB:2, WR:2, TE:1, FLEX:1, ... }
 * @param {Array}  flexPositions  - ['RB','WR','TE']
 */
function computeWheelTurnScore(player, pool, nextPick, positionCounts, rosterReq, flexPositions) {
  const pos = player.position;
  const myPts = player.projections?.fantasyPoints ?? 0;
  const reach = nextPick ?? 999;

  // Best same-position player who will likely survive until my next pick
  const willSurvive = pool.filter(p =>
    p.id !== player.id &&
    p.position === pos &&
    (p.adp ?? 999) > reach
  );
  const bestSurvivorPts = willSurvive.length > 0
    ? Math.max(...willSurvive.map(p => p.projections?.fantasyPoints ?? 0))
    : 0;

  const tierGap = Math.max(0, myPts - bestSurvivorPts);

  // Need multiplier: same logic as roster-aware score
  const have = positionCounts[pos] ?? 0;
  const startersNeeded = rosterReq[pos] ?? 0;
  const flexEligible = flexPositions.includes(pos);
  const flexStartersFilled = flexPositions.reduce((sum, fp) => {
    const h = positionCounts[fp] ?? 0;
    const need = rosterReq[fp] ?? 0;
    return sum + Math.max(0, h - need);
  }, 0);
  const flexSlots = rosterReq.FLEX ?? 0;
  const needsFlex = flexEligible && flexStartersFilled < flexSlots;
  const needed = have < startersNeeded || needsFlex;

  return tierGap * (needed ? 1.5 : 0.4);
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
 * Roster-aware Best Pick score. Core principle: take the best available player (by ADP)
 * AT A POSITION YOU STILL NEED. As your roster fills, positions you've stocked get pushed
 * down so you stop hoarding (3 RBs → stop drafting RBs, pivot to WR/QB/TE). A bounded
 * scarcity bonus lets a needed position jump a few ADP slots when its quality players are
 * about to dry up before your next pick (the "grab the last good QB" pivot).
 *
 * @param {object} player
 * @param {object} ctx  { positionCounts, rosterReq, flexPositions, poolByPos, nextPick }
 */
function computeRosterAwareScore(player, ctx) {
  const { positionCounts, rosterReq, flexPositions, poolByPos, nextPick } = ctx;
  const pos = player.position;
  const adp = player.adp ?? 999;

  // Base value: best-available signal. ADP 1 ≈ 299, ADP 300 ≈ 1. Dominant term.
  const base = Math.max(1, 300 - adp);

  const have = positionCounts[pos] ?? 0;
  const startersNeeded = rosterReq[pos] ?? 0;
  const flexEligible = flexPositions.includes(pos);

  // Flex slots are shared among flex-eligible positions. Count flex-eligible players
  // I hold beyond their dedicated starter requirements.
  const flexStartersFilled = flexPositions.reduce((sum, fp) => {
    const h = positionCounts[fp] ?? 0;
    const need = rosterReq[fp] ?? 0;
    return sum + Math.max(0, h - need);
  }, 0);
  const flexSlots = rosterReq.FLEX ?? 0;
  const needsFlex = flexEligible && flexStartersFilled < flexSlots;

  // A position is "needed" if I lack a dedicated starter or can still fill a flex slot.
  const needed = have < startersNeeded || needsFlex;

  // Saturated positions are pushed well below every needed player so they stop being
  // recommended once you've stocked them (prevents hoarding 4+ RBs).
  let score = needed ? base : base * 0.3;

  // Bounded scarcity tiebreak — only for needed positions whose quality players are about
  // to disappear before your next pick. Kept small (max +8) so it can only break ties
  // between similar-ADP players or nudge you toward the last startable QB/TE when the
  // choice is close; it can NEVER leap a big ADP gap (a TE18 won't jump a RB2).
  if (needed) {
    const reach = nextPick ?? adp + 12;
    const remaining = (poolByPos[pos] ?? []).filter(p => (p.adp ?? 999) <= reach).length;
    if (remaining <= 2) score += 8;
    else if (remaining <= 4) score += 3;
  }

  return score;
}

/**
 * Main draft engine.
 */
export function runDraftEngine({ availablePlayers, draftedPlayers = [], myRoster = [], currentPick = 1, nextPick = null, positions = [], teamSize = 12, rosterRequirements = {}, flexPositions = [] }) {
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

  // 3A. Best Pick — roster-aware best available. Starts from consensus ADP, then weights
  // by what YOUR roster still needs and positional scarcity. Early on (empty roster) this
  // is just best-player-available; as you fill positions it pivots intelligently — e.g.
  // 3 RBs and no QB will surface a QB over a 4th RB of similar rank.
  const positionCounts = {};
  for (const p of myRoster) {
    positionCounts[p.position] = (positionCounts[p.position] ?? 0) + 1;
  }
  const poolByPos = {};
  for (const p of pool) {
    if (LATE_ROUND_POSITIONS.has(p.position)) continue;
    (poolByPos[p.position] = poolByPos[p.position] ?? []).push(p);
  }
  const bestPickCtx = { positionCounts, rosterReq: rosterRequirements, flexPositions, poolByPos, nextPick };
  const bestPick = [...pool]
    .filter(p => !LATE_ROUND_POSITIONS.has(p.position))
    .filter(p => (p.adp ?? 999) < 999)   // must have a consensus rank
    .map(p => ({ ...p, _rosterScore: computeRosterAwareScore(p, bestPickCtx) }))
    .sort((a, b) => b._rosterScore - a._rosterScore)
    .slice(0, 3)
    .map(({ _rosterScore, ...p }) => p);

  // 3B. Wheel Value — take now vs wait logic. For each available skill player, calculate
  // how much positional quality you LOSE by passing on them until your next snake pick.
  // High score = big tier drop after the turn = take this pick. Low = safely wait.
  // DST/K excluded; must have real projected points to produce a meaningful gap.
  const minWheelGap = 10; // pts — filter noise; gaps < 10pts aren't meaningful
  const wheelValue = [...pool]
    .filter(p => !LATE_ROUND_POSITIONS.has(p.position))
    .filter(p => (p.projections?.fantasyPoints ?? 0) > 0)
    .map(p => ({ ...p, _wheelScore: computeWheelTurnScore(p, pool, nextPick, positionCounts, rosterRequirements, flexPositions) }))
    .filter(p => p._wheelScore >= minWheelGap)
    .sort((a, b) => b._wheelScore - a._wheelScore)
    .slice(0, 3)
    .map(({ _wheelScore, ...p }) => ({ ...p, wheelScore: _wheelScore }));

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

  return { top10, topByPosition, bestPick, wheelValue, wontMakeItBack, upsidePick };
}
