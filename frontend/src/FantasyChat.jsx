import React, { useState, useRef, useEffect } from 'react';
import { playerValue } from './utils/tradeAnalyzer.js';

// ─── helpers ──────────────────────────────────────────────────────────────────
// Gemini is proxied through the backend — no key needed in the browser.

/** Build a short player summary string for the AI context prompt. */
function playerSummary(p, sport) {
  if (!p) return '';
  const val = playerValue(p, sport).toFixed(1);
  const age = p.age ? ` Age ${p.age}` : '';
  const adp = p.adp ? ` ADP#${p.adp}` : '';
  if (sport === 'football') {
    const s = p.stats ?? {};
    let stats = '';
    if (p.position === 'QB') stats = `${s.passYards ?? 0}PaYd/${s.passTD ?? 0}TD/${s.rushYards ?? 0}RuYd`;
    else if (p.position === 'RB') stats = `${s.rushYards ?? 0}RuYd/${s.rushTD ?? 0}TD/${s.receptions ?? 0}Rec`;
    else stats = `${s.receptions ?? 0}Rec/${s.recYards ?? 0}Yd/${s.recTD ?? 0}TD`;
    return `${p.name}(${p.position},${p.team}${age}${adp},val=${val},${stats})`;
  }
  const s = p.stats ?? p;
  const isPitcher = Number(s.IP ?? s.ip ?? 0) > 0 || p.position === 'SP' || p.position === 'RP';
  if (isPitcher) {
    return `${p.name}(${p.position},${p.team}${age},val=${val},W=${s.W ?? 0},SV=${s.SV ?? 0},K=${s.pitchingK ?? 0},ERA=${s.ERA ?? 0})`;
  }
  return `${p.name}(${p.position},${p.team}${age},val=${val},HR=${s.HR ?? s.hr ?? 0},RBI=${s.RBI ?? s.rbi ?? 0},SB=${s.SB ?? s.sb ?? 0})`;
}

/** Build the system prompt injecting current player context. */
function buildSystemPrompt(sport, myRoster, availablePlayers) {
  const rosterStr = (myRoster || []).map(p => playerSummary(p, sport)).join(', ');
  const topAvail = (availablePlayers || [])
    .filter(p => !myRoster?.some(r => (r.id ?? r.name) === (p.id ?? p.name)))
    .slice(0, 20)
    .map(p => playerSummary(p, sport))
    .join(', ');

  const sportCtx = sport === 'football'
    ? `Scoring: PPR (1 pt/reception). Standard roster: QB/2RB/2WR/TE/FLEX/K/DST. 2026 NFL season. Use VBD and positional scarcity — RBs and WRs age-curve faster, QBs have deeper value.`
    : `Scoring: 5x5 H2H categories — R/H/HR/RBI/SB (hitting) + W/SV/K/ERA/WHIP (pitching). 12-team snake draft. Positions: C/1B/2B/3B/SS/OF×3/SP×2/RP×2/UTIL. Closer saves and SP strikeouts are scarcer — weight those.`;

  return `You are an elite fantasy ${sport} analyst and drafter for a 12-team H2H league. Give sharp, confident advice like an expert would — no hedging, no filler.

${sportCtx}

MY CURRENT ROSTER: ${rosterStr || '(empty — draft may not have started yet)'}

TOP AVAILABLE PLAYERS (ranked by projected value): ${topAvail || '(not loaded)'}

Rules for your responses:
- Always give a clear verdict first: Accept / Decline / Add / Drop / Draft / Pass
- Back it up with 1-3 specific reasons using the data above (val, age, position scarcity)
- For draft picks: name a specific player recommendation with why
- For trades: compare both sides by total value AND positional need
- Keep it under 6 sentences unless the user asks for more depth
- Use markdown bold for player names and key verdicts`;
}

// ─── Rule-based fallback ──────────────────────────────────────────────────────

function ruleBased(question, sport, myRoster, availablePlayers) {
  const q = question.toLowerCase();
  const avail = availablePlayers || [];
  const roster = myRoster || [];
  const isFootballSport = sport === 'football';

  // Helper: find a player by name fragment in either pool
  const findPlayer = (fragment) => {
    const f = fragment.toLowerCase().trim();
    const allPlayers = [...roster, ...avail];
    return allPlayers.find(p => p.name?.toLowerCase().includes(f));
  };

  // Helper: positional scarcity label
  const scarcity = (pos) => {
    if (isFootballSport) {
      if (pos === 'RB') return '(scarce — RB runs out fast)';
      if (pos === 'TE') return '(positional scarcity — top TEs matter)';
      if (pos === 'QB') return '(wait on QB — deepest position)';
      if (pos === 'K' || pos === 'DST') return '(stream weekly — draft late)';
    } else {
      if (pos === 'C') return '(scarcest position in baseball)';
      if (pos === 'SP') return '(starting pitching is deep — patience pays)';
      if (pos === 'RP' || pos === 'SV') return '(closers are volatile — stream saves late)';
      if (pos === 'SS') return '(elite SS thin after top 3)';
    }
    return '';
  };

  // ── Who should I pick / draft next ───────────────────────────────────────
  if (q.match(/pick|draft|who should i (take|grab|select)|next pick|my turn/)) {
    const myPositions = roster.map(p => p.position);
    // find positions with 0 or fewest players
    const posCount = {};
    myPositions.forEach(pos => { posCount[pos] = (posCount[pos] || 0) + 1; });
    const topAvail = avail.slice(0, 15);
    if (topAvail.length === 0) return 'No available players loaded. Start a draft first.';

    // Score: base value + bonus for thin positions on roster
    const scored = topAvail.map(p => {
      const base = playerValue(p, sport);
      const need = posCount[p.position] === undefined ? 2 : posCount[p.position] === 0 ? 1.5 : 1;
      return { p, score: base * need };
    }).sort((a, b) => b.score - a.score);

    const top = scored[0].p;
    const runners = scored.slice(1, 4).map(x => `**${x.p.name}** (${x.p.position})`).join(', ');
    return `**Draft ${top.name}** (${top.position}/${top.team}, val=${playerValue(top, sport).toFixed(1)}) ${scarcity(top.position)}\n\nAlso consider: ${runners}`;
  }

  // ── Waiver / add / drop ───────────────────────────────────────────────────
  if (q.match(/add|waiver|drop|pick.?up|free agent/)) {
    const topFree = avail
      .filter(p => !roster.some(r => (r.id ?? r.name) === (p.id ?? p.name)))
      .slice(0, 6);
    if (topFree.length === 0) return 'No available players found. Make sure the draft is initialized.';

    // If they mention a specific position
    const posMatch = q.match(/\b(qb|rb|wr|te|k|dst|c|1b|2b|3b|ss|of|sp|rp)\b/i);
    const filtered = posMatch
      ? topFree.filter(p => p.position?.toLowerCase() === posMatch[1].toLowerCase())
      : topFree;
    const list = (filtered.length ? filtered : topFree).slice(0, 5)
      .map((p, i) => `${i + 1}. **${p.name}** (${p.position}/${p.team}, val=${playerValue(p, sport).toFixed(1)}${p.age ? `, age ${p.age}` : ''}) ${scarcity(p.position)}`)
      .join('\n');
    const posLabel = posMatch ? ` at ${posMatch[1].toUpperCase()}` : '';
    return `**Top waiver adds${posLabel}:**\n${list}\n\n_Tip: Target the player that fills your biggest positional need._`;
  }

  // ── Trade analysis ────────────────────────────────────────────────────────
  if (q.includes('trade')) {
    // Try to extract player names — look for "for" separator
    const forIdx = q.indexOf(' for ');
    if (forIdx > -1) {
      const givingStr = q.slice(0, forIdx).replace(/trade|give|sending|i get|i give/gi, '').trim();
      const gettingStr = q.slice(forIdx + 5).replace(/getting|receiving/gi, '').trim();
      const giving = givingStr.split(/,| and /).map(s => s.trim()).filter(Boolean).map(findPlayer).filter(Boolean);
      const getting = gettingStr.split(/,| and /).map(s => s.trim()).filter(Boolean).map(findPlayer).filter(Boolean);
      if (giving.length && getting.length) {
        const giveVal = giving.reduce((s, p) => s + playerValue(p, sport), 0);
        const getVal = getting.reduce((s, p) => s + playerValue(p, sport), 0);
        const diff = getVal - giveVal;
        const verdict = diff > 3 ? '✅ **Accept**' : diff < -3 ? '❌ **Decline**' : '⚖️ **Fair trade**';
        const giveList = giving.map(p => `**${p.name}** (val=${playerValue(p, sport).toFixed(1)})`).join(', ');
        const getList = getting.map(p => `**${p.name}** (val=${playerValue(p, sport).toFixed(1)})`).join(', ');
        return `${verdict}\n\nYou give: ${giveList} (total ${giveVal.toFixed(1)})\nYou get: ${getList} (total ${getVal.toFixed(1)})\n\n${diff > 0 ? `You gain +${diff.toFixed(1)} in value.` : diff < 0 ? `You lose ${Math.abs(diff).toFixed(1)} in value.` : 'Values are essentially equal.'} For a full breakdown, use the **Trade Analyzer** tab.`;
      }
    }
    return 'For trade analysis, try: *"Trade [player] for [player]"* — I\'ll compare values. Or use the **Trade Analyzer** tab for a detailed side-by-side breakdown.';
  }

  // ── Keeper advice ─────────────────────────────────────────────────────────
  if (q.includes('keeper')) {
    const candidates = roster
      .filter(p => p.adp && p.age)
      .map(p => {
        const draftRound = Math.ceil((p.adp || 200) / 12);
        const cost = Math.max(1, draftRound - 1);
        const val = playerValue(p, sport);
        return { p, cost, val, ratio: val / cost };
      })
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 5);

    if (candidates.length === 0) {
      return `No keeper candidates found with ADP data. If you're in a keeper league, try the **manual roster input** to load your actual players with ADP data.`;
    }
    const list = candidates
      .map(({ p, cost, val }) => `**${p.name}** (${p.position}, age ${p.age}) — keep Rd ${cost}, val=${val.toFixed(1)}, ratio=${(val/cost).toFixed(2)}`)
      .join('\n- ');
    return `**Best keeper candidates** (sorted by value-per-round-cost):\n- ${list}\n\n_Younger players with low ADP cost are the best long-term keepers._`;
  }

  // ── Roster / team review ──────────────────────────────────────────────────
  if (q.match(/team|roster|my picks|how.*(look|doing)|strength|weakness/)) {
    if (!roster.length) return 'No roster loaded yet. Initialize the draft or use the **manual roster input** in this chat to enter your players.';
    const sorted = [...roster].sort((a, b) => playerValue(b, sport) - playerValue(a, sport));
    const posCount = {};
    sorted.forEach(p => { posCount[p.position] = (posCount[p.position] || 0) + 1; });
    const anchors = sorted.slice(0, 3).map(p => `**${p.name}** (${p.position}, val=${playerValue(p, sport).toFixed(1)})`).join(', ');
    const posBreakdown = Object.entries(posCount).map(([pos, n]) => `${pos}×${n}`).join(', ');
    const weakSpot = sorted.length > 5
      ? sorted.slice(-3).map(p => p.position).join('/')
      : null;
    return `**Roster:** ${posBreakdown}\n**Anchors:** ${anchors}\n${weakSpot ? `**Potential weak spots:** ${weakSpot} — consider upgrading on waivers.\n` : ''}\nAsk me about specific trades, waiver adds, or who to draft next.`;
  }

  // ── Position-specific question ────────────────────────────────────────────
  const posMatch = q.match(/\b(qb|rb|wr|te|k|dst|catcher|first base|second base|third base|shortstop|outfield|starter|closer)\b/i);
  if (posMatch) {
    const posMap = { catcher:'C', 'first base':'1B', 'second base':'2B', 'third base':'3B', shortstop:'SS', outfield:'OF', starter:'SP', closer:'RP' };
    const pos = posMap[posMatch[1].toLowerCase()] || posMatch[1].toUpperCase();
    const posPlayers = avail.filter(p => p.position?.toUpperCase() === pos).slice(0, 5);
    if (posPlayers.length === 0) return `No available ${pos} players found in the pool.`;
    const list = posPlayers.map((p, i) => `${i+1}. **${p.name}** (${p.team}, val=${playerValue(p, sport).toFixed(1)}${p.age ? `, age ${p.age}` : ''})`).join('\n');
    return `**Best available ${pos}s:**\n${list}\n\n${scarcity(pos)}`;
  }

  // ── Rankings ──────────────────────────────────────────────────────────────
  if (q.match(/rank|top \d|best available|who.*available/)) {
    const top = avail.slice(0, 10)
      .map((p, i) => `${i+1}. **${p.name}** (${p.position}/${p.team}, val=${playerValue(p, sport).toFixed(1)})`).join('\n');
    return `**Top 10 available:**\n${top}`;
  }

  // ── Draft round strategy ──────────────────────────────────────────────────
  if (q.match(/round|strategy|early|late|when.*draft|should.*wait/)) {
    if (isFootballSport) {
      return `**Football draft strategy by round:**\n- **Rds 1-3:** RB/WR — the deepest positions here, but depth falls fast. Don't reach for QB.\n- **Rds 4-6:** WR2, RB2, flex — build your core. TE if elite (Kelce/Andrews).\n- **Rds 7-9:** QB — take best available QB here. Huge value over late QBs.\n- **Rds 10-12:** TE2, flex depth — target upside.\n- **Last 2 rds:** K + DST — stream both, don't overdraft.`;
    }
    return `**Baseball draft strategy by round:**\n- **Rds 1-3:** Elite OF/1B hitters — HR/RBI anchors.\n- **Rds 4-6:** C/2B/SS — scarce positions, take the best early.\n- **Rds 7-9:** SP anchor — one elite arm here.\n- **Rds 10-13:** Balance SP/RP/hitters. Target saves.\n- **Rds 14+:** Upside SP, multi-category hitters, closers.`;
  }

  return "I can help with: **who to draft next**, **trade analysis** (say \"trade X for Y\"), **waiver adds**, **keeper advice**, or a **roster review**. What do you need?";
}

// ─── Backend proxy call ───────────────────────────────────────────────────────
// POSTs to /api/chat on the Spring Boot server, which holds the Gemini API key.
async function callChat(systemPrompt, history, userText) {
  const contents = [
    { role: 'user',  parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Understood. Ready to help.' }] },
    ...history.slice(1).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: userText }] },
  ];

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: 1024, temperature: 0.4, topP: 0.9 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || err?.error || `Server error ${res.status}`;
    if (res.status === 503) throw new Error('AI not configured on server yet.');
    if (res.status === 429) throw new Error('Rate limit hit — try again in a moment.');
    throw new Error(msg);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no response)';
}

// ─── Roster input parser ──────────────────────────────────────────────────────
// Accepts comma-separated, newline-separated, or mixed input.
// Each token is fuzzy-matched against the player pool by normalized name.
function parseRosterInput(raw, playerPool) {
  const pool = playerPool || [];
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

  // Split on commas or newlines; filter blanks
  const tokens = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);

  return tokens.map(token => {
    const t = norm(token);
    // 1. Exact normalized match
    let hit = pool.find(p => norm(p.name) === t);
    // 2. Starts-with (handles truncated input like "mahomes")
    if (!hit) hit = pool.find(p => norm(p.name).startsWith(t));
    // 3. Last-name only (single word token)
    if (!hit && !t.includes(' ')) {
      hit = pool.find(p => {
        const parts = norm(p.name).split(' ');
        return parts[parts.length - 1] === t;
      });
    }
    // 4. Substring match
    if (!hit) hit = pool.find(p => norm(p.name).includes(t));
    return hit
      ? { ...hit, _inputName: token }
      : { id: `manual-${token}`, name: token, position: '?', team: '?', _inputName: token, _unmatched: true };
  });
}

// ─── FantasyChat component ────────────────────────────────────────────────────

export default function FantasyChat({ sport, myRoster, availablePlayers }) {
  const initialMessage = {
    role: 'assistant',
    content: `Hey! I'm your fantasy ${sport} assistant. Ask me anything:\n- *"Is this trade good for me?"*\n- *"Who should I pick up off waivers?"*\n- *"Is my team still looking strong?"*\n- *"Who are my best keepers?"*`,
  };
  const [messages, setMessages] = useState([initialMessage]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [rosterInput, setRosterInput] = useState('');
  const [manualRoster, setManualRoster] = useState([]);
  const [rosterOpen, setRosterOpen] = useState(false);
  const bottomRef = useRef(null);

  // Combined roster: manual entry overrides the prop when set
  const effectiveRoster = manualRoster.length > 0 ? manualRoster : myRoster;

  const applyRoster = () => {
    const parsed = parseRosterInput(rosterInput, availablePlayers);
    setManualRoster(parsed);
  };

  const clearRoster = () => {
    setRosterInput('');
    setManualRoster([]);
  };

  // Clear manual roster when sport changes so NFL players don't bleed into baseball
  useEffect(() => {
    setManualRoster([]);
    setRosterInput('');
    setMessages([initialMessage]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sport]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const q = input.trim();
    if (!q) return;
    const userMsg = { role: 'user', content: q };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      let reply;
      if (aiAvailable) {
        try {
          const systemPrompt = buildSystemPrompt(sport, effectiveRoster, availablePlayers);
          reply = await callChat(systemPrompt, messages.slice(-8), q);
        } catch (e) {
          // Always answer from the local engine instead of surfacing the error.
          const local = ruleBased(q, sport, effectiveRoster, availablePlayers);
          if (e.message.includes('Rate limit')) {
            // Transient — keep AI enabled so the next message retries the model.
            reply = `_⏳ AI is rate-limited right now — here's my read from the draft data we already have:_\n\n${local}`;
          } else {
            // Hard failure (not configured / server error) — stop hitting the API.
            setAiAvailable(false);
            reply = local;
          }
        }
      } else {
        reply = ruleBased(q, sport, effectiveRoster, availablePlayers);
      }
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (e) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠️ ${e.message}`,
      }]);
    }
    setLoading(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // Suggested prompts — mid-draft aware when roster is loaded
  const rosterSize = effectiveRoster.length;
  const approxRound = rosterSize > 0 ? rosterSize + 1 : null;
  const suggestions = sport === 'football'
    ? rosterSize > 0
      ? [
          `It's round ${Math.min(approxRound, 15)} — who should I pick next?`,
          'My RBs are thin — best available RB right now?',
          'Who won\'t make it back to my next pick?',
          'Compare my top 2 remaining options',
        ]
      : [
          'Who should I draft in round 1?',
          'My RBs are thin — best available?',
          'Best value picks in rounds 3–5?',
          'Give me a draft strategy',
        ]
    : rosterSize > 0
      ? [
          `Round ${Math.min(approxRound, 23)} — who fills my biggest need?`,
          'Who should I grab before they\'re gone?',
          'Compare my pitching vs hitting depth',
          'Keeper advice for my roster',
        ]
      : ['Who should I pick up from waivers?', 'How does my pitching look?', 'Best hitter to add?', 'Keeper advice for my roster'];

  return (
    <div className="tab-content">
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>💬 Fantasy Assistant</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setMessages([initialMessage])}
              disabled={loading}
              title="Clear chat history"
              style={{
                fontSize: '0.78em', padding: '3px 10px', borderRadius: 6,
                background: '#fff5f5', color: '#c53030',
                border: '1px solid #fed7d7', cursor: 'pointer',
              }}
            >
              🗑 Clear
            </button>
            <span style={{
              fontSize: '0.78em', padding: '3px 10px', borderRadius: 6,
              background: aiAvailable ? '#f0fff4' : '#fffaf0',
              color: aiAvailable ? '#276749' : '#744210',
              border: `1px solid ${aiAvailable ? '#9ae6b4' : '#f6ad55'}`,
            }}>
              {aiAvailable ? '🤖 Gemini 2.0 Flash' : '📊 Rule-based mode'}
            </span>
          </div>
        </div>

        {/* Offline mode banner */}
        {!aiAvailable && (
          <div style={{
            marginBottom: 8, padding: '8px 12px', borderRadius: 6,
            background: '#fffaf0', border: '1px solid #f6ad55',
            fontSize: '0.82em', color: '#744210',
          }}>
            <strong>📊 Smart mode</strong> — using built-in analysis engine. AI responses require
            network access to Gemini (blocked on some corporate networks). All draft advice, waiver
            recommendations, and trade analysis still work fully.
          </div>
        )}

        {/* Manual roster input — collapsible. Lets user paste their team for advice
            when the live draft hasn't been started or when reviewing an existing team. */}
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={() => setRosterOpen(o => !o)}
            style={{
              fontSize: '0.8em', padding: '4px 10px', borderRadius: 6,
              background: manualRoster.length > 0 ? '#ebf8ff' : '#f7fafc',
              border: '1px solid #cbd5e0', color: '#2d3748', cursor: 'pointer',
            }}
          >
            {rosterOpen ? '▼' : '▶'} My roster {manualRoster.length > 0
              ? `(using ${manualRoster.length} manual)`
              : myRoster?.length > 0
                ? `(using ${myRoster.length} from draft)`
                : '(none — click to add)'}
          </button>

          {rosterOpen && (
            <div style={{
              marginTop: 6, padding: 10, background: '#f7fafc',
              borderRadius: 6, border: '1px solid #e2e8f0',
            }}>
              <p style={{ margin: '0 0 6px', fontSize: '0.8em', color: '#4a5568' }}>
                Paste player names (one per line or comma-separated). I'll fuzzy-match them.
              </p>
              <textarea
                value={rosterInput}
                onChange={e => setRosterInput(e.target.value)}
                rows={3}
                placeholder={sport === 'football'
                  ? 'Christian McCaffrey, Tyreek Hill, Travis Kelce…'
                  : 'Aaron Judge, Shohei Ohtani, Mookie Betts…'}
                style={{
                  width: '100%', padding: '6px 8px', fontSize: '0.85em',
                  border: '1px solid #cbd5e0', borderRadius: 4,
                  fontFamily: 'inherit', boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button
                  onClick={applyRoster}
                  disabled={!rosterInput.trim()}
                  style={{
                    padding: '4px 12px', fontSize: '0.82em', borderRadius: 4,
                    background: '#3182ce', color: '#fff', border: 'none',
                    cursor: rosterInput.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  Apply
                </button>
                {manualRoster.length > 0 && (
                  <button
                    onClick={clearRoster}
                    style={{
                      padding: '4px 12px', fontSize: '0.82em', borderRadius: 4,
                      background: '#fff', color: '#c53030',
                      border: '1px solid #fed7d7', cursor: 'pointer',
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              {manualRoster.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {manualRoster.map(p => (
                    <span key={p.id ?? p.name} style={{
                      fontSize: '0.78em', padding: '2px 8px', borderRadius: 12,
                      background: '#bee3f8', color: '#2c5282',
                    }}>
                      {p.name} ({p.position})
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chat window */}
        <div style={{
          height: 340, overflowY: 'auto', background: '#f7fafc', borderRadius: 8,
          border: '1px solid #e2e8f0', padding: '10px 12px', marginBottom: 10,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              display: 'flex',
              justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
            }}>
              <div style={{
                maxWidth: '82%',
                background: m.role === 'user' ? '#3182ce' : '#fff',
                color: m.role === 'user' ? '#fff' : '#2d3748',
                borderRadius: m.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                padding: '8px 12px',
                fontSize: '0.88em',
                lineHeight: 1.5,
                boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                whiteSpace: 'pre-wrap',
              }}>
                {/* Render simple markdown bold */}
                <FormattedMessage text={m.content} />
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{
                background: '#fff', borderRadius: '12px 12px 12px 2px', padding: '8px 14px',
                fontSize: '0.88em', color: '#a0aec0', boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
              }}>
                ⏳ Thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Suggestions */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {suggestions.map(s => (
            <button
              key={s}
              onClick={() => setInput(s)}
              style={{
                fontSize: '0.78em', padding: '3px 10px', borderRadius: 20,
                border: '1px solid #bee3f8', background: '#ebf8ff', color: '#2b6cb0',
                cursor: 'pointer',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Input */}
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about trades, waivers, keepers, your team… (Enter to send)"
            rows={2}
            style={{
              flex: 1, padding: '8px 12px', fontSize: '0.9em',
              border: '1px solid #cbd5e0', borderRadius: 8, resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            style={{
              padding: '0 18px', background: loading ? '#a0aec0' : '#3182ce',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: loading ? 'not-allowed' : 'pointer', fontSize: '0.95em', fontWeight: 600,
            }}
          >
            Send
          </button>
        </div>

        <p style={{ margin: '6px 0 0', fontSize: '0.75em', color: '#a0aec0' }}>
          {aiAvailable
            ? '🤖 Powered by Gemini 2.0 Flash | Your roster and available players are included as context'
            : '📊 Rule-based analysis mode'
          }
        </p>
      </section>
    </div>
  );
}

/** Render **bold** and line breaks from markdown-ish text. */
function FormattedMessage({ text }) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return part.split('\n').map((line, j) => (
          <React.Fragment key={`${i}-${j}`}>
            {line}
            {j < part.split('\n').length - 1 && <br />}
          </React.Fragment>
        ));
      })}
    </>
  );
}
