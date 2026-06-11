/**
 * Calculate fantasy points for a player given their projected stats
 * and a scoring settings object.
 *
 * Works for football. Baseball scoring is handled by the backend.
 *
 * @param {Object} playerStats  - raw stat projections (passYards, rushTD, receptions, etc.)
 * @param {Object} scoringSettings - scoring weights (same shape as FOOTBALL_SCORING_PRESETS entries)
 * @returns {number} projected fantasy points
 */
export function calculateFantasyPoints(playerStats, scoringSettings) {
  if (!playerStats || !scoringSettings) return 0;

  const s = scoringSettings;
  const p = playerStats;

  let pts = 0;
  pts += (p.passYards   ?? 0) * (s.passYards   ?? 0);
  pts += (p.passTD      ?? 0) * (s.passTD      ?? 0);
  pts += (p.passInt     ?? 0) * (s.passInt     ?? 0);
  pts += (p.rushYards   ?? 0) * (s.rushYards   ?? 0);
  pts += (p.rushTD      ?? 0) * (s.rushTD      ?? 0);
  pts += (p.receptions  ?? 0) * (s.receptions  ?? 0);
  pts += (p.recYards    ?? 0) * (s.recYards    ?? 0);
  pts += (p.recTD       ?? 0) * (s.recTD       ?? 0);
  pts += (p.fumbleLost  ?? 0) * (s.fumbleLost  ?? 0);
  pts += (p.twoPointConv ?? 0) * (s.twoPointConv ?? 0);

  // ── DST scoring ───────────────────────────────────────────────────────────
  // Standard ESPN: sacks=1, INT=2, fumRec=2, safety=2, TD=6
  // pointsAllowed tiers: 0pts=10, 1-6=7, 7-13=4, 14-17=1, 18-27=0, 28-34=-1, 35+=−4
  pts += (p.dstSacks           ?? 0) * (s.dstSacks           ?? 1);
  pts += (p.dstInterceptions   ?? 0) * (s.dstInterceptions   ?? 2);
  pts += (p.dstFumblesRecovered?? 0) * (s.dstFumblesRecovered?? 2);
  pts += (p.dstSafeties        ?? 0) * (s.dstSafeties        ?? 2);
  pts += (p.dstTouchdowns      ?? 0) * (s.dstTouchdowns      ?? 6);
  pts += (p.dstBlockedKicks    ?? 0) * (s.dstBlockedKicks    ?? 2);
  if (p.dstPointsAllowed != null) {
    const pa = p.dstPointsAllowed;
    pts += pa === 0 ? 10 : pa <= 6 ? 7 : pa <= 13 ? 4 : pa <= 17 ? 1 : pa <= 27 ? 0 : pa <= 34 ? -1 : -4;
  }

  // ── Kicker scoring ────────────────────────────────────────────────────────
  pts += (p.fgMade    ?? 0) * (s.fgMade    ?? 3);
  pts += (p.fgMissed  ?? 0) * (s.fgMissed  ?? -1);
  pts += (p.xpMade    ?? 0) * (s.xpMade    ?? 1);
  pts += (p.xpMissed  ?? 0) * (s.xpMissed  ?? -1);
  pts += (p.fgLong50  ?? 0) * (s.fgLong50  ?? 1);  // bonus for 50+ yard FGs

  return Math.round(pts * 10) / 10;
}
