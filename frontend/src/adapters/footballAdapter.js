import { calculateFantasyPoints } from '../utils/calculateFantasyPoints.js';
import { FOOTBALL_SCORING_PRESETS } from '../config/scoringSystems.js';
import { SPORTS } from '../config/sportConfig.js';
import { TEAM_BYE_WEEKS, PLAYER_STATUS } from '../data/footballPlayers.js';

const REPLACEMENT_LEVEL = SPORTS.football.replacementLevel;

export function normalizeFootballPlayer(raw, scoringPreset = 'ppr', rank = 0, posRank = 0, vbd = 0, baseline = 0) {
  const scoring = FOOTBALL_SCORING_PRESETS[scoringPreset] ?? FOOTBALL_SCORING_PRESETS.ppr;
  const fantasyPoints = calculateFantasyPoints(raw.stats ?? {}, scoring);

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

  const withPts = rawPlayers.map(p => ({
    ...p,
    byeWeek: p.byeWeek ?? TEAM_BYE_WEEKS[p.team] ?? null,
    status: p.status ?? PLAYER_STATUS[p.id] ?? 'Active',
    _pts: calculateFantasyPoints(p.stats ?? {}, scoring),
  }));

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

  // Sort by VBD descending, then ADP as tiebreaker.
  // This is the key change: a QB projected at 400 pts with replacement QB at 280 (VBD=120)
  // ranks below an RB projected at 350 pts with replacement RB at 180 (VBD=170).
  const withVBD = withPts.map(p => ({
    ...p,
    _vbd: Math.max(0, p._pts - (baselines[p.position] ?? 0)),
  }));

  const sorted = [...withVBD].sort((a, b) => {
    if (b._vbd !== a._vbd) return b._vbd - a._vbd;
    return (a.adp ?? 999) - (b.adp ?? 999);
  });

  const posCounters = {};
  return sorted.map((p, i) => {
    const pos = p.position;
    posCounters[pos] = posCounters[pos] ?? 0;
    const posRank = posCounters[pos]++;
    const { _pts, _vbd, ...raw } = p;
    return normalizeFootballPlayer(raw, scoringPreset, i, posRank, _vbd, baselines[pos] ?? 0);
  });
}
