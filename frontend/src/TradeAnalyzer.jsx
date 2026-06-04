import React, { useState, useMemo } from 'react';
import { analyzeTrade, playerValue } from './utils/tradeAnalyzer.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Keeper cost: what ADP round a player costs to keep (1 round earlier than drafted). */
function keeperCost(p) {
  const adp = p.adp ?? p.rankings?.overall ?? null;
  if (!adp) return null;
  // Approximate draft round from ADP (12-team league)
  return Math.max(1, Math.ceil(adp / 12) - 1);
}

/** Rough age risk label for RBs, WRs, TEs, QBs */
function ageRisk(p) {
  const age = p.age;
  if (!age) return null;
  const pos = p.position;
  if (pos === 'RB') {
    if (age >= 31) return { label: 'High age risk', color: '#c53030' };
    if (age >= 28) return { label: 'Moderate age risk', color: '#c05621' };
    if (age <= 24) return { label: 'Young — keeper value', color: '#276749' };
  }
  if (pos === 'WR' || pos === 'TE' || pos === 'QB') {
    if (age >= 34) return { label: 'High age risk', color: '#c53030' };
    if (age >= 31) return { label: 'Moderate age risk', color: '#c05621' };
    if (age <= 24) return { label: 'Young — keeper value', color: '#276749' };
  }
  return null;
}

function PlayerCard({ p, sport, onRemove }) {
  const val = playerValue(p, sport);
  const risk = ageRisk(p);
  const cost = keeperCost(p);

  // Per-stat summary line
  const statLine = (() => {
    if (sport === 'football') {
      const s = p.stats ?? {};
      const pts = p.projections?.fantasyPoints;
      if (p.position === 'QB') {
        return `${s.passYards ?? 0} PaYd · ${s.passTD ?? 0} PaTD · ${s.rushYards ?? 0} RuYd · ${s.rushTD ?? 0} RuTD`;
      }
      if (p.position === 'RB') {
        return `${s.rushYards ?? 0} RuYd · ${s.rushTD ?? 0} TD · ${s.receptions ?? 0} Rec · ${s.recYards ?? 0} ReYd`;
      }
      if (p.position === 'WR' || p.position === 'TE') {
        return `${s.receptions ?? 0} Rec · ${s.recYards ?? 0} ReYd · ${s.recTD ?? 0} TD`;
      }
      return pts ? `${pts.toFixed(0)} proj pts` : '';
    }
    // Baseball
    const s = p.stats ?? p;
    const isPitcher = Number(s.IP ?? s.ip ?? 0) > 0 || p.position === 'SP' || p.position === 'RP';
    if (isPitcher) {
      return `${Number(s.IP ?? s.ip ?? 0).toFixed(0)} IP · ${s.W ?? s.w ?? 0} W · ${s.SV ?? s.sv ?? 0} SV · ${s.pitchingK ?? s.pK ?? 0} K · ERA ${Number(s.ERA ?? s.era ?? 0).toFixed(2)}`;
    }
    return `${s.HR ?? s.hr ?? 0} HR · ${s.RBI ?? s.rbi ?? 0} RBI · ${s.R ?? s.r ?? 0} R · ${s.SB ?? s.sb ?? 0} SB`;
  })();

  return (
    <li style={{
      background: '#fff',
      borderRadius: 6,
      padding: '8px 10px',
      marginBottom: 6,
      border: '1px solid #e2e8f0',
      fontSize: '0.86em',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <span className="badge" style={{ marginRight: 6 }}>{p.position}</span>
          <strong>{p.name}</strong>
          <span style={{ color: '#718096', marginLeft: 5 }}>{p.team}</span>
          {p.age && <span style={{ color: '#a0aec0', marginLeft: 6 }}>Age {p.age}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#4a5568', fontWeight: 700 }}>{val.toFixed(1)}</span>
          <button
            style={{ background: 'none', border: 'none', color: '#c53030', cursor: 'pointer', fontSize: '1em', padding: '0 2px' }}
            onClick={onRemove}
          >✕</button>
        </div>
      </div>
      {statLine && <div style={{ color: '#718096', marginTop: 3, fontSize: '0.9em' }}>{statLine}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
        {p.adp && (
          <span style={{ fontSize: '0.82em', background: '#edf2f7', borderRadius: 4, padding: '1px 6px' }}>
            ADP #{p.adp}
          </span>
        )}
        {cost && (
          <span style={{ fontSize: '0.82em', background: '#ebf8ff', borderRadius: 4, padding: '1px 6px', color: '#2b6cb0' }}>
            Keeper: Rd {cost}
          </span>
        )}
        {risk && (
          <span style={{ fontSize: '0.82em', background: '#fff5f5', borderRadius: 4, padding: '1px 6px', color: risk.color }}>
            {risk.label}
          </span>
        )}
      </div>
    </li>
  );
}

export default function TradeAnalyzer({ sport, availablePlayers, searchPlayers }) {
  const [give, setGive] = useState([]);
  const [get,  setGet]  = useState([]);
  const [giveSearch, setGiveSearch] = useState('');
  const [getSearch,  setGetSearch]  = useState('');
  const [giveResults, setGiveResults] = useState([]);
  const [getResults,  setGetResults]  = useState([]);

  // Build a quick lookup from the local pool first; backend search is the fallback.
  const filterLocal = (q) => {
    if (!q || q.length < 2) return [];
    const needle = q.toLowerCase();
    return (availablePlayers || [])
      .filter(p => p.name?.toLowerCase().includes(needle))
      .slice(0, 8);
  };

  const handleSearch = async (q, setResults) => {
    const local = filterLocal(q);
    if (local.length > 0) { setResults(local); return; }
    if (searchPlayers) await searchPlayers(q, setResults);
    else setResults([]);
  };

  const analysis = useMemo(
    () => (give.length || get.length) ? analyzeTrade({ give, get, sport }) : null,
    [give, get, sport]
  );

  const renderPicker = (label, items, setItems, search, setSearch, results, setResults, color) => (
    <div style={{flex:1, minWidth:280, background:'#f7fafc', borderRadius:8, padding:14, border:`2px solid ${color}`}}>
      <h4 style={{margin:'0 0 8px', color}}>{label}</h4>
      <div style={{position:'relative', marginBottom:8}}>
        <input
          type="text"
          placeholder="Search player by name…"
          value={search}
          onChange={e => { setSearch(e.target.value); handleSearch(e.target.value, setResults); }}
          style={{width:'100%', padding:'6px 10px', border:'1px solid #cbd5e0', borderRadius:6, fontSize:'0.9em', boxSizing:'border-box'}}
        />
        {results.length > 0 && (
          <ul style={{position:'absolute', top:'100%', left:0, right:0, background:'#fff', border:'1px solid #cbd5e0',
                      borderRadius:6, listStyle:'none', margin:'2px 0 0', padding:0, maxHeight:180, overflowY:'auto', zIndex:10}}>
            {results.map(p => (
              <li key={p.id ?? p.name}
                  style={{padding:'6px 10px', cursor:'pointer', borderBottom:'1px solid #edf2f7', fontSize:'0.88em'}}
                  onClick={() => {
                    if (!items.some(it => (it.id ?? it.name) === (p.id ?? p.name))) {
                      setItems([...items, p]);
                    }
                    setSearch(''); setResults([]);
                  }}>
                <strong>{p.name}</strong>{' '}
                <span style={{color:'#718096'}}>{p.position} · {p.team}</span>
                {p.age && <span style={{color:'#a0aec0'}}> · Age {p.age}</span>}
                {p.adp && <span style={{color:'#4a5568'}}> · ADP #{p.adp}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {items.length === 0
        ? <p style={{color:'#a0aec0', fontSize:'0.85em', margin:'8px 0 0'}}>No players selected.</p>
        : <ul style={{listStyle:'none', padding:0, margin:0}}>
            {items.map(p => (
              <PlayerCard
                key={p.id ?? p.name}
                p={p}
                sport={sport}
                onRemove={() => setItems(items.filter(x => (x.id ?? x.name) !== (p.id ?? p.name)))}
              />
            ))}
          </ul>
      }
    </div>
  );

  return (
    <div className="tab-content">
      <section className="card">
        <h3>🔄 Trade Analyzer</h3>
        <p className="hint" style={{marginTop:0}}>
          Search and add players to each side. Shows age, ADP, keeper cost, and projected value.{' '}
          {sport === 'football' ? 'Football value = projected fantasy points + VBD (positional scarcity).'
                                : 'Baseball value = weighted projected stats (HR/R/RBI/SB/W/SV/K minus ERA/WHIP penalties).'}
        </p>

        <div style={{display:'flex', gap:14, flexWrap:'wrap', marginBottom:18}}>
          {renderPicker('📤 You give', give, setGive, giveSearch, setGiveSearch, giveResults, setGiveResults, '#c53030')}
          {renderPicker('📥 You get', get,  setGet,  getSearch,  setGetSearch,  getResults,  setGetResults, '#2f855a')}
        </div>

        {analysis && (
          <div style={{padding:16, background:'#fff', border:`2px solid ${analysis.color}`, borderRadius:10}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12, marginBottom:10}}>
              <h3 style={{margin:0, color:analysis.color}}>{analysis.verdict}</h3>
              <span style={{fontWeight:700, color:analysis.color, fontSize:'1.1em'}}>{analysis.recommendation}</span>
            </div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:10, marginBottom:12}}>
              <Stat label="You give"   value={analysis.giveValue.toFixed(1)} />
              <Stat label="You get"    value={analysis.getValue.toFixed(1)} />
              <Stat label="Net change" value={(analysis.delta >= 0 ? '+' : '') + analysis.delta.toFixed(1)} color={analysis.color} />
              <Stat label="% change"   value={(analysis.deltaPct >= 0 ? '+' : '') + analysis.deltaPct + '%'} color={analysis.color} />
            </div>
            <p style={{margin:'0 0 10px', fontSize:'0.92em', color:'#2d3748'}}>
              {explain(analysis)}{analysis.quantityNote}
            </p>
            {/* Age / keeper context */}
            {buildKeeperNotes([...give, ...get]).length > 0 && (
              <div style={{borderTop:'1px solid #e2e8f0', paddingTop:10, marginTop:4}}>
                <strong style={{fontSize:'0.82em', color:'#4a5568', textTransform:'uppercase', letterSpacing:'0.05em'}}>
                  Keeper / Age Notes
                </strong>
                <ul style={{margin:'6px 0 0', padding:'0 0 0 16px', fontSize:'0.88em', color:'#4a5568'}}>
                  {buildKeeperNotes([...give, ...get]).map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{background:'#f7fafc', borderRadius:6, padding:'8px 10px', textAlign:'center'}}>
      <div style={{fontSize:'0.75em', color:'#718096', textTransform:'uppercase', fontWeight:600}}>{label}</div>
      <div style={{fontSize:'1.15em', fontWeight:700, color: color ?? '#2d3748'}}>{value}</div>
    </div>
  );
}

/** Build age/keeper advisory notes for a combined player list. */
function buildKeeperNotes(players) {
  const notes = [];
  for (const p of players) {
    const risk = ageRisk(p);
    const cost = keeperCost(p);
    const adpRound = p.adp ? Math.ceil(p.adp / 12) : null;

    if (risk?.color === '#c53030') {
      notes.push(`${p.name} (${p.position}, Age ${p.age}): high age risk — production may drop sharply.`);
    } else if (risk?.color === '#c05621') {
      notes.push(`${p.name} (${p.position}, Age ${p.age}): moderate age concern, monitor into next season.`);
    } else if (risk?.color === '#276749') {
      notes.push(`${p.name} (${p.position}, Age ${p.age}): young asset — strong keeper/dynasty value.`);
    }

    if (cost && adpRound) {
      const costStr = `keep in Rd ${cost} (drafted ~Rd ${adpRound})`;
      if (cost <= 3 && adpRound >= 6) {
        notes.push(`${p.name}: excellent keeper value — ${costStr}.`);
      } else if (cost <= adpRound - 4) {
        notes.push(`${p.name}: good keeper — ${costStr}.`);
      } else if (cost >= adpRound) {
        notes.push(`${p.name}: questionable keeper — ${costStr} costs as much as their draft value.`);
      }
    }
  }
  // Dedup
  return [...new Set(notes)];
}

function explain(a) {
  const giveNames = a.breakdown.give.map(d => d.player.name).join(', ') || '(nothing)';
  const getNames  = a.breakdown.get.map(d => d.player.name).join(', ')  || '(nothing)';
  if (a.deltaPct >= 20) {
    return `Sending ${giveNames} and receiving ${getNames} is a clear win — you gain ${a.delta.toFixed(1)} points of value (${a.deltaPct}% upgrade). `;
  }
  if (a.deltaPct >= 8) {
    return `Modest win: ${getNames} grades out ${a.deltaPct}% above ${giveNames}. Worth accepting unless positional fit is a major issue. `;
  }
  if (a.deltaPct >= -8) {
    return `Roughly even (${a.deltaPct >= 0 ? '+' : ''}${a.deltaPct}%). Decide based on roster construction, age trajectory, and positional need. `;
  }
  if (a.deltaPct >= -20) {
    return `Mild loss (${a.deltaPct}%). Decline unless ${getNames} fills a critical roster hole that ${giveNames} can't. `;
  }
  return `Lopsided in their favor — you lose ${Math.abs(a.delta).toFixed(1)} points of value (${a.deltaPct}%). Decline. `;
}
