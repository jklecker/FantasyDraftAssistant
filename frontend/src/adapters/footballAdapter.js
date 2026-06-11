import { calculateFantasyPoints } from '../utils/calculateFantasyPoints.js';
import { FOOTBALL_SCORING_PRESETS } from '../config/scoringSystems.js';
import { SPORTS } from '../config/sportConfig.js';
import { TEAM_BYE_WEEKS, PLAYER_STATUS } from '../data/footballPlayers.js';

const REPLACEMENT_LEVEL = SPORTS.football.replacementLevel;

export function normalizeFootballPlayer(raw, scoringPreset = 'ppr', rank = 0, posRank = 0, vbd = 0, baseline = 0, ptsOverride = null) {
  const scoring = FOOTBALL_SCORING_PRESETS[scoringPreset] ?? FOOTBALL_SCORING_PRESETS.ppr;
  // Prefer the precomputed _pts (which already applied the ADP-synthetic fallback)
  // over re-deriving it from raw.stats, which would return 0 when stats are empty.
  const fantasyPoints = ptsOverride != null
    ? ptsOverride
    : calculateFantasyPoints(raw.stats ?? {}, scoring);

  return {
    id: raw.id,
    name: raw.name,
    position: raw.position,
    team: raw.team,
    sport: 'football',

    stats: raw.stats ?? {},

    projections: {
      fantasyPoints,
      rawStats: raw.stats ?? {},
    },

    rankings: {
      overall: rank + 1,
      position: posRank + 1,
    },

    adp: raw.adp ?? rank + 1,

    // Value Based Drafting: how much better this player is than the replacement-level
    // player at their position. Drives overall rankings — larger = more valuable to draft early.
    vbd,
    vbdBaseline: baseline,

    byeWeek: raw.byeWeek ?? null,
    status: raw.status ?? 'Active',

    pff: raw.pff ?? {},
    // Merge analytics with computed ranks so the draft board can display them.
    nextGen: {
      ...(raw.nextGen ?? {}),
      compositeRank: rank + 1,      // VBD-sorted overall rank (1 = best)
      posRank: posRank + 1,          // VBD-sorted rank within position
    },

    isDrafted: false,
  };
}

export function normalizeFootballPlayers(rawPlayers, scoringPreset = 'ppr') {
  if (!rawPlayers?.length) return [];

  const scoring = FOOTBALL_SCORING_PRESETS[scoringPreset] ?? FOOTBALL_SCORING_PRESETS.ppr;

  // Effective ADP for ranking/_pts: prefer real ADP, then any nextGen ranking signal.
  // Backend often returns adp=null for most players but populates nextGen.espnAdp,
  // overallRank, berryRank, or compositeRank — use whichever exists so VBD is meaningful.
  const effectiveAdp = (p) => {
    const candidates = [
      p.adp,
      p.nextGen?.espnAdp,
      p.nextGen?.overallRank,
      p.nextGen?.berryRank,
      p.nextGen?.compositeRank,
    ];
    for (const c of candidates) {
      if (c != null && Number.isFinite(+c) && +c > 0) return +c;
    }
    return null;
  };

  // Trusted consensus rank used ONLY for sort ordering (not for display ADP).
  // Preference order: FP ECR adp (best overall consensus) → compositeRank (Berry + scrapers)
  // → espnAdp (ESPN scraper, can be stale/off for individual players).
  // espnAdp is last because the scraper sometimes returns inflated values (e.g. QB espnAdp=43/69
  // when actual ESPN rankings have them at 7/14). compositeRank is more stable.
  const trustedAdp = (p) => {
    if (p.adp != null && Number.isFinite(+p.adp) && +p.adp > 0) return +p.adp;
    const composite = p.nextGen?.compositeRank;
    if (composite != null && Number.isFinite(+composite) && +composite > 0) return +composite;
    const espn = p.nextGen?.espnAdp;
    if (espn != null && Number.isFinite(+espn) && +espn > 0) return +espn;
    return null;
  };

  const withPts = rawPlayers.map(p => {
    const eAdp = effectiveAdp(p);
    const tAdp = trustedAdp(p);
    return {
      ...p,
      byeWeek: p.byeWeek ?? TEAM_BYE_WEEKS[p.team] ?? null,
      status: p.status ?? PLAYER_STATUS[p.id] ?? 'Active',
      _effAdp: eAdp,
      _trustedAdp: tAdp,
      _pts: (() => {
        const fromStats = calculateFantasyPoints(p.stats ?? {}, scoring);
        if (fromStats > 0) return fromStats;
        const fromBackend = p.nextGen?.projectedPoints ?? 0;
        if (fromBackend > 0) return fromBackend;
        // Position-aware ADP synthetic so DST/K land in the correct pts range.
        // Values calibrated to real-world full-season PPR projections:
        //   QB  ADP 7  → ~472 pts  (Josh Allen tier)
        //   RB  ADP 2  → ~347 pts  (Bijan tier)
        //   WR  ADP 4  → ~304 pts  (CeeDee tier)
        //   TE  ADP 10 → ~205 pts  (Kelce tier)
        //   DST ADP 50 → ~135 pts  (top DST)
        //   K   ADP130 → ~116 pts  (top K)
        const adpVal = eAdp ?? 200;
        const pos = p.position;
        if (pos === 'QB')  return Math.max(0, 480 - adpVal * 1.2);
        if (pos === 'RB')  return Math.max(0, 350 - adpVal * 1.6);
        if (pos === 'WR')  return Math.max(0, 310 - adpVal * 1.4);
        if (pos === 'TE')  return Math.max(0, 220 - adpVal * 1.5);
        if (pos === 'DST') return Math.max(0, 155 - adpVal * 0.4);
        if (pos === 'K')   return Math.max(0, 155 - adpVal * 0.3);
        return Math.max(0, 400 - adpVal * 1.6);  // fallback for unknown positions
      })(),
    };
  });

  // Compute VBD baseline per position: the projected points of the replacement-level player.
  // Replacement level = the Nth best player (last starter across all 12 teams).
  const byPosition = {};
  for (const p of withPts) {
    byPosition[p.position] = byPosition[p.position] ?? [];
    byPosition[p.position].push(p._pts);
  }
  const baselines = {};
  for (const [pos, pts] of Object.entries(byPosition)) {
    const sorted = [...pts].sort((a, b) => b - a);
    const replIdx = (REPLACEMENT_LEVEL[pos] ?? 13) - 1;
    baselines[pos] = sorted[Math.min(replIdx, sorted.length - 1)] ?? 0;
  }

  const withVBD = withPts.map(p => ({
    ...p,
    _vbd: Math.max(0, p._pts - (baselines[p.position] ?? 0)),
  }));

  // Sort by consensus ADP when available (FantasyPros ECR / ESPN), fall back to VBD.
  // Pure VBD overvalues dual-threat QBs (Lamar/Allen's rushing pushes raw pts sky-high)
  // and misses the "wait on QB" wisdom that expert consensus rankings already encode.
  // FantasyPros ECR adp=14 for Lamar and adp=7 for Allen correctly reflect that dynamic.
  // Only _trustedAdp (FP ECR + ESPN) is used for sort — not noisy composite/overallRank.
  const sorted = [...withVBD].sort((a, b) => {
    const aAdp = a._trustedAdp;
    const bAdp = b._trustedAdp;
    // Both have consensus ADP — trust it as primary sort (mirrors ESPN Top 300 ordering)
    if (aAdp != null && bAdp != null) return aAdp - bAdp;
    if (aAdp != null) return -1;   // a has ADP, b doesn't → a ranks higher
    if (bAdp != null) return 1;    // b has ADP, a doesn't → b ranks higher
    // No trusted ADP for either — fall back to VBD (positional scarcity-adjusted value)
    if (b._vbd !== a._vbd) return b._vbd - a._vbd;
    return 0;
  });

  const posCounters = {};
  return sorted.map((p, i) => {
    const pos = p.position;
    posCounters[pos] = posCounters[pos] ?? 0;
    const posRank = posCounters[pos]++;
    const { _pts, _vbd, _effAdp, _trustedAdp, ...raw } = p;
    // Promote effective ADP into raw so the display ADP isn't null for the ~99% of
    // players the backend doesn't populate adp for.
    if (_effAdp != null && (raw.adp == null || raw.adp <= 0)) raw.adp = _effAdp;
    return normalizeFootballPlayer(raw, scoringPreset, i, posRank, _vbd, baselines[pos] ?? 0, _pts);
  });
}
