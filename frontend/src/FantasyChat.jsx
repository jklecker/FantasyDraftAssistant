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
    .slice(0, 40)
    .map(p => playerSummary(p, sport))
    .join(', ');

  return `You are an expert fantasy ${sport} assistant for a 12-team H2H league. Be concise and direct.

${sport === 'football' ? 'Scoring: PPR (1pt/reception). VBD-based rankings. 2026 NFL season projections.' : 'Scoring: H2H categories (R/H/HR/RBI/SB for hitters; W/SV/K/ERA/WHIP for pitchers).'}

MY ROSTER: ${rosterStr || '(none provided)'}

TOP AVAILABLE PLAYERS: ${topAvail || '(none provided)'}

When asked about trades, waivers, or roster decisions:
- Compare projected value numbers (val=) when relevant
- Reference age and ADP context (keeper leagues: younger players with low ADP rounds are more valuable)
- Give a clear recommendation (Accept / Decline / Add / Drop)
- Keep answers under 5 sentences unless the user asks for detail`;
}

// ─── Rule-based fallback (no OpenAI key) ─────────────────────────────────────

function ruleBased(question, sport, myRoster, availablePlayers) {
  const q = question.toLowerCase();

  // Waiver / add / drop
  if (q.includes('add') || q.includes('waiver') || q.includes('drop') || q.includes('pickup')) {
    const topFree = (availablePlayers || [])
      .filter(p => !myRoster?.some(r => (r.id ?? r.name) === (p.id ?? p.name)))
      .slice(0, 5);
    if (topFree.length === 0) return 'No available players found. Make sure your roster is loaded.';
    const list = topFree.map(p => `**${p.name}** (${p.position}/${p.team}, val=${playerValue(p, sport).toFixed(1)}${p.age ? `, age ${p.age}` : ''})`).join('\n- ');
    return `Top available players by value:\n- ${list}\n\nFor the best waiver pick, target the highest-value player at your weakest position.`;
  }

  // Trade
  if (q.includes('trade')) {
    return 'Use the **Trade Analyzer** tab to compare values side-by-side. Look for the player with higher projected value, younger age (keeper leagues), and the position you need most.';
  }

  // Keeper
  if (q.includes('keeper')) {
    const keeperCandidates = (myRoster || [])
      .filter(p => p.adp && p.age)
      .map(p => {
        const draftRound = Math.ceil((p.adp || 200) / 12);
        const cost = Math.max(1, draftRound - 1);
        return { p, cost, draftRound, val: playerValue(p, sport) };
      })
      .sort((a, b) => (b.val / b.cost) - (a.val / a.cost))
      .slice(0, 5);

    if (keeperCandidates.length === 0) return 'Load your roster first to get keeper recommendations.';
    const list = keeperCandidates
      .map(({ p, cost }) => `**${p.name}** (${p.position}, age ${p.age}) — keep in Rd ${cost}, val=${playerValue(p, sport).toFixed(1)}`)
      .join('\n- ');
    return `Best keeper candidates (highest value per cost round):\n- ${list}`;
  }

  // Roster review / team check
  if (q.includes('team') || q.includes('roster') || q.includes('my picks')) {
    if (!myRoster?.length) return 'No roster loaded yet. Initialize a draft first.';
    const sorted = [...myRoster].sort((a, b) => playerValue(b, sport) - playerValue(a, sport));
    const top5 = sorted.slice(0, 5).map(p => `**${p.name}** (${p.position}, val=${playerValue(p, sport).toFixed(1)})`).join(', ');
    return `Your top 5 players by value: ${top5}. To get specific advice, describe what you're looking for (trade, waiver add, keeper decision).`;
  }

  // Rankings question
  if (q.includes('rank') || q.includes('top') || q.includes('best')) {
    const topPlayers = (availablePlayers || []).slice(0, 8)
      .map((p, i) => `${i + 1}. **${p.name}** (${p.position}/${p.team}, val=${playerValue(p, sport).toFixed(1)})`).join('\n');
    return `Top available players:\n${topPlayers}`;
  }

  return "I can help with trade analysis, waiver wire decisions, keeper recommendations, and team reviews. Try asking: *\"Who should I add from waivers?\"*, *\"Is my team good?\"*, or *\"Who are my best keeper options?\"*";
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
      generationConfig: { maxOutputTokens: 512, temperature: 0.7 },
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

// ─── FantasyChat component ────────────────────────────────────────────────────

export default function FantasyChat({ sport, myRoster, availablePlayers }) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: `Hey! I'm your fantasy ${sport} assistant. Ask me anything:\n- *"Is this trade good for me?"*\n- *"Who should I pick up off waivers?"*\n- *"Is my team still looking strong?"*\n- *"Who are my best keepers?"*`,
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const bottomRef = useRef(null);

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
          const systemPrompt = buildSystemPrompt(sport, myRoster, availablePlayers);
          reply = await callChat(systemPrompt, messages.slice(-8), q);
        } catch (e) {
          // Fall back to rule-based if AI unavailable (e.g. local dev without key)
          if (e.message.includes('not configured') || e.message.includes('Failed to fetch')) {
            setAiAvailable(false);
            reply = ruleBased(q, sport, myRoster, availablePlayers);
          } else {
            throw e;
          }
        }
      } else {
        reply = ruleBased(q, sport, myRoster, availablePlayers);
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

  // Suggested prompts
  const suggestions = sport === 'football'
    ? ['Who should I add off waivers?', 'Is my team still strong?', 'Best keeper options?', 'Evaluate a trade for me']
    : ['Who should I pick up from waivers?', 'How does my pitching look?', 'Best hitter to add?', 'Keeper advice for my roster'];

  return (
    <div className="tab-content">
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>💬 Fantasy Assistant</h3>
          <span style={{
            fontSize: '0.78em', padding: '3px 10px', borderRadius: 6,
            background: aiAvailable ? '#f0fff4' : '#fffaf0',
            color: aiAvailable ? '#276749' : '#744210',
            border: `1px solid ${aiAvailable ? '#9ae6b4' : '#f6ad55'}`,
          }}>
            {aiAvailable ? '🤖 Gemini 2.0 Flash' : '📊 Rule-based mode'}
          </span>
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
