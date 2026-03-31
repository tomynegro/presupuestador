import { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';

// ─── CONSTANTS ───────────────────────────────────────────────
const DEFAULT_PROFILES = [
  { id: 'PM',       name: 'PM',        price: 95,  fixed: true },
  { id: 'DEV-Front',name: 'DEV Front', price: 75,  fixed: true },
  { id: 'DEV-Back', name: 'DEV Back',  price: 80,  fixed: true },
  { id: 'DE',       name: 'DE',        price: 80,  fixed: true },
  { id: 'DS',       name: 'DS',        price: 85,  fixed: true },
  { id: 'DA',       name: 'DA',        price: 80,  fixed: true },
  { id: 'IT',       name: 'IT',        price: 65,  fixed: true },
  { id: 'Apoyos',   name: 'Apoyos',    price: 50,  fixed: true },
];

const uid = () => Math.random().toString(36).slice(2, 9);
const fmt = (n, dec=0) => n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtEur = (n) => fmt(n, 0) + ' €';
const fmtH = (n) => fmt(n, 1) + ' h';

// ─── STORAGE ─────────────────────────────────────────────────
const load = (key, def) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; } };
const save = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

// ─── CALCULATIONS ─────────────────────────────────────────────
// calcTask: unchanged logic, just renamed
function calcTask(task, profiles) {
  const profile = profiles.find(p => p.id === task.profileId);
  const profilePrice = profile ? profile.price : 0;
  const priceH = (task.customPrice != null ? task.customPrice : profilePrice);
  const pct = (task.assignPct || 0) / 100;
  const persons = task.persons || 1;
  const contingency = (task.contingency || 0) / 100;
  const blocks = task.weekBlocks && task.weekBlocks.length > 0 ? task.weekBlocks : null;
  let baseHours, totalWeeks, avgHoursWeek;
  if (blocks) {
    baseHours    = blocks.reduce((s, b) => s + (b.weeks||0) * (b.hoursWeek||0), 0) * pct * persons;
    totalWeeks   = blocks.reduce((s, b) => s + (b.weeks||0), 0);
    avgHoursWeek = totalWeeks > 0 ? blocks.reduce((s,b) => s + (b.weeks||0)*(b.hoursWeek||0), 0) / totalWeeks : 0;
  } else {
    const weeks  = task.weeks || 0;
    const hoursW = task.hoursWeek || 0;
    baseHours    = pct * persons * weeks * hoursW;
    totalWeeks   = weeks;
    avgHoursWeek = hoursW;
  }
  const adjHours    = baseHours * (1 + contingency);
  const baseAmount  = baseHours * priceH;
  const finalAmount = adjHours * priceH;
  return { baseHours, adjHours, baseAmount, finalAmount, priceH, profilePrice, totalWeeks, avgHoursWeek };
}

// calcLine: aggregates its tasks (fixedTotal is purely informational)
function calcLine(line, profiles) {
  const tasks = line.tasks || [];
  const activeTasks = tasks.filter(t => t.active !== false);
  const baseHours   = activeTasks.reduce((s,t) => s + calcTask(t, profiles).baseHours, 0);
  const adjHours    = activeTasks.reduce((s,t) => s + calcTask(t, profiles).adjHours, 0);
  const baseAmount  = activeTasks.reduce((s,t) => s + calcTask(t, profiles).baseAmount, 0);
  const finalAmount = activeTasks.reduce((s,t) => s + calcTask(t, profiles).finalAmount, 0);
  const totalWeeks  = activeTasks.length > 0 ? Math.max(...activeTasks.map(t => calcTask(t, profiles).totalWeeks)) : 0;
  return { baseHours, adjHours, baseAmount, finalAmount, totalWeeks };
}

// Migrate old data: a line without tasks[] had the task fields directly on it
function migrateLine(line) {
  if (line.tasks) return line; // already new format
  const task = {
    id: uid(), task: line.task||'', profileId: line.profileId||'', persons: line.persons||1,
    assignPct: line.assignPct??100, weeks: line.weeks||0, hoursWeek: line.hoursWeek||0,
    customPrice: line.customPrice??null, contingency: line.contingency||0,
    weekBlocks: line.weekBlocks||null, desc: line.desc||'', notes: line.notes||'',
    active: line.active !== false,
  };
  return { id: line.id, name: line.task||'Línea', gantt: line.gantt||null, tasks: [task] };
}

function migrateSection(sec) {
  return { ...sec, lines: (sec.lines||[]).map(migrateLine) };
}

function migrateBudget(budget) {
  return { ...budget, sections: (budget.sections||[]).map(migrateSection) };
}

function calcBudget(budget, profiles) {
  const b = migrateBudget(budget);
  const mode = b.mode || 'libre';
  const derived = mode !== 'libre' ? calcDerivedTasks(b, profiles) : {};
  const allActive = [];
  b.sections.forEach(sec => sec.lines.forEach(line => {
    const lc = calcLine(line, profiles);
    const hasFixed = line.fixedTotal != null && line.fixedTotal !== '';
    if (hasFixed) {
      // Fixed total line: use its hours from tasks but override final amount
      allActive.push({ baseHours: lc.baseHours, adjHours: lc.adjHours, baseAmount: lc.baseAmount, finalAmount: lc.finalAmount });
    } else {
      (line.tasks||[]).filter(t => t.active !== false).forEach(task => {
        const c = calcTask(task, profiles);
        const d = derived[task.id];
        if (d) {
          const priceH = d.derivedPriceH || 0;
          const baseHours = d.derivedHours != null ? d.derivedHours : c.baseHours;
          const cont = (task.contingency || 0) / 100;
          const adjHours = baseHours * (1 + cont);
          allActive.push({ baseHours, adjHours, baseAmount: baseHours*priceH, finalAmount: adjHours*priceH });
        } else {
          allActive.push(c);
        }
      });
    }
  }));
  const totalBaseH = allActive.reduce((s,l) => s+l.baseHours, 0);
  const totalAdjH  = allActive.reduce((s,l) => s+l.adjHours, 0);
  const totalBase  = allActive.reduce((s,l) => s+l.baseAmount, 0);
  const globalContingency = (b.globalContingency || 0) / 100;
  const totalFinal = mode !== 'libre' && (b.lockedTotal || 0) > 0
    ? b.lockedTotal
    : totalBase * (1 + globalContingency);
  const avgPrice = totalBaseH > 0 ? totalFinal / totalBaseH : 0;
  return { totalBaseH, totalAdjH, totalBase, totalFinal, avgPrice };
}

function calcDerivedTasks(budget, profiles) {
  const mode = budget.mode || 'libre';
  const result = {};
  if (mode === 'libre') return result;
  const allActive = [];
  budget.sections.forEach(sec => sec.lines.forEach(line =>
    (line.tasks||[]).filter(t => t.active !== false).forEach(task => {
      allActive.push({ task, ...calcTask(task, profiles) });
    })
  ));
  const totalAdjH    = allActive.reduce((s,l) => s+l.adjHours, 0);
  const globalCont   = (budget.globalContingency || 0) / 100;
  const lockedTotal  = budget.lockedTotal || 0;
  const targetPriceH = budget.targetPriceH || 0;
  if (mode === 'bloqueado') {
    const netTotal = globalCont > 0 ? lockedTotal/(1+globalCont) : lockedTotal;
    allActive.forEach(({ task, adjHours }) => {
      const share = totalAdjH > 0 ? adjHours/totalAdjH : 0;
      const derivedPriceH = adjHours > 0 ? (netTotal*share)/adjHours : 0;
      result[task.id] = { derivedPriceH };
    });
  }
  if (mode === 'horas') {
    const netTotal     = globalCont > 0 ? lockedTotal/(1+globalCont) : lockedTotal;
    const totalAvailH  = targetPriceH > 0 ? netTotal/targetPriceH : 0;
    const totalWeight  = allActive.reduce((s,{task}) => s+(task.assignPct||0)*(task.persons||1), 0);
    allActive.forEach(({ task }) => {
      const weight = (task.assignPct||0)*(task.persons||1);
      const share  = totalWeight > 0 ? weight/totalWeight : 0;
      const derivedHours = totalAvailH * share;
      const hoursW = task.hoursWeek || (budget.defaultHoursWeek||40);
      const pct    = (task.assignPct||0)/100;
      const persons = task.persons||1;
      const divisor = pct*persons*hoursW;
      result[task.id] = { derivedPriceH: targetPriceH, derivedHours, derivedWeeks: divisor>0?derivedHours/divisor:0 };
    });
  }
  return result;
}

// Alias for backward compat in places still using calcDerivedLines
function calcDerivedLines(budget, profiles) { return calcDerivedTasks(migrateBudget(budget), profiles); }

// ─── TOAST ───────────────────────────────────────────────────
function Toast({ msg, type, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 2400); return () => clearTimeout(t); }, []);
  return <div className={`toast ${type}`}>{msg}</div>;
}

// ─── PROFILE BADGE ───────────────────────────────────────────
function ProfileBadge({ profileId, profiles }) {
  const p = profiles.find(x => x.id === profileId);
  const name = p ? p.name : profileId;
  const cls = DEFAULT_PROFILES.find(d => d.id === profileId) ? `tag-${profileId}` : 'tag-custom';
  return <span className={`profile-badge ${cls}`}>{name}</span>;
}

// ─── PROFILES MODAL ──────────────────────────────────────────
function ProfilesModal({ profiles, onClose, onSave }) {
  const [local, setLocal] = useState(profiles.map(p => ({ ...p })));
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');

  const updatePrice = (id, val) => setLocal(l => l.map(p => p.id === id ? { ...p, price: parseFloat(val) || 0 } : p));
  const addProfile = () => {
    if (!newName.trim()) return;
    setLocal(l => [...l, { id: uid(), name: newName.trim(), price: parseFloat(newPrice) || 0, fixed: false }]);
    setNewName(''); setNewPrice('');
  };
  const delProfile = (id) => setLocal(l => l.filter(p => p.id !== id));

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-title">⚙️ <span>Perfiles</span> profesionales</div>
        <table className="profiles-table">
          <thead><tr><th>Perfil</th><th>€/hora</th><th></th></tr></thead>
          <tbody>
            {local.map(p => (
              <tr key={p.id}>
                <td><ProfileBadge profileId={p.id} profiles={local} /></td>
                <td>
                  <input className="price-input" type="number" value={p.price}
                    onChange={e => updatePrice(p.id, e.target.value)} min={0} />
                </td>
                <td>
                  {!p.fixed && <button className="card-btn danger" onClick={() => delProfile(p.id)}>✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="divider" />
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <input className="cell-input" style={{ flex:1, background:'var(--bg)', border:'1px solid var(--border-mid)', borderRadius:4, padding:'6px 10px', color:'var(--text)' }}
            placeholder="Nombre del perfil" value={newName} onChange={e => setNewName(e.target.value)} />
          <input className="price-input" type="number" placeholder="€/h" value={newPrice}
            onChange={e => setNewPrice(e.target.value)} min={0} />
          <button className="btn btn-primary btn-sm" onClick={addProfile}>+ Añadir</button>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={() => onSave(local)}>Guardar cambios</button>
        </div>
      </div>
    </div>
  );
}

// ─── NEW BUDGET MODAL ─────────────────────────────────────────
function BudgetModal({ initial, onClose, onSave }) {
  const [name, setName] = useState(initial?.name || '');
  const [client, setClient] = useState(initial?.client || '');
  const [desc, setDesc] = useState(initial?.desc || '');
  const ok = name.trim();
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">📋 {initial ? 'Editar' : 'Nuevo'} <span>presupuesto</span></div>
        <div className="field"><label>Nombre del presupuesto *</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Proyecto Portal Web" autoFocus /></div>
        <div className="field"><label>Cliente</label><input value={client} onChange={e => setClient(e.target.value)} placeholder="Ej: Acme Corp" /></div>
        <div className="field"><label>Descripción</label><textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Resumen del proyecto (opcional)" /></div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={!ok} onClick={() => ok && onSave({ name: name.trim(), client: client.trim(), desc: desc.trim() })}>
            {initial ? 'Guardar' : 'Crear presupuesto'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TASK ROW ─────────────────────────────────────────────────
function TaskRow({ task, profiles, mode, derived, onUpdate, onDelete, onDuplicate, defaultHoursWeek }) {
  const [showAdv, setShowAdv] = useState(false);
  const calc = calcTask(task, profiles);
  const set  = (field, val) => onUpdate({ ...task, [field]: val });
  const maxPct = (task.persons || 1) * 100;
  const hasBlocks = task.weekBlocks && task.weekBlocks.length > 0;
  const d = derived || {};
  const effPriceH = mode !== 'libre' && d.derivedPriceH != null ? d.derivedPriceH : calc.priceH;
  const effBaseH  = mode === 'horas'  && d.derivedHours  != null ? d.derivedHours  : calc.baseHours;
  const effWeeks  = mode === 'horas'  && d.derivedWeeks  != null ? d.derivedWeeks  : null;
  const cont      = (task.contingency || 0) / 100;
  const effAdjH   = effBaseH * (1 + cont);
  const effFinal  = effAdjH * effPriceH;

  const setWBlock = (i, field, val) => set('weekBlocks', (task.weekBlocks||[]).map((b,idx) => idx===i ? {...b,[field]:parseFloat(val)||0} : b));
  const addWBlock = () => set('weekBlocks', [...(task.weekBlocks||[]), {weeks:1,hoursWeek:defaultHoursWeek}]);
  const delWBlock = (i) => { const b=(task.weekBlocks||[]).filter((_,idx)=>idx!==i); set('weekBlocks',b.length>0?b:null); };

  return (
    <>
      <tr className={task.active === false ? 'disabled' : ''} style={{background:'var(--surface)'}}>
        <td style={{width:24,paddingLeft:28}}>
          <input type="checkbox" className="toggle-check" checked={task.active !== false}
            onChange={e => set('active', e.target.checked)} />
        </td>
        <td style={{minWidth:140, paddingLeft:8}}>
          <input className="cell-input" value={task.task||''} onChange={e=>set('task',e.target.value)} placeholder="Tarea *"
            style={!task.task?.trim()?{borderColor:'var(--danger)',background:'var(--danger-pale)'}:{}} />
          {!task.task?.trim() && <div style={{fontSize:9,color:'var(--danger)',fontFamily:'var(--font-mono)',marginTop:1,paddingLeft:4}}>Obligatorio</div>}
        </td>
        <td style={{minWidth:110}}>
          <select className="cell-select" value={task.profileId||''} onChange={e=>set('profileId',e.target.value)}>
            {profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </td>
        <td style={{width:50}}>
          <input className="cell-input" type="number" min={1} value={task.persons??1}
            onChange={e=>set('persons',parseInt(e.target.value)||1)} />
        </td>
        <td style={{width:66}}>
          <input className="cell-input" type="number" min={0} max={maxPct} value={task.assignPct??100}
            onChange={e=>{let v=parseFloat(e.target.value)||0;if(v>maxPct)v=maxPct;set('assignPct',v);}} />
        </td>
        <td style={{width:72}}>
          {mode==='horas'&&effWeeks!=null
            ?<span className="cell-readonly" style={{color:'var(--cyan-dim)'}}>{fmt(effWeeks,1)}</span>
            :hasBlocks
              ?<span className="cell-dimmed" title="Calculado de los tramos">{fmt(calc.totalWeeks,1)} *</span>
              :<input className="cell-input" type="number" min={0} value={task.weeks??1} onChange={e=>set('weeks',parseFloat(e.target.value)||0)} />
          }
        </td>
        <td style={{width:60}}>
          {hasBlocks
            ?<span className="cell-dimmed" title="Promedio ponderado">{fmt(calc.avgHoursWeek,1)} *</span>
            :<input className="cell-input" type="number" min={0} value={task.hoursWeek??defaultHoursWeek} onChange={e=>set('hoursWeek',parseFloat(e.target.value)||0)} />
          }
        </td>
        <td style={{width:72}}>
          {mode==='libre'
            ?<input className="cell-input" type="number" min={0} value={task.customPrice??calc.profilePrice} onChange={e=>set('customPrice',parseFloat(e.target.value)||0)} />
            :<span className="cell-readonly">{fmt(effPriceH,2)}</span>
          }
        </td>
        <td><span className="cell-dimmed">{fmtH(effBaseH)}</span></td>
        <td><span className="cell-dimmed">{fmtH(effAdjH)}</span></td>
        <td><span className="cell-readonly">{fmtEur(effFinal)}</span></td>
        <td>
          <div style={{display:'flex',gap:3}}>
            <button className="card-btn advanced-toggle" title="Panel avanzado" onClick={()=>setShowAdv(v=>!v)}>⋯</button>
            <button className="card-btn" title="Duplicar" onClick={onDuplicate}>⧉</button>
            <button className="card-btn danger" title="Eliminar" onClick={onDelete}>✕</button>
          </div>
        </td>
      </tr>
      {showAdv && (
        <tr><td colSpan={12} style={{padding:0}}>
          <div className="advanced-panel">
            <div className="adv-field" style={{gridColumn:'1 / -1'}}>
              <label>Descripción (exportable a Excel)</label>
              <input className="cell-input" style={{background:'var(--bg)',border:'1px solid var(--border-mid)',borderRadius:4,padding:'4px 8px',width:'100%'}}
                value={task.desc||''} onChange={e=>set('desc',e.target.value)} placeholder="Descripción de la tarea..." />
            </div>
            <div className="adv-field" style={{gridColumn:'1 / -1'}}>
              <label>Notas internas (NO se exportan)</label>
              <input className="cell-input" style={{background:'#fff8f6',border:'1px solid rgba(214,59,16,0.25)',borderRadius:4,padding:'4px 8px',width:'100%'}}
                value={task.notes||''} onChange={e=>set('notes',e.target.value)} placeholder="Observaciones privadas..." />
            </div>
            <div className="adv-field">
              <label>Contingencia %</label>
              <input className="cell-input num-input-sm" type="number" min={0}
                style={{background:'var(--bg)',border:'1px solid var(--border-mid)',borderRadius:4,padding:'4px 8px'}}
                value={task.contingency??0} onChange={e=>set('contingency',parseFloat(e.target.value)||0)} />
            </div>
            {mode==='horas'&&d.derivedHours!=null&&(
              <div className="adv-field">
                <label>Horas disponibles</label>
                <span style={{fontFamily:'var(--font-mono)',fontSize:13,fontWeight:700,color:'var(--cyan)'}}>{fmtH(d.derivedHours)}</span>
              </div>
            )}
            <div className="adv-field" style={{gridColumn:'1 / -1'}}>
              <label style={{marginBottom:8,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span>Tramos de semanas</span>
                <button className="add-line-btn" style={{margin:0,padding:'2px 10px',fontSize:11}} onClick={addWBlock}>+ Añadir tramo</button>
              </label>
              {(!task.weekBlocks||task.weekBlocks.length===0)?(
                <div style={{fontSize:12,color:'var(--text-dim)',padding:'4px 0'}}>
                  Sin tramos — usando <strong>{task.weeks??1} sem × {task.hoursWeek??defaultHoursWeek} h/sem</strong>.
                </div>
              ):(
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto',gap:8,padding:'0 2px'}}>
                    <span style={{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--text-dim)',textTransform:'uppercase',letterSpacing:'0.5px'}}>Semanas</span>
                    <span style={{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--text-dim)',textTransform:'uppercase',letterSpacing:'0.5px'}}>h/sem</span>
                    <span />
                  </div>
                  {task.weekBlocks.map((b,i)=>(
                    <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 1fr auto',gap:8,alignItems:'center'}}>
                      <input className="cell-input" type="number" min={0} style={{background:'var(--bg)',border:'1px solid var(--border-mid)',borderRadius:4,padding:'4px 8px'}} value={b.weeks} onChange={e=>setWBlock(i,'weeks',e.target.value)} />
                      <input className="cell-input" type="number" min={0} style={{background:'var(--bg)',border:'1px solid var(--border-mid)',borderRadius:4,padding:'4px 8px'}} value={b.hoursWeek} onChange={e=>setWBlock(i,'hoursWeek',e.target.value)} />
                      <button className="card-btn danger" onClick={()=>delWBlock(i)}>✕</button>
                    </div>
                  ))}
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto',gap:8,padding:'6px 2px 2px',borderTop:'1px solid var(--border)'}}>
                    <span style={{fontSize:12,fontFamily:'var(--font-mono)',fontWeight:700,color:'var(--navy)'}}>{fmt(calc.totalWeeks,1)} sem</span>
                    <span style={{fontSize:12,fontFamily:'var(--font-mono)',fontWeight:700,color:'var(--navy)'}}>{fmt(calc.avgHoursWeek,1)} h/sem <span style={{fontWeight:400,color:'var(--text-dim)',fontSize:10}}>(prom.)</span></span>
                    <span />
                  </div>
                </div>
              )}
            </div>
          </div>
        </td></tr>
      )}
    </>
  );
}

// ─── LINE BLOCK (agrupador intermedio) ────────────────────────
function LineBlock({ line, profiles, mode, derivedMap, onUpdateLine, onDeleteLine, onDuplicateLine, defaultHoursWeek }) {
  const [open, setOpen] = useState(true);

  const activeTasks = (line.tasks||[]).filter(t => t.active !== false);
  const lc = (() => {
    const baseH  = activeTasks.reduce((s,t)=>{const d=derivedMap?.[t.id];return s+(d?.derivedHours!=null?d.derivedHours:calcTask(t,profiles).baseHours);},0);
    const adjH   = activeTasks.reduce((s,t)=>{const d=derivedMap?.[t.id];const bh=d?.derivedHours!=null?d.derivedHours:calcTask(t,profiles).baseHours;return s+bh*(1+(t.contingency||0)/100);},0);
    const base   = activeTasks.reduce((s,t)=>{const d=derivedMap?.[t.id];const ph=d?.derivedPriceH??calcTask(t,profiles).priceH;const bh=d?.derivedHours!=null?d.derivedHours:calcTask(t,profiles).baseHours;return s+bh*ph;},0);
    const taskFinal = activeTasks.reduce((s,t)=>{const d=derivedMap?.[t.id];const ph=d?.derivedPriceH??calcTask(t,profiles).priceH;const bh=d?.derivedHours!=null?d.derivedHours:calcTask(t,profiles).baseHours;return s+bh*(1+(t.contingency||0)/100)*ph;},0);
    const final  = (line.fixedTotal!=null&&line.fixedTotal!=='') ? Number(line.fixedTotal) : taskFinal;
    const avgH   = baseH>0?final/baseH:0;
    return {baseH, adjH, base, taskFinal, final, avgH};
  })();

  const hasFixed = line.fixedTotal != null && line.fixedTotal !== '';
  const lineDisplayTotal = lc.final;
  const lineTotal = lineDisplayTotal;

  const updateTask    = (tid, upd) => onUpdateLine({...line, tasks:(line.tasks||[]).map(t=>t.id===tid?upd:t)});
  const deleteTask    = (tid) => onUpdateLine({...line, tasks:(line.tasks||[]).filter(t=>t.id!==tid)});
  const duplicateTask = (tid) => {
    const idx = (line.tasks||[]).findIndex(t=>t.id===tid);
    const clone = {...line.tasks[idx], id:uid(), task:(line.tasks[idx].task||'')+'  (copia)'};
    const ts=[...(line.tasks||[])]; ts.splice(idx+1,0,clone);
    onUpdateLine({...line, tasks:ts});
  };
  const addTask = () => {
    const def = {id:uid(),task:'',profileId:profiles[0]?.id||'',persons:1,assignPct:100,weeks:4,hoursWeek:defaultHoursWeek,contingency:0,active:true};
    onUpdateLine({...line, tasks:[...(line.tasks||[]),def]});
  };

  return (
    <div style={{marginBottom:4, marginLeft:0}}>
      {/* Line header */}
      <div style={{
        display:'flex', alignItems:'center', gap:8, padding:'7px 12px',
        background:'var(--surface-2)', border:'1px solid var(--border)',
        borderRadius: open ? '6px 6px 0 0' : '6px',
        cursor:'pointer', userSelect:'none',
      }} onClick={()=>setOpen(o=>!o)}>
        <span style={{fontSize:10,color:'var(--cyan)',transition:'transform 0.2s',transform:open?'rotate(90deg)':'rotate(0deg)'}}>▶</span>
        <input className="cell-input" style={{flex:1,fontWeight:700,fontSize:12,color:'var(--navy)',background:'transparent',border:'1px solid transparent'}}
          value={line.name||''} onClick={e=>e.stopPropagation()}
          onChange={e=>onUpdateLine({...line,name:e.target.value})}
          placeholder="Nombre de la línea" />
        <span style={{fontFamily:'var(--font-mono)',fontSize:11,fontWeight:600,color: hasFixed ? '#fff' : 'var(--navy)',
          background: hasFixed ? 'var(--navy)' : 'var(--cyan-pale)',padding:'2px 8px',borderRadius:4}}>
          {fmtEur(lineDisplayTotal)}
        </span>
        <div style={{display:'flex',gap:3}} onClick={e=>e.stopPropagation()}>
          <button className="card-btn" title="Duplicar línea" onClick={onDuplicateLine}>⧉</button>
          <button className="card-btn danger" title="Eliminar línea" onClick={onDeleteLine}>✕</button>
        </div>
      </div>

      {open && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{paddingLeft:28}}></th><th>Tarea</th><th>Perfil</th>
                  <th>Pers.</th><th>Asig.%</th><th>Sem.</th><th>h/sem</th>
                  <th>€/h</th><th>h base</th><th>h ajust.</th><th>Importe</th><th></th>
                </tr>
              </thead>
              <tbody>
                {(line.tasks||[]).map(task=>(
                  <TaskRow key={task.id} task={task} profiles={profiles} mode={mode}
                    derived={derivedMap?.[task.id]}
                    onUpdate={upd=>updateTask(task.id,upd)}
                    onDelete={()=>deleteTask(task.id)}
                    onDuplicate={()=>duplicateTask(task.id)}
                    defaultHoursWeek={defaultHoursWeek}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <button className="add-line-btn" style={{marginLeft:8,fontSize:11}} onClick={addTask}>+ Añadir tarea</button>
          {/* Line subtotal strip */}
          {activeTasks.length > 0 && (
            <div style={{display:'flex',justifyContent:'flex-end',gap:0,background:'var(--surface-2)',
              border:'1px solid var(--border)',borderTop:'none',borderRadius:'0 0 6px 6px',marginBottom:2,flexWrap:'wrap'}}>
              {[
                ['h base', fmtH(lc.baseH)],
                ['h ajust.', fmtH(lc.adjH)],
                ['Base', fmtEur(lc.base)],
                ['€/h medio', fmt(lc.avgH,2)+' €'],
                ['Total tareas', fmtEur(lc.taskFinal)],
              ].map(([label,val],i)=>(
                <div key={label} style={{display:'flex',flexDirection:'column',alignItems:'flex-end',padding:'6px 14px',
                  borderLeft:i>0?'1px solid var(--border)':'none'}}>
                  <span style={{fontSize:9,fontFamily:'var(--font-mono)',fontWeight:600,textTransform:'uppercase',
                    letterSpacing:'0.6px',color:'var(--text-dim)'}}>{label}</span>
                  <span style={{fontSize:12,fontFamily:'var(--font-mono)',fontWeight:700,color:'var(--text)'}}>{val}</span>
                </div>
              ))}
              {/* TOTAL FIX cell */}
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',padding:'6px 14px',
                borderLeft:'1px solid var(--border)',background:'var(--navy)',borderRadius:'0 0 5px 0',minWidth:140}}>
                <span style={{fontSize:9,fontFamily:'var(--font-mono)',fontWeight:600,textTransform:'uppercase',
                  letterSpacing:'0.6px',color:'rgba(255,255,255,0.5)',display:'flex',alignItems:'center',gap:4}}>
                  Total Fix
                  {hasFixed && (
                    <button onClick={()=>onUpdateLine({...line,fixedTotal:null})}
                      style={{background:'none',border:'none',cursor:'pointer',color:'rgba(255,100,100,0.7)',
                        fontSize:10,padding:'0 2px',lineHeight:1}} title="Eliminar Total Fix">✕</button>
                  )}
                </span>
                <input
                  type="number" min={0}
                  value={line.fixedTotal ?? ''}
                  placeholder={fmtEur(lc.taskFinal).replace(' €','')}
                  onChange={e => onUpdateLine({...line, fixedTotal: e.target.value==='' ? null : parseFloat(e.target.value)||0})}
                  style={{
                    background:'transparent', border:'none', borderBottom:`1px solid ${hasFixed?'var(--cyan)':'rgba(255,255,255,0.2)'}`,
                    color: hasFixed ? 'var(--cyan)' : 'rgba(255,255,255,0.4)',
                    fontFamily:'var(--font-mono)', fontSize:13, fontWeight:700,
                    textAlign:'right', width:'100%', outline:'none', padding:'2px 0',
                    cursor:'text',
                  }}
                  onClick={e=>e.stopPropagation()}
                />
                {hasFixed && (
                  <span style={{fontSize:9,color:'rgba(255,255,255,0.35)',fontFamily:'var(--font-mono)',marginTop:1}}>
                    dif. {fmtEur(lc.final - lc.taskFinal)}
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── SECTION BLOCK ────────────────────────────────────────────
function SectionBlock({ section, profiles, mode, derivedMap, onUpdateSection, onDeleteSection, onDuplicateSection, defaultHoursWeek }) {
  const [open, setOpen] = useState(true);
  const sec = migrateSection(section); // ensure new format

  const allTasks = sec.lines.flatMap(l=>(l.tasks||[]).filter(t=>t.active!==false));
  const secTotal = sec.lines.reduce((s,l) => s + calcLine(l, profiles).finalAmount, 0);

  const updateLine    = (lid,upd) => onUpdateSection({...sec,lines:sec.lines.map(l=>l.id===lid?upd:l)});
  const deleteLine    = (lid) => onUpdateSection({...sec,lines:sec.lines.filter(l=>l.id!==lid)});
  const duplicateLine = (lid) => {
    const idx=sec.lines.findIndex(l=>l.id===lid);
    const clone={...sec.lines[idx],id:uid(),name:(sec.lines[idx].name||'')+'(copia)',tasks:(sec.lines[idx].tasks||[]).map(t=>({...t,id:uid()}))};
    const ls=[...sec.lines]; ls.splice(idx+1,0,clone);
    onUpdateSection({...sec,lines:ls});
  };
  const addLine = () => {
    const nl={id:uid(),name:'Nueva línea',tasks:[{id:uid(),task:'',profileId:profiles[0]?.id||'',persons:1,assignPct:100,weeks:4,hoursWeek:defaultHoursWeek,contingency:0,active:true}]};
    onUpdateSection({...sec,lines:[...sec.lines,nl]});
  };

  // Section subtotal
  const secSub = (() => {
    const baseH=allTasks.reduce((s,t)=>{const d=derivedMap?.[t.id];return s+(d?.derivedHours!=null?d.derivedHours:calcTask(t,profiles).baseHours);},0);
    const adjH =allTasks.reduce((s,t)=>{const d=derivedMap?.[t.id];const bh=d?.derivedHours!=null?d.derivedHours:calcTask(t,profiles).baseHours;return s+bh*(1+(t.contingency||0)/100);},0);
    const base =allTasks.reduce((s,t)=>{const d=derivedMap?.[t.id];const ph=d?.derivedPriceH??calcTask(t,profiles).priceH;const bh=d?.derivedHours!=null?d.derivedHours:calcTask(t,profiles).baseHours;return s+bh*ph;},0);
    const final= sec.lines.reduce((s,l) => s + calcLine(l, profiles).finalAmount, 0);
    const avgH =baseH>0?final/baseH:0;
    return {baseH,adjH,base,final,avgH};
  })();

  return (
    <div className="section-block">
      <div className="section-header" onClick={()=>setOpen(o=>!o)}>
        <span className={`section-chevron ${open?'open':''}`}>▶</span>
        <span className="section-name">
          <input className="cell-input" style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:13,color:'var(--navy)'}}
            value={sec.name} onClick={e=>e.stopPropagation()}
            onChange={e=>onUpdateSection({...sec,name:e.target.value})} />
        </span>
        <span className="section-total">{fmtEur(secTotal)}</span>
        <div className="section-actions" onClick={e=>e.stopPropagation()}>
          <button className="card-btn" title="Duplicar sección" onClick={onDuplicateSection}>⧉</button>
          <button className="card-btn danger" title="Eliminar sección" onClick={onDeleteSection}>✕</button>
        </div>
      </div>
      {open && (
        <>
          <div style={{padding:'8px 0 4px 0'}}>
            {sec.lines.map(line=>(
              <LineBlock key={line.id} line={line} profiles={profiles} mode={mode}
                derivedMap={derivedMap}
                onUpdateLine={upd=>updateLine(line.id,upd)}
                onDeleteLine={()=>deleteLine(line.id)}
                onDuplicateLine={()=>duplicateLine(line.id)}
                defaultHoursWeek={defaultHoursWeek}
              />
            ))}
            <button className="add-line-btn" onClick={addLine}>+ Añadir línea</button>
          </div>
          {/* Section subtotal */}
          {allTasks.length > 0 && (
            <div style={{display:'flex',justifyContent:'flex-end',gap:0,background:'var(--surface-2)',border:'1px solid var(--border)',borderTop:'none',borderRadius:'0 0 6px 6px',marginBottom:4}}>
              {[['h base',fmtH(secSub.baseH)],['h ajust.',fmtH(secSub.adjH)],['Base',fmtEur(secSub.base)],['€/h medio',fmt(secSub.avgH,2)+' €'],['Total sección',fmtEur(secSub.final)]].map(([label,val],i,arr)=>(
                <div key={label} style={{display:'flex',flexDirection:'column',alignItems:'flex-end',padding:'7px 16px',borderLeft:i>0?'1px solid var(--border)':'none',background:i===arr.length-1?'var(--navy)':'transparent',borderRadius:i===arr.length-1?'0 0 5px 0':0}}>
                  <span style={{fontSize:9,fontFamily:'var(--font-mono)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.6px',color:i===arr.length-1?'rgba(255,255,255,0.5)':'var(--text-dim)'}}>{label}</span>
                  <span style={{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:700,color:i===arr.length-1?'var(--cyan)':'var(--text)'}}>{val}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── BUDGET VIEW ──────────────────────────────────────────────
function BudgetView({ budget, profiles, onUpdate, onBack }) {
  const [mode, setMode] = useState(budget.mode || 'libre');
  const [lockedTotal, setLockedTotal] = useState(budget.lockedTotal || '');
  const [targetPriceH, setTargetPriceH] = useState(budget.targetPriceH || '');

  const kpis = calcBudget(budget, profiles);
  const derivedMap = calcDerivedLines(budget, profiles);

  const updateBudget = (updates) => {
    const updated = { ...budget, ...updates, updatedAt: Date.now() };
    onUpdate(updated);
  };
  const updateSection = (secId, updated) => {
    updateBudget({ sections: budget.sections.map(s => s.id === secId ? updated : s) });
  };
  const deleteSection = (secId) => {
    updateBudget({ sections: budget.sections.filter(s => s.id !== secId) });
  };
  const duplicateSection = (secId) => {
    const idx = budget.sections.findIndex(s => s.id === secId);
    const orig = migrateSection(budget.sections[idx]);
    const clone = { ...orig, id: uid(), name: orig.name + ' (copia)',
      lines: orig.lines.map(l => ({ ...l, id: uid(), tasks: (l.tasks||[]).map(t => ({ ...t, id: uid() })) })) };
    const newSecs = [...budget.sections];
    newSecs.splice(idx + 1, 0, clone);
    updateBudget({ sections: newSecs });
  };
  const addSection = () => {
    const sec = { id: uid(), name: 'Nueva sección', lines: [] };
    updateBudget({ sections: [...budget.sections, sec] });
  };
  useEffect(() => { updateBudget({ mode }); }, [mode]);

  return (
    <div className="budget-view">
      {/* Back + mode selector */}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:18, flexWrap:'wrap' }}>
        <button className="back-btn" onClick={onBack}>← Volver</button>
        <div style={{ flex:1 }} />
        <div className="mode-selector">
          <button className={`mode-btn ${mode==='libre'?'active':''}`} onClick={() => setMode('libre')}>Libre</button>
          <button className={`mode-btn ${mode==='bloqueado'?'active':''}`} onClick={() => setMode('bloqueado')}>Total bloqueado</button>
          <button className={`mode-btn ${mode==='horas'?'active':''}`} onClick={() => setMode('horas')}>Horas disponibles</button>
        </div>
      </div>

      {/* KPI Bar */}
      <div className="kpi-bar">
        <div className="kpi-item"><span className="kpi-label">Horas base</span><span className="kpi-value">{fmtH(kpis.totalBaseH)}</span></div>
        <div className="kpi-item"><span className="kpi-label">Horas ajustadas</span><span className="kpi-value">{fmtH(kpis.totalAdjH)}</span></div>
        <div className="kpi-item"><span className="kpi-label">Presupuesto base</span><span className="kpi-value">{fmtEur(kpis.totalBase)}</span></div>
        <div className="kpi-item"><span className="kpi-label">Presupuesto final</span><span className="kpi-value cyan">{fmtEur(kpis.totalFinal)}</span></div>
        <div className="kpi-item"><span className="kpi-label">€/hora medio</span><span className="kpi-value">{fmt(kpis.avgPrice, 2)} €</span></div>
      </div>

      {/* Mode info */}
      {mode === 'bloqueado' && (
        <div className="mode-info">
          <span className="mode-info-icon">🔒</span>
          <div>
            <strong>Modo total bloqueado:</strong> Fija un importe total y el sistema calculará el €/hora de cada línea activa de forma proporcional a sus horas ajustadas.
            <div style={{ marginTop:8, display:'flex', gap:12, alignItems:'center' }}>
              <label style={{ fontSize:11, color:'var(--text-mid)', fontFamily:'var(--font-mono)', fontWeight:600 }}>IMPORTE TOTAL BLOQUEADO (€)</label>
              <input className="price-input" type="number" min={0}
                style={{ background:'var(--bg)', border:'1px solid var(--cyan)', borderRadius:4, padding:'4px 10px', color:'var(--text)', fontFamily:'var(--font-mono)', fontSize:13, width:130 }}
                value={lockedTotal} onChange={e => { setLockedTotal(e.target.value); updateBudget({ lockedTotal: parseFloat(e.target.value) || 0 }); }}
                placeholder="0" />
            </div>
          </div>
        </div>
      )}
      {mode === 'horas' && (
        <div className="mode-info">
          <span className="mode-info-icon">⏱</span>
          <div>
            <strong>Modo horas disponibles:</strong> Fija un total y un €/hora objetivo. Se calculan las horas disponibles por línea proporcionales a la asignación.
            <div style={{ marginTop:8, display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
              <div><label style={{ fontSize:11, color:'var(--text-mid)', fontFamily:'var(--font-mono)', fontWeight:600, display:'block', marginBottom:3 }}>TOTAL (€)</label>
                <input className="price-input" type="number" min={0}
                  style={{ background:'var(--bg)', border:'1px solid var(--cyan)', borderRadius:4, padding:'4px 10px', color:'var(--text)', fontFamily:'var(--font-mono)', fontSize:13, width:120 }}
                  value={lockedTotal} onChange={e => { setLockedTotal(e.target.value); updateBudget({ lockedTotal: parseFloat(e.target.value) || 0 }); }}
                  placeholder="0" />
              </div>
              <div><label style={{ fontSize:11, color:'var(--text-mid)', fontFamily:'var(--font-mono)', fontWeight:600, display:'block', marginBottom:3 }}>€/HORA OBJETIVO</label>
                <input className="price-input" type="number" min={0}
                  style={{ background:'var(--bg)', border:'1px solid var(--cyan)', borderRadius:4, padding:'4px 10px', color:'var(--text)', fontFamily:'var(--font-mono)', fontSize:13, width:100 }}
                  value={targetPriceH} onChange={e => { setTargetPriceH(e.target.value); updateBudget({ targetPriceH: parseFloat(e.target.value) || 0 }); }}
                  placeholder="0" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global config */}
      <div className="global-config">
        <div className="field" style={{ margin:0 }}>
          <label>Horas semanales por defecto</label>
          <input type="number" min={1} max={80} value={budget.defaultHoursWeek || 40}
            onChange={e => updateBudget({ defaultHoursWeek: parseFloat(e.target.value) || 40 })}
            className="num-input-sm" />
        </div>
        <div className="field" style={{ margin:0 }}>
          <label>Contingencia global %</label>
          <input type="number" min={0} max={100} value={budget.globalContingency || 0}
            onChange={e => updateBudget({ globalContingency: parseFloat(e.target.value) || 0 })}
            className="num-input-sm" />
        </div>
        <div className="field" style={{ margin:0, flex:1, minWidth:200 }}>
          <label>Descripción del presupuesto</label>
          <input
            value={budget.desc || ''}
            onChange={e => updateBudget({ desc: e.target.value })}
            placeholder="Resumen del proyecto (opcional)"
            style={{ background:'var(--bg)', border:'1px solid var(--border-mid)', borderRadius:4,
              color:'var(--text)', padding:'4px 8px', fontSize:12, fontFamily:'var(--font-body)',
              outline:'none', width:'100%' }}
            onFocus={e => e.target.style.borderColor='var(--cyan)'}
            onBlur={e => e.target.style.borderColor='var(--border-mid)'}
          />
        </div>
      </div>

      {/* Sections */}
      {budget.sections.map(sec => (
        <SectionBlock key={sec.id} section={sec} profiles={profiles} mode={mode}
          derivedMap={derivedMap}
          onUpdateSection={upd => updateSection(sec.id, upd)}
          onDeleteSection={() => deleteSection(sec.id)}
          onDuplicateSection={() => duplicateSection(sec.id)}
          defaultHoursWeek={budget.defaultHoursWeek || 40}
        />
      ))}

      <button className="add-line-btn" style={{ marginTop:8, fontSize:13, padding:'9px 14px' }} onClick={addSection}>
        + Añadir sección
      </button>
    </div>
  );
}

// ─── EXPORT EXCEL ─────────────────────────────────────────────
function exportToExcel(budget, profiles) {
  const wb = XLSX.utils.book_new();
  const b = migrateBudget(budget);
  const derived = calcDerivedTasks(b, profiles);

  // Sheet 1: Tasks
  const rows = [['Sección','Línea','Tarea','Descripción','Perfil','Personas','Asig%','Semanas','h/sem','€/h','h Base','h Ajust.','Importe base','Importe final']];
  b.sections.forEach(sec => {
    sec.lines.forEach(line => {
      (line.tasks||[]).forEach(task => {
        if (task.active === false) return;
        const c = calcTask(task, profiles);
        const d = derived[task.id];
        const p = profiles.find(x => x.id === task.profileId);
        const priceH   = d?.derivedPriceH  != null ? d.derivedPriceH  : c.priceH;
        const baseH    = d?.derivedHours   != null ? d.derivedHours   : c.baseHours;
        const cont     = (task.contingency || 0) / 100;
        const adjH     = baseH * (1 + cont);
        const baseAmt  = baseH * priceH;
        const finalAmt = adjH  * priceH;
        const weeks    = d?.derivedWeeks   != null ? d.derivedWeeks   : (task.weeks || 0);
        rows.push([
          sec.name, line.name||'', task.task||'', task.desc||'', p?.name||task.profileId,
          task.persons||1, task.assignPct||100,
          +weeks.toFixed(2), task.hoursWeek||0,
          +priceH.toFixed(2), +baseH.toFixed(2), +adjH.toFixed(2),
          +baseAmt.toFixed(2), +finalAmt.toFixed(2),
        ]);
      });
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Tareas');

  // Sheet 2: Summary
  const kpis = calcBudget(b, profiles);
  const sum = [
    ['Campo','Valor'],
    ['Nombre', b.name], ['Cliente', b.client||''], ['Descripción', b.desc||''],
    ['Modo', b.mode||'libre'],
    ['Horas base', +kpis.totalBaseH.toFixed(2)],
    ['Horas ajustadas', +kpis.totalAdjH.toFixed(2)],
    ['Presupuesto base', +kpis.totalBase.toFixed(2)],
    ['Presupuesto final', +kpis.totalFinal.toFixed(2)],
    ['€/hora medio', +kpis.avgPrice.toFixed(2)],
    ['Contingencia global %', b.globalContingency||0],
    ['Horas semanales por defecto', b.defaultHoursWeek||40],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'Resumen');

  // Sheet 3: Profiles
  const profRows = [['ID','Nombre','€/hora']];
  profiles.forEach(p => profRows.push([p.id, p.name, p.price]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(profRows), 'Perfiles');

  XLSX.writeFile(wb, `${b.name.replace(/[^a-zA-Z0-9_\-áéíóúÁÉÍÓÚñÑ]/g,'_')}.xlsx`);
}

// ─── HOME ─────────────────────────────────────────────────────
function Home({ budgets, onOpen, onCreate, onDuplicate, onDelete, onImport, onOpenProfiles }) {
  const fileRef = useRef();
  const [searchClient, setSearchClient] = useState('');
  const [searchDesc, setSearchDesc] = useState('');

  const handleImport = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { try { onImport(JSON.parse(ev.target.result)); } catch { alert('Fichero JSON no válido'); } };
    reader.readAsText(file);
    e.target.value = '';
  };

  const filtered = budgets.filter(b => {
    const matchClient = !searchClient || (b.client || '').toLowerCase().includes(searchClient.toLowerCase());
    const matchDesc   = !searchDesc   || (b.name  || '').toLowerCase().includes(searchDesc.toLowerCase());
    return matchClient && matchDesc;
  });

  return (
    <>
      <div className="home-header">
        <div className="home-title">Mis <span>presupuestos</span></div>
        <div className="home-sub">Gestión de estimaciones para proyectos de software</div>
      </div>
      <div className="home-toolbar">
        <button className="btn btn-primary" onClick={onCreate}>+ Nuevo presupuesto</button>
        <button className="btn btn-ghost" onClick={() => fileRef.current.click()}>⬆ Importar JSON</button>
        <input ref={fileRef} type="file" accept=".json" className="import-input" onChange={handleImport} />
        <div style={{ display:'flex', gap:8, marginLeft:'auto', flexWrap:'wrap' }}>
          <div style={{ position:'relative' }}>
            <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', fontSize:13, color:'var(--text-dim)', pointerEvents:'none' }}>🏢</span>
            <input
              style={{ background:'var(--surface)', border:'1px solid var(--border-mid)', borderRadius:'var(--radius-sm)', padding:'6px 10px 6px 28px', fontSize:13, color:'var(--text)', outline:'none', width:180, fontFamily:'var(--font-body)' }}
              placeholder="Buscar por cliente…"
              value={searchClient}
              onChange={e => setSearchClient(e.target.value)}
              onFocus={e => e.target.style.borderColor='var(--cyan)'}
              onBlur={e => e.target.style.borderColor='var(--border-mid)'}
            />
            {searchClient && <button onClick={() => setSearchClient('')} style={{ position:'absolute', right:7, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'var(--text-dim)', fontSize:13, lineHeight:1 }}>✕</button>}
          </div>
          <div style={{ position:'relative' }}>
            <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', fontSize:13, color:'var(--text-dim)', pointerEvents:'none' }}>🔍</span>
            <input
              style={{ background:'var(--surface)', border:'1px solid var(--border-mid)', borderRadius:'var(--radius-sm)', padding:'6px 10px 6px 28px', fontSize:13, color:'var(--text)', outline:'none', width:200, fontFamily:'var(--font-body)' }}
              placeholder="Buscar por proyecto…"
              value={searchDesc}
              onChange={e => setSearchDesc(e.target.value)}
              onFocus={e => e.target.style.borderColor='var(--cyan)'}
              onBlur={e => e.target.style.borderColor='var(--border-mid)'}
            />
            {searchDesc && <button onClick={() => setSearchDesc('')} style={{ position:'absolute', right:7, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'var(--text-dim)', fontSize:13, lineHeight:1 }}>✕</button>}
          </div>
        </div>
      </div>
      {budgets.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📂</div>
          <div className="empty-title">Sin presupuestos todavía</div>
          <div className="empty-sub">Crea tu primer presupuesto para empezar a estimar</div>
          <button className="btn btn-primary" onClick={onCreate}>+ Crear presupuesto</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <div className="empty-title">Sin resultados</div>
          <div className="empty-sub">Prueba a ajustar los filtros de búsqueda</div>
        </div>
      ) : (
        <div className="budget-grid">
          {filtered.map(b => (
            <div key={b.id} className="budget-card" onClick={() => onOpen(b.id)}>
              <div className="budget-card-name">{b.name}</div>
              {b.client && <div className="budget-card-client">{b.client}</div>}
              {b.desc && <div className="budget-card-desc">{b.desc}</div>}
              <div className="budget-card-meta">
                <span className="budget-card-date">{new Date(b.updatedAt || b.createdAt).toLocaleDateString('es-ES')}</span>
                <div className="budget-card-actions" onClick={e => e.stopPropagation()}>
                  <button className="card-btn" title="Duplicar" onClick={() => onDuplicate(b.id)}>⧉</button>
                  <button className="card-btn danger" title="Eliminar" onClick={() => onDelete(b.id)}>✕</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── PROFILE SUMMARY MODAL ───────────────────────────────────
function ProfileSummaryModal({ budget, profiles, derivedMap, onClose }) {
  // Build per-section and global profile hour/amount totals
  const buildTotals = (lines) => {
    const map = {};
    lines.forEach(line => {
      (line.tasks||[]).forEach(task => {
        if (task.active === false) return;
        const d = derivedMap?.[task.id];
        const c = calcTask(task, profiles);
        const priceH  = d?.derivedPriceH != null ? d.derivedPriceH : c.priceH;
        const baseH   = d?.derivedHours  != null ? d.derivedHours  : c.baseHours;
        const cont    = (task.contingency || 0) / 100;
        const adjH    = baseH * (1 + cont);
        const amount  = adjH * priceH;
        const weeks   = d?.derivedWeeks  != null ? d.derivedWeeks  : c.totalWeeks;
        const pid     = task.profileId || '?';
        if (!map[pid]) map[pid] = { baseH: 0, adjH: 0, amount: 0, weeks: 0 };
        map[pid].baseH  += baseH;
        map[pid].adjH   += adjH;
        map[pid].amount += amount;
        map[pid].weeks  += weeks;
      });
    });
    return map;
  };

  const b = migrateBudget(budget);
  const globalLines = b.sections.flatMap(s => s.lines);
  const globalTotals = buildTotals(globalLines);
  const allTasks = globalLines.flatMap(l => (l.tasks||[]).filter(t => t.active !== false));
  const usedProfileIds = [...new Set(allTasks.map(t => t.profileId))];

  const ProfileGrid = ({ totals }) => (
    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
      <thead>
        <tr style={{ background:'var(--surface-2)', borderBottom:'1px solid var(--border)' }}>
          <th style={{ padding:'7px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:10, fontWeight:600, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.5px' }}>Perfil</th>
          <th style={{ padding:'7px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:10, fontWeight:600, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.5px' }}>Semanas</th>
          <th style={{ padding:'7px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:10, fontWeight:600, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.5px' }}>h base</th>
          <th style={{ padding:'7px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:10, fontWeight:600, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.5px' }}>h ajust.</th>
          <th style={{ padding:'7px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:10, fontWeight:600, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.5px' }}>Importe</th>
          <th style={{ padding:'7px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:10, fontWeight:600, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.5px' }}>% s/total</th>
        </tr>
      </thead>
      <tbody>
        {usedProfileIds.filter(pid => totals[pid]?.adjH > 0).map((pid, i, arr) => {
          const p = profiles.find(x => x.id === pid);
          const t = totals[pid];
          const pct = globalAdjH > 0 ? t.adjH / globalAdjH * 100 : 0;
          return (
            <tr key={pid} style={{ borderBottom:'1px solid var(--border)', background: i%2===0 ? 'transparent' : 'var(--surface-2)' }}>
              <td style={{ padding:'8px 12px' }}>
                <ProfileBadge profileId={pid} profiles={profiles} />
              </td>
              <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-mid)' }}>{fmt(t.weeks,1)}</td>
              <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-mid)' }}>{fmtH(t.baseH)}</td>
              <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:12, fontWeight:600, color:'var(--navy)' }}>{fmtH(t.adjH)}</td>
              <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:12, fontWeight:600, color:'var(--navy)' }}>{fmtEur(t.amount)}</td>
              <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-mid)' }}>{fmt(pct,1)} %</td>
            </tr>
          );
        })}
        {/* Total row */}
        <tr style={{ background:'var(--navy)', borderTop:'2px solid var(--border-mid)' }}>
          <td style={{ padding:'8px 12px', fontFamily:'var(--font-display)', fontSize:12, fontWeight:800, color:'#fff' }}>TOTAL</td>
          <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:12, color:'rgba(255,255,255,0.6)' }}>{fmt(usedProfileIds.reduce((s,pid)=>s+(totals[pid]?.weeks||0),0),1)}</td>
          <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:12, color:'rgba(255,255,255,0.6)' }}>{fmtH(usedProfileIds.reduce((s,pid)=>s+(totals[pid]?.baseH||0),0))}</td>
          <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:13, fontWeight:700, color:'var(--cyan)' }}>{fmtH(usedProfileIds.reduce((s,pid)=>s+(totals[pid]?.adjH||0),0))}</td>
          <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:13, fontWeight:700, color:'var(--cyan)' }}>{fmtEur(usedProfileIds.reduce((s,pid)=>s+(totals[pid]?.amount||0),0))}</td>
          <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:12, color:'rgba(255,255,255,0.6)' }}>100 %</td>
        </tr>
      </tbody>
    </table>
  );

  const globalAdjH  = usedProfileIds.reduce((s,pid) => s + (globalTotals[pid]?.adjH  || 0), 0);
  const globalAmt   = usedProfileIds.reduce((s,pid) => s + (globalTotals[pid]?.amount || 0), 0);

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal profile-summary-modal">
        <div className="modal-title">📊 Horas por <span>perfil</span></div>

        {/* Global */}
        <div className="profile-summary-section">
          <div className="profile-summary-section-title">
            Total presupuesto
            <span>{fmtH(globalAdjH)} · {fmtEur(globalAmt)}</span>
          </div>
          <ProfileGrid totals={globalTotals} />
        </div>

        {/* Per section */}
        {b.sections.map(sec => {
          const secTotals = buildTotals(sec.lines);
          const secAdjH   = usedProfileIds.reduce((s,pid) => s + (secTotals[pid]?.adjH  || 0), 0);
          const secAmt    = usedProfileIds.reduce((s,pid) => s + (secTotals[pid]?.amount || 0), 0);
          if (secAdjH === 0) return null;
          return (
            <div key={sec.id} className="profile-summary-section">
              <div className="profile-summary-section-title">
                {sec.name || 'Sin nombre'}
                <span>{fmtH(secAdjH)} · {fmtEur(secAmt)}</span>
              </div>
              <ProfileGrid totals={secTotals} />
            </div>
          );
        })}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

// ─── GANTT HELPERS ────────────────────────────────────────────
const WEEK_W = 36; // px per week column

function barClass(profileId) {
  const known = ['PM','DEV-Front','DEV-Back','DE','DS','DA','IT','Apoyos'];
  return known.includes(profileId) ? `bar-${profileId}` : 'bar-custom';
}

function weekLabel(weekIdx, startDate, useRealDates) {
  if (!useRealDates || !startDate) return `S${weekIdx + 1}`;
  const d = new Date(startDate);
  d.setDate(d.getDate() + weekIdx * 7);
  return `S${weekIdx + 1}`;
}

function weekDate(weekIdx, startDate) {
  if (!startDate) return null;
  const d = new Date(startDate);
  d.setDate(d.getDate() + weekIdx * 7);
  return d;
}

function monthOf(weekIdx, startDate) {
  const d = weekDate(weekIdx, startDate);
  if (!d) return null;
  return d.toLocaleString('es-ES', { month: 'short' });
}

function isMonthStart(weekIdx, startDate) {
  if (!startDate) return false;
  const d = weekDate(weekIdx, startDate);
  const prev = weekDate(weekIdx - 1, startDate);
  return !prev || d.getMonth() !== prev.getMonth();
}

// Get or init gantt data for a line
function getLineGantt(line, totalWeeks) {
  if (line.gantt && line.gantt.length > 0) return line.gantt;
  // Default: one block spanning the full line weeks
  const w = totalWeeks || (line.weeks || 4);
  return [{ id: uid(), start: 0, end: Math.max(1, Math.round(w)) - 1 }];
}

// ─── GANTT VIEW ───────────────────────────────────────────────
function GanttView({ budget, profiles, onUpdate, onBack }) {
  const gKey = (k) => `gantt_${budget.id}_${k}`;

  const [useRealDates, setUseRealDates] = useState(!!budget.ganttStartDate);
  const [startDate, setStartDate]       = useState(budget.ganttStartDate || '');
  const [selectedLine, setSelectedLine] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [dragging, setDragging]         = useState(null);

  // Persisted states
  const [ganttHidden, setGanttHiddenRaw]     = useState(() => load(gKey('hidden'), {}));
  const [expandedLines, setExpandedLinesRaw] = useState(() => load(gKey('expanded'), {}));
  const [showHours, setShowHoursRaw]         = useState(() => load(gKey('showHours'), true));
  const [showWeeks, setShowWeeksRaw]         = useState(() => load(gKey('showWeeks'), true));
  const [showBadges, setShowBadgesRaw]       = useState(() => load(gKey('showBadges'), true));
  const [labelWidth, setLabelWidthRaw]       = useState(() => load(gKey('labelWidth'), 220));

  // Wrappers that also persist
  const setGanttHidden    = (fn) => setGanttHiddenRaw(prev => { const next = typeof fn==='function'?fn(prev):fn; save(gKey('hidden'), next); return next; });
  const setExpandedLines  = (fn) => setExpandedLinesRaw(prev => { const next = typeof fn==='function'?fn(prev):fn; save(gKey('expanded'), next); return next; });
  const setShowHours      = (fn) => setShowHoursRaw(prev => { const next = typeof fn==='function'?fn(prev):fn; save(gKey('showHours'), next); return next; });
  const setShowWeeks      = (fn) => setShowWeeksRaw(prev => { const next = typeof fn==='function'?fn(prev):fn; save(gKey('showWeeks'), next); return next; });
  const setShowBadges     = (fn) => setShowBadgesRaw(prev => { const next = typeof fn==='function'?fn(prev):fn; save(gKey('showBadges'), next); return next; });
  const setLabelWidth     = (v)  => { setLabelWidthRaw(v); save(gKey('labelWidth'), v); };

  const [showVisPanel, setShowVisPanel] = useState(false);

  const toggleExpand = (lineId) => setExpandedLines(h => ({ ...h, [lineId]: !h[lineId] }));
  const toggleHidden = (lineId) => setGanttHidden(h => ({ ...h, [lineId]: !h[lineId] }));

  const [resizing, setResizing] = useState(false);

  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = labelWidth;
    setResizing(true);
    const onMove = (ev) => {
      const w = Math.max(120, Math.min(500, startW + ev.clientX - startX));
      setLabelWidth(w);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [labelWidth]);
  const MIN_WEEK_W = 32;
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(800); // sensible default avoids zero

  // Measure container on mount and resize
  useEffect(() => {
    if (!containerRef.current) return;
    // Read immediately on mount
    setContainerWidth(containerRef.current.getBoundingClientRect().width || 800);
    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const b = migrateBudget(budget);

  // Only count visible lines for column range
  const visibleLines = b.sections.flatMap(s => s.lines.filter(l => !ganttHidden[l.id]));
  const maxWeek = visibleLines.length > 0
    ? Math.max(...visibleLines.map(l => {
        const gantt = getLineGantt(l, calcLine(l, profiles).totalWeeks);
        return Math.max(...gantt.map(blk => blk.end + 1));
      }))
    : 12;
  const totalCols = maxWeek + 1;

  // WEEK_W: fill available width, minimum MIN_WEEK_W
  const LABEL_W    = labelWidth;
  const availableW = containerWidth - LABEL_W;
  const WEEK_W = availableW > 0 && totalCols > 0
    ? Math.max(MIN_WEEK_W, Math.floor(availableW / totalCols))
    : MIN_WEEK_W;

  const weeks = Array.from({ length: totalCols }, (_, i) => i);

  const saveStartDate = (val) => {
    setStartDate(val);
    onUpdate({ ...budget, ganttStartDate: val, updatedAt: Date.now() });
  };

  // Get/init gantt for a task — defaults to span of the parent line's first block
  const getTaskGantt = (task, lineGantt) => {
    if (task.gantt && task.gantt.length > 0) return task.gantt;
    // Default: same span as the line's first block
    const lineStart = Math.min(...lineGantt.map(b => b.start));
    const lineEnd   = Math.max(...lineGantt.map(b => b.end));
    return [{ id: uid(), start: lineStart, end: lineEnd }];
  };

  // Clamp a task block to stay within any line block range
  const clampToLine = (taskStart, taskEnd, lineGantt) => {
    const lineStart = Math.min(...lineGantt.map(b => b.start));
    const lineEnd   = Math.max(...lineGantt.map(b => b.end));
    const len = taskEnd - taskStart;
    let s = Math.max(lineStart, Math.min(taskStart, lineEnd - len));
    let e = s + len;
    if (e > lineEnd) { e = lineEnd; s = Math.max(lineStart, e - len); }
    return { start: s, end: e };
  };

  const updateLineGantt = (secId, lineId, gantt) => {
    const sections = b.sections.map(s => s.id !== secId ? s : {
      ...s, lines: s.lines.map(l => l.id !== lineId ? l : { ...l, gantt })
    });
    onUpdate({ ...budget, sections, updatedAt: Date.now() });
  };

  const updateTaskGantt = (secId, lineId, taskId, gantt) => {
    const sections = b.sections.map(s => s.id !== secId ? s : {
      ...s, lines: s.lines.map(l => l.id !== lineId ? l : {
        ...l, tasks: (l.tasks||[]).map(t => t.id !== taskId ? t : { ...t, gantt })
      })
    });
    onUpdate({ ...budget, sections, updatedAt: Date.now() });
  };

  // Drag — supports both line blocks (taskId=null) and task blocks (taskId set)
  const handleMouseDown = (e, secId, lineId, blockIdx, type, taskId=null) => {
    e.preventDefault();
    e.stopPropagation();
    const line = b.sections.find(s=>s.id===secId).lines.find(l=>l.id===lineId);
    const lineGantt = getLineGantt(line, calcLine(line, profiles).totalWeeks);
    let gantt;
    if (taskId) {
      const task = (line.tasks||[]).find(t=>t.id===taskId);
      gantt = getTaskGantt(task, lineGantt);
    } else {
      gantt = lineGantt;
    }
    const block = gantt[blockIdx];
    setDragging({ secId, lineId, taskId, blockIdx, type, startX: e.clientX, origStart: block.start, origEnd: block.end });
    setSelectedLine({ secId, lineId });
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const dw = Math.round((e.clientX - dragging.startX) / WEEK_W);
      const line = b.sections.find(s=>s.id===dragging.secId).lines.find(l=>l.id===dragging.lineId);
      const lineGantt = getLineGantt(line, calcLine(line, profiles).totalWeeks);

      if (dragging.taskId) {
        // Task drag — clamped to line bounds
        const task = (line.tasks||[]).find(t=>t.id===dragging.taskId);
        const gantt = getTaskGantt(task, lineGantt).map(blk=>({...blk}));
        const blk = gantt[dragging.blockIdx];
        if (dragging.type === 'bar') {
          const len = dragging.origEnd - dragging.origStart;
          const clamped = clampToLine(dragging.origStart + dw, dragging.origStart + dw + len, lineGantt);
          blk.start = clamped.start; blk.end = clamped.end;
        } else if (dragging.type === 'left') {
          const lineStart = Math.min(...lineGantt.map(b=>b.start));
          blk.start = Math.max(lineStart, Math.min(dragging.origStart + dw, blk.end));
        } else {
          const lineEnd = Math.max(...lineGantt.map(b=>b.end));
          blk.end = Math.min(lineEnd, Math.max(blk.start, dragging.origEnd + dw));
        }
        updateTaskGantt(dragging.secId, dragging.lineId, dragging.taskId, gantt);
      } else {
        // Line drag — free movement
        const gantt = lineGantt.map(blk=>({...blk}));
        const blk = gantt[dragging.blockIdx];
        if (dragging.type === 'bar') {
          const len = dragging.origEnd - dragging.origStart;
          blk.start = Math.max(0, dragging.origStart + dw);
          blk.end   = blk.start + len;
        } else if (dragging.type === 'left') {
          blk.start = Math.max(0, Math.min(dragging.origStart + dw, blk.end));
        } else {
          blk.end = Math.max(blk.start, dragging.origEnd + dw);
        }
        updateLineGantt(dragging.secId, dragging.lineId, gantt);
      }
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging, budget]);

  // Week label helpers
  const fmtWkHeader = (i) => {
    if (useRealDates && startDate) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i * 7);
      return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}`;
    }
    return `S${i+1}`;
  };
  const isMStart = (i) => {
    if (!useRealDates || !startDate) return false;
    const d = new Date(startDate); d.setDate(d.getDate() + i*7);
    const p = new Date(startDate); p.setDate(p.getDate() + (i-1)*7);
    return i===0 || d.getMonth() !== p.getMonth();
  };
  const monthName = (i) => {
    const d = new Date(startDate); d.setDate(d.getDate() + i*7);
    return d.toLocaleString('es-ES',{month:'short'});
  };

  const GridLines = () => (
    <div className="gantt-gridlines">
      {weeks.map(i => <div key={i} className={`gantt-gridline ${isMStart(i)?'month-start':''}`} style={{width:WEEK_W}} />)}
    </div>
  );

  // Today marker
  const TodayLine = () => {
    if (!useRealDates || !startDate) return null;
    const diff = (new Date() - new Date(startDate)) / (1000*60*60*24*7);
    if (diff < 0 || diff > totalCols) return null;
    return <div className="gantt-today-line" style={{left: diff*WEEK_W}} />;
  };

  // Selected line data for panel
  const selSec   = selectedLine ? b.sections.find(s=>s.id===selectedLine.secId) : null;
  const selLine  = selSec ? selSec.lines.find(l=>l.id===selectedLine.lineId) : null;
  const selCalc  = selLine ? calcLine(selLine, profiles) : null;
  const selGantt = selLine ? getLineGantt(selLine, selCalc.totalWeeks) : [];

  // Task panel
  const selTaskSec  = selectedTask ? b.sections.find(s=>s.id===selectedTask.secId) : null;
  const selTaskLine = selTaskSec ? selTaskSec.lines.find(l=>l.id===selectedTask.lineId) : null;
  const selTaskObj  = selTaskLine ? (selTaskLine.tasks||[]).find(t=>t.id===selectedTask.taskId) : null;
  const selTaskLineGantt = selTaskLine ? getLineGantt(selTaskLine, calcLine(selTaskLine,profiles).totalWeeks) : [];
  const selTaskGantt = selTaskObj ? getTaskGantt(selTaskObj, selTaskLineGantt) : [];
  const selTaskLineStart = selTaskLineGantt.length ? Math.min(...selTaskLineGantt.map(b=>b.start)) : 0;
  const selTaskLineEnd   = selTaskLineGantt.length ? Math.max(...selTaskLineGantt.map(b=>b.end))   : 0;

  const updateSelGantt = (g) => updateLineGantt(selectedLine.secId, selectedLine.lineId, g);
  const addBlock  = () => { const last=selGantt[selGantt.length-1]; updateSelGantt([...selGantt,{id:uid(),start:(last?.end??0)+2,end:(last?.end??0)+3}]); };
  const delBlock  = (i) => { if(selGantt.length<=1)return; updateSelGantt(selGantt.filter((_,idx)=>idx!==i)); };
  const setBlock  = (i,field,raw) => {
    const v = Math.max(0, parseInt(raw)||0);
    updateSelGantt(selGantt.map((b,idx)=>idx!==i?b:{
      ...b,
      start: field==='start' ? Math.min(v, b.end) : b.start,
      end:   field==='end'   ? Math.max(v, b.start) : b.end,
    }));
  };

  const updateSelTaskGantt = (g) => updateTaskGantt(selectedTask.secId, selectedTask.lineId, selectedTask.taskId, g);
  const addTaskBlock  = () => { const last=selTaskGantt[selTaskGantt.length-1]; updateSelTaskGantt([...selTaskGantt,{id:uid(),start:Math.min((last?.end??selTaskLineStart)+2,selTaskLineEnd),end:selTaskLineEnd}]); };
  const delTaskBlock  = (i) => { if(selTaskGantt.length<=1)return; updateSelTaskGantt(selTaskGantt.filter((_,idx)=>idx!==i)); };
  const setTaskBlock  = (i,field,raw) => {
    const v = Math.max(selTaskLineStart, Math.min(parseInt(raw)||0, selTaskLineEnd));
    updateSelTaskGantt(selTaskGantt.map((b,idx)=>idx!==i?b:{
      ...b,
      start: field==='start' ? Math.min(v, b.end) : b.start,
      end:   field==='end'   ? Math.max(v, b.start) : b.end,
    }));
  };

  const fmtDateRange = (b) => {
    if (!useRealDates || !startDate) return `${b.end-b.start+1} sem`;
    const ds = new Date(startDate); ds.setDate(ds.getDate()+b.start*7);
    const de = new Date(startDate); de.setDate(de.getDate()+b.end*7+6);
    const fmt2 = d => `${d.getDate()}/${d.getMonth()+1}`;
    return `${b.end-b.start+1} sem · ${fmt2(ds)}–${fmt2(de)}`;
  };

  return (
    <div className="gantt-wrap">
      {/* Toolbar */}
      <div className="gantt-toolbar">
        <button className="back-btn" onClick={onBack}>← Presupuesto</button>
        <div style={{fontFamily:'var(--font-display)',fontSize:15,fontWeight:800,color:'var(--navy)'}}>
          Planificación · <span style={{color:'var(--cyan)'}}>{budget.name}</span>
        </div>
        <div className="gantt-toolbar-right">
          <div className="gantt-toggle">
            <button className={!useRealDates?'active':''} onClick={()=>setUseRealDates(false)}>Semanas relativas</button>
            <button className={useRealDates?'active':''}  onClick={()=>setUseRealDates(true)}>Fechas reales</button>
          </div>
          {useRealDates && (
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <label style={{fontSize:11,fontFamily:'var(--font-mono)',color:'var(--text-dim)'}}>Inicio:</label>
              <input type="date" className="gantt-date-input" value={startDate} onChange={e=>saveStartDate(e.target.value)} />
            </div>
          )}
        </div>
      </div>

      {/* View options */}
      <div style={{display:'flex',gap:6,marginBottom:8,alignItems:'center'}}>
        <span style={{fontSize:11,fontFamily:'var(--font-mono)',color:'var(--text-dim)',marginRight:4}}>Mostrar:</span>
        <button
          className="btn btn-ghost btn-sm"
          style={{fontSize:11, background: showBadges ? 'var(--cyan-pale)' : 'transparent', borderColor: showBadges ? 'var(--cyan)' : 'var(--border-mid)', color: showBadges ? 'var(--cyan-dim)' : 'var(--text-dim)'}}
          onClick={()=>setShowBadges(v=>!v)}
        >
          {showBadges ? '✓' : '○'} Perfil
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{fontSize:11, background: showWeeks ? 'var(--cyan-pale)' : 'transparent', borderColor: showWeeks ? 'var(--cyan)' : 'var(--border-mid)', color: showWeeks ? 'var(--cyan-dim)' : 'var(--text-dim)'}}
          onClick={()=>setShowWeeks(v=>!v)}
        >
          {showWeeks ? '✓' : '○'} Semanas
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{fontSize:11, background: showHours ? 'var(--cyan-pale)' : 'transparent', borderColor: showHours ? 'var(--cyan)' : 'var(--border-mid)', color: showHours ? 'var(--cyan-dim)' : 'var(--text-dim)'}}
          onClick={()=>setShowHours(v=>!v)}
        >
          {showHours ? '✓' : '○'} Horas
        </button>
        <div style={{width:1, background:'var(--border)', margin:'0 4px'}} />
        <button
          className="btn btn-ghost btn-sm"
          style={{fontSize:11,
            background: showVisPanel ? 'var(--cyan-pale)' : 'transparent',
            borderColor: showVisPanel ? 'var(--cyan)' : 'var(--border-mid)',
            color: showVisPanel ? 'var(--cyan-dim)' : 'var(--text-dim)'}}
          onClick={()=>setShowVisPanel(v=>!v)}
        >
          👁 Visibilidad {Object.values(ganttHidden).filter(Boolean).length > 0 && `(${Object.values(ganttHidden).filter(Boolean).length} ocultas)`}
        </button>
      </div>

      {/* Visibility panel */}
      {showVisPanel && (
        <div style={{
          background:'var(--surface)', border:'1px solid var(--border)',
          borderRadius:'var(--radius)', padding:'14px 16px', marginBottom:12,
          boxShadow:'var(--shadow-sm)'
        }}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
            <span style={{fontFamily:'var(--font-display)',fontSize:13,fontWeight:800,color:'var(--navy)'}}>
              Visibilidad de líneas
            </span>
            <div style={{display:'flex',gap:6}}>
              <button className="btn btn-ghost btn-sm" style={{fontSize:11}}
                onClick={()=>setGanttHidden({})}>Mostrar todas</button>
              <button className="btn btn-ghost btn-sm" style={{fontSize:11}}
                onClick={()=>{
                  const all = {};
                  b.sections.forEach(s=>s.lines.forEach(l=>{all[l.id]=true;}));
                  setGanttHidden(all);
                }}>Ocultar todas</button>
            </div>
          </div>
          {b.sections.map(sec => {
            if (!sec.lines.length) return null;
            return (
              <div key={sec.id} style={{marginBottom:10}}>
                <div style={{fontSize:10,fontFamily:'var(--font-mono)',fontWeight:700,
                  color:'var(--text-dim)',textTransform:'uppercase',letterSpacing:'0.5px',
                  marginBottom:6,display:'flex',alignItems:'center',gap:6}}>
                  <span style={{width:3,height:12,background:'var(--cyan)',borderRadius:2,display:'inline-block'}}/>
                  {sec.name||'Sección'}
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  {sec.lines.map(line => {
                    const hidden = !!ganttHidden[line.id];
                    // Collect profile badges from tasks
                    const taskProfiles = [...new Set((line.tasks||[]).map(t=>t.profileId).filter(Boolean))];
                    return (
                      <label key={line.id} style={{
                        display:'flex',alignItems:'center',gap:8,
                        padding:'5px 8px',borderRadius:5,cursor:'pointer',
                        background: hidden ? 'var(--surface-2)' : 'transparent',
                        transition:'background 0.1s'
                      }}>
                        <input type="checkbox" checked={!hidden}
                          onChange={()=>toggleHidden(line.id)}
                          style={{accentColor:'var(--cyan)',width:14,height:14,cursor:'pointer'}} />
                        <span style={{fontSize:12,fontWeight:600,color: hidden ? 'var(--text-dim)' : 'var(--navy)',flex:1}}>
                          {line.name||'—'}
                        </span>
                        <span style={{display:'flex',gap:3,flexWrap:'wrap'}}>
                          {taskProfiles.map(pid=><ProfileBadge key={pid} profileId={pid} profiles={profiles} />)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Single-scroll Gantt */}
      <div className="gantt-scroll-outer" ref={containerRef}>
        <div className="gantt-inner">

          {/* ── Header row ── */}
          <div className="gantt-row is-header">
            <div className="gantt-label-cell" style={{width:labelWidth, minWidth:labelWidth, position:'relative'}}>
              Desarrollo
              <div
                className={`gantt-label-resize ${resizing?'resizing':''}`}
                onMouseDown={handleResizeStart}
                title="Arrastrar para redimensionar"
              />
            </div>
            <div className="gantt-grid-cell">
              {weeks.map(i => (
                <div key={i} className={`gantt-week-cell ${isMStart(i)?'month-start':''}`} style={{width:WEEK_W}}>
                  {isMStart(i) && <span className="wk-month">{monthName(i)}</span>}
                  <span>{fmtWkHeader(i)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Data rows ── */}
          {b.sections.map(sec => (
            <React.Fragment key={sec.id}>

              {/* Section row */}
              <div className="gantt-row is-section">
                <div className="gantt-label-cell" style={{width:labelWidth,minWidth:labelWidth}}>{sec.name||'Sección'}</div>
                <div className="gantt-grid-cell">
                  <GridLines />
                </div>
              </div>

              {/* Line rows */}
              {sec.lines.map(line => {
                const c         = calcLine(line, profiles);
                const lineGantt = getLineGantt(line, c.totalWeeks);
                const isSel     = selectedLine?.lineId === line.id;
                const isHidden  = !!ganttHidden[line.id];
                const isExpanded = !!expandedLines[line.id];
                const activeTasks = (line.tasks||[]).filter(t => t.active !== false);
                const taskProfiles = [...new Set(activeTasks.map(t=>t.profileId).filter(Boolean))];
                // Line span for constraint indicator
                const lineStart = Math.min(...lineGantt.map(b=>b.start));
                const lineEnd   = Math.max(...lineGantt.map(b=>b.end));

                return (
                  <div key={line.id} className={`gantt-row is-line ${isSel?'selected':''} ${isHidden?'gantt-row-hidden':''}`}>
                    {/* Frozen label */}
                    <div className="gantt-label-cell" style={{width:labelWidth,minWidth:labelWidth}}>
                      {/* Line name row with expand toggle */}
                      <div style={{display:'flex',alignItems:'center',gap:4,padding:'6px 0 2px',cursor:'pointer'}}
                        onClick={() => setSelectedLine(isSel ? null : {secId:sec.id,lineId:line.id})}>
                        {activeTasks.length > 0 && (
                          <button
                            style={{background:'none',border:'none',cursor:'pointer',padding:'0 2px',fontSize:10,
                              color:'var(--cyan-dim)',lineHeight:1,flexShrink:0,
                              transition:'transform 0.15s',transform:isExpanded?'rotate(90deg)':'rotate(0deg)'}}
                            onClick={e=>{e.stopPropagation();toggleExpand(line.id);}}
                            title={isExpanded?'Colapsar tareas':'Expandir tareas'}
                          >▶</button>
                        )}
                        <span className="gantt-line-name">{line.name||'—'}</span>
                        {(showBadges || showWeeks || showHours) && (
                          <span className="gantt-line-meta" style={{marginLeft:2}}>
                            {showBadges && taskProfiles.map(pid=><ProfileBadge key={pid} profileId={pid} profiles={profiles} />)}
                            {showBadges && (showWeeks||showHours) && ' '}
                            {showWeeks && `${fmt(c.totalWeeks,1)} sem`}
                            {showWeeks && showHours && ' · '}
                            {showHours && fmtH(c.baseHours)}
                          </span>
                        )}
                      </div>
                      {/* Task sub-labels when expanded */}
                      {isExpanded && activeTasks.map(task => (
                        <div key={task.id} className="gantt-task-label">
                          <span className="task-name">{task.task||'—'}</span>
                          {showBadges && <ProfileBadge profileId={task.profileId} profiles={profiles} />}
                          {showHours && <span style={{color:'var(--text-dim)',fontSize:9,marginLeft:2}}>{fmtH(calcTask(task,profiles).baseHours)}</span>}
                        </div>
                      ))}
                      {isExpanded && <div style={{height:4}} />}
                    </div>

                    {/* Grid + bars */}
                    <div className="gantt-grid-cell" style={{position:'relative'}}>
                      <GridLines />
                      <div className="gantt-bars-multi">
                        {/* Line track */}
                        <div className="gantt-bar-track is-line-track" style={{position:'relative'}}>
                          <TodayLine />
                          {lineGantt.map((block, bi) => {
                            const left  = block.start * WEEK_W;
                            const width = Math.max(WEEK_W, (block.end - block.start + 1) * WEEK_W);
                            return (
                              <div key={block.id||bi}
                                className={`gantt-bar ${isSel?'selected':''}`}
                                style={{left, width, top:'15%', bottom:'15%', height:'70%',
                                  position:'absolute',
                                  background: isSel ? 'var(--navy)' : 'var(--cyan)'}}
                                onMouseDown={e=>handleMouseDown(e,sec.id,line.id,bi,'bar',null)}
                              >
                                <div className="gantt-handle gantt-handle-left"
                                  onMouseDown={e=>{e.stopPropagation();handleMouseDown(e,sec.id,line.id,bi,'left',null);}} />
                                <div className="gantt-handle gantt-handle-right"
                                  onMouseDown={e=>{e.stopPropagation();handleMouseDown(e,sec.id,line.id,bi,'right',null);}} />
                              </div>
                            );
                          })}
                        </div>
                        {isExpanded && activeTasks.map(task => {
                          const tGantt = getTaskGantt(task, lineGantt);
                          const isTaskSel = selectedTask?.taskId === task.id;
                          return (
                            <div key={task.id} className="gantt-bar-track is-task-track" style={{position:'relative'}}>
                              {/* Line bound indicator */}
                              <div style={{
                                position:'absolute',
                                left: lineStart * WEEK_W, width: (lineEnd - lineStart + 1) * WEEK_W,
                                top:'20%', bottom:'20%', height:'60%', borderRadius:3,
                                background:'var(--border)', opacity:0.6, pointerEvents:'none',
                              }} />
                              {tGantt.map((block, bi) => {
                                const left  = block.start * WEEK_W;
                                const width = Math.max(WEEK_W, (block.end - block.start + 1) * WEEK_W);
                                return (
                                  <div key={bi}
                                    className={`gantt-bar ${isTaskSel?'selected':''}`}
                                    style={{left, width, top:'15%', bottom:'15%', height:'70%',
                                      position:'absolute',
                                      background: isTaskSel ? 'var(--cyan-dim)' : 'var(--navy)',
                                      opacity: isTaskSel ? 1 : 0.65, cursor:'grab'}}
                                    onMouseDown={e=>{
                                      handleMouseDown(e,sec.id,line.id,bi,'bar',task.id);
                                      setSelectedTask({secId:sec.id,lineId:line.id,taskId:task.id});
                                      setSelectedLine(null);
                                    }}
                                  >
                                    <div className="gantt-handle gantt-handle-left"
                                      onMouseDown={e=>{e.stopPropagation();handleMouseDown(e,sec.id,line.id,bi,'left',task.id);setSelectedTask({secId:sec.id,lineId:line.id,taskId:task.id});setSelectedLine(null);}} />
                                    <div className="gantt-handle gantt-handle-right"
                                      onMouseDown={e=>{e.stopPropagation();handleMouseDown(e,sec.id,line.id,bi,'right',task.id);setSelectedTask({secId:sec.id,lineId:line.id,taskId:task.id});setSelectedLine(null);}} />
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                        {isExpanded && <div style={{height:4}} />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </React.Fragment>
          ))}

        </div>
      </div>

      {/* Line edit panel */}
      {selectedLine && selLine && (
        <div className="gantt-panel">
          <div className="gantt-panel-title">
            <span>
              ✏️ <strong>{selLine.name||'Línea sin nombre'}</strong>
              <span style={{fontFamily:'var(--font-mono)',fontSize:11,color:'var(--text-dim)',fontWeight:400,marginLeft:10}}>
                {fmt(selCalc.totalWeeks,1)} sem · {fmtH(selCalc.baseHours)}
              </span>
            </span>
            <button className="card-btn" onClick={()=>setSelectedLine(null)}>✕</button>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'70px 90px 110px 1fr auto',gap:8,marginBottom:4}}>
            <span className="gantt-block-label">Bloque</span>
            <span className="gantt-block-label">Sem. inicio</span>
            <span className="gantt-block-label">Sem. fin</span>
            <span className="gantt-block-label">Duración</span>
            <span />
          </div>
          {selGantt.map((blk,i) => {
            const totalBudgetWeeks = Math.round(selCalc.totalWeeks) || 1;
            const usedByOthers = selGantt.reduce((s,bl,idx) => idx===i ? s : s + (bl.end - bl.start + 1), 0);
            const autoEnd = blk.start + (totalBudgetWeeks - usedByOthers) - 1;
            return (
              <div key={blk.id||i} className="gantt-block-row" style={{gridTemplateColumns:'70px 90px 110px 1fr auto'}}>
                <span style={{fontFamily:'var(--font-mono)',fontSize:12,fontWeight:700,color:'var(--navy)'}}>B{i+1}</span>
                <input className="num-input-sm" type="number" min={1} value={blk.start+1}
                  onChange={e=>setBlock(i,'start',(parseInt(e.target.value)||1)-1)} />
                <div style={{display:'flex',gap:4,alignItems:'center'}}>
                  <input className="num-input-sm" style={{width:60}} type="number" min={blk.start+1} value={blk.end+1}
                    onChange={e=>setBlock(i,'end',(parseInt(e.target.value)||1)-1)} />
                  <button title={`Completar hasta sem. ${autoEnd+1}`} className="card-btn" style={{fontSize:13,flexShrink:0}}
                    onClick={() => setBlock(i,'end', Math.max(blk.start, autoEnd))}>⇥</button>
                </div>
                <span style={{fontFamily:'var(--font-mono)',fontSize:11,color:'var(--text-dim)'}}>{fmtDateRange(blk)}</span>
                <button className="card-btn danger" disabled={selGantt.length<=1} onClick={()=>delBlock(i)}>✕</button>
              </div>
            );
          })}
          <button className="add-line-btn" style={{marginTop:6}} onClick={addBlock}>+ Añadir bloque</button>
          <p style={{marginTop:8,fontSize:11,color:'var(--text-dim)',fontFamily:'var(--font-mono)'}}>
            💡 Arrastra las barras o sus extremos en el Gantt · Los bloques son visuales y no afectan al presupuesto
          </p>
        </div>
      )}

      {/* Task edit panel */}
      {selectedTask && selTaskObj && (
        <div className="gantt-panel" style={{marginTop:selectedLine?8:12}}>
          <div className="gantt-panel-title">
            <span>
              ✏️ Tarea: <strong>{selTaskObj.task||'—'}</strong>
              <span style={{fontFamily:'var(--font-mono)',fontSize:11,color:'var(--text-dim)',fontWeight:400,marginLeft:10}}>
                <ProfileBadge profileId={selTaskObj.profileId} profiles={profiles} />
                {' '}límite S{selTaskLineStart+1}–S{selTaskLineEnd+1}
              </span>
            </span>
            <button className="card-btn" onClick={()=>setSelectedTask(null)}>✕</button>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'70px 90px 110px 1fr auto',gap:8,marginBottom:4}}>
            <span className="gantt-block-label">Bloque</span>
            <span className="gantt-block-label">Sem. inicio</span>
            <span className="gantt-block-label">Sem. fin</span>
            <span className="gantt-block-label">Duración</span>
            <span />
          </div>
          {selTaskGantt.map((blk,i) => (
            <div key={blk.id||i} className="gantt-block-row" style={{gridTemplateColumns:'70px 90px 110px 1fr auto'}}>
              <span style={{fontFamily:'var(--font-mono)',fontSize:12,fontWeight:700,color:'var(--navy)'}}>B{i+1}</span>
              <input className="num-input-sm" type="number" min={selTaskLineStart+1} max={selTaskLineEnd+1} value={blk.start+1}
                onChange={e=>setTaskBlock(i,'start',(parseInt(e.target.value)||1)-1)} />
              <div style={{display:'flex',gap:4,alignItems:'center'}}>
                <input className="num-input-sm" style={{width:60}} type="number" min={blk.start+1} max={selTaskLineEnd+1} value={blk.end+1}
                  onChange={e=>setTaskBlock(i,'end',(parseInt(e.target.value)||1)-1)} />
                <button title="Completar hasta el fin de la línea" className="card-btn" style={{fontSize:13,flexShrink:0}}
                  onClick={() => setTaskBlock(i,'end', selTaskLineEnd)}>⇥</button>
              </div>
              <span style={{fontFamily:'var(--font-mono)',fontSize:11,color:'var(--text-dim)'}}>{fmtDateRange(blk)}</span>
              <button className="card-btn danger" disabled={selTaskGantt.length<=1} onClick={()=>delTaskBlock(i)}>✕</button>
            </div>
          ))}
          <button className="add-line-btn" style={{marginTop:6}} onClick={addTaskBlock}>+ Añadir bloque</button>
        </div>
      )}
    </div>
  );
}

// ─── SAVE BUTTON ─────────────────────────────────────────────
function SaveButton({ budget }) {
  const [state, setState] = useState('idle'); // idle | saving | saved
  const handleSave = () => {
    setState('saving');
    setTimeout(() => {
      // Data already auto-saved; this is a manual confirmation
      try { localStorage.setItem('presupuestador_budgets', JSON.stringify(
        JSON.parse(localStorage.getItem('presupuestador_budgets') || '[]')
      )); } catch {}
      setState('saved');
      setTimeout(() => setState('idle'), 2000);
    }, 350);
  };
  return (
    <button
      className={`btn btn-save btn-sm ${state === 'saved' ? 'saved' : ''}`}
      onClick={handleSave}
      disabled={state === 'saving'}
    >
      {state === 'saving' ? '…' : state === 'saved' ? '✓ Guardado' : '💾 Guardar'}
    </button>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────
function App() {
  const [budgets, setBudgets] = useState(() => load('presupuestador_budgets', []));
  const [profiles, setProfiles] = useState(() => {
    const saved = load('presupuestador_profiles', null);
    if (!saved) return DEFAULT_PROFILES;
    return DEFAULT_PROFILES.map(d => ({ ...d, price: saved.find(s => s.id === d.id)?.price ?? d.price }))
      .concat((saved || []).filter(s => !s.fixed));
  });
  const [activeBudgetId, setActiveBudgetId] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showGantt, setShowGantt] = useState(false);
  const [toast, setToast] = useState(null);

  const activeBudget = budgets.find(b => b.id === activeBudgetId);

  useEffect(() => { save('presupuestador_budgets', budgets); }, [budgets]);
  useEffect(() => { save('presupuestador_profiles', profiles); }, [profiles]);

  const showToast = (msg, type='success') => setToast({ msg, type });

  const createBudget = ({ name, client, desc }) => {
    const b = { id: uid(), name, client, desc, createdAt: Date.now(), updatedAt: Date.now(),
      sections: [], mode: 'libre', defaultHoursWeek: 40, globalContingency: 0 };
    setBudgets(prev => [...prev, b]);
    setShowNewModal(false);
    setActiveBudgetId(b.id);
    showToast('Presupuesto creado');
  };
  const updateBudget = (updated) => {
    setBudgets(prev => prev.map(b => b.id === updated.id ? updated : b));
  };
  const duplicateBudget = (id) => {
    const orig = budgets.find(b => b.id === id);
    const clone = { ...orig, id: uid(), name: orig.name + ' (copia)', createdAt: Date.now(), updatedAt: Date.now(),
      sections: orig.sections.map(s => ({ ...s, id: uid(), lines: s.lines.map(l => ({ ...l, id: uid() })) })) };
    setBudgets(prev => [...prev, clone]);
    showToast('Presupuesto duplicado');
  };
  const deleteBudget = (id) => {
    if (!confirm('¿Eliminar este presupuesto? Esta acción no se puede deshacer.')) return;
    setBudgets(prev => prev.filter(b => b.id !== id));
    if (activeBudgetId === id) setActiveBudgetId(null);
    showToast('Presupuesto eliminado', 'error');
  };
  const exportBudget = (id) => {
    const b = budgets.find(x => x.id === id);
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${b.name.replace(/\s+/g,'_')}.json`; a.click();
    showToast('Exportado como JSON');
  };
  const importBudget = (data) => {
    const existing = budgets.find(b => b.name === data.name);
    let finalData = { ...data, id: uid(), updatedAt: Date.now() };
    if (existing) {
      const choice = confirm(`Ya existe un presupuesto llamado "${data.name}".\nAceptar = Sobrescribir\nCancelar = Añadir como copia`);
      if (choice) {
        setBudgets(prev => prev.map(b => b.name === data.name ? finalData : b));
      } else {
        finalData = { ...finalData, name: data.name + ' (importado)' };
        setBudgets(prev => [...prev, finalData]);
      }
    } else {
      setBudgets(prev => [...prev, finalData]);
    }
    showToast('Presupuesto importado');
  };

  return (
    <div className="app">
      {/* TOPBAR */}
      <header className="topbar">
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div className="topbar-brand" style={{ cursor: activeBudget ? 'pointer' : 'default', flexShrink:0 }}
            onClick={() => activeBudget && setActiveBudgetId(null)}>
            <div className="topbar-logo">P</div>
            {!activeBudget && <>Presupuestador <span>·</span></>}
          </div>
          {activeBudget && (
            <div className="topbar-meta">
              <input
                className="topbar-field"
                value={activeBudget.name}
                placeholder="Nombre del presupuesto"
                onChange={e => updateBudget({ ...activeBudget, name: e.target.value, updatedAt: Date.now() })}
              />
              <input
                className="topbar-field topbar-field-client"
                value={activeBudget.client || ''}
                placeholder="Cliente"
                onChange={e => updateBudget({ ...activeBudget, client: e.target.value, updatedAt: Date.now() })}
              />
            </div>
          )}
        </div>
        <div className="topbar-actions">
          {activeBudget && <>
            <SaveButton budget={activeBudget} />
            <button className="btn btn-ghost-dark btn-sm" onClick={() => { setShowGantt(false); setShowSummary(true); }}>📊 Resumen</button>
            <button className="btn btn-ghost-dark btn-sm" onClick={() => { setShowSummary(false); setShowGantt(g => !g); }}>📅 {showGantt ? 'Presupuesto' : 'Planificación'}</button>
            <button className="btn btn-ghost-dark btn-sm" onClick={() => exportBudget(activeBudget.id)}>⬇ JSON</button>
            <button className="btn btn-ghost-dark btn-sm" onClick={() => exportToExcel(activeBudget, profiles)}>📊 Excel</button>
          </>}
          <button className="btn btn-ghost-dark btn-sm" onClick={() => setShowProfiles(true)}>⚙ Perfiles</button>
        </div>
      </header>

      {/* MAIN */}
      <main className="main">
        {activeBudget
          ? showGantt
            ? <GanttView budget={activeBudget} profiles={profiles} onUpdate={updateBudget} onBack={() => setShowGantt(false)} />
            : <BudgetView budget={activeBudget} profiles={profiles} onUpdate={updateBudget} onBack={() => { setActiveBudgetId(null); setShowGantt(false); }} />
          : <Home budgets={budgets}
              onOpen={id => { setActiveBudgetId(id); setShowGantt(false); }}
              onCreate={() => setShowNewModal(true)}
              onDuplicate={duplicateBudget}
              onDelete={deleteBudget}
              onImport={importBudget}
              onOpenProfiles={() => setShowProfiles(true)}
            />
        }
      </main>

      {/* MODALS */}
      {showNewModal && <BudgetModal onClose={() => setShowNewModal(false)} onSave={createBudget} />}
      {showProfiles && (
        <ProfilesModal profiles={profiles} onClose={() => setShowProfiles(false)}
          onSave={p => { setProfiles(p); setShowProfiles(false); showToast('Perfiles guardados'); }} />
      )}
      {showSummary && activeBudget && (
        <ProfileSummaryModal
          budget={activeBudget}
          profiles={profiles}
          derivedMap={calcDerivedLines(activeBudget, profiles)}
          onClose={() => setShowSummary(false)}
        />
      )}

      {/* TOAST */}
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}

export default App;
