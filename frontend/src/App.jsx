import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Fuse from 'fuse.js';
import { getSportConfig, isFootball } from './config/sportConfig.js';
import { FOOTBALL_PRESET_LIST, CUSTOM_SCORING_KEYS } from './config/scoringSystems.js';
import { normalizeFootballPlayers } from './adapters/footballAdapter.js';
import { FOOTBALL_PLAYERS } from './data/footballPlayers.js';
import { runDraftEngine } from './utils/draftEngine.js';
import { calculateFantasyPoints } from './utils/calculateFantasyPoints.js';
import TradeAnalyzer from './TradeAnalyzer.jsx';
import FantasyChat from './FantasyChat.jsx';

// ─── helpers ──────────────────────────────────────────────────────────────────

const API_BASE = process.env.REACT_APP_API_BASE || '';

async function apiFetch(url, opts = {}) {
  const res = await fetch(API_BASE + url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  // 204 No Content has no body
  if (res.status === 204) return null;
  return res.json();
}

// ─── PlayerSearch ─────────────────────────────────────────────────────────────

function PlayerSearch({ label, value, onChange, onSelect, results }) {
  return (
    <div className="player-search" data-testid="player-search">
      {label && <label>{label}</label>}
      <input
        type="text"
        placeholder="e.g. Mike Trout"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="search-dropdown" data-testid="search-dropdown">
          {results.map(p => (
            <li key={p.id} onClick={() => onSelect(p)}>
              {p.name} <span className="badge">{p.position}</span> {p.team}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── initialKeeperGrid ────────────────────────────────────────────────────────

function makeKeeperGrid(myTeamId = null) {
  return Array.from({ length: 12 }, (_, i) => {
    const teamNum = i + 1;
    const isMyTeam = myTeamId && myTeamId === teamNum;
    return {
      name: `Team ${teamNum}${isMyTeam ? ' (Your Team)' : ''}`,
      teamId: teamNum,
      isMyTeam,
      keepers: [
        { search: '', results: [], player: null, round: '' },
        { search: '', results: [], player: null, round: '' },
      ],
    };
  });
}

// ─── buildDraftBoard ──────────────────────────────────────────────────────────
// Returns { keepers: [...], picks: [...] } for the Drafted tab.

function buildDraftBoard(draftState) {
  if (!draftState?.teams) return { keepers: [], picks: [] };

  const numTeams = draftState.teams.length || 1;

  // player id → team name (non-keepers)
  const playerTeamMap = {};
  draftState.teams.forEach(team =>
    team.roster?.forEach(p => { if (!p.keeper) playerTeamMap[p.id] = team.name; })
  );

  // keepers: pull from each team's roster where keeper===true, attach round from team.keepers
  const keepers = [];
  draftState.teams.forEach(team => {
    (team.roster || [])
      .filter(p => p.keeper)
      .forEach(p => {
        const kd = (team.keepers || []).find(k => k.playerId === p.id);
        keepers.push({ player: p, teamName: team.name, round: kd?.round ?? '—' });
      });
  });
  keepers.sort((a, b) => (a.round ?? 99) - (b.round ?? 99));

  // regular picks in draft order with round number
  const picks = (draftState.draftedPlayers || []).map((p, i) => ({
    player: p,
    teamName: playerTeamMap[p.id] || '?',
    overall: i + 1,
    round: Math.floor(i / numTeams) + 1,
  }));

  return { keepers, picks };
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [sport, setSport] = useState(() => {
    try { return window.localStorage.getItem('sport') || 'baseball'; } catch (_) { return 'baseball'; }
  });
  const sportConfig = getSportConfig(sport);

  // Football-specific state
  const [footballScoringPreset, setFootballScoringPreset] = useState(() => {
    try { return window.localStorage.getItem('footballScoringPreset') || 'ppr'; } catch (_) { return 'ppr'; }
  });
  const [customFootballScoring, setCustomFootballScoring] = useState(null);
  const [customScoringJson, setCustomScoringJson] = useState('');
  const [customScoringError, setCustomScoringError] = useState('');
  // Football per-team picks: [{playerId, teamSlot, overall}] in draft order.
  // teamSlot is auto-assigned via snake draft based on `footballTeamSize`.
  const [footballPicks, setFootballPicks] = useState(() => {
    try {
      const raw = window.localStorage.getItem('footballPicks');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  });
  const [footballBoardSearch, setFootballBoardSearch] = useState('');
  const [footballBoardSort, setFootballBoardSort] = useState({ col: 'adp', dir: 'asc' });
  const [footballPosFilter, setFootballPosFilter] = useState('QB');
  const [draftedChipsExpanded, setDraftedChipsExpanded] = useState(false);
  const [baseballBoardSearch, setBaseballBoardSearch] = useState('');
  const [baseballBoardPos, setBaseballBoardPos] = useState('ALL');
  const [baseballTopPos, setBaseballTopPos] = useState('C');
  const [footballEngine, setFootballEngine] = useState(null);
  const [footballPlayers, setFootballPlayers] = useState(null); // null = not loaded, [] = empty
  const [footballLoading, setFootballLoading] = useState(false);
  const [footballError, setFootballError] = useState('');
  const [footballTeamPos, setFootballTeamPos] = useState(() => {
    try { return Number(window.localStorage.getItem('footballTeamPos')) || 1; } catch (_) { return 1; }
  });
  const [footballTeamSize, setFootballTeamSize] = useState(() => {
    try { return Number(window.localStorage.getItem('footballTeamSize')) || 12; } catch (_) { return 12; }
  });

  // ── Cheat Sheet state (independent draft tracker for ESPN/Yahoo users) ──
  const [cheatPicks, setCheatPicks] = useState(() => {
    try {
      const raw = window.localStorage.getItem('cheatPicks');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  });
  const [csMyTeam, setCsMyTeam] = useState(() => {
    try { return Number(window.localStorage.getItem('csMyTeam')) || 1; } catch (_) { return 1; }
  });
  const [csPosFilter, setCsPosFilter] = useState('ALL');
  const [csSearch, setCsSearch] = useState('');

  const [activeTab, setActiveTab]   = useState('draft');
  const [draftState, setDraftState] = useState(null);
  const [currentTeam, setCurrentTeam] = useState(null);
  const [recommendations, setRecs]  = useState([]);
  const [positionalNeeds, setNeeds] = useState({});
  const [statusMsg, setStatusMsg]   = useState('');
  const [errorMsg, setErrorMsg]     = useState('');

  // Scoring presets state
  const [scoringPresets, setScoringPresets] = useState([]);
  const [activeScoring, setActiveScoring] = useState(null);
  const [scoringLoading, setScoringLoading] = useState(false);

  // Keep-alive
  const [lastPing, setLastPing] = useState(null);
  const [pinging, setPinging]   = useState(false);

  // Draft timer
  const [timerSeconds, setTimerSeconds] = useState(120);
  const [timerActive, setTimerActive]   = useState(false);
  const [timerLeft,   setTimerLeft]     = useState(120);
  const timerRef = useRef(null);

  // Mobile More-menu
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  // Toast notifications (replaces banner for transient feedback)
  const [toastMsg, setToastMsg] = useState('');
  const toastTimeoutRef = useRef(null);
  const showToast = (msg) => {
    setToastMsg(msg);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToastMsg(''), 3500);
  };

  // Draft pick form
  const [pickSearch, setPickSearch]   = useState('');
  const [pickResults, setPickResults] = useState([]);
  const [selectedPick, setSelectedPick] = useState(null);

  // My Picks tab state
  const [myTeamId, setMyTeamId] = useState(() => {
    try {
      const raw = window.localStorage.getItem('myTeamId');
      const parsed = raw ? Number(raw) : null;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch (_) {
      return null;
    }
  });

  // Keeper grid — 12 teams × 2 slots each (rebuilt when myTeamId changes)
  const [keeperGrid, setKeeperGrid] = useState(() => makeKeeperGrid(null));
  const [myRecBoard, setMyRecBoard] = useState({ overall: [], pitchers: [], batters: [] });
  const [recsLoading, setRecsLoading] = useState(false);

  // Fuse.js index — rebuilt whenever the available player pool changes
  const fuseRef = useRef(null);

  // ── data fetchers ────────────────────────────────────────────────────────

  // Rebuild the client-side Fuse.js search index from a fresh state snapshot.
  const buildFuseIndex = (state) => {
    const players = state?.availablePlayers;
    if (players && players.length > 0) {
      fuseRef.current = new Fuse(players, {
        keys: ['name'],
        threshold: 0.45,
        distance: 200,
        minMatchCharLength: 2,
        includeScore: true,
      });
    } else {
      fuseRef.current = null;
    }
  };

  const loadState = useCallback(async () => {
    try {
      // Always call auto-initialize with the current sport so the backend
      // re-initializes if a stale state from a different sport is present.
      const state = await apiFetch(`/draft/auto-initialize?sport=${sport}`, { method: 'POST' });
      setDraftState(state);
      buildFuseIndex(state);
    } catch (_) {
      try {
        const state = await apiFetch('/draft/state');
        setDraftState(state);
        buildFuseIndex(state);
      } catch (_2) { /* ignore */ }
    }
  }, [sport]);

  const loadCurrentTeam = useCallback(async () => {
    try { setCurrentTeam(await apiFetch('/draft/current-team')); } catch (_) {}
  }, []);

  const loadRecommendations = useCallback(async (teamId, round) => {
    try { setRecs(await apiFetch(`/draft/recommendations?teamId=${teamId}&round=${round}&limit=15`)); }
    catch (_) {}
  }, []);

  const loadPositionalNeeds = useCallback(async (teamId) => {
    try { setNeeds((await apiFetch(`/draft/positional-needs?teamId=${teamId}`)) || {}); }
    catch (_) { setNeeds({}); }
  }, []);

  // Load top-5 recommendations for the user's own team.
  const loadMyRecs = useCallback(async (teamId, round) => {
    if (!teamId || !round) return;
    setRecsLoading(true);
    try {
      const data = await apiFetch(
        `/draft/recommendations/board?teamId=${teamId}&round=${round}&overallLimit=15&pitcherLimit=10&batterLimit=10`
      );
      setMyRecBoard({
        overall: data?.overall || [],
        pitchers: data?.pitchers || [],
        batters: data?.batters || [],
      });
    } catch (_) {
      setMyRecBoard({ overall: [], pitchers: [], batters: [] });
    }
    setRecsLoading(false);
  }, []);

  const loadScoringPresets = useCallback(async () => {
    try {
      const presets = await apiFetch('/draft/scoring/presets');
      setScoringPresets(presets || []);
    } catch (_) {
      setScoringPresets([]);
    }
  }, []);

  const loadActiveScoringPreset = useCallback(async () => {
    try {
      // Load the active preset for THIS draft session
      const preset = await apiFetch('/draft/scoring/active-session');
      setActiveScoring(preset);
    } catch (_) {
      // Fallback: try the global endpoint (for backward compat if session not initialized)
      try {
        const preset = await apiFetch('/draft/scoring/active');
        setActiveScoring(preset);
      } catch (_2) {
        setActiveScoring(null);
      }
    }
  }, []);

  const handleSetActiveScoringPreset = async (presetKey) => {
    setScoringLoading(true);
    setErrorMsg('');
    try {
      // Set the preset for THIS draft session
      await apiFetch(`/draft/scoring/set-preset?presetKey=${encodeURIComponent(presetKey)}`, {
        method: 'POST',
      });
      setStatusMsg('✅ Scoring preset updated! Recommendations will refresh.');
      await loadActiveScoringPreset();
      // Refresh recommendations if on the recs tab
      if (activeTab === 'recs' && myTeamId && draftState?.round) {
        await loadMyRecs(myTeamId, draftState.round);
      }
    } catch (e) {
      setErrorMsg(`Failed to change scoring preset: ${e.message}`);
    }
    setScoringLoading(false);
  };

  // ── snake draft helpers ──────────────────────────────────────────────────
  // Returns which team slot (1-based) is making pick N in a snake draft.
  const calcTeamForPick = (pickNum, numTeams) => {
    const round = Math.ceil(pickNum / numTeams);
    const pickInRound = ((pickNum - 1) % numTeams) + 1;
    return round % 2 === 1 ? pickInRound : numTeams - pickInRound + 1;
  };

  // Returns the first overall pick number >= fromPick that belongs to teamPos
  // in a numTeams-team snake draft.
  const calcNextSnakePick = (fromPick, teamPos, numTeams) => {
    for (let round = 1; round <= 30; round++) {
      const myPick = round % 2 === 1
        ? (round - 1) * numTeams + teamPos
        : round * numTeams - teamPos + 1;
      if (myPick >= fromPick) return myPick;
    }
    return null;
  };

  // Derived from footballPicks — memoized so the engine useEffect only fires when picks actually change.
  const footballDraftedIds = useMemo(() => footballPicks.map(p => p.playerId), [footballPicks]);

  // Add a football pick — auto-assigns it to whichever team is on the clock
  // based on snake order. Toasts on duplicate player.
  const addFootballPick = (playerId) => {
    setFootballPicks(prev => {
      if (prev.some(p => p.playerId === playerId)) {
        const name = footballEngine?.players?.find(p => p.id === playerId)?.name ?? 'That player';
        showToast(`⚠️ ${name} is already drafted — pick someone else.`);
        return prev;
      }
      const overall = prev.length + 1;
      const teamSlot = calcTeamForPick(overall, footballTeamSize);
      return [...prev, { playerId, teamSlot, overall }];
    });
  };

  // Remove a football pick. Reassigns teamSlot for picks that came after,
  // since snake order shifts when a pick is undone.
  const removeFootballPick = (playerId) => {
    setFootballPicks(prev => {
      const filtered = prev.filter(p => p.playerId !== playerId);
      return filtered.map((p, i) => ({
        ...p,
        overall: i + 1,
        teamSlot: calcTeamForPick(i + 1, footballTeamSize),
      }));
    });
  };

  // Persist sport selection
  useEffect(() => {
    try { window.localStorage.setItem('sport', sport); } catch (_) {}
  }, [sport]);

  // Persist football picks
  useEffect(() => {
    try { window.localStorage.setItem('footballPicks', JSON.stringify(footballPicks)); } catch (_) {}
  }, [footballPicks]);

  // Reassign snake slots whenever team size changes
  useEffect(() => {
    setFootballPicks(prev => prev.map((p, i) => ({
      ...p,
      teamSlot: calcTeamForPick(i + 1, footballTeamSize),
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [footballTeamSize]);

  // Persist football draft settings
  useEffect(() => {
    try { window.localStorage.setItem('footballTeamPos', String(footballTeamPos)); } catch (_) {}
  }, [footballTeamPos]);
  useEffect(() => {
    try { window.localStorage.setItem('footballTeamSize', String(footballTeamSize)); } catch (_) {}
  }, [footballTeamSize]);
  useEffect(() => {
    try { window.localStorage.setItem('footballScoringPreset', footballScoringPreset); } catch (_) {}
  }, [footballScoringPreset]);
  useEffect(() => {
    try { window.localStorage.setItem('cheatPicks', JSON.stringify(cheatPicks)); } catch (_) {}
  }, [cheatPicks]);
  useEffect(() => {
    try { window.localStorage.setItem('csMyTeam', String(csMyTeam)); } catch (_) {}
  }, [csMyTeam]);

  // Fetch live NFL players when sport switches to football or scoring changes
  useEffect(() => {
    if (!isFootball(sport)) return;
    const scoring = customFootballScoring ? 'ppr' : footballScoringPreset;
    setFootballLoading(true);
    setFootballError('');
    apiFetch(`/nfl/players?scoring=${scoring}`)
      .then(data => { setFootballPlayers(data || []); setFootballLoading(false); })
      .catch(e => {
        setFootballError(`Failed to load NFL players: ${e.message}`);
        setFootballLoading(false);
        // Fall back to mock data so the app is still usable
        setFootballPlayers(FOOTBALL_PLAYERS);
      });
  }, [sport, footballScoringPreset, customFootballScoring]);

  // Recompute football draft engine when player pool or drafted ids change
  useEffect(() => {
    if (!isFootball(sport) || footballPlayers === null) return;
    const activeScoringSettings = customFootballScoring
      || FOOTBALL_PRESET_LIST.find(p => p.key === footballScoringPreset);
    const normalizeKey = customFootballScoring ? 'ppr' : footballScoringPreset;

    // Use API data only when FantasyPros rankings are present (adp populated).
    // Off-season / blocked: fall back to mock data which has real projections.
    const hasRealRankings = footballPlayers.some(p =>
      (p.adp != null && p.adp > 0)
      || (p.nextGen && (
        (p.nextGen.espnAdp != null && p.nextGen.espnAdp > 0)
        || (p.nextGen.overallRank != null && p.nextGen.overallRank > 0)
        || (p.nextGen.berryRank != null && p.nextGen.berryRank > 0)
        || (p.nextGen.compositeRank != null && p.nextGen.compositeRank > 0)
      ))
    );

    // When using live API data, enrich each player with pff + nextGen analytics
    // from the mock data (matched by name). The live API has accurate ADP/rankings
    // but no pre-season projections; mock data has the analytics but no live rankings.
    // Draft is always pre-season so mock projections are the right source for upside/breakout.
    const mockByName = new Map(
      FOOTBALL_PLAYERS.map(p => [p.name.toLowerCase().trim(), p])
    );
    const sourceData = hasRealRankings
      ? footballPlayers.map(p => {
          const mock = mockByName.get(p.name?.toLowerCase().trim());
          if (!mock) return p;
          return {
            ...p,
            // Prefer live stats/projections; fall back to mock for analytics not in live API
            stats: p.stats ?? mock.stats ?? null,
            pff: (p.pff && Object.keys(p.pff).length > 0) ? p.pff : (mock.pff ?? p.pff),
            nextGen: {
              ...(mock.nextGen ?? {}),   // analytics from mock (targetShare, rushShare, etc.)
              ...(p.nextGen ?? {}),      // live rankings overlay on top (espnAdp, compositeRank, etc.)
            },
          };
        })
      : FOOTBALL_PLAYERS;

    const allNormalized = normalizeFootballPlayers(sourceData, normalizeKey);
    const available = allNormalized.map(p => ({
      ...p,
      isDrafted: footballDraftedIds.includes(p.id),
      projections: {
        ...p.projections,
        fantasyPoints: (() => {
          if (activeScoringSettings) {
            const fromStats = calculateFantasyPoints(p.stats ?? {}, activeScoringSettings);
            if (fromStats > 0) return fromStats;
          }
          // Fall back to whatever the adapter computed (may be ADP-synthetic)
          return p.projections?.fantasyPoints ?? 0;
        })(),
      },
    }));
    const currentOverallPick = footballDraftedIds.length + 1;
    const myNextPick = calcNextSnakePick(currentOverallPick + 1, footballTeamPos, footballTeamSize);
    // My current roster — used to make Best Pick roster-aware (need + scarcity).
    const myPlayerIds = footballPicks
      .filter(pk => pk.teamSlot === footballTeamPos)
      .map(pk => pk.playerId);
    const myRoster = available.filter(p => myPlayerIds.includes(p.id));
    const result = runDraftEngine({
      availablePlayers: available.filter(p => !p.isDrafted),
      draftedPlayers: available.filter(p => p.isDrafted),
      myRoster,
      currentPick: currentOverallPick,
      nextPick: myNextPick,
      positions: sportConfig.positions,
      teamSize: footballTeamSize,
      rosterRequirements: sportConfig.rosterRequirements ?? {},
      flexPositions: sportConfig.flexPositions ?? [],
    });
    setFootballEngine({ players: available, ...result });
  }, [sport, footballPlayers, footballScoringPreset, customFootballScoring, footballDraftedIds, footballPicks, sportConfig, footballTeamPos, footballTeamSize]);

  useEffect(() => { loadState(); loadCurrentTeam(); loadScoringPresets(); loadActiveScoringPreset(); }, [loadState, loadCurrentTeam, loadScoringPresets, loadActiveScoringPreset]);

  useEffect(() => {
    if (currentTeam && draftState) {
      loadRecommendations(currentTeam.id, draftState.round);
      loadPositionalNeeds(currentTeam.id);
    }
  }, [currentTeam, draftState, loadRecommendations, loadPositionalNeeds]);

  // Auto-detect user's team (prefer explicit My Team label if present, otherwise last team).
  useEffect(() => {
    if (draftState?.teams && !myTeamId) {
      const found = draftState.teams.find(t => t.name === 'My Team')
        ?? draftState.teams[draftState.teams.length - 1];
      if (found) setMyTeamId(found.id);
    }
  }, [draftState, myTeamId]);

  // Reload recommendations for My Team whenever the recs tab is visible
  // or whenever the draft state changes (i.e. a pick was made).
  useEffect(() => {
    if (activeTab === 'recs' && myTeamId && draftState?.round) {
      loadMyRecs(myTeamId, draftState.round);
    }
  }, [activeTab, myTeamId, draftState, loadMyRecs]);

  // Persist "your team" selection so it remains set on refresh.
  useEffect(() => {
    if (!myTeamId) return;
    try {
      window.localStorage.setItem('myTeamId', String(myTeamId));
    } catch (_) {}
  }, [myTeamId]);

  // Rebuild keeper grid when myTeamId changes to update team labels
  useEffect(() => {
    setKeeperGrid(makeKeeperGrid(myTeamId));
  }, [myTeamId]);

  // ── keep-alive ───────────────────────────────────────────────────────────

  const ping = useCallback(async () => {
    setPinging(true);
    try { await fetch('/ping'); setLastPing(new Date()); } catch (_) {}
    setPinging(false);
  }, []);

  useEffect(() => {
    const id = setInterval(ping, 13 * 60 * 1000);
    return () => clearInterval(id);
  }, [ping]);

  // ── draft timer ──────────────────────────────────────────────────────────

  const resetTimer = useCallback(() => {
    setTimerLeft(timerSeconds);
    setTimerActive(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }, [timerSeconds]);

  const startTimer = useCallback(() => {
    setTimerLeft(timerSeconds);
    setTimerActive(true);
  }, [timerSeconds]);

  useEffect(() => {
    if (!timerActive) { if (timerRef.current) clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => {
      setTimerLeft(prev => {
        if (prev <= 1) { clearInterval(timerRef.current); setTimerActive(false); showToast('⏰ Time\'s up!'); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [timerActive]);

  // Reset timer whenever the pick advances (currentTeam changes)
  useEffect(() => { resetTimer(); }, [currentTeam, resetTimer]);

  // ── player search ────────────────────────────────────────────────────────
  // Uses the local Fuse.js index (instant + fuzzy) when a draft is in progress;
  // falls back to the backend API when no local index is available.

  const searchPlayers = async (q, setResults) => {
    if (q.length < 2) { setResults([]); return; }
    if (fuseRef.current) {
      // Client-side fuzzy search — no network round-trip
      const hits = fuseRef.current.search(q).slice(0, 8).map(r => r.item);
      setResults(hits);
      return;
    }
    // Fallback: backend fuzzy search (also handles misspellings via FuzzyMatcher)
    try {
      const data = await apiFetch(`/draft/players?q=${encodeURIComponent(q)}`);
      setResults((data || []).slice(0, 8));
    } catch (_) { setResults([]); }
  };

  // ── draft pick ───────────────────────────────────────────────────────────
  // Use explicitly selected player, or fall back to the top search result.

  const handleDraftPick = async () => {
    const playerToPick = selectedPick || pickResults[0];
    setErrorMsg('');
    try {
      let data;
      if (playerToPick?.id) {
        data = await apiFetch(`/draft/pick?playerId=${playerToPick.id}`, { method: 'POST' });
      } else if (pickSearch.trim()) {
        data = await apiFetch(
          `/draft/pick?playerName=${encodeURIComponent(pickSearch.trim())}`,
          { method: 'POST' }
        );
      } else {
        setErrorMsg('Type a player name first.');
        return;
      }
      showToast(`✅ ${playerToPick?.name ?? pickSearch} → ${data.pickedByTeam}  (Rd ${data.round})`);
      setStatusMsg('');
      setSelectedPick(null);
      setPickSearch('');
      setPickResults([]);
      resetTimer();
      await loadState();
      await loadCurrentTeam();
    } catch (e) {
      // Duplicate / already-drafted player gives a 400 from the backend
      const isDuplicate = e.message?.toLowerCase().includes('not available');
      setErrorMsg(isDuplicate
        ? `⚠️ ${playerToPick?.name ?? 'That player'} was already drafted — pick someone else.`
        : `Pick failed: ${e.message}`);
    }
  };

  // Pick a player directly from the recommendations tab.
  const handlePickPlayer = async (player) => {
    setErrorMsg('');
    try {
      const data = await apiFetch(`/draft/pick?playerId=${player.id}`, { method: 'POST' });
      showToast(`✅ ${player.name} → ${data.pickedByTeam}  (Rd ${data.round})`);
      setStatusMsg('');
      resetTimer();
      await loadState();
      await loadCurrentTeam();
    } catch (e) {
      const isDuplicate = e.message?.toLowerCase().includes('not available');
      setErrorMsg(isDuplicate
        ? `⚠️ ${player.name} was already drafted.`
        : `Pick failed: ${e.message}`);
    }
  };

  // Undo the last baseball pick.
  const handleUndo = async () => {
    setErrorMsg('');
    try {
      const data = await apiFetch('/draft/undo', { method: 'POST' });
      showToast(`↩️ Undid pick: ${data.undonePlayer}`);
      setStatusMsg('');
      await loadState();
      await loadCurrentTeam();
    } catch (e) {
      setErrorMsg(`Undo failed: ${e.message}`);
    }
  };

  // ── keeper grid ──────────────────────────────────────────────────────────

  const updateKeeperSlot = (ti, ki, patch) =>
    setKeeperGrid(prev =>
      prev.map((team, idx) =>
        idx !== ti ? team : {
          ...team,
          keepers: team.keepers.map((k, i) => i !== ki ? k : { ...k, ...patch }),
        }
      )
    );

  const searchKeeperPlayer = async (ti, ki, q) => {
    updateKeeperSlot(ti, ki, { search: q, results: [], player: q ? null : undefined });
    if (q.length < 2) return;
    if (fuseRef.current) {
      const hits = fuseRef.current.search(q).slice(0, 5).map(r => r.item);
      updateKeeperSlot(ti, ki, { results: hits });
      return;
    }
    try {
      const data = await apiFetch(`/draft/players?q=${encodeURIComponent(q)}`);
      updateKeeperSlot(ti, ki, { results: (data || []).slice(0, 5) });
    } catch (_) {}
  };

  const submitKeeperGrid = async () => {
    const keepers = keeperGrid.flatMap(team =>
      team.keepers
        .filter(k => k.player && k.round)
        .map(k => ({ teamName: team.name, playerId: k.player.id, round: parseInt(k.round, 10) }))
    );
    if (!keepers.length) { setErrorMsg('Enter at least one keeper before submitting.'); return; }
    setErrorMsg('');
    try {
      await apiFetch('/draft/load-keepers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepers }),
      });
      setStatusMsg(`✅ ${keepers.length} keeper(s) loaded!`);
      setKeeperGrid(makeKeeperGrid());
      await loadState();
    } catch (e) {
      setErrorMsg(`Failed to load keepers: ${e.message}`);
    }
  };

  // ── derived ──────────────────────────────────────────────────────────────

  const isLateRound   = draftState && draftState.round > 10;
  const canSubmitPick = selectedPick !== null || pickSearch.trim().length > 0;
  const pendingPlayerLabel = !selectedPick && pickResults[0]
    ? `Will pick: ${pickResults[0].name}`
    : null;
  const stat = (p, ...keys) => {
    if (!p) return 0;
    for (const k of keys) {
      const v = p[k];
      if (v !== undefined && v !== null) return v;
    }
    return 0;
  };

  const isPitcher = (p) => p && (Number(stat(p, 'IP', 'ip')) > 0 || p.position === 'SP' || p.position === 'RP');
  const overallProjection = (p) => {
    if (isPitcher(p)) {
      return `IP ${Number(stat(p, 'IP', 'ip')).toFixed(1)} | W ${stat(p, 'W', 'w')} | SV ${stat(p, 'SV', 'sv')} | K ${stat(p, 'pitchingK', 'pK')} | ERA ${Number(stat(p, 'ERA', 'era')).toFixed(2)} | WHIP ${Number(stat(p, 'WHIP', 'whip')).toFixed(2)}`;
    }
    return `R ${stat(p, 'R', 'r')} | H ${stat(p, 'H', 'h')} | 2B ${stat(p, 'twoB', '2B')} | 3B ${stat(p, 'threeB', '3B')} | HR ${stat(p, 'HR', 'hr')} | RBI ${stat(p, 'RBI', 'rbi')} | SB ${stat(p, 'SB', 'sb')} | BB ${stat(p, 'BB', 'bb')} | K ${stat(p, 'K', 'k')}`;
  };

  // Short stat line for compact table cells
  const shortProjection = (p) => {
    if (isPitcher(p)) {
      return `${stat(p, 'W', 'w')}W · ${stat(p, 'pitchingK', 'pK')}K · ${Number(stat(p, 'ERA', 'era')).toFixed(2)} ERA · ${Number(stat(p, 'WHIP', 'whip')).toFixed(2)} WHIP`;
    }
    return `${stat(p, 'HR', 'hr')}HR · ${stat(p, 'RBI', 'rbi')}RBI · ${stat(p, 'R', 'r')}R · ${stat(p, 'SB', 'sb')}SB`;
  };
  const myTeam = draftState?.teams?.find(t => t.id === myTeamId) || null;
  const { keepers: draftedKeepers, picks: draftedPicks } = buildDraftBoard(draftState);

  // Baseball category strength helper — returns which H2H cats a player primarily helps
  const baseballCatStrength = (p) => {
    if (!p) return [];
    const isPitcher = Number(stat(p,'IP','ip')) > 0 || p.position === 'SP' || p.position === 'RP';
    if (isPitcher) {
      const cats = [];
      if (Number(stat(p,'SV','sv')) >= 15) cats.push('SV');
      if (Number(stat(p,'W','w')) >= 8)  cats.push('W');
      if (Number(stat(p,'pitchingK','pK')) >= 120) cats.push('K');
      const era = Number(stat(p,'ERA','era'));
      if (era > 0 && era < 3.5) cats.push('ERA');
      const whip = Number(stat(p,'WHIP','whip'));
      if (whip > 0 && whip < 1.2) cats.push('WHIP');
      return cats;
    }
    const cats = [];
    if (Number(stat(p,'HR','hr')) >= 25) cats.push('HR');
    if (Number(stat(p,'RBI','rbi')) >= 80) cats.push('RBI');
    if (Number(stat(p,'R','r')) >= 80)  cats.push('R');
    if (Number(stat(p,'SB','sb')) >= 20) cats.push('SB');
    if (Number(stat(p,'H','h')) >= 145)  cats.push('AVG');
    return cats;
  };

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <header className="app-header">
        <h1>{sportConfig.emoji} Fantasy Draft Assistant</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
          <label style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.9em' }}>Sport:</label>
          <select
            value={sport}
            onChange={e => {
              const newSport = e.target.value;
              setSport(newSport);
              setActiveTab('draft');
              setDraftState(null);
              setFootballPicks([]);
              setFootballEngine(null);
              setFootballPlayers(null);
              if (newSport !== 'football') {
                loadState();
                loadCurrentTeam();
              }
            }}
            style={{ fontSize: '0.95em', padding: '4px 10px', borderRadius: 6 }}
          >
            <option value="baseball">⚾ Baseball</option>
            <option value="football">🏈 Football</option>
          </select>

          <button
            onClick={async () => {
              const hasPicks = isFootball(sport)
                ? footballPicks.length > 0
                : (draftState?.draftedPlayers?.length ?? 0) > 0;
              const msg = hasPicks
                ? `Start a new draft? This will erase all ${isFootball(sport) ? footballPicks.length + ' picks' : draftState.draftedPlayers.length + ' picks and all keepers'}. This cannot be undone.`
                : 'Start a new draft? This will reset all state.';
              if (!window.confirm(msg)) return;

              if (isFootball(sport)) {
                setFootballPicks([]);
                setFootballEngine(null);
                try { window.localStorage.removeItem('footballPicks'); } catch (_) {}
                showToast('🆕 New football draft started!');
              } else {
                try {
                  await apiFetch('/draft/reset', { method: 'POST' });
                  const state = await apiFetch(`/draft/auto-initialize?sport=${sport}`, { method: 'POST' });
                  setDraftState(state);
                  buildFuseIndex(state);
                  setKeeperGrid(makeKeeperGrid(myTeamId));
                  setRecs([]);
                  setNeeds({});
                  setMyRecBoard({ overall: [], pitchers: [], batters: [] });
                  setPickSearch('');
                  setPickResults([]);
                  setSelectedPick(null);
                  resetTimer();
                  showToast('🆕 New baseball draft started!');
                } catch (e) {
                  setErrorMsg(`Reset failed: ${e.message}`);
                }
              }
              setActiveTab('draft');
              setStatusMsg('');
              setErrorMsg('');
            }}
            style={{
              padding: '4px 14px', borderRadius: 6, border: '1px solid #fc8181',
              background: '#fff5f5', color: '#c53030', cursor: 'pointer',
              fontSize: '0.85em', fontWeight: 600,
            }}
            title="Reset all picks and start a new draft"
          >
            🆕 New Draft
          </button>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {[
          { id: 'draft',      label: '📋 Draft Board' },
          { id: 'recs',      label: '🎯 My Picks' },
          ...(isFootball(sport) ? [{ id: 'cheatsheet', label: '🗒️ Cheat Sheet' }] : []),
          { id: 'keepers',   label: '🔒 Keepers (optional)' },
          { id: 'drafted',   label: '📜 Drafted' },
          { id: 'trade',     label: '🔄 Trade Analyzer' },
          { id: 'chat',      label: '💬 Assistant' },
          { id: 'settings',  label: '⚙️ Scoring/Settings' },
        ].map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            className={`tab${activeTab === id ? ' active' : ''}`}
            onClick={() => { setActiveTab(id); setErrorMsg(''); setStatusMsg(''); }}
          >
            {label}
          </button>
        ))}
      </nav>

      {draftState?.teams?.length > 0 && (
        <section className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>Your Team:</strong>
            <select
              value={myTeamId || ''}
              onChange={e => setMyTeamId(Number(e.target.value) || null)}
              style={{ fontSize: '1em', padding: '4px 8px', borderRadius: 6 }}
            >
              {draftState.teams.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {myTeam && <span style={{ color: '#4a5568' }}>Selected: <strong>{myTeam.name}</strong></span>}
          </div>
        </section>
      )}

      {statusMsg && <div className="banner success" data-testid="status-msg">{statusMsg}</div>}
      {errorMsg  && <div className="banner error"   data-testid="error-msg">{errorMsg}</div>}
      {toastMsg && <div className="toast-msg">{toastMsg}</div>}

      {/* ── MOBILE BOTTOM NAV ─────────────────────────────────────────────── */}
      {showMoreMenu && (
        <>
          <div className="more-sheet-backdrop" onClick={() => setShowMoreMenu(false)} />
          <div className="more-sheet">
            <h4>More</h4>
            {[
              ...(isFootball(sport) ? [{ id: 'cheatsheet', icon: '🗒️', label: 'Cheat Sheet', desc: 'ESPN/Yahoo companion' }] : []),
              { id: 'keepers',   icon: '🔒', label: 'Keepers',         desc: 'Optional' },
              { id: 'trade',     icon: '🔄', label: 'Trade Analyzer',   desc: '' },
              { id: 'settings',  icon: '⚙️', label: 'Settings',         desc: '' },
            ].map(({ id, icon, label, desc }) => (
              <button
                key={id}
                className={`more-sheet-btn${activeTab === id ? ' active' : ''}`}
                onClick={() => { setActiveTab(id); setShowMoreMenu(false); setErrorMsg(''); setStatusMsg(''); }}
              >
                <span className="sheet-icon">{icon}</span>
                <span className="sheet-label">{label}</span>
                {desc && <span className="sheet-desc">{desc}</span>}
              </button>
            ))}
            <button
              className="more-sheet-btn danger"
              onClick={async () => {
                setShowMoreMenu(false);
                const hasPicks = isFootball(sport)
                  ? footballPicks.length > 0
                  : (draftState?.draftedPlayers?.length ?? 0) > 0;
                const msg = hasPicks
                  ? `Start a new draft? This will erase all picks. This cannot be undone.`
                  : 'Start a new draft? This will reset all state.';
                if (!window.confirm(msg)) return;
                if (isFootball(sport)) {
                  setFootballPicks([]);
                  setFootballEngine(null);
                  try { window.localStorage.removeItem('footballPicks'); } catch (_) {}
                  showToast('🆕 New football draft started!');
                } else {
                  try {
                    await apiFetch('/draft/reset', { method: 'POST' });
                    const state = await apiFetch(`/draft/auto-initialize?sport=${sport}`, { method: 'POST' });
                    setDraftState(state);
                    buildFuseIndex(state);
                    setKeeperGrid(makeKeeperGrid(myTeamId));
                    setRecs([]);
                    setNeeds({});
                    setMyRecBoard({ overall: [], pitchers: [], batters: [] });
                    setPickSearch('');
                    setPickResults([]);
                    setSelectedPick(null);
                    resetTimer();
                    showToast('🆕 New baseball draft started!');
                  } catch (e) {
                    setErrorMsg(`Reset failed: ${e.message}`);
                  }
                }
                setActiveTab('draft');
                setStatusMsg('');
                setErrorMsg('');
              }}
            >
              <span className="sheet-icon">🆕</span>
              <span className="sheet-label">New Draft</span>
            </button>
          </div>
        </>
      )}
      <nav className="bottom-nav" aria-label="Navigation">
        {[
          { id: 'draft',   icon: '📋', label: 'Board'   },
          { id: 'recs',    icon: '🎯', label: 'My Picks' },
          { id: 'drafted', icon: '📜', label: 'History'  },
          { id: 'chat',    icon: '💬', label: 'Chat'     },
        ].map(({ id, icon, label }) => (
          <button
            key={id}
            className={`bottom-nav-btn${activeTab === id ? ' active' : ''}`}
            onClick={() => { setActiveTab(id); setShowMoreMenu(false); setErrorMsg(''); setStatusMsg(''); }}
          >
            <span className="nav-icon">{icon}</span>
            <span className="nav-label">{label}</span>
          </button>
        ))}
        <button
          className={`bottom-nav-btn${ ['keepers','trade','settings'].includes(activeTab) ? ' active' : ''}`}
          onClick={() => setShowMoreMenu(m => !m)}
        >
          <span className="nav-icon">⋯</span>
          <span className="nav-label">More</span>
        </button>
      </nav>

      {/* Keep-alive bar */}
      <div className="keepalive-bar" data-testid="keepalive-bar">
        <span className={`ping-dot${pinging ? ' pinging' : ''}`} title="Connection status">●</span>
        <span className="ping-label">
          {lastPing ? `Last contact ${lastPing.toLocaleTimeString()}` : 'Auto-ping every 13 min to stay alive'}
        </span>
        <button className="btn-ping" onClick={ping} disabled={pinging} title="Ping the server now">
          {pinging ? '…' : '🔄'}
        </button>
      </div>

      {/* ── DRAFT BOARD TAB ─────────────────────────────────────────────── */}
      {activeTab === 'draft' && isFootball(sport) && footballLoading && (
        <div className="tab-content"><p className="hint">⏳ Loading NFL players from Sleeper + FantasyPros…</p></div>
      )}
      {activeTab === 'draft' && isFootball(sport) && footballError && !footballLoading && (
        <div className="tab-content"><div className="banner error">{footballError} (showing mock data)</div></div>
      )}
      {activeTab === 'draft' && isFootball(sport) && !footballLoading && footballEngine && (
        <div className="tab-content" data-testid="draft-tab-football">
          {/* Snake pick info bar */}
          {(() => {
            const currentOverallPick = footballDraftedIds.length + 1;
            const myNext = calcNextSnakePick(currentOverallPick + 1, footballTeamPos, footballTeamSize);
            const onClockSlot = calcTeamForPick(currentOverallPick, footballTeamSize);
            const isMyTurn = onClockSlot === footballTeamPos;
            return (
              <div style={{padding:'8px 14px',background: isMyTurn ? '#f0fff4' : '#f7fafc',border:`1px solid ${isMyTurn ? '#9ae6b4' : '#e2e8f0'}`,borderRadius:8,marginBottom:12,display:'flex',gap:16,flexWrap:'wrap',alignItems:'center',fontSize:'0.88em'}}>
                <span>📍 <strong>Overall pick:</strong> #{currentOverallPick}</span>
                <span>🕐 <strong>On the clock:</strong> Team {onClockSlot}{isMyTurn ? ' (You!)' : ''}</span>
                <span style={{display:'flex',alignItems:'center',gap:6}}>
                  🎯 <strong>Your slot:</strong>
                  <select value={footballTeamPos}
                    onChange={e => setFootballTeamPos(Math.min(Math.max(1, Number(e.target.value)), footballTeamSize))}
                    style={{padding:'2px 6px',borderRadius:4,border:'1px solid #cbd5e0',fontSize:'0.9em'}}>
                    {Array.from({length: footballTeamSize}, (_, i) => i + 1).map(n =>
                      <option key={n} value={n}>#{n}</option>
                    )}
                  </select>
                  <span style={{color:'#718096'}}>of {footballTeamSize}</span>
                </span>
                {myNext && <span>⏭ <strong>Your next pick:</strong> #{myNext}</span>}
                {isMyTurn && <span style={{color:'#276749',fontWeight:700}}>✅ You're on the clock!</span>}
                {/* Timer */}
                <span style={{display:'flex',alignItems:'center',gap:6,marginLeft:'auto'}}>
                  <span style={{
                    fontWeight:700,fontVariantNumeric:'tabular-nums',
                    color: timerLeft<=15?'#c53030':timerLeft<=30?'#dd6b20':'#2d3748'
                  }}>
                    {String(Math.floor(timerLeft/60)).padStart(2,'0')}:{String(timerLeft%60).padStart(2,'0')}
                  </span>
                  {!timerActive
                    ? <button onClick={startTimer} style={{padding:'2px 8px',borderRadius:5,border:'1px solid #9ae6b4',background:'#f0fff4',color:'#276749',cursor:'pointer',fontSize:'0.8em'}}>Start</button>
                    : <button onClick={resetTimer} style={{padding:'2px 8px',borderRadius:5,border:'1px solid #feb2b2',background:'#fff5f5',color:'#c53030',cursor:'pointer',fontSize:'0.8em'}}>Reset</button>
                  }
                </span>
              </div>
            );
          })()}

          {/* Search bar */}
          <div style={{marginBottom:12}}>
            <input
              type="text"
              placeholder="Search players by name, position, or team…"
              value={footballBoardSearch}
              onChange={e => setFootballBoardSearch(e.target.value)}
              style={{width:'100%',padding:'8px 12px',fontSize:'0.95em',borderRadius:6,border:'1px solid #cbd5e0',boxSizing:'border-box'}}
            />
          </div>
          {(() => {
            const q = footballBoardSearch.trim().toLowerCase();
            const available = footballEngine.players.filter(p => !p.isDrafted);

            // Sort the available pool based on selected column
            const sortFn = (() => {
              const { col, dir } = footballBoardSort;
              const d = dir === 'asc' ? 1 : -1;
              if (col === 'vbd')  return (a, b) => d * ((a.vbd ?? -1) - (b.vbd ?? -1));
              if (col === 'pts')  return (a, b) => d * ((a.projections?.fantasyPoints ?? 0) - (b.projections?.fantasyPoints ?? 0));
              if (col === 'adp')  return (a, b) => d * ((a.adp ?? 999) - (b.adp ?? 999));
              return () => 0;
            })();

            const sorted = [...available].sort(sortFn);
            const searchResults = q
              ? sorted.filter(p =>
                  p.name.toLowerCase().includes(q) ||
                  p.position.toLowerCase().includes(q) ||
                  p.team.toLowerCase().includes(q)
                ).slice(0, 20)
              : null;
            const rows = searchResults ?? sorted.slice(0, 10);
            const title = searchResults ? `Search Results (${rows.length})` : '🏈 Top 10 Available';

            const sortHeader = (col, label, title) => {
              const active = footballBoardSort.col === col;
              const arrow = active ? (footballBoardSort.dir === 'desc' ? ' ↓' : ' ↑') : '';
              return (
                <th key={col}
                  title={title}
                  style={{cursor:'pointer', userSelect:'none', color: active ? '#2b6cb0' : undefined}}
                  onClick={() => setFootballBoardSort(s =>
                    s.col === col ? { col, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: col === 'adp' ? 'asc' : 'desc' }
                  )}>
                  {label}{arrow}
                </th>
              );
            };

            return (
              <section className="card">
                <h3>{title}</h3>
                <div className="data-table-wrapper">
                  <table className="data-table">
                    <thead><tr>
                      <th>#</th><th>Player</th><th>Pos</th><th>Pos Rank</th><th>Team</th>
                      {sortHeader('vbd', 'VBD', 'Value Over Replacement — positional scarcity-adjusted rank')}
                      {sortHeader('pts', 'Proj Pts', 'Projected fantasy points')}
                      {sortHeader('adp', 'ADP', 'Average Draft Position — click to sort by when players typically go')}
                      <th title="Composite rank from FantasyPros, ESPN, and CBS — lower is better">Consensus</th>
                      <th>Bye / Status</th>
                      <th className="sticky-col"></th>
                    </tr></thead>
                    <tbody>
                      {rows.map((p, i) => {
                        const cr = p.nextGen?.compositeRank;
                        const sc = p.nextGen?.sourceCount ?? 0;
                        return (
                        <tr key={p.id}>
                          <td className="pick-num">#{i+1}</td>
                          <td><strong>{p.name}</strong></td>
                          <td><span className="badge">{p.position}</span></td>
                          <td style={{color:'#4a5568',fontWeight:600}}>
                            {p.nextGen?.posRank ? `${p.position}${p.nextGen.posRank}` : '—'}
                          </td>
                          <td>{p.team}</td>
                          <td style={{fontWeight:600,color: footballBoardSort.col === 'vbd' ? '#2b6cb0' : undefined}}>{p.vbd != null ? p.vbd.toFixed(1) : '—'}</td>
                          <td style={{fontWeight: footballBoardSort.col === 'pts' ? 600 : undefined}}>{p.projections.fantasyPoints.toFixed(1)}</td>
                          <td style={{fontWeight: footballBoardSort.col === 'adp' ? 600 : undefined}}>{p.adp ?? '—'}</td>
                          <td title={`Sources: ${sc}/7 (FP/ESPN/CBS/Berry/DraftSharks/FantasyLife/Yahoo)`}>
                            {cr ? <>
                              <strong>{cr.toFixed(1)}</strong>
                              <span style={{marginLeft:4,fontSize:'0.7em',color: sc >= 5 ? '#38a169' : sc >= 2 ? '#dd6b20' : '#a0aec0'}}>
                                {'●'.repeat(sc)}{'○'.repeat(Math.max(0, 7 - sc))}
                              </span>
                            </> : '—'}
                          </td>
                          <td>
                            {p.byeWeek ? `Wk ${p.byeWeek}` : '—'}
                            {p.status && p.status !== 'Active' && (
                              <span style={{marginLeft:4,fontSize:'0.72em',padding:'1px 5px',borderRadius:4,background:'#fff5f5',color:'#c53030',border:'1px solid #fed7d7'}}>{p.status}</span>
                            )}
                          </td>
                          <td className="sticky-col">
                            <button className="btn-primary" style={{padding:'4px 10px',fontSize:'0.85em'}}
                              onClick={() => { addFootballPick(p.id); setFootballBoardSearch(''); }}>
                              Draft
                            </button>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })()}

          <section className="card">
            <h3>Recommendations</h3>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))',gap:16}}>
              {[
                {label:'🏆 Best Pick', players: footballEngine.bestPick, subtitle:'Smart pick for your roster — balances best available with what you need + scarcity', extraCol: p => p.adp != null ? `ADP ${p.adp}` : null},
                {label:'💎 Best Value', players: footballEngine.bestValue, subtitle:'Slipped past their ADP — still here at your pick', extraCol: p => `${(p.valueScore??0).toFixed(0)} picks past ADP`},
                {label:'⏰ Won\'t Make It Back', players: footballEngine.wontMakeItBack, subtitle:'Gone before your next pick'},
                {label:'🚀 Upside Pick', players: footballEngine.upsidePick, subtitle:'Breakout potential via analytics', extraCol: p => `${(p.breakoutScore??0).toFixed(1)} brk`},
              ].map(({label, players, subtitle, extraCol}) => (
                <div key={label} style={{background:'#f7fafc',borderRadius:8,padding:12,border:'1px solid #e2e8f0'}}>
                  <h4 style={{margin:'0 0 4px'}}>{label}</h4>
                  <p style={{margin:'0 0 8px',fontSize:'0.8em',color:'#718096'}}>{subtitle}</p>
                  {players.length === 0
                    ? <p style={{color:'#a0aec0',fontSize:'0.85em'}}>—</p>
                    : players.map(p => (
                      <div key={p.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                        <span>
                          <span className="badge">{p.position}</span>
                          {p.nextGen?.posRank && (
                            <span style={{fontSize:'0.75em',color:'#4a5568',fontWeight:600,marginLeft:2}}>
                              {p.position}{p.nextGen.posRank}
                            </span>
                          )}{' '}
                          <strong>{p.name}</strong>{' '}
                          <span style={{color:'#718096',fontSize:'0.8em'}}>{p.team}</span>
                        </span>
                        <span style={{display:'flex',gap:6,alignItems:'center',fontSize:'0.82em',color:'#4a5568'}}>
                          {extraCol && <span style={{color:'#38a169'}}>{extraCol(p)}</span>}
                          <span>{p.projections.fantasyPoints.toFixed(1)} pts</span>
                          <button className="btn-primary" style={{padding:'2px 8px',fontSize:'0.8em'}}
                            onClick={() => addFootballPick(p.id)}>
                            Draft
                          </button>
                        </span>
                      </div>
                    ))
                  }
                </div>
              ))}
            </div>
          </section>

          {(() => {
            const availPos = sportConfig.positions.filter(pos => footballEngine.topByPosition[pos]?.length > 0);
            if (!availPos.length) return null;
            const selPos = availPos.includes(footballPosFilter) ? footballPosFilter : availPos[0];
            const topPlayers = (footballEngine.topByPosition[selPos] ?? []).slice(0, 5);
            return (
              <section className="card">
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,flexWrap:'wrap'}}>
                  <h4 style={{margin:0}}>Top Players by Position</h4>
                  <select
                    value={selPos}
                    onChange={e => setFootballPosFilter(e.target.value)}
                    style={{padding:'4px 10px',borderRadius:6,border:'1px solid #cbd5e0',fontSize:'0.9em'}}
                  >
                    {availPos.map(pos => <option key={pos} value={pos}>{pos}</option>)}
                  </select>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {topPlayers.map((p, i) => (
                    <div key={p.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',background:'#f7fafc',borderRadius:6,border:'1px solid #e2e8f0'}}>
                      <span style={{fontWeight:700,color:'#a0aec0',minWidth:22,textAlign:'right'}}>#{i+1}</span>
                      <span className="badge">{p.position}</span>
                      <strong style={{flex:1}}>{p.name}</strong>
                      <span style={{color:'#718096',fontSize:'0.85em'}}>{p.team}</span>
                      <span style={{color:'#4a5568',fontSize:'0.85em',minWidth:55,textAlign:'right'}}>{p.projections.fantasyPoints.toFixed(1)} pts</span>
                      <button className="btn-primary" style={{padding:'2px 8px',fontSize:'0.78em'}}
                        onClick={() => addFootballPick(p.id)}>Draft</button>
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

          <section className="card">
            <h4 style={{display:'flex',alignItems:'center',gap:10}}>
              Drafted Players ({footballDraftedIds.length})
              {footballDraftedIds.length > 0 && (
                <button onClick={() => {
                  const lastPick = footballPicks[footballPicks.length - 1];
                  if (lastPick) { removeFootballPick(lastPick.playerId); showToast('↩️ Undid last pick'); }
                }} style={{fontSize:'0.8em',padding:'3px 10px',borderRadius:6,border:'1px solid #e2e8f0',background:'#f7fafc',color:'#4a5568',cursor:'pointer',fontWeight:400}}>
                  ↩ Undo Last
                </button>
              )}
              {footballDraftedIds.length > 0 && (
                <button onClick={() => setDraftedChipsExpanded(x => !x)}
                  style={{fontSize:'0.8em',padding:'3px 10px',borderRadius:6,border:'1px solid #e2e8f0',background:'#f7fafc',color:'#4a5568',cursor:'pointer',fontWeight:400,marginLeft:'auto'}}>
                  {draftedChipsExpanded ? '▲ Collapse' : '▼ Expand'}
                </button>
              )}
            </h4>
            {footballDraftedIds.length === 0
              ? <p className="hint">No players drafted yet. See the 📜 History tab for the full draft order.</p>
              : draftedChipsExpanded
                ? <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                    {footballEngine.players
                      .filter(p => footballDraftedIds.includes(p.id))
                      .map(p => {
                        const pick = footballPicks.find(fp => fp.playerId === p.id);
                        const teamLabel = pick ? `T${pick.teamSlot}` : '?';
                        return (
                        <span key={p.id} style={{background:'#fed7d7',borderRadius:4,padding:'3px 8px',fontSize:'0.82em'}}>
                          <span className="badge" style={{background:'#4a5568'}}>{teamLabel}</span>
                          <span className="badge">{p.position}</span> {p.name}
                          <button style={{marginLeft:4,background:'none',border:'none',cursor:'pointer',color:'#c53030'}}
                            onClick={() => removeFootballPick(p.id)}>✕</button>
                        </span>
                        );
                      })}
                  </div>
                : <p className="hint" style={{margin:0}}>Click ▼ Expand to see all {footballDraftedIds.length} drafted players, or view the 📜 History tab.</p>
            }
          </section>

          {/* Per-team roster tracker — like baseball */}
          <section className="card">
            <h3>Team Rosters <span style={{fontSize:'0.85rem',fontWeight:400,color:'#b7791f'}}>— your team is highlighted ⭐</span></h3>
            <div className="team-grid">
              {Array.from({length: footballTeamSize}, (_, i) => i + 1)
                .sort((a, b) => {
                  if (a === footballTeamPos) return -1;
                  if (b === footballTeamPos) return 1;
                  return a - b;
                })
                .map(slot => {
                  const isMine = slot === footballTeamPos;
                  const currentOverallPick = footballPicks.length + 1;
                  const onClock = calcTeamForPick(currentOverallPick, footballTeamSize) === slot;
                  const teamPicks = footballPicks
                    .filter(p => p.teamSlot === slot)
                    .map(p => ({ pick: p, player: footballEngine.players.find(pl => pl.id === p.playerId) }))
                    .filter(x => x.player);
                  return (
                    <div key={slot} className={`team-card${onClock ? ' on-clock' : ''}${isMine ? ' my-team' : ''}`}>
                      <h4>
                        {isMine ? '⭐ ' : ''}{onClock && '🕐 '}Team {slot}{isMine ? ' (You)' : ''}
                        {isMine && <span className="my-team-badge">YOUR TEAM</span>}
                        <span className="pick-count">({teamPicks.length} picks)</span>
                      </h4>
                      {teamPicks.length === 0
                        ? <p className="empty-roster">—</p>
                        : <ol>{teamPicks.map(({player}) => (
                            <li key={player.id}>
                              <span className="badge">{player.position}</span> {player.name}
                            </li>
                          ))}</ol>
                      }
                    </div>
                  );
                })}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'draft' && !isFootball(sport) && (
        <div className="tab-content" data-testid="draft-tab">

          {currentTeam && draftState ? (
            <div className="on-the-clock">
              <div className="clock-main">
                <span className="clock-label">🕐 On the Clock</span>
                <span className="clock-team">{currentTeam.name}</span>
                <span className="clock-meta">
                  Round {draftState.round} · Pick {draftState.currentPick}
                  {isLateRound && <span className="upside-badge">🚀 Upside Mode</span>}
                </span>
              </div>
              {Object.keys(positionalNeeds).length > 0 && (
                <div className="needs-row">
                  <span className="needs-label">Still needs:</span>
                  {Object.entries(positionalNeeds).map(([pos, count]) => (
                    <span key={pos} className="needs-badge" title={`Need ${count} more ${pos}`}>
                      {pos}{count > 1 ? ` ×${count}` : ''}
                    </span>
                  ))}
                </div>
              )}
              {/* Draft timer */}
              <div style={{display:'flex',alignItems:'center',gap:8,marginTop:8,flexWrap:'wrap'}}>
                <span style={{
                  fontSize:'1.3em',fontWeight:700,fontVariantNumeric:'tabular-nums',
                  color: timerLeft <= 15 ? '#c53030' : timerLeft <= 30 ? '#dd6b20' : '#2d3748',
                  minWidth: 42, textAlign:'center',
                }}>
                  {String(Math.floor(timerLeft/60)).padStart(2,'0')}:{String(timerLeft%60).padStart(2,'0')}
                </span>
                <input type="range" min={30} max={300} step={30} value={timerSeconds}
                  onChange={e => { setTimerSeconds(Number(e.target.value)); resetTimer(); }}
                  style={{width:80}} title={`${timerSeconds}s per pick`}
                />
                <span style={{fontSize:'0.78em',color:'#718096'}}>{timerSeconds}s</span>
                {!timerActive
                  ? <button onClick={startTimer} style={{padding:'3px 10px',borderRadius:6,border:'1px solid #9ae6b4',background:'#f0fff4',color:'#276749',cursor:'pointer',fontSize:'0.82em'}}>Start</button>
                  : <button onClick={resetTimer} style={{padding:'3px 10px',borderRadius:6,border:'1px solid #feb2b2',background:'#fff5f5',color:'#c53030',cursor:'pointer',fontSize:'0.82em'}}>Reset</button>
                }
                {draftState.draftedPlayers?.length > 0 && (
                  <button onClick={handleUndo}
                    style={{marginLeft:8,padding:'3px 10px',borderRadius:6,border:'1px solid #e2e8f0',background:'#f7fafc',color:'#4a5568',cursor:'pointer',fontSize:'0.82em'}}
                    title="Undo last pick">
                    ↩ Undo
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="hint">Draft not initialized — POST /draft/initialize to start.</p>
          )}

          {/* Pick form */}
          <section className="card">
            <h3>
              Draft a Player
              {currentTeam && (
                <span className="picking-for" data-testid="picking-for">
                  — picking for <strong>{currentTeam.name}</strong>
                </span>
              )}
            </h3>
            <PlayerSearch
              label="Player"
              value={pickSearch}
              onChange={q => { setPickSearch(q); setSelectedPick(null); searchPlayers(q, setPickResults); }}
              onSelect={p => { setSelectedPick(p); setPickSearch(p.name); setPickResults([]); }}
              results={pickResults}
            />
            {selectedPick && (
              <div className="selected-player" data-testid="selected-player">
                Selected: <strong>{selectedPick.name}</strong>
                <span className="badge">{selectedPick.position}</span> {selectedPick.team}
              </div>
            )}
            {pendingPlayerLabel && (
              <div className="pending-pick-hint" data-testid="pending-pick-hint">
                {pendingPlayerLabel}
              </div>
            )}
            <button className="btn-primary" onClick={handleDraftPick} disabled={!canSubmitPick}>
              Submit Pick
            </button>
          </section>

          {/* Available Player Browser */}
          {draftState?.availablePlayers?.length > 0 && (
            <section className="card">
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
                <h3 style={{margin:0}}>⚾ Available Players</h3>
                <input
                  type="text"
                  placeholder="Search by name or team…"
                  value={baseballBoardSearch}
                  onChange={e => setBaseballBoardSearch(e.target.value)}
                  style={{flex:1,minWidth:140,padding:'5px 10px',border:'1px solid #cbd5e0',borderRadius:6,fontSize:'0.9em'}}
                />
                <select
                  value={baseballBoardPos}
                  onChange={e => setBaseballBoardPos(e.target.value)}
                  style={{padding:'5px 10px',border:'1px solid #cbd5e0',borderRadius:6,fontSize:'0.9em'}}
                >
                  <option value="ALL">All Positions</option>
                  {sportConfig.positions.map(pos => <option key={pos} value={pos}>{pos}</option>)}
                </select>
              </div>
              {(() => {
                const q = baseballBoardSearch.trim().toLowerCase();
                let players = draftState.availablePlayers;
                if (baseballBoardPos !== 'ALL') players = players.filter(p => p.position === baseballBoardPos);
                if (q) players = players.filter(p =>
                  p.name.toLowerCase().includes(q) || (p.team ?? '').toLowerCase().includes(q)
                );
                const rows = players.slice(0, 15);
                if (rows.length === 0) return <p className="hint">No available players match that filter.</p>;
                return (
                  <div className="data-table-wrapper">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Player</th><th>Pos</th><th>Team</th>
                          <th>Key Stats</th><th>Cats</th><th className="sticky-col"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p, i) => (
                          <tr key={p.id} className="clickable"
                            onClick={() => { setSelectedPick(p); setPickSearch(p.name); setPickResults([]); }}
                            title="Click to select">
                            <td className="pick-num">#{i + 1}</td>
                            <td><strong>{p.name}</strong></td>
                            <td><span className="badge">{p.position}</span></td>
                            <td>{p.team}</td>
                            <td style={{fontSize:'0.83em',color:'#4a5568'}}>{shortProjection(p)}</td>
                            <td style={{whiteSpace:'nowrap'}}>
                              {baseballCatStrength(p).map(c => (
                                <span key={c} style={{display:'inline-block',marginRight:3,padding:'1px 5px',borderRadius:4,fontSize:'0.72em',background:'#ebf8ff',color:'#2b6cb0',border:'1px solid #bee3f8',fontWeight:600}}>{c}</span>
                              ))}
                            </td>
                            <td className="sticky-col">
                              <button className="btn-primary" style={{padding:'4px 12px',fontSize:'0.85em'}}
                                onClick={e => { e.stopPropagation(); handlePickPlayer(p); }}>
                                Draft
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </section>
          )}

          {/* Top 5 by Position */}
          {draftState?.availablePlayers?.length > 0 && (() => {
            const availPos = sportConfig.positions.filter(pos =>
              draftState.availablePlayers.some(p => p.position === pos)
            );
            if (!availPos.length) return null;
            const selPos = availPos.includes(baseballTopPos) ? baseballTopPos : availPos[0];
            const topPlayers = draftState.availablePlayers
              .filter(p => p.position === selPos)
              .slice(0, 5);
            return (
              <section className="card">
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,flexWrap:'wrap'}}>
                  <h4 style={{margin:0}}>Top Players by Position</h4>
                  <select
                    value={selPos}
                    onChange={e => setBaseballTopPos(e.target.value)}
                    style={{padding:'4px 10px',borderRadius:6,border:'1px solid #cbd5e0',fontSize:'0.9em'}}
                  >
                    {availPos.map(pos => <option key={pos} value={pos}>{pos}</option>)}
                  </select>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {topPlayers.map((p, i) => (
                    <div key={p.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',background:'#f7fafc',borderRadius:6,border:'1px solid #e2e8f0',cursor:'pointer'}}
                      onClick={() => { setSelectedPick(p); setPickSearch(p.name); setPickResults([]); }}>
                      <span style={{fontWeight:700,color:'#a0aec0',minWidth:22,textAlign:'right'}}>#{i+1}</span>
                      <span className="badge">{p.position}</span>
                      <strong style={{flex:1}}>{p.name}</strong>
                      <span style={{color:'#718096',fontSize:'0.85em'}}>{p.team}</span>
                      <span style={{color:'#4a5568',fontSize:'0.82em',minWidth:120,textAlign:'right'}}>{shortProjection(p)}</span>
                      <div style={{display:'flex',gap:3}}>
                        {baseballCatStrength(p).map(c => (
                          <span key={c} style={{padding:'1px 5px',borderRadius:4,fontSize:'0.7em',background:'#ebf8ff',color:'#2b6cb0',border:'1px solid #bee3f8',fontWeight:600}}>{c}</span>
                        ))}
                      </div>
                      <button className="btn-primary" style={{padding:'2px 8px',fontSize:'0.78em',flexShrink:0}}
                        onClick={e => { e.stopPropagation(); handlePickPlayer(p); }}>Draft</button>
                    </div>
                  ))}
                  {topPlayers.length === 0 && <p className="hint" style={{margin:0}}>No available {selPos}s.</p>}
                </div>
              </section>
            );
          })()}

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <section className="card">
              <h3>Top Picks for {currentTeam?.name}{isLateRound && ' — Upside Weighted 🚀'}</h3>
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Player</th><th>Pos</th><th>MLB</th><th>Projected Stats</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recommendations.map((p, i) => (
                      <tr key={p.id} className="clickable"
                        onClick={() => { setSelectedPick(p); setPickSearch(p.name); setPickResults([]); }}
                        title="Click to select">
                        <td className="pick-num">#{i + 1}</td>
                        <td><strong>{p.name}</strong></td>
                        <td><span className="badge">{p.position}</span></td>
                        <td>{p.team}</td>
                        <td style={{ fontSize: '0.85em' }}>{overallProjection(p)}</td>
                        <td>
                          <button className="btn-primary" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={(e) => { e.stopPropagation(); setSelectedPick(p); setPickSearch(p.name); handleDraftPick(); }}>
                            Draft
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Team Tracker */}
          {draftState?.teams?.length > 0 && (
            <section className="card">
              <h3>Team Rosters {myTeamId && <span style={{fontSize:'0.85rem',fontWeight:400,color:'#b7791f'}}>— your team is highlighted ⭐</span>}</h3>
              <div className="team-grid">
                {[...draftState.teams]
                  .sort((a, b) => {
                    if (a.id === myTeamId) return -1;
                    if (b.id === myTeamId) return 1;
                    return 0;
                  })
                  .map(team => {
                  const isMine = team.id === myTeamId;
                  const onClock = currentTeam?.id === team.id;
                  return (
                  <div key={team.id}
                    className={`team-card${onClock ? ' on-clock' : ''}${isMine ? ' my-team' : ''}`}>
                    <h4>
                      {isMine ? '⭐ ' : ''}{onClock && '🕐 '}{team.name}
                      {isMine && <span className="my-team-badge">YOUR TEAM</span>}
                      <span className="pick-count">({team.roster.length} picks)</span>
                    </h4>
                    {team.roster.length === 0
                      ? <p className="empty-roster">—</p>
                      : <ol>{team.roster.map(p => (
                          <li key={p.id}>
                            <span className="badge">{p.position}</span> {p.name}
                            {p.keeper && <span className="keeper-tag">🔒</span>}
                          </li>
                        ))}</ol>
                    }
                  </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ── MY PICKS TAB — FOOTBALL ─────────────────────────────────────── */}
      {activeTab === 'recs' && isFootball(sport) && (
        <div className="tab-content" data-testid="recs-tab-football">
          {!footballEngine ? (
            <p className="hint">Loading football data…</p>
          ) : (
            <>
              {(() => {
                const currentOverallPick = footballDraftedIds.length + 1;
                const onClockSlot = calcTeamForPick(currentOverallPick, footballTeamSize);
                const isMyTurn = onClockSlot === footballTeamPos;
                const myNextPick = calcNextSnakePick(currentOverallPick + 1, footballTeamPos, footballTeamSize);

                // Build roster slots: assign drafted players to position slots greedily.
                // Filter by team slot — picks for OTHER teams must not show up on my roster.
                const myPlayerIds = new Set(
                  footballPicks.filter(p => p.teamSlot === footballTeamPos).map(p => p.playerId)
                );
                const drafted = footballEngine.players.filter(p => myPlayerIds.has(p.id));
                const byPos = {};
                drafted.forEach(p => { byPos[p.position] = [...(byPos[p.position] || []), p]; });
                const req = sportConfig.rosterRequirements;
                const flexPositions = sportConfig.flexPositions ?? [];
                const slots = [];
                for (const [pos, count] of Object.entries(req)) {
                  if (pos === 'FLEX') continue;
                  for (let i = 0; i < count; i++) {
                    const player = byPos[pos]?.shift() ?? null;
                    slots.push({ label: count > 1 ? `${pos} ${i+1}` : pos, pos, player });
                  }
                }
                if (req.FLEX) {
                  for (let i = 0; i < req.FLEX; i++) {
                    let flexPlayer = null;
                    for (const fp of flexPositions) {
                      if (byPos[fp]?.length) { flexPlayer = byPos[fp].shift(); break; }
                    }
                    slots.push({ label: 'FLEX', pos: 'FLEX', player: flexPlayer });
                  }
                }
                // Bench: remaining players
                const bench = Object.values(byPos).flat();

                return (
                  <>
                    {/* Turn indicator */}
                    <div style={{padding:'8px 14px',background: isMyTurn ? '#f0fff4' : '#f7fafc',border:`1px solid ${isMyTurn ? '#9ae6b4' : '#e2e8f0'}`,borderRadius:8,marginBottom:12,display:'flex',gap:16,flexWrap:'wrap',alignItems:'center',fontSize:'0.88em'}}>
                      <span>📍 <strong>Overall pick:</strong> #{currentOverallPick}</span>
                      <span>🕐 <strong>On the clock:</strong> Team {onClockSlot}{isMyTurn ? ' (You!)' : ''}</span>
                      {!isMyTurn && myNextPick && <span>⏭ <strong>Your next pick:</strong> #{myNextPick}</span>}
                      {isMyTurn && <span style={{color:'#276749',fontWeight:700}}>✅ Your pick — draft a player below!</span>}
                      {!isMyTurn && <span style={{color:'#c05621',fontWeight:600}}>Waiting for Team {onClockSlot}…</span>}
                    </div>

                    {/* Roster slots table */}
                    <section className="card">
                      <h3>🎯 My Roster</h3>
                      <table className="data-table" style={{marginBottom: bench.length ? 12 : 0}}>
                        <thead><tr><th>Slot</th><th>Player</th><th>Team</th><th>Proj Pts</th><th></th></tr></thead>
                        <tbody>
                          {slots.map((slot, i) => (
                            <tr key={i} style={{background: slot.player ? undefined : '#fffaf0'}}>
                              <td><span className="badge" style={{background: slot.player ? undefined : '#fed7aa', color: slot.player ? undefined : '#7c2d12'}}>{slot.label}</span></td>
                              <td>{slot.player ? <strong>{slot.player.name}</strong> : <span style={{color:'#a0aec0',fontStyle:'italic'}}>Empty</span>}</td>
                              <td>{slot.player?.team ?? '—'}</td>
                              <td>{slot.player ? slot.player.projections.fantasyPoints.toFixed(0) : '—'}</td>
                              <td>{slot.player && (
                                <button style={{background:'none',border:'none',cursor:'pointer',color:'#c53030',fontSize:'0.85em'}}
                                  onClick={() => removeFootballPick(slot.player.id)}>✕</button>
                              )}</td>
                            </tr>
                          ))}
                          {bench.map((p, i) => (
                            <tr key={`bench-${p.id}`} style={{background:'#f7fafc'}}>
                              <td><span className="badge" style={{background:'#e2e8f0',color:'#4a5568'}}>BN {i+1}</span></td>
                              <td><strong>{p.name}</strong></td>
                              <td>{p.team}</td>
                              <td>{p.projections.fantasyPoints.toFixed(0)}</td>
                              <td>
                                <button style={{background:'none',border:'none',cursor:'pointer',color:'#c53030',fontSize:'0.85em'}}
                                  onClick={() => removeFootballPick(p.id)}>✕</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </section>

                    {/* Available players — only allow drafting on my turn */}
                    <section className="card">
                      <h3>Top 10 Available {!isMyTurn && <span style={{fontSize:'0.8em',color:'#a0aec0',fontWeight:400}}>(draft unlocks on your pick)</span>}</h3>
                      <div className="data-table-wrapper">
                        <table className="data-table">
                          <thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th>VBD</th><th>Proj Pts</th><th>ADP</th><th></th></tr></thead>
                          <tbody>
                            {footballEngine.top10.map((p, i) => (
                              <tr key={p.id}>
                                <td className="pick-num">#{i+1}</td>
                                <td><strong>{p.name}</strong></td>
                                <td><span className="badge">{p.position}</span></td>
                                <td>{p.team}</td>
                                <td style={{fontWeight:600,color:'#2b6cb0'}}>{p.vbd != null ? p.vbd.toFixed(0) : '—'}</td>
                                <td>{p.projections.fantasyPoints.toFixed(1)}</td>
                                <td>{p.adp ?? '—'}</td>
                                <td>
                                  <button className="btn-primary" style={{padding:'4px 10px',fontSize:'0.85em'}}
                                    disabled={!isMyTurn}
                                    title={!isMyTurn ? `Waiting for Team ${onClockSlot} to pick` : 'Draft this player'}
                                    onClick={() => addFootballPick(p.id)}>
                                    Draft
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </>
                );
              })()}

              {footballEngine.wontMakeItBack.length > 0 && (
                <section className="card">
                  <h3>⏰ Won't Make It Back</h3>
                  <p className="hint" style={{marginTop:0}}>Gone before your next pick (#{calcNextSnakePick(footballDraftedIds.length + 2, footballTeamPos, footballTeamSize)})</p>
                  <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
                    {footballEngine.wontMakeItBack.map(p => (
                      <div key={p.id} style={{background:'#fff5f5',border:'1px solid #feb2b2',borderRadius:6,padding:'6px 10px',fontSize:'0.85em'}}>
                        <span className="badge">{p.position}</span> <strong>{p.name}</strong>{' '}
                        <span style={{color:'#718096'}}>{p.team}</span>{' '}
                        <span style={{color:'#e53e3e',fontWeight:600}}>ADP {p.adp}</span>
                        <button className="btn-primary" style={{marginLeft:6,padding:'2px 8px',fontSize:'0.78em'}}
                          onClick={() => addFootballPick(p.id)}>Draft</button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {/* ── MY PICKS / RECOMMENDATIONS TAB — BASEBALL ───────────────────── */}
      {activeTab === 'recs' && !isFootball(sport) && (
        <div className="tab-content" data-testid="recs-tab">
          {!draftState ? (
            <p className="hint">Draft not initialized yet.</p>
          ) : (
            <section className="card">
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>🎯 Top Picks for</h3>
                <select
                  value={myTeamId || ''}
                  onChange={e => setMyTeamId(Number(e.target.value))}
                  style={{ fontSize: '1em', padding: '4px 8px', borderRadius: 6 }}
                >
                  {draftState.teams.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <span style={{ color: '#888', fontSize: '0.85em' }}>Round {draftState.round}</span>
                <button
                  className="btn-ping"
                  onClick={() => myTeamId && loadMyRecs(myTeamId, draftState.round)}
                  disabled={recsLoading}
                  title="Refresh recommendations"
                  style={{ marginLeft: 4 }}
                >
                  {recsLoading ? '…' : '🔄 Refresh'}
                </button>
              </div>

              {/* On-the-clock banner */}
              {currentTeam && (
                <div style={{ marginBottom: 14 }}>
                  {currentTeam.id === myTeamId
                    ? <div className="banner success" style={{ margin: 0 }}>
                        ✅ It's YOUR turn! Round {draftState.round} · Pick {draftState.currentPick} — select a player below and click <strong>Draft</strong>.
                      </div>
                    : <div className="banner" style={{ margin: 0, background: '#f0f4ff', color: '#555', border: '1px solid #c5d3f5' }}>
                        ⏳ <strong>{currentTeam.name}</strong> is on the clock (Rd {draftState.round} · Pick {draftState.currentPick}). Plan your next pick below.
                      </div>
                  }
                </div>
              )}

              {(myRecBoard.overall.length === 0 && myRecBoard.pitchers.length === 0 && myRecBoard.batters.length === 0) ? (
                <p className="hint">
                  {recsLoading
                    ? 'Loading recommendations…'
                    : 'No recommendations yet — select your team above and click 🔄 Refresh.'}
                </p>
              ) : (
                <>
                  <h4 style={{ margin: '8px 0' }}>Top 15 Overall</h4>
                  <div className="data-table-wrapper">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Player</th><th>Pos</th><th>MLB</th><th>Projected Stats</th><th>Cats</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {myRecBoard.overall.map((p, i) => (
                          <tr key={`overall-${p.id}`}>
                            <td className="pick-num">#{i + 1}</td>
                            <td><strong>{p.name}</strong></td>
                            <td><span className="badge">{p.position}</span></td>
                            <td>{p.team}</td>
                            <td style={{ fontSize: '0.85em' }}>{overallProjection(p)}</td>
                            <td style={{whiteSpace:'nowrap'}}>
                              {baseballCatStrength(p).map(c => (
                                <span key={c} style={{display:'inline-block',marginRight:3,padding:'1px 5px',borderRadius:4,fontSize:'0.72em',background:'#ebf8ff',color:'#2b6cb0',border:'1px solid #bee3f8',fontWeight:600}}>{c}</span>
                              ))}
                            </td>
                            <td>
                              <button className="btn-primary" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={() => handlePickPlayer(p)}>
                                Draft
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <h4 style={{ margin: '16px 0 8px' }}>Top 10 Pitchers</h4>
                  <div className="data-table-wrapper">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Player</th><th>Pos</th><th>MLB</th>
                          <th>IP</th><th>W</th><th>L</th><th>SV</th><th>BB</th><th>K</th><th>ERA</th><th>WHIP</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {myRecBoard.pitchers.map((p, i) => (
                          <tr key={`pitcher-${p.id}`}>
                            <td className="pick-num">#{i + 1}</td>
                            <td><strong>{p.name}</strong></td>
                            <td><span className="badge">{p.position}</span></td>
                            <td>{p.team}</td>
                            <td>{Number(stat(p, 'IP', 'ip')).toFixed(1)}</td>
                            <td>{stat(p, 'W', 'w')}</td>
                            <td>{stat(p, 'L', 'l')}</td>
                            <td>{stat(p, 'SV', 'sv')}</td>
                            <td>{stat(p, 'pitchingBB', 'pBB')}</td>
                            <td>{stat(p, 'pitchingK', 'pK')}</td>
                            <td>{Number(stat(p, 'ERA', 'era')).toFixed(2)}</td>
                            <td>{Number(stat(p, 'WHIP', 'whip')).toFixed(2)}</td>
                            <td><button className="btn-primary" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={() => handlePickPlayer(p)}>Draft</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <h4 style={{ margin: '16px 0 8px' }}>Top 10 Batters</h4>
                  <div className="data-table-wrapper">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Player</th><th>Pos</th><th>MLB</th>
                          <th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>SB</th><th>BB</th><th>K</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {myRecBoard.batters.map((p, i) => (
                          <tr key={`batter-${p.id}`}>
                            <td className="pick-num">#{i + 1}</td>
                            <td><strong>{p.name}</strong></td>
                            <td><span className="badge">{p.position}</span></td>
                            <td>{p.team}</td>
                            <td>{stat(p, 'R', 'r')}</td>
                            <td>{stat(p, 'H', 'h')}</td>
                            <td>{stat(p, 'twoB', '2B')}</td>
                            <td>{stat(p, 'threeB', '3B')}</td>
                            <td>{stat(p, 'HR', 'hr')}</td>
                            <td>{stat(p, 'RBI', 'rbi')}</td>
                            <td>{stat(p, 'SB', 'sb')}</td>
                            <td>{stat(p, 'BB', 'bb')}</td>
                            <td>{stat(p, 'K', 'k')}</td>
                            <td><button className="btn-primary" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={() => handlePickPlayer(p)}>Draft</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      )}

      {/* ── KEEPERS TAB ─────────────────────────────────────────────────── */}
      {activeTab === 'keepers' && (
        <div className="tab-content" data-testid="keepers-tab">
          <section className="card">
            <h3>Keepers <span className="optional-tag">optional</span></h3>
            <p className="hint">
              Skip this tab entirely if your league doesn't use keepers.<br />
              Fill in the player name and the round their slot occupies for each team, then
              click <strong>Submit All Keepers</strong>. Empty slots are ignored.
            </p>

            <div className="keeper-grid-wrap" data-testid="keeper-grid">
              <table className="keeper-table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Keeper 1</th><th>Rd</th>
                    <th>Keeper 2</th><th>Rd</th>
                  </tr>
                </thead>
                <tbody>
                  {keeperGrid.map((team, ti) => (
                    <tr key={ti} className={team.isMyTeam ? 'your-team-row' : ''}>
                      <td className="keeper-team-name">{team.name}</td>
                      {team.keepers.map((k, ki) => (
                        <React.Fragment key={ki}>
                          <td className="keeper-player-cell">
                            <div className="keeper-search-wrap">
                              <input
                                type="text"
                                className="keeper-player-input"
                                placeholder={isFootball(sport) ? 'e.g. Josh Allen' : 'e.g. Mike Trout'}
                                value={k.search}
                                data-testid={`keeper-player-${ti}-${ki}`}
                                onChange={e => searchKeeperPlayer(ti, ki, e.target.value)}
                              />
                              {k.player && (
                                <span className="keeper-selected-name">
                                  ✓ {k.player.name}
                                  <button
                                    className="keeper-clear"
                                    onClick={() => updateKeeperSlot(ti, ki, { search: '', player: null, results: [] })}
                                  >✕</button>
                                </span>
                              )}
                              {k.results.length > 0 && (
                                <ul className="keeper-dropdown" data-testid={`keeper-results-${ti}-${ki}`}>
                                  {k.results.map(p => (
                                    <li key={p.id}
                                      onClick={() => updateKeeperSlot(ti, ki, {
                                        player: p, search: '', results: [],
                                      })}>
                                      {p.name} <span className="badge">{p.position}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </td>
                          <td>
                            <input
                              type="number"
                              className="keeper-round-input"
                              placeholder="Rd"
                              min="1"
                              value={k.round}
                              data-testid={`keeper-round-${ti}-${ki}`}
                              onChange={e => updateKeeperSlot(ti, ki, { round: e.target.value })}
                            />
                          </td>
                        </React.Fragment>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button className="btn-primary" style={{ marginTop: '16px' }} onClick={submitKeeperGrid}>
              🔒 Submit All Keepers to Draft
            </button>
          </section>
        </div>
      )}

      {/* ── DRAFTED TAB ─────────────────────────────────────────────────── */}
      {activeTab === 'drafted' && (
        <div className="tab-content" data-testid="drafted-tab">
          {isFootball(sport) ? (
            /* ── Football history ─────────────────────────────────────── */
            !footballEngine || footballPicks.length === 0 ? (
              <p className="hint">No picks yet — start drafting on the Draft Board.</p>
            ) : (
              <>
                <section className="card">
                  <h3>📜 Draft Order ({footballPicks.length} picks)</h3>
                  <div className="data-table-wrapper">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Rd</th><th>Team</th>
                          <th>Player</th><th>Pos</th><th>NFL Team</th><th>Proj Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {footballPicks.map(pick => {
                          const player = footballEngine.players.find(p => p.id === pick.playerId);
                          if (!player) return null;
                          const round = Math.ceil(pick.overall / footballTeamSize);
                          return (
                            <tr key={pick.playerId}>
                              <td className="pick-num">#{pick.overall}</td>
                              <td>{round}</td>
                              <td>Team {pick.teamSlot}{pick.teamSlot === footballTeamPos ? ' ⭐' : ''}</td>
                              <td><strong>{player.name}</strong></td>
                              <td><span className="badge">{player.position}</span></td>
                              <td>{player.team}</td>
                              <td>{player.projections.fantasyPoints.toFixed(1)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="card">
                  <h3>Team Rosters <span style={{fontSize:'0.85rem',fontWeight:400,color:'#b7791f'}}>— your team highlighted ⭐</span></h3>
                  <div className="team-grid">
                    {Array.from({length: footballTeamSize}, (_, i) => i + 1)
                      .sort((a, b) => {
                        if (a === footballTeamPos) return -1;
                        if (b === footballTeamPos) return 1;
                        return a - b;
                      })
                      .map(slot => {
                        const isMine = slot === footballTeamPos;
                        const teamPicks = footballPicks
                          .filter(p => p.teamSlot === slot)
                          .map(p => footballEngine.players.find(pl => pl.id === p.playerId))
                          .filter(Boolean);
                        return (
                          <div key={slot} className={`team-card${isMine ? ' my-team' : ''}`}>
                            <h4>
                              {isMine ? '⭐ ' : ''}Team {slot}{isMine ? ' (You)' : ''}
                              {isMine && <span className="my-team-badge">YOUR TEAM</span>}
                              <span className="pick-count">({teamPicks.length})</span>
                            </h4>
                            {teamPicks.length === 0
                              ? <p className="empty-roster">—</p>
                              : <ol>{teamPicks.map(p => (
                                  <li key={p.id}>
                                    <span className="badge">{p.position}</span> {p.name}
                                  </li>
                                ))}</ol>
                            }
                          </div>
                        );
                      })}
                  </div>
                </section>
              </>
            )
          ) : (
            /* ── Baseball history ─────────────────────────────────────── */
            !draftState ? (
              <p className="hint">Draft not initialized yet.</p>
            ) : (
              <>
                {draftedKeepers.length > 0 && (
                  <section className="card">
                    <h3>🔒 Keepers</h3>
                    <div className="data-table-wrapper">
                      <table className="data-table">
                        <thead><tr><th>Player</th><th>Pos</th><th>Team</th><th>Kept In Rd</th><th>Kept By</th></tr></thead>
                        <tbody>
                          {draftedKeepers.map((entry, i) => (
                            <tr key={i}>
                              <td><strong>{entry.player.name}</strong></td>
                              <td><span className="badge">{entry.player.position}</span></td>
                              <td>{entry.player.team}</td>
                              <td>{entry.round}</td>
                              <td>{entry.teamName}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
                <section className="card">
                  <h3>📜 Draft Picks</h3>
                  {draftedPicks.length === 0
                    ? <p className="hint">No picks yet.</p>
                    : (
                      <div className="data-table-wrapper">
                        <table className="data-table">
                          <thead><tr><th>#</th><th>Rd</th><th>Player</th><th>Pos</th><th>Team</th><th>Picked By</th></tr></thead>
                          <tbody>
                            {draftedPicks.map(entry => (
                              <tr key={entry.player.id}>
                                <td className="pick-num">#{entry.overall}</td>
                                <td>{entry.round}</td>
                                <td><strong>{entry.player.name}</strong></td>
                                <td><span className="badge">{entry.player.position}</span></td>
                                <td>{entry.player.team}</td>
                                <td>{entry.teamName}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  }
                </section>
              </>
            )
          )}
        </div>
      )}

      {/* ── CHEAT SHEET TAB ─────────────────────────────────────────────── */}
      {activeTab === 'cheatsheet' && isFootball(sport) && (() => {
        // ── helpers scoped to this render ──────────────────────────────────
        const csTeamCount = footballTeamSize;
        const csTotalPicks = cheatPicks.length;
        const csCurrentPick = csTotalPicks + 1;
        const csCurrentRound = Math.ceil(csCurrentPick / csTeamCount);
        const csPickInRound  = ((csCurrentPick - 1) % csTeamCount) + 1;
        const csOnClock = csCurrentRound % 2 === 0
          ? csTeamCount - csPickInRound + 1
          : csPickInRound;

        // next pick for my team
        let csMyNextPick = null;
        for (let p = csCurrentPick + 1; p <= csTeamCount * 20; p++) {
          const r   = Math.ceil(p / csTeamCount);
          const pip = ((p - 1) % csTeamCount) + 1;
          const t   = r % 2 === 0 ? csTeamCount - pip + 1 : pip;
          if (t === csMyTeam) { csMyNextPick = p; break; }
        }

        // player pool: use engine if loaded, else normalize mock data
        const normalizeKey = footballScoringPreset === 'custom' ? 'ppr' : footballScoringPreset;
        const csAllPlayers = footballEngine?.players
          || normalizeFootballPlayers(FOOTBALL_PLAYERS, normalizeKey);

        // per-team rosters
        const csRosters = {};
        for (let t = 1; t <= csTeamCount; t++) csRosters[t] = [];
        cheatPicks.forEach(cp => {
          const p = csAllPlayers.find(pl => pl.id === cp.playerId);
          if (p) csRosters[cp.teamSlot]?.push(p);
        });

        const completedRounds = Math.ceil(csTotalPicks / csTeamCount) - (csTotalPicks % csTeamCount === 0 && csTotalPicks > 0 ? 0 : 1);
        const needLevel = (t, pos) => {
          const cnt = (csRosters[t] || []).filter(p => p.position === pos).length;
          if (completedRounds < 2) return 'ok';
          if (pos === 'QB') return cnt === 0 && completedRounds >= 6 ? 'urgent' : 'ok';
          if (pos === 'RB') return cnt === 0 ? (completedRounds >= 3 ? 'urgent' : 'warn') : cnt < 2 && completedRounds >= 5 ? 'warn' : 'ok';
          if (pos === 'WR') return cnt === 0 ? (completedRounds >= 3 ? 'urgent' : 'warn') : cnt < 2 && completedRounds >= 5 ? 'warn' : 'ok';
          if (pos === 'TE') return cnt === 0 && completedRounds >= 7 ? 'urgent' : 'ok';
          return 'ok';
        };

        // pickMap for fast lookup
        const csPickMap = {};
        cheatPicks.forEach(cp => { csPickMap[cp.playerId] = cp; });

        // filtered player list
        const draftedSet = new Set(cheatPicks.map(cp => cp.playerId));
        let csFiltered = csAllPlayers;
        if (csPosFilter !== 'ALL') {
          csFiltered = csFiltered.filter(p =>
            csPosFilter === 'DST' ? (p.position === 'DST' || p.position === 'DEF') : p.position === csPosFilter
          );
        }
        if (csSearch.trim()) {
          const q = csSearch.toLowerCase();
          csFiltered = csFiltered.filter(p =>
            p.name.toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q)
          );
        }
        const csAvailable = csFiltered.filter(p => !draftedSet.has(p.id));
        const csDrafted    = csFiltered.filter(p => draftedSet.has(p.id));
        const showLimit = csSearch.trim() || csPosFilter !== 'ALL' ? 150 : 60;

        const cellStyle = (t) => ({
          padding: '2px 4px', textAlign: 'center',
          borderLeft:  t === csMyTeam ? '2px solid #bee3f8' : '1px solid #f0f4ff',
          borderRight: t === csMyTeam ? '2px solid #bee3f8' : '',
        });

        return (
          <div className="tab-content" data-testid="cheatsheet-tab">
            {/* ── Controls ────────────────────────────────────────────── */}
            <section className="card">
              <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:8 }}>
                <h3 style={{ margin:0 }}>🗒️ Draft Cheat Sheet</h3>
                <span style={{ color:'#718096', fontSize:'0.82em' }}>Track all picks while drafting on ESPN/Yahoo</span>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                <label style={{ fontSize:'0.9em', fontWeight:600 }}>My team slot:</label>
                <select value={csMyTeam} onChange={e => setCsMyTeam(Number(e.target.value))}
                  style={{ padding:'3px 8px', borderRadius:6, fontSize:'0.9em' }}>
                  {Array.from({ length: csTeamCount }, (_, i) => (
                    <option key={i+1} value={i+1}>Team {i+1}</option>
                  ))}
                </select>
                <span style={{ color:'#718096', fontSize:'0.82em' }}>
                  ({csTeamCount} teams · {footballScoringPreset.toUpperCase()})
                </span>
                <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
                  {csTotalPicks > 0 && (
                    <button onClick={() => setCheatPicks(p => p.slice(0, -1))}
                      style={{ padding:'3px 10px', borderRadius:6, fontSize:'0.82em',
                        background:'#f7fafc', color:'#4a5568', border:'1px solid #e2e8f0', cursor:'pointer' }}>
                      ↩ Undo
                    </button>
                  )}
                  <button onClick={() => { if (window.confirm('Reset all cheat sheet picks?')) setCheatPicks([]); }}
                    style={{ padding:'3px 10px', borderRadius:6, fontSize:'0.82em',
                      background:'#fff5f5', color:'#c53030', border:'1px solid #fed7d7', cursor:'pointer' }}>
                    🗑 Reset
                  </button>
                </div>
              </div>

              {/* On the clock */}
              <div style={{
                marginTop:10, padding:'8px 12px', borderRadius:8,
                background: csOnClock === csMyTeam ? '#f0fff4' : '#ebf8ff',
                border: `1px solid ${csOnClock === csMyTeam ? '#9ae6b4' : '#bee3f8'}`,
                display:'flex', alignItems:'center', gap:14, flexWrap:'wrap',
              }}>
                <div>
                  <strong>Round {csCurrentRound} · Pick #{csCurrentPick}</strong>
                  {' — '}
                  <span style={{ fontWeight:700, color: csOnClock === csMyTeam ? '#276749' : '#2b6cb0', fontSize:'1.05em' }}>
                    {csOnClock === csMyTeam ? `⭐ YOUR PICK (Team ${csOnClock})` : `Team ${csOnClock} is on the clock`}
                  </span>
                </div>
                {csMyNextPick && csOnClock !== csMyTeam && (
                  <span style={{ color:'#718096', fontSize:'0.85em' }}>
                    Your next pick: #{csMyNextPick} ({csMyNextPick - csCurrentPick} picks away)
                  </span>
                )}
              </div>
            </section>

            {/* ── Team Needs Grid ──────────────────────────────────────── */}
            {csTotalPicks > 0 && (
              <section className="card" style={{ padding:'12px 14px', overflowX:'auto' }}>
                <h4 style={{ margin:'0 0 8px', fontSize:'0.9em', color:'#4a5568' }}>📊 Team Positional Needs</h4>
                <table style={{ borderCollapse:'collapse', fontSize:'0.82em', minWidth: csTeamCount * 42 }}>
                  <thead>
                    <tr>
                      <th style={{ padding:'3px 6px', textAlign:'left', color:'#718096', width:36 }}>Pos</th>
                      {Array.from({ length: csTeamCount }, (_, i) => {
                        const t = i + 1;
                        return (
                          <th key={t} style={{
                            padding:'3px 4px', textAlign:'center', minWidth:38,
                            background: t === csMyTeam ? '#ebf8ff' : t === csOnClock ? '#fffff0' : '',
                            color: t === csMyTeam ? '#2b6cb0' : '#4a5568',
                            fontWeight: t === csMyTeam ? 700 : 400,
                            borderBottom: t === csMyTeam ? '2px solid #3182ce' : '1px solid #e2e8f0',
                          }}>
                            T{t}{t === csOnClock ? '⏰' : ''}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {['QB','RB','WR','TE'].map(pos => (
                      <tr key={pos}>
                        <td style={{ padding:'3px 6px', fontWeight:700, color:'#4a5568' }}>{pos}</td>
                        {Array.from({ length: csTeamCount }, (_, i) => {
                          const t   = i + 1;
                          const cnt = (csRosters[t] || []).filter(p => p.position === pos).length;
                          const lvl = needLevel(t, pos);
                          return (
                            <td key={t} style={{
                              ...cellStyle(t),
                              background: lvl === 'urgent' ? '#fff5f5' : lvl === 'warn' ? '#fffaf0' : '',
                              color: lvl === 'urgent' ? '#c53030' : lvl === 'warn' ? '#c05621' : '#2d3748',
                              fontWeight: lvl !== 'ok' ? 700 : 400,
                            }}>
                              {cnt}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr style={{ borderTop:'2px solid #e2e8f0' }}>
                      <td style={{ padding:'3px 6px', fontWeight:700, color:'#a0aec0', fontSize:'0.8em' }}>Picks</td>
                      {Array.from({ length: csTeamCount }, (_, i) => {
                        const t = i + 1;
                        return (
                          <td key={t} style={{ ...cellStyle(t), color:'#718096', fontSize:'0.8em' }}>
                            {(csRosters[t] || []).length}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
                <p style={{ margin:'5px 0 0', fontSize:'0.72em', color:'#a0aec0' }}>
                  🟥 urgent need · 🟧 thin · Blue column = your team · ⏰ = on the clock
                </p>
              </section>
            )}

            {/* ── Player List ──────────────────────────────────────────── */}
            <section className="card">
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap' }}>
                <h3 style={{ margin:0 }}>👤 Player Pool</h3>
                <input value={csSearch} onChange={e => setCsSearch(e.target.value)}
                  placeholder="Search player…"
                  style={{ padding:'4px 10px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:'0.9em', width:150 }}
                />
                {['ALL','QB','RB','WR','TE','K','DST'].map(pos => (
                  <button key={pos} onClick={() => setCsPosFilter(pos)} style={{
                    padding:'2px 9px', borderRadius:12, fontSize:'0.8em', cursor:'pointer',
                    background: csPosFilter === pos ? '#3182ce' : '#f7fafc',
                    color:      csPosFilter === pos ? '#fff' : '#4a5568',
                    border: `1px solid ${csPosFilter === pos ? '#3182ce' : '#e2e8f0'}`,
                    fontWeight: csPosFilter === pos ? 700 : 400,
                  }}>
                    {pos}
                  </button>
                ))}
              </div>

              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Player</th><th>Pos</th><th>NFL</th><th>Proj Pts</th>
                      <th>
                        Mark Drafted
                        <span style={{ marginLeft:5, fontSize:'0.75em', color:'#a0aec0', fontWeight:400 }}>
                          📌 = Team {csOnClock} (clock)
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {csAvailable.slice(0, showLimit).map((p, i) => {
                      const pts = p.projectedPoints ?? p.vbd ?? 0;
                      return (
                        <tr key={p.id}>
                          <td style={{ color:'#a0aec0', fontSize:'0.8em' }}>{i + 1}</td>
                          <td><strong>{p.name}</strong></td>
                          <td><span className="badge">{p.position}</span></td>
                          <td style={{ color:'#718096', fontSize:'0.85em' }}>{p.team}</td>
                          <td style={{ color:'#4a5568', fontSize:'0.85em' }}>{pts > 0 ? pts.toFixed(1) : '—'}</td>
                          <td>
                            <div style={{ display:'flex', gap:4 }}>
                              <button
                                onClick={() => setCheatPicks(prev => [...prev, { playerId: p.id, teamSlot: csOnClock, overall: prev.length + 1 }])}
                                title={`Mark as picked by Team ${csOnClock} (on clock)`}
                                style={{ padding:'2px 8px', borderRadius:4, fontSize:'0.78em', cursor:'pointer',
                                  background: csOnClock === csMyTeam ? '#c6f6d5' : '#ebf8ff',
                                  color:      csOnClock === csMyTeam ? '#276749' : '#2b6cb0',
                                  border: `1px solid ${csOnClock === csMyTeam ? '#9ae6b4' : '#bee3f8'}`,
                                  fontWeight:600 }}>
                                📌 T{csOnClock}
                              </button>
                              <select defaultValue=""
                                onChange={e => {
                                  if (!e.target.value) return;
                                  const t = Number(e.target.value);
                                  setCheatPicks(prev => [...prev, { playerId: p.id, teamSlot: t, overall: prev.length + 1 }]);
                                  e.target.value = '';
                                }}
                                style={{ padding:'2px 4px', borderRadius:4, fontSize:'0.78em', border:'1px solid #e2e8f0', cursor:'pointer' }}>
                                <option value="">→ Team…</option>
                                {Array.from({ length: csTeamCount }, (_, idx) => (
                                  <option key={idx+1} value={idx+1}>
                                    {idx + 1 === csMyTeam ? `⭐ Me (T${idx+1})` : `Team ${idx+1}`}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {csDrafted.length > 0 && (
                      <>
                        <tr>
                          <td colSpan={6} style={{ padding:'6px 6px 2px', color:'#a0aec0', fontSize:'0.78em', fontStyle:'italic' }}>
                            — Drafted ({csDrafted.length}) —
                          </td>
                        </tr>
                        {csDrafted.map(p => {
                          const pick = csPickMap[p.id];
                          const pts  = p.projectedPoints ?? p.vbd ?? 0;
                          return (
                            <tr key={p.id} style={{ opacity:0.4, background:'#f7fafc' }}>
                              <td style={{ color:'#a0aec0', fontSize:'0.8em' }}>#{pick.overall}</td>
                              <td><strong style={{ textDecoration:'line-through' }}>{p.name}</strong></td>
                              <td><span className="badge">{p.position}</span></td>
                              <td style={{ color:'#718096', fontSize:'0.85em' }}>{p.team}</td>
                              <td style={{ color:'#a0aec0', fontSize:'0.85em' }}>{pts > 0 ? pts.toFixed(1) : '—'}</td>
                              <td>
                                <span style={{
                                  fontSize:'0.78em', padding:'2px 8px', borderRadius:4,
                                  background: pick.teamSlot === csMyTeam ? '#c6f6d5' : '#e2e8f0',
                                  color:      pick.teamSlot === csMyTeam ? '#276749' : '#4a5568',
                                }}>
                                  {pick.teamSlot === csMyTeam ? `⭐ Mine` : `Team ${pick.teamSlot}`}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
              {!csSearch.trim() && csPosFilter === 'ALL' && csAvailable.length > showLimit && (
                <p style={{ margin:'6px 0 0', fontSize:'0.78em', color:'#a0aec0' }}>
                  Showing top {showLimit} available — use position filter or search to see more.
                </p>
              )}
            </section>
          </div>
        );
      })()}

      {/* ── TRADE ANALYZER TAB ───────────────────────────────────────────── */}
      {activeTab === 'trade' && (
        <TradeAnalyzer
          key={sport}
          sport={sport}
          availablePlayers={
            isFootball(sport)
              ? (footballEngine?.players ?? [])
              : (draftState?.availablePlayers ?? [])
          }
          searchPlayers={isFootball(sport) ? null : searchPlayers}
        />
      )}

      {/* ── CHAT TAB ────────────────────────────────────────────────────── */}
      {activeTab === 'chat' && (() => {
        // For football, MY roster = only picks where teamSlot matches my draft position.
        // Without this filter the chat would treat every drafted player as "mine".
        const myFootballPickIds = isFootball(sport)
          ? new Set(footballPicks.filter(p => p.teamSlot === footballTeamPos).map(p => p.playerId))
          : null;
        const myFootballRoster = isFootball(sport)
          ? (footballEngine?.players?.filter(p => myFootballPickIds.has(p.id)) ?? [])
          : null;
        return (
          <FantasyChat
            sport={sport}
            myRoster={isFootball(sport) ? myFootballRoster : (myTeam?.roster ?? [])}
            availablePlayers={
              isFootball(sport)
                ? (footballEngine?.players?.filter(p => !p.isDrafted) ?? [])
                : (draftState?.availablePlayers ?? [])
            }
          />
        );
      })()}

      {/* ── SETTINGS TAB ────────────────────────────────────────────────── */}
      {activeTab === 'settings' && isFootball(sport) && (
        <div className="tab-content" data-testid="settings-tab-football">
          <section className="card">
            <h3>⚙️ Football Scoring Settings</h3>
            <p className="hint">Select a scoring mode or upload a custom JSON configuration.</p>
            <div style={{marginBottom:16,display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <button className="btn-ping" onClick={async () => {
                try {
                  await apiFetch('/nfl/refresh', {method:'POST'});
                  setStatusMsg('✅ NFL cache cleared — reload Draft Board to re-fetch.');
                } catch(e) { setErrorMsg(`Refresh failed: ${e.message}`); }
              }}>🔄 Refresh NFL Data</button>
              <span style={{fontSize:'0.82em',color:'#718096'}}>Re-fetches from Sleeper + FantasyPros</span>
            </div>

            <div style={{marginBottom:20}}>
              <label style={{display:'block',marginBottom:8,fontWeight:'bold'}}>Snake Draft Position:</label>
              <div style={{display:'flex',gap:20,flexWrap:'wrap',alignItems:'center'}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <label style={{fontSize:'0.9em',color:'#4a5568'}}>Your pick #:</label>
                  <input
                    type="number" min="1" max={footballTeamSize}
                    value={footballTeamPos}
                    onChange={e => setFootballTeamPos(Math.min(Math.max(1, Number(e.target.value)), footballTeamSize))}
                    style={{width:60,padding:'4px 8px',borderRadius:6,border:'1px solid #cbd5e0',fontSize:'1em'}}
                  />
                  <span style={{color:'#718096',fontSize:'0.85em'}}>of {footballTeamSize}</span>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <label style={{fontSize:'0.9em',color:'#4a5568'}}>Teams in league:</label>
                  <input
                    type="number" min="8" max="20"
                    value={footballTeamSize}
                    onChange={e => setFootballTeamSize(Math.max(8, Number(e.target.value)))}
                    style={{width:60,padding:'4px 8px',borderRadius:6,border:'1px solid #cbd5e0',fontSize:'1em'}}
                  />
                </div>
              </div>
              <p className="hint" style={{marginTop:6,fontSize:'0.82em'}}>
                Used to calculate "Won't Make It Back" — players likely gone before your next snake pick.
              </p>
            </div>

            <div style={{marginBottom:20}}>
              <label style={{display:'block',marginBottom:8,fontWeight:'bold'}}>Scoring Mode:</label>
              <select
                value={footballScoringPreset}
                onChange={e => { setFootballScoringPreset(e.target.value); setCustomFootballScoring(null); setCustomScoringJson(''); setCustomScoringError(''); }}
                style={{fontSize:'1em',padding:'8px 12px',borderRadius:6,minWidth:260}}
              >
                {FOOTBALL_PRESET_LIST.map(p => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </select>
            </div>

            <div style={{marginBottom:20}}>
              <h4 style={{marginBottom:8}}>Custom JSON Scoring</h4>
              <p className="hint" style={{marginBottom:6}}>Paste a JSON object with scoring weights to override the preset above.</p>
              <textarea
                rows={6}
                style={{width:'100%',fontFamily:'monospace',fontSize:'0.85em',padding:8,borderRadius:6,border:'1px solid #cbd5e0',boxSizing:'border-box'}}
                placeholder={'{\n  "passYards": 0.04,\n  "passTD": 4,\n  "rushYards": 0.1,\n  "rushTD": 6,\n  "receptions": 1\n}'}
                value={customScoringJson}
                onChange={e => setCustomScoringJson(e.target.value)}
              />
              {customScoringError && <p style={{color:'#e53e3e',fontSize:'0.85em',margin:'4px 0'}}>{customScoringError}</p>}
              <button className="btn-primary" style={{marginTop:8}} onClick={() => {
                try {
                  const parsed = JSON.parse(customScoringJson);
                  const valid = CUSTOM_SCORING_KEYS.some(k => parsed[k] !== undefined);
                  if (!valid) throw new Error('No recognized scoring keys found.');
                  setCustomFootballScoring(parsed);
                  setCustomScoringError('');
                  setStatusMsg('✅ Custom football scoring applied!');
                } catch(e) {
                  setCustomScoringError(`Invalid JSON: ${e.message}`);
                }
              }}>Apply Custom Scoring</button>
              {customFootballScoring && (
                <button style={{marginTop:8,marginLeft:8,background:'none',border:'1px solid #cbd5e0',borderRadius:6,padding:'6px 12px',cursor:'pointer'}}
                  onClick={() => { setCustomFootballScoring(null); setCustomScoringJson(''); setCustomScoringError(''); }}>
                  Clear Custom
                </button>
              )}
            </div>

            {customFootballScoring && (
              <div style={{padding:12,background:'#f0fff4',borderRadius:8,border:'1px solid #9ae6b4',marginBottom:16}}>
                <strong>Active: Custom Scoring</strong>
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:6,marginTop:8}}>
                  {Object.entries(customFootballScoring).map(([k,v]) => (
                    <div key={k} style={{background:'#fff',borderRadius:4,padding:'4px 8px',fontSize:'0.82em'}}>
                      <strong>{k}</strong>: {v}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {activeTab === 'settings' && !isFootball(sport) && (
        <div className="tab-content" data-testid="settings-tab">
          <section className="card">
            <h3>⚙️ Scoring Settings</h3>
            <p className="hint">
              Select a scoring preset to use for player rankings and recommendations. 
              Each preset defines how stats are weighted when calculating player scores.
            </p>

            {/* Preset selector */}
            {scoringPresets.length > 0 ? (
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
                  Scoring Preset:
                </label>
                <select
                  value={activeScoring?.activePresetKey || ''}
                  onChange={e => e.target.value && handleSetActiveScoringPreset(e.target.value)}
                  disabled={scoringLoading}
                  style={{
                    fontSize: '1em',
                    padding: '8px 12px',
                    borderRadius: 6,
                    minWidth: 300,
                    cursor: scoringLoading ? 'not-allowed' : 'pointer',
                  }}
                  data-testid="scoring-preset-select"
                >
                  <option value="">-- Select a preset --</option>
                  {scoringPresets.map(preset => (
                    <option key={preset.key} value={preset.key}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="hint">Loading scoring presets...</p>
            )}

            {/* Active preset details */}
            {activeScoring && (
              <div style={{ marginTop: '24px', padding: '16px', background: '#f9f9f9', borderRadius: 8, border: '1px solid #ddd' }}>
                <h4 style={{ marginTop: 0, marginBottom: 12 }}>📊 Active Preset Details</h4>

                <div style={{ marginBottom: 12 }}>
                  <strong>Preset:</strong> {activeScoring.name}
                  <br />
                  <strong>Type:</strong> {activeScoring.type}
                  <br />
                  <strong>Description:</strong> {activeScoring.description}
                </div>

                {/* Batting weights */}
                {activeScoring.batting && Object.keys(activeScoring.batting).length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <h5 style={{ marginBottom: 8 }}>Batting Weights</h5>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                      {Object.entries(activeScoring.batting).map(([stat, weight]) => (
                        <div key={stat} style={{
                          padding: 8,
                          background: weight > 0 ? '#e8f5e9' : '#ffebee',
                          borderRadius: 4,
                          fontSize: '0.85em',
                        }}>
                          <strong>{stat}</strong>: {Number(weight).toFixed(2)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Pitching weights */}
                {activeScoring.pitching && Object.keys(activeScoring.pitching).length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <h5 style={{ marginBottom: 8 }}>Pitching Weights</h5>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                      {Object.entries(activeScoring.pitching).map(([stat, weight]) => (
                        <div key={stat} style={{
                          padding: 8,
                          background: weight > 0 ? '#e8f5e9' : '#ffebee',
                          borderRadius: 4,
                          fontSize: '0.85em',
                        }}>
                          <strong>{stat}</strong>: {Number(weight).toFixed(2)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Team need adjustments if present */}
                {activeScoring.teamNeedAdjustments && Object.keys(activeScoring.teamNeedAdjustments).length > 0 && (
                  <div>
                    <h5 style={{ marginBottom: 8 }}>Team Need Adjustments</h5>
                    <div style={{ fontSize: '0.85em', color: '#666' }}>
                      <p>Dynamically adjust scoring based on team stat deficits:</p>
                      <ul style={{ margin: '8px 0' }}>
                        {Object.entries(activeScoring.teamNeedAdjustments).map(([stat, adjustment]) => (
                          <li key={stat} style={{ marginBottom: 4 }}>
                            <strong>{stat}:</strong> {JSON.stringify(adjustment)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            )}

            <p className="hint" style={{ marginTop: '20px', fontSize: '0.85em', color: '#999' }}>
              💡 Tip: When you change the scoring preset, the player recommendations will automatically refresh 
              to reflect the new scoring weights on your next view.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
