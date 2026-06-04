// Trade value heuristics — sport-aware. Returns a single numeric "value" per player
// representing approximate season-long fantasy worth, including positional scarcity.
//
// Football: uses projected fantasy points + VBD (already computed by the draft engine).
// Baseball: weighted sum of projected counting stats normalized per category.

const BASEBALL_BATTER_WEIGHTS = {
  R: 1.0, H: 0.3, HR: 4.0, RBI: 1.0, SB: 3.0, BB: 0.5, K: -0.2,
  twoB: 0.5, threeB: 1.0,
};

const BASEBALL_PITCHER_WEIGHTS = {
  IP: 0.5, W: 5.0, SV: 8.0, pitchingK: 1.0, pitchingBB: -0.5,
  // ERA/WHIP are rate stats — handled separately below.
};

function num(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function baseballValue(p) {
  if (!p) return 0;
  const isPitcher = num(p.IP ?? p.ip) > 0 || p.position === 'SP' || p.position === 'RP';
  if (isPitcher) {
    let v = 0;
    for (const [k, w] of Object.entries(BASEBALL_PITCHER_WEIGHTS)) v += num(p[k]) * w;
    // Rate-stat penalty: ERA over 4.0 hurts; WHIP over 1.3 hurts. Capped.
    const era = num(p.ERA ?? p.era);
    const whip = num(p.WHIP ?? p.whip);
    if (era > 0) v -= Math.max(0, era - 4.0) * 15;
    if (whip > 0) v -= Math.max(0, whip - 1.3) * 50;
    return Math.max(0, v);
  }
  let v = 0;
  for (const [k, w] of Object.entries(BASEBALL_BATTER_WEIGHTS)) {
    const altKey = k === 'twoB' ? '2B' : k === 'threeB' ? '3B' : k.toLowerCase();
    v += num(p[k] ?? p[altKey]) * w;
  }
  return Math.max(0, v);
}

function footballValue(p) {
  if (!p) return 0;
  const pts = num(p.projections?.fantasyPoints);
  const vbd = num(p.vbd);
  // VBD already encodes positional scarcity — use it alone to avoid double-counting.
  // Only fall back to raw pts when VBD is unavailable (e.g. non-normalized mock data).
  return vbd > 0 ? vbd : pts;
}

export function playerValue(player, sport) {
  if (!player) return 0;
  return sport === 'football' ? footballValue(player) : baseballValue(player);
}

/**
 * Compare two sides of a trade and produce a verdict.
 * `give` = players you would send away; `get` = players you would receive.
 * Returns { giveValue, getValue, delta, deltaPct, verdict, recommendation, breakdown }.
 */
export function analyzeTrade({ give, get, sport }) {
  const giveDetails = give.map(p => ({ player: p, value: playerValue(p, sport) }));
  const getDetails  = get.map(p  => ({ player: p, value: playerValue(p, sport) }));

  const giveValue = giveDetails.reduce((s, d) => s + d.value, 0);
  const getValue  = getDetails.reduce((s, d) => s + d.value, 0);
  const delta     = getValue - giveValue;

  // Percent change vs the side you're giving up — protects against tiny absolute values.
  const base = Math.max(giveValue, 1);
  const deltaPct = (delta / base) * 100;

  let verdict, recommendation, color;
  if (deltaPct >= 20) {
    verdict = 'Great trade';
    recommendation = 'ACCEPT';
    color = '#276749';
  } else if (deltaPct >= 8) {
    verdict = 'Good trade';
    recommendation = 'ACCEPT';
    color = '#2f855a';
  } else if (deltaPct >= -8) {
    verdict = 'Even trade';
    recommendation = 'CONSIDER — roughly balanced';
    color = '#4a5568';
  } else if (deltaPct >= -20) {
    verdict = 'Slight loss';
    recommendation = 'DECLINE unless you need positional balance';
    color = '#c05621';
  } else {
    verdict = 'Bad trade';
    recommendation = 'DECLINE';
    color = '#9b2c2c';
  }

  // Quantity mismatch warning (e.g. 2-for-1) — usually means side with fewer
  // bodies should be the higher per-player value side.
  const quantityNote =
    give.length !== get.length
      ? ` You ${give.length > get.length ? 'lose' : 'gain'} a roster spot (${give.length}-for-${get.length}).`
      : '';

  return {
    giveValue: Math.round(giveValue * 10) / 10,
    getValue: Math.round(getValue * 10) / 10,
    delta: Math.round(delta * 10) / 10,
    deltaPct: Math.round(deltaPct * 10) / 10,
    verdict,
    recommendation,
    color,
    quantityNote,
    breakdown: { give: giveDetails, get: getDetails },
  };
}
