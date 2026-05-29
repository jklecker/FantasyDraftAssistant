import React, { useState, useMemo } from 'react';
import { analyzeTrade, playerValue } from './utils/tradeAnalyzer.js';

/**
 * Trade Analyzer component — sport-agnostic.
 *
 * @param {Object}   props
 * @param {string}   props.sport             'baseball' or 'football'
 * @param {Array}    props.availablePlayers  Pool of all players to pick from (with stats).
 *                                            For baseball: pass draftState players + your roster.
 *                                            For football: pass footballEngine.players (or all).
 * @param {Function} props.searchPlayers     async (query, setResults) => populates a list of matches.
 *                                            Used when availablePlayers isn't a full pool (baseball
 *                                            falls back to backend fuzzy search).
 */
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
    <div style={{flex:1, minWidth:260, background:'#f7fafc', borderRadius:8, padding:14, border:`2px solid ${color}`}}>
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
                <strong>{p.name}</strong> <span style={{color:'#718096'}}>{p.position} · {p.team}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {items.length === 0
        ? <p style={{color:'#a0aec0', fontSize:'0.85em', margin:'8px 0 0'}}>No players selected.</p>
        : <ul style={{listStyle:'none', padding:0, margin:0}}>
            {items.map(p => (
              <li key={p.id ?? p.name}
                  style={{display:'flex', justifyContent:'space-between', alignItems:'center',
                          padding:'6px 8px', marginBottom:4, background:'#fff', borderRadius:4, fontSize:'0.88em'}}>
                <span>
                  <span className="badge" style={{marginRight:6}}>{p.position}</span>
                  <strong>{p.name}</strong>{' '}
                  <span style={{color:'#718096'}}>{p.team}</span>
                </span>
                <span style={{display:'flex', alignItems:'center', gap:8}}>
                  <span style={{color:'#4a5568', fontWeight:600}}>{playerValue(p, sport).toFixed(1)}</span>
                  <button style={{background:'none', border:'none', color:'#c53030', cursor:'pointer', fontSize:'1em'}}
                          onClick={() => setItems(items.filter(x => (x.id ?? x.name) !== (p.id ?? p.name)))}>✕</button>
                </span>
              </li>
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
          Add players to each side. Value scoring uses{' '}
          {sport === 'football' ? 'projected fantasy points + VBD (positional scarcity).'
                                : 'weighted projected season stats (HR / R / RBI / SB / W / SV / K, minus ERA/WHIP penalties).'}
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
              <Stat label="You give"   value={analysis.giveValue} />
              <Stat label="You get"    value={analysis.getValue} />
              <Stat label="Net change" value={(analysis.delta >= 0 ? '+' : '') + analysis.delta} color={analysis.color} />
              <Stat label="% change"   value={(analysis.deltaPct >= 0 ? '+' : '') + analysis.deltaPct + '%'} color={analysis.color} />
            </div>
            <p style={{margin:0, fontSize:'0.92em', color:'#2d3748'}}>
              {explain(analysis)}{analysis.quantityNote}
            </p>
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

function explain(a) {
  const giveNames = a.breakdown.give.map(d => d.player.name).join(', ') || '(nothing)';
  const getNames  = a.breakdown.get.map(d => d.player.name).join(', ')  || '(nothing)';
  if (a.deltaPct >= 20) {
    return `Sending ${giveNames} and receiving ${getNames} is a clear win — you gain ${a.delta} points of value (${a.deltaPct}% upgrade). Accept.`;
  }
  if (a.deltaPct >= 8) {
    return `Modest win: ${getNames} grades out ${a.deltaPct}% above ${giveNames}. Worth accepting unless positional fit is a major issue.`;
  }
  if (a.deltaPct >= -8) {
    return `Roughly even (${a.deltaPct >= 0 ? '+' : ''}${a.deltaPct}%). Decide based on roster construction and need.`;
  }
  if (a.deltaPct >= -20) {
    return `Mild loss (${a.deltaPct}%). Decline unless ${getNames} fills a critical roster hole that ${giveNames} can't.`;
  }
  return `Lopsided in their favor — you lose ${Math.abs(a.delta)} points of value (${a.deltaPct}%). Decline.`;
}
