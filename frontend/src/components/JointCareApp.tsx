import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowRight, CalendarDays, ChevronDown, MessageCircle, Phone,
  ClipboardList, Clock3, FileText, HeartPulse, Info, LayoutDashboard, LockKeyhole,
  LogOut, Menu, Plus, Radio, RefreshCw, Save, ShieldCheck, SlidersHorizontal,
  Sparkles, UserRound, UsersRound, Wifi, WifiOff, X,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { buildDailyTrends, localDayKey, summarizeDemo, summarizeObserved } from '../lib/analytics';
import { deleteTrustedContact, emptyWorkspace, getDemoWorkspace, isValidE164Phone, loadWorkspace, postApi, saveProfile, saveSymptom, saveTrustedContact } from '../lib/data';
import { supabase, supabaseConfigured } from '../lib/supabase';
import type { AppMode, MonitoringSession, PatientSettings, Profile, SensorReading, SymptomRecord, TrustedEmergencyContact, WorkspaceData } from '../types';
import { AutoimmuneModules } from './AutoimmuneModules';

const NAV = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { id: 'symptoms', label: 'Symptom tracker', icon: HeartPulse },
  { id: 'monitor', label: 'Live monitoring', icon: Activity },
  { id: 'history', label: 'History & reports', icon: ClipboardList },
  { id: 'profile', label: 'Patient profile', icon: UserRound },
  { id: 'clinician', label: 'Clinician view', icon: UsersRound },
] as const;
type View = (typeof NAV)[number]['id'] | 'login';
const TITLES: Record<View, string> = {
  dashboard: 'Overview', symptoms: 'Symptom tracker', monitor: 'Live monitoring', history: 'History & reports', profile: 'Patient profile', clinician: 'Clinician view', login: 'Account access',
};
const formatDate = (date?: string | null) => date ? new Date(date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function getDataQualityWarnings(readings: SensorReading[]): string[] {
  if (!readings.length) return ['No sensor samples are available in the loaded history.'];
  const warnings: string[] = [];
  const missing = readings.filter((row) => typeof row.relative_angle_degrees !== 'number' || !Number.isFinite(row.relative_angle_degrees)).length;
  const flagged = readings.filter((row) => row.quality === 'low' || row.quality === 'invalid').length;
  if (missing) warnings.push(`${missing} sample${missing === 1 ? '' : 's'} without a usable relative angle`);
  if (flagged) warnings.push(`${flagged} sample${flagged === 1 ? '' : 's'} already flagged low/invalid by the recorded quality field`);
  const groups = new Map<string, Array<{ at: number; angle: number }>>();
  for (const row of readings) {
    const at = new Date(row.measured_at).getTime();
    if (!Number.isFinite(at) || typeof row.relative_angle_degrees !== 'number' || !Number.isFinite(row.relative_angle_degrees)) continue;
    const group = groups.get(row.session_id) || [];
    group.push({ at, angle: row.relative_angle_degrees });
    groups.set(row.session_id, group);
  }
  let gaps = 0; let jumps = 0;
  for (const samples of groups.values()) {
    const sorted = [...samples].sort((a, b) => a.at - b.at);
    for (let index = 1; index < sorted.length; index += 1) {
      const seconds = (sorted[index].at - sorted[index - 1].at) / 1000;
      if (seconds > 60) gaps += 1;
      else if (seconds > 0 && Math.abs(sorted[index].angle - sorted[index - 1].angle) >= 90) jumps += 1;
    }
  }
  if (gaps) warnings.push(`${gaps} within-session gap${gaps === 1 ? '' : 's'} over 60 seconds`);
  if (jumps) warnings.push(`${jumps} adjacent relative-angle change${jumps === 1 ? '' : 's'} of 90° or more; verify placement and continuity`);
  return warnings;
}

function IconButton({ title, children, onClick }: { title: string; children: ReactNode; onClick: () => void }) {
  return <button className="icon-btn" aria-label={title} title={title} onClick={onClick}>{children}</button>;
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><img src="/jointcare-mark.svg" alt="" width="34" height="34" /></span><span><span className="brand-name">JointCare AI</span><span className="brand-tag">Understand Every Movement</span></span></div>;
}

function DemoNotice() {
  return <div className="demo-banner"><Info size={14} /><span><strong>SIMULATED DEMO</strong> — example readings and symptoms are synthetic, local-only, and not a person's medical record.</span></div>;
}

function AppNav({ active, onNavigate, clinician, onLogout, mobile = false, collapsed = false, onToggleCollapse = () => {} }: { active: View; onNavigate: (view: View) => void; clinician: boolean; onLogout: () => void; mobile?: boolean; collapsed?: boolean; onToggleCollapse?: () => void }) {
  const links = NAV.filter((item) => item.id !== 'clinician' || clinician);
  return <>
    {mobile ? <nav className="mobile-nav" aria-label="Main navigation">
      {links.filter((item) => ['dashboard', 'symptoms', 'monitor', 'history', 'profile'].includes(item.id)).map((item) => {
        const Icon = item.icon;
        return <button key={item.id} className={`nav-button ${active === item.id ? 'active' : ''}`} onClick={() => onNavigate(item.id)}><Icon size={18} /><span>{item.id === 'dashboard' ? 'Home' : item.id === 'symptoms' ? 'Track' : item.id === 'monitor' ? 'Monitor' : item.id === 'history' ? 'History' : 'Profile'}</span></button>;
      })}
    </nav> : <aside className="sidebar">
      <div className="sidebar-top"><Brand /><button className="icon-btn collapse-button" onClick={onToggleCollapse} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand navigation' : 'Collapse navigation'}><Menu size={14} /></button></div>
      <div className="nav-group"><div className="nav-label"><span className="nav-text">Workspace</span></div>
        {links.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} title={item.label} aria-label={item.label} className={`nav-button ${active === item.id ? 'active' : ''}`} onClick={() => onNavigate(item.id)}><Icon size={16} strokeWidth={1.8} /><span className="nav-text">{item.label}</span></button>;
        })}
      </div>
      <div className="sidebar-bottom">
        <div className="safety-card"><strong><ShieldCheck size={13} /> Privacy & interpretation</strong>Movement and symptom logs are descriptive signals, not a diagnosis or inflammation measurement.</div>
        <button className="nav-button" title={supabase?.auth ? 'Sign out' : 'Exit demo'} aria-label={supabase?.auth ? 'Sign out' : 'Exit demo'} onClick={onLogout}><LogOut size={16} /><span className="nav-text">{supabase?.auth ? 'Sign out' : 'Exit demo'}</span></button>
      </div>
    </aside>}
  </>;
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: number | null; color?: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div style={{ background: '#191d1e', border: '1px solid #353c3c', borderRadius: 9, padding: '9px 11px', fontSize: 10, color: '#e7e9e8' }}><div style={{ color: '#9da6a4', marginBottom: 5 }}>{label}</div>{payload.map((item, index) => <div key={`${item.name}-${index}`} style={{ color: item.color, padding: '2px 0' }}>{item.name}: {item.value ?? '—'}</div>)}</div>;
}

function MetricCard({ label, value, unit, note, icon }: { label: string; value: string | number; unit?: string; note: string; icon: ReactNode }) {
  return <div className="card metric-card"><div className="metric-label">{icon}{label}</div><div className="metric-value">{value}<span className="metric-unit">{unit}</span></div><div className="metric-note">{note}</div></div>;
}

function Dashboard({ data, mode, onNavigate, accessToken, onAnalysisSaved, notify }: { data: WorkspaceData; mode: AppMode; onNavigate: (view: View) => void; accessToken?: string; onAnalysisSaved: (analysis: Record<string, unknown>) => void; notify: (message: string) => void }) {
  const [range, setRange] = useState<7 | 30>(7);
  const trends = useMemo(() => buildDailyTrends(data.readings, data.symptoms, range), [data.readings, data.symptoms, range]);
  const latestReading = data.readings[0];
  const latestSymptom = data.symptoms[0];
  const lastReadingAge = latestReading ? Date.now() - new Date(latestReading.measured_at).getTime() : Number.POSITIVE_INFINITY;
  const connection = mode === 'demo' ? 'Simulated' : lastReadingAge < 5 * 60_000 ? 'Recent data' : 'No recent data';
  const storedSummary = typeof data.analysis?.summary === 'string' ? data.analysis.summary : null;
  const summary = mode === 'demo' ? summarizeDemo() : storedSummary || summarizeObserved(data.readings, data.symptoms);
  const generatedAt = typeof data.analysis?.generated_at === 'string' ? data.analysis.generated_at : null;
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  async function generateAnalysis() {
    if (!accessToken) return;
    setAnalyzing(true); setAnalysisError('');
    try {
      const saved = await postApi<Record<string, unknown>>(`/api/v1/analytics/generate?days=${range}`, accessToken, {});
      onAnalysisSaved(saved); notify('Rule-based summary saved to your account.');
    } catch (cause) { setAnalysisError(cause instanceof Error ? cause.message : 'Could not generate a summary.'); }
    finally { setAnalyzing(false); }
  }
  return <>
    {mode === 'demo' && <DemoNotice />}
    <div className="page-heading"><div><div className="eyebrow-line">Movement journal / {mode === 'demo' ? 'sample workspace' : 'your account'}</div><h1>Movement, made visible.</h1><p>A calm view of your movement sessions and the symptoms you choose to record.</p></div><button className="btn primary" onClick={() => onNavigate('symptoms')}><Plus size={14} /> Log symptoms</button></div>
    <AutoimmuneModules data={data} mode={mode} notify={notify} />
    <div className="grid metrics-grid">
      <MetricCard label="Sensor status" value={connection} note={mode === 'demo' ? 'Simulated device stream' : latestReading ? `Last sample ${formatDate(latestReading.measured_at)}` : 'No stored hardware readings'} icon={mode === 'demo' ? <Radio size={13} /> : lastReadingAge < 300000 ? <Wifi size={13} /> : <WifiOff size={13} />} />
      <MetricCard label="Latest relative angle" value={latestReading?.relative_angle_degrees == null ? '—' : Number(latestReading.relative_angle_degrees).toFixed(1)} unit={latestReading?.relative_angle_degrees == null ? '' : '°'} note={mode === 'demo' ? 'Example measurement · relative only' : latestReading ? 'Observed in your saved session' : 'No angle reading available'} icon={<Activity size={13} />} />
      <MetricCard label="Reported pain" value={latestSymptom ? `${latestSymptom.pain_score}/10` : '—'} note={latestSymptom ? `Self-reported · ${formatDate(latestSymptom.recorded_at)}` : 'No symptom record yet'} icon={<HeartPulse size={13} />} />
      <MetricCard label="Reported stiffness" value={latestSymptom ? `${latestSymptom.stiffness_score}/10` : '—'} note={latestSymptom ? `Self-reported · ${latestSymptom.joint}` : 'No symptom record yet'} icon={<SlidersHorizontal size={13} />} />
    </div>
    <div className="grid two-column">
      <section className="card"><div className="card-head"><div><h2 className="card-title">Movement trend · {range} days</h2><p className="card-subtitle">Relative angle values from available sessions. Not a clinical range.</p></div><div className="range-switch" role="group" aria-label="Dashboard trend period"><button type="button" className={`chip range-chip ${range === 7 ? 'selected' : ''}`} aria-pressed={range === 7} onClick={() => setRange(7)}><CalendarDays size={11} />7 days</button><button type="button" className={`chip range-chip ${range === 30 ? 'selected' : ''}`} aria-pressed={range === 30} onClick={() => setRange(30)}>30 days</button></div></div>
        {trends.some((row) => row.angle != null) ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={trends} margin={{ top: 8, right: 7, bottom: 0, left: -18 }}><defs><linearGradient id="movementFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8dd9c2" stopOpacity={0.18} /><stop offset="100%" stopColor="#8dd9c2" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#262b2c" vertical={false} /><XAxis dataKey="day" minTickGap={range === 30 ? 22 : 8} tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} unit="°" /><Tooltip content={<ChartTooltip />} /><Area type="monotone" dataKey="angle" name="Relative angle (°)" stroke="#8dd9c2" strokeWidth={2} fill="url(#movementFill)" connectNulls={false} activeDot={{ r: 4, fill: '#8dd9c2', stroke: '#0d1110' }} /></AreaChart></ResponsiveContainer></div> : <div className="empty-state">No movement-angle records are available for this range.<br />Start a monitoring session to build a history.</div>}
      </section>
      <section className="card"><div className="card-head"><div><h2 className="card-title">Pattern summary</h2><p className="card-subtitle">Transparent, rule-based comparison of available records</p></div><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>{mode === 'account' && accessToken && <button className="btn" onClick={() => void generateAnalysis()} disabled={analyzing} aria-label="Save a new rule-based summary">{analyzing ? 'Analyzing…' : 'Refresh summary'}</button>}<Sparkles size={15} color="#8dd9c2" /></div></div><div className="insight"><Activity size={15} color="#8dd9c2" /><p>{summary}<small>Descriptive only · No diagnosis or treatment advice{generatedAt ? ` · Saved ${formatDate(generatedAt)}` : ''}</small></p></div>{analysisError && <div className="form-error" role="alert" style={{ marginTop: 12 }}>{analysisError}</div>}<div className="section-label" style={{ marginTop: 22 }}>Recent sessions</div>
        {data.sessions.length ? <div className="data-list">{data.sessions.slice(0, 3).map((session) => <div className="data-row" key={session.id}><div><div className="data-main">{session.mode === 'demo' || mode === 'demo' ? 'Simulated session' : 'Movement session'}</div><div className="data-meta">{formatDate(session.started_at)}</div></div><span className={`chip ${session.status === 'active' ? 'mint' : ''}`}>{session.status}</span></div>)}</div> : <div className="empty-state" style={{ minHeight: 80 }}>No sessions recorded yet.</div>}
        <div className="section-label" style={{ marginTop: 16 }}>Recent symptom records</div>
        {data.symptoms.length ? <div className="data-list">{data.symptoms.slice(0, 3).map((record) => <div className="data-row" key={record.id}><div><div className="data-main">{record.joint} · pain {record.pain_score}/10 · stiffness {record.stiffness_score}/10</div><div className="data-meta">Self-reported · {formatDate(record.recorded_at)}</div></div>{record.swelling && <span className="chip amber">Swelling</span>}</div>)}</div> : <div className="help-text">No symptom entries yet.</div>}
      </section>
    </div>
    <section className="card"><div className="card-head"><div><h2 className="card-title">Pain & stiffness notes</h2><p className="card-subtitle">Self-reported scores · 0–10</p></div><button className="btn ghost" onClick={() => onNavigate('history')}>Open history <ArrowRight size={13} /></button></div>
      {trends.some((row) => row.pain != null || row.stiffness != null) ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={trends} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}><CartesianGrid stroke="#262b2c" vertical={false} /><XAxis dataKey="day" minTickGap={range === 30 ? 22 : 8} tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} /><Tooltip content={<ChartTooltip />} /><Line type="monotone" dataKey="pain" name="Pain" stroke="#e4b779" strokeWidth={2} dot={{ r: 3, fill: '#e4b779' }} connectNulls /><Line type="monotone" dataKey="stiffness" name="Stiffness" stroke="#c7a3e5" strokeWidth={2} dot={{ r: 3, fill: '#c7a3e5' }} connectNulls /><ReferenceLine y={0} stroke="#34393a" /></LineChart></ResponsiveContainer></div> : <div className="empty-state">Record symptoms to see your self-reported trend here.</div>}
    </section>
  </>;
}

function SymptomTracker({ data, mode, userId, onSaved, notify }: { data: WorkspaceData; mode: AppMode; userId?: string; onSaved: (record: SymptomRecord) => void; notify: (message: string) => void }) {
  const [pain, setPain] = useState(3);
  const [stiffness, setStiffness] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const nowLocal = () => { const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset()); return now.toISOString().slice(0, 16); };
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess('');
    const form = new FormData(event.currentTarget);
    const rawDate = String(form.get('recorded_at') || '');
    const record: Omit<SymptomRecord, 'id'> = {
      recorded_at: new Date(rawDate).toISOString(), joint: String(form.get('joint') || 'Knee'), pain_score: pain, stiffness_score: stiffness,
      swelling: form.get('swelling') === 'on', discomfort: String(form.get('discomfort') || '').trim() || null,
      activity: String(form.get('activity') || '').trim() || null, notes: String(form.get('notes') || '').trim() || null,
      source: mode === 'demo' ? 'simulated_demo_only' : 'patient',
    };
    try {
      if (mode === 'account' && userId) {
        const saved = await saveSymptom(userId, record);
        onSaved(saved);
        setSuccess('Your symptom record has been saved to your Supabase account.');
      } else {
        const saved: SymptomRecord = { ...record, id: `demo-local-${crypto.randomUUID()}` };
        const old = JSON.parse(localStorage.getItem('jointcare.demo.symptoms') || '[]') as SymptomRecord[];
        localStorage.setItem('jointcare.demo.symptoms', JSON.stringify([saved, ...old].slice(0, 100)));
        onSaved(saved);
        setSuccess('Saved in this browser’s simulated demo history only. It was not sent to Supabase.');
      }
      (event.currentTarget as HTMLFormElement).reset(); setPain(3); setStiffness(2); notify('Symptom entry saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save the symptom entry. Check configuration and permissions.'); }
    finally { setBusy(false); }
  }
  return <>
    {mode === 'demo' && <DemoNotice />}
    <div className="page-heading"><div><div className="eyebrow-line">Patient-reported record</div><h1>Daily symptom check-in</h1><p>A short, optional record of what you noticed and what you were doing.</p></div></div>
    <div className="grid two-column" style={{ alignItems: 'start' }}>
      <section className="card"><div className="card-head"><div><h2 className="card-title">Add an entry</h2><p className="card-subtitle">Scores describe your report, not a clinical assessment.</p></div><HeartPulse size={15} color="#8dd9c2" /></div>
        <form onSubmit={submit}><div className="form-grid">
          <div className="field"><label htmlFor="recorded_at">Date and time</label><input className="input" type="datetime-local" name="recorded_at" id="recorded_at" defaultValue={nowLocal()} required /></div>
          <div className="field"><label htmlFor="joint">Joint</label><select className="select" name="joint" id="joint" defaultValue={data.settings?.monitored_joint || 'Knee'}><option>Knee</option><option>Hip</option><option>Shoulder</option><option>Wrist</option><option>Ankle</option><option>Other</option></select></div>
          <div className="field"><label htmlFor="pain">Pain · <span className="mono">{pain}/10</span></label><input className="input" id="pain" type="range" min="0" max="10" step="1" value={pain} onChange={(e) => setPain(Number(e.target.value))} aria-valuetext={`${pain} out of 10`} /><div className="help-text">0 — none · 10 — highest you report</div></div>
          <div className="field"><label htmlFor="stiffness">Stiffness · <span className="mono">{stiffness}/10</span></label><input className="input" id="stiffness" type="range" min="0" max="10" step="1" value={stiffness} onChange={(e) => setStiffness(Number(e.target.value))} aria-valuetext={`${stiffness} out of 10`} /><div className="help-text">0 — none · 10 — highest you report</div></div>
          <div className="field"><label htmlFor="activity">Activity performed</label><input className="input" id="activity" name="activity" maxLength={120} placeholder="e.g., walk, stretching, desk work" /></div>
          <div className="field"><label htmlFor="discomfort">Other discomfort (optional)</label><input className="input" id="discomfort" name="discomfort" maxLength={500} placeholder="A short description" /></div>
          <div className="field full"><label style={{ display: 'flex', gap: 9, alignItems: 'center' }}><input name="swelling" type="checkbox" /> I noticed swelling (self-reported)</label></div>
          <div className="field full"><label htmlFor="notes">Notes (optional)</label><textarea className="textarea" id="notes" name="notes" maxLength={2000} placeholder="Anything else you want to remember?" /></div>
        </div>
        {error && <div className="form-error" role="alert" style={{ marginTop: 15 }}>{error}</div>}{success && <div className="form-success" role="status" style={{ marginTop: 15 }}>{success}</div>}
        <div className="form-actions"><button className="btn primary" disabled={busy}><Save size={14} />{busy ? 'Saving…' : 'Save check-in'}</button></div></form>
      </section>
      <section className="card"><div className="card-head"><div><h2 className="card-title">Recent entries</h2><p className="card-subtitle">{mode === 'demo' ? 'Synthetic sample and local-only demo entries' : 'Only records visible to your Supabase account'}</p></div><span className="chip">{data.symptoms.length} records</span></div>
        {data.symptoms.length ? <div className="data-list">{data.symptoms.slice(0, 8).map((record) => <div className="data-row" key={record.id}><div><div className="data-main">{record.joint} · pain {record.pain_score}/10</div><div className="data-meta">stiffness {record.stiffness_score}/10{record.activity ? ` · ${record.activity}` : ''} · {formatDate(record.recorded_at)}</div></div>{record.swelling && <span className="chip amber">Swelling reported</span>}</div>)}</div> : <div className="empty-state">Your symptom history will appear here after your first entry.</div>}
      </section>
    </div>
  </>;
}

function MonitorPage({ data, mode, session, accessToken, onReload, onDataSaved, notify }: { data: WorkspaceData; mode: AppMode; session: MonitoringSession | null; accessToken?: string; onReload: () => Promise<void>; onDataSaved: (session: MonitoringSession | null) => void; notify: (message: string) => void }) {
  const [monitorMode, setMonitorMode] = useState<'demo' | 'hardware'>(mode === 'demo' ? 'demo' : 'hardware');
  const [running, setRunning] = useState(Boolean(session && ['active', 'paused'].includes(session.status)));
  const [paused, setPaused] = useState(session?.status === 'paused');
  const [currentSession, setCurrentSession] = useState<MonitoringSession | null>(session);
  const [samples, setSamples] = useState<Array<{ t: string; angle: number; ax: number; ay: number; az: number; gx: number; gy: number; gz: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedDevice, setSelectedDevice] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const [registering, setRegistering] = useState(false);
  const latest = samples.at(-1);
  useEffect(() => {
    if (!session) return;
    setCurrentSession(session); setRunning(['active', 'paused'].includes(session.status)); setPaused(session.status === 'paused');
  }, [session]);
  useEffect(() => {
    if (!running || paused || monitorMode !== 'demo') return;
    const timer = window.setInterval(() => {
      setSamples((previous) => {
        const index = previous.length;
        const angle = 22 + Math.sin(index / 3) * 7 + Math.random() * 0.7;
        const next = { t: new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }), angle: Number(angle.toFixed(1)), ax: Number((0.15 + Math.random() * 0.12).toFixed(2)), ay: Number((0.03 + Math.random() * 0.1).toFixed(2)), az: Number((9.5 + Math.random() * 0.3).toFixed(2)), gx: Number((Math.random() * 0.11).toFixed(2)), gy: Number((Math.random() * 0.09).toFixed(2)), gz: Number((Math.random() * 0.08).toFixed(2)) };
        return [...previous.slice(-39), next];
      });
    }, 700);
    return () => window.clearInterval(timer);
  }, [running, paused, monitorMode]);
  useEffect(() => {
    if (!running || paused || monitorMode !== 'hardware') return;
    const timer = window.setInterval(() => { void onReload(); }, 4000);
    return () => window.clearInterval(timer);
  }, [running, paused, monitorMode, onReload]);
  const realLatest = data.readings[0];
  const shownAngle = monitorMode === 'demo' ? latest?.angle : realLatest?.relative_angle_degrees;
  const sessionDuration = currentSession?.started_at ? Math.max(0, Math.floor((Date.now() - new Date(currentSession.started_at).getTime()) / 1000)) : 0;
  const durationText = `${String(Math.floor(sessionDuration / 60)).padStart(2, '0')}:${String(sessionDuration % 60).padStart(2, '0')}`;
  const chartData = monitorMode === 'demo' ? samples : data.readings.slice(0, 40).reverse().map((reading) => ({ t: new Date(reading.measured_at).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }), angle: reading.relative_angle_degrees ?? 0 }));
  async function start() {
    setError('');
    if (monitorMode === 'demo') {
      const demoSession: MonitoringSession = { id: `sim-${crypto.randomUUID()}`, mode: 'demo', status: 'active', started_at: new Date().toISOString() };
      setCurrentSession(demoSession); setSamples([]); setRunning(true); setPaused(false); notify('Simulated monitor started. No patient records were written.'); return;
    }
    if (!accessToken) { setError('Sign in before starting a real hardware session.'); return; }
    if (!selectedDevice) { setError('Select an enrolled device before starting a hardware session.'); return; }
    setBusy(true);
    try {
      const result = await postApi<MonitoringSession & { session_id?: string }>('/api/v1/sensor/sessions/start', accessToken, { mode: 'real', device_id: selectedDevice });
      const started = { ...result, id: result.id || result.session_id || '', status: 'active' as const };
      setCurrentSession(started); onDataSaved(started); setRunning(true); setPaused(false); notify('Hardware session opened. Waiting for authorized device readings.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start the session.'); }
    finally { setBusy(false); }
  }
  async function pauseOrResume() {
    if (monitorMode === 'demo') { setPaused((value) => !value); return; }
    if (!accessToken || !currentSession?.id) return;
    setBusy(true); setError('');
    try {
      const path = paused ? 'resume' : 'pause';
      const result = await postApi<MonitoringSession>(`/api/v1/sensor/sessions/${path}?session_id=${encodeURIComponent(currentSession.id)}`, accessToken, {});
      setCurrentSession(result); setPaused(!paused); onDataSaved(result); notify(paused ? 'Session resumed.' : 'Session paused.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Session state could not be changed.'); }
    finally { setBusy(false); }
  }
  async function stop() {
    if (monitorMode === 'demo') { setRunning(false); setPaused(false); setCurrentSession(null); notify('Simulated session stopped; no readings were saved.'); return; }
    if (!accessToken || !currentSession?.id) { setRunning(false); return; }
    setBusy(true); setError('');
    try {
      await postApi(`/api/v1/sensor/sessions/stop?session_id=${encodeURIComponent(currentSession.id)}`, accessToken, {});
      setRunning(false); setPaused(false); setCurrentSession(null); onDataSaved(null); await onReload(); notify('Monitoring session stopped.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not stop the session.'); }
    finally { setBusy(false); }
  }
  async function registerDevice(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); if (!accessToken) return;
    setRegistering(true); setError('');
    try {
      const response = await postApi<{ device: { id: string; device_identifier: string }; device_token: string }>('/api/v1/sensor/devices/register', accessToken, { device_identifier: deviceName.trim() });
      setDeviceToken(response.device_token); setSelectedDevice(response.device.id); setDeviceName(''); await onReload(); notify('Device enrolled. Copy its token now; it is displayed only once.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not enroll the device.'); }
    finally { setRegistering(false); }
  }
  async function copyToken() {
    try { await navigator.clipboard.writeText(deviceToken); notify('One-time device token copied. Store it securely; do not commit it.'); }
    catch { setError('Clipboard was unavailable. Copy the token manually from the field.'); }
  }
  async function copySessionId() {
    if (!currentSession?.id) return;
    try { await navigator.clipboard.writeText(currentSession.id); notify('Session ID copied. Paste it into your untracked firmware secrets file.'); }
    catch { setError('Clipboard was unavailable. Copy the session ID manually from the field.'); }
  }
  const dataRate = monitorMode === 'demo' ? (running && !paused ? '1.4 Hz' : '—') : `${data.readings.filter((reading) => Date.now() - new Date(reading.measured_at).getTime() < 60_000).length}/min`;
  return <>
    {monitorMode === 'demo' && <DemoNotice />}
    <div className="page-heading"><div><div className="eyebrow-line">Wearable / session {running ? 'active' : 'idle'}</div><h1>Live movement monitor</h1><p>See incoming sensor signals and connection state. Relative angles are not a clinical range.</p></div><div className={`chip ${running && !paused ? 'mint' : ''}`}><span className="pulse-dot" />{monitorMode === 'demo' ? 'SIMULATED DEVICE' : running ? (paused ? 'PAUSED' : 'HARDWARE SESSION') : 'HARDWARE READY'}</div></div>
    <div className="grid two-column" style={{ alignItems: 'start' }}>
      <div className="grid">
        <section className="card"><div className="card-head"><div><h2 className="card-title">Connection & controls</h2><p className="card-subtitle">Choose a source. Demo samples never enter your account.</p></div><Radio size={15} color="#8dd9c2" /></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}><button className={`btn ${monitorMode === 'demo' ? 'primary' : 'ghost'}`} onClick={() => { setMonitorMode('demo'); setRunning(false); setPaused(false); setCurrentSession(null); }} disabled={busy || running}><Activity size={13} /> Demo mode</button><button className={`btn ${monitorMode === 'hardware' ? 'primary' : 'ghost'}`} onClick={() => { setMonitorMode('hardware'); setRunning(false); setPaused(false); setCurrentSession(null); }} disabled={mode !== 'account' || busy || running}><Wifi size={13} /> Real hardware</button></div>
          {monitorMode === 'hardware' && <div className="field" style={{ marginBottom: 15 }}><label htmlFor="device">Authorized device</label><select className="select" id="device" value={selectedDevice} onChange={(event) => setSelectedDevice(event.target.value)}><option value="">Select an enrolled device</option>{data.devices.filter((device) => device.is_active && device.status === 'active').map((device) => <option key={device.id} value={device.id}>{device.device_identifier}</option>)}</select><span className="help-text">First enroll a device below. ESP32 credentials are shown only once.</span></div>}
          {error && <div className="form-error" role="alert" style={{ marginBottom: 13 }}>{error}</div>}
          {deviceToken && <div className="card" style={{ padding: 13, marginBottom: 14, borderColor: '#4a594c' }}><div className="card-title" style={{ marginBottom: 6 }}>Device token — shown once</div><div className="help-text" style={{ marginBottom: 9 }}>Copy to your untracked local firmware secrets file. Do not paste into a public sketch or share it.</div><input className="input mono" value={deviceToken} readOnly aria-label="One-time device token" /><button className="btn" style={{ marginTop: 8 }} onClick={copyToken}>Copy token</button></div>}
          {monitorMode === 'hardware' && currentSession?.id && <div className="card" style={{ padding: 13, marginBottom: 14 }}><div className="card-title" style={{ marginBottom: 6 }}>Active session ID</div><div className="help-text" style={{ marginBottom: 9 }}>Copy this after starting a hardware session and paste it into local `secrets.h` as `SESSION_ID`.</div><input className="input mono" value={currentSession.id} readOnly aria-label="Active hardware session ID" /><button className="btn" style={{ marginTop: 8 }} onClick={() => void copySessionId()}>Copy session ID</button></div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!running ? <button className="btn primary" onClick={() => void start()} disabled={busy}><Activity size={14} />{busy ? 'Connecting…' : 'Start session'}</button> : <><button className="btn" onClick={() => void pauseOrResume()} disabled={busy}>{paused ? 'Resume' : 'Pause'}</button><button className="btn danger" onClick={() => void stop()} disabled={busy}><X size={13} /> Stop session</button></>}
            {monitorMode === 'hardware' && accessToken && !running && <form onSubmit={registerDevice} style={{ display: 'flex', gap: 7, flex: '1 1 280px' }}><input className="input" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} minLength={1} maxLength={128} placeholder="New device name / identifier" aria-label="New device identifier" required /><button className="btn" disabled={registering || !deviceName.trim()}><Plus size={13} />{registering ? 'Enrolling…' : 'Enroll device'}</button></form>}
          </div>
        </section>
        <section className="card"><div className="card-head"><div><h2 className="card-title">Movement angle</h2><p className="card-subtitle">Relative signal over the active session</p></div><span className="chip">{monitorMode === 'demo' ? 'Simulated' : 'Stored samples'}</span></div>
          {chartData.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}><CartesianGrid stroke="#262b2c" vertical={false} /><XAxis dataKey="t" tick={{ fill: '#838b8b', fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={25} /><YAxis tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} unit="°" /><Tooltip content={<ChartTooltip />} /><Line type="monotone" dataKey="angle" name="Relative angle (°)" stroke="#8dd9c2" strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div> : <div className="empty-state">Start a demo or hardware session to view movement samples.</div>}
        </section>
      </div>
      <div className="grid">
        <section className="card"><div className="card-head"><div><h2 className="card-title">Session readout</h2><p className="card-subtitle">{running ? 'Session is active' : 'No active session'}</p></div><Clock3 size={15} color="#8dd9c2" /></div>
          <div className="sensor-panel"><div className="sensor-reading"><span>Relative angle</span><strong>{shownAngle == null ? '—' : `${Number(shownAngle).toFixed(1)}°`}</strong></div><div className="sensor-reading"><span>Duration</span><strong>{durationText}</strong></div><div className="sensor-reading"><span>Incoming rate</span><strong>{dataRate}</strong></div><div className="sensor-reading"><span>Device</span><strong style={{ fontSize: 11 }}>{monitorMode === 'demo' ? 'DEMO-001' : data.devices.find((device) => device.id === selectedDevice)?.device_identifier || 'Not selected'}</strong></div></div>
          <div className="section-label" style={{ marginTop: 20 }}>Accelerometer · m/s²</div><div className="sensor-panel">{[['X', latest?.ax ?? realLatest?.accel_x], ['Y', latest?.ay ?? realLatest?.accel_y], ['Z', latest?.az ?? realLatest?.accel_z]].map(([label, value]) => <div className="sensor-reading" key={`a-${label}`}><span>Accel {label}</span><strong>{typeof value === 'number' ? value.toFixed(2) : '—'}</strong></div>)}</div>
          <div className="section-label" style={{ marginTop: 18 }}>Gyroscope · rad/s</div><div className="sensor-panel">{[['X', latest?.gx ?? realLatest?.gyro_x], ['Y', latest?.gy ?? realLatest?.gyro_y], ['Z', latest?.gz ?? realLatest?.gyro_z]].map(([label, value]) => <div className="sensor-reading" key={`g-${label}`}><span>Gyro {label}</span><strong>{typeof value === 'number' ? value.toFixed(3) : '—'}</strong></div>)}</div>
          {monitorMode === 'hardware' && <p className="help-text" style={{ marginTop: 14 }}>Hardware readings are refreshed from saved Supabase batches every few seconds while the monitor is open.</p>}
        </section>
        <section className="card"><div className="card-head"><div><h2 className="card-title">Device status</h2><p className="card-subtitle">Recent connection and data checks</p></div><button className="icon-btn" onClick={() => void onReload()} title="Refresh saved records"><RefreshCw size={13} /></button></div>
          <div className="data-list"><div className="data-row"><div><div className="data-main">Source mode</div><div className="data-meta">Provenance stays explicit</div></div><span className={`chip ${monitorMode === 'demo' ? 'amber' : ''}`}>{monitorMode === 'demo' ? 'SIMULATED' : 'HARDWARE'}</span></div><div className="data-row"><div><div className="data-main">Latest saved sample</div><div className="data-meta">{realLatest ? formatDate(realLatest.measured_at) : 'No hardware sample stored'}</div></div><span className="data-value">{realLatest?.quality || '—'}</span></div><div className="data-row"><div><div className="data-main">Stream strategy</div><div className="data-meta">Polling saved batches while open</div></div><span className="data-value">4 sec</span></div></div>
        </section>
      </div>
    </div>
    <div className="help-text">A six-axis sensor reports acceleration and angular velocity. It does not directly measure inflammation, confirm a diagnosis, or replace a clinician’s assessment.</div>
  </>;
}

function HistoryPage({ data, mode, notify }: { data: WorkspaceData; mode: AppMode; notify: (message: string) => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filteredReadings = data.readings.filter((row) => (!from || localDayKey(row.measured_at) >= from) && (!to || localDayKey(row.measured_at) <= to));
  const filteredSymptoms = data.symptoms.filter((row) => (!from || localDayKey(row.recorded_at) >= from) && (!to || localDayKey(row.recorded_at) <= to));
  const filteredSessions = data.sessions.filter((row) => (!from || localDayKey(row.started_at) >= from) && (!to || localDayKey(row.started_at) <= to));
  const sessionComparisons = filteredSessions.map((session) => {
    const angles = filteredReadings.filter((reading) => reading.session_id === session.id).map((reading) => reading.relative_angle_degrees).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return { session, samples: angles.length, mean: average(angles), span: angles.length ? Math.max(...angles) - Math.min(...angles) : null };
  });
  const orderedReadings = [...filteredReadings].sort((left, right) => new Date(left.measured_at).getTime() - new Date(right.measured_at).getTime());
  const midpoint = Math.ceil(orderedReadings.length / 2);
  const firstAngle = average(orderedReadings.slice(0, midpoint).map((row) => row.relative_angle_degrees).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
  const latestAngle = average(orderedReadings.slice(midpoint).map((row) => row.relative_angle_degrees).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
  const symptomTrend = [...new Set(filteredSymptoms.map((row) => localDayKey(row.recorded_at)))].sort().map((day) => {
    const records = filteredSymptoms.filter((row) => localDayKey(row.recorded_at) === day);
    return { day: new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), pain: average(records.map((row) => row.pain_score)), stiffness: average(records.map((row) => row.stiffness_score)) };
  });
  function exportCsv() {
    const rows = [
      ['record_type', 'timestamp', 'joint', 'pain_score_0_10', 'stiffness_score_0_10', 'relative_angle_degrees', 'accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'source', 'session_id', 'session_mode', 'session_status'],
      ...filteredSymptoms.map((entry) => ['symptom', entry.recorded_at, entry.joint, entry.pain_score, entry.stiffness_score, '', '', '', '', '', '', '', entry.source || (mode === 'demo' ? 'simulated_demo_only' : 'patient'), '', '', '']),
      ...filteredReadings.map((entry) => ['movement', entry.measured_at, '', '', '', entry.relative_angle_degrees ?? '', entry.accel_x, entry.accel_y, entry.accel_z, entry.gyro_x, entry.gyro_y, entry.gyro_z, entry.source, entry.session_id, '', '']),
      ...filteredSessions.map((entry) => ['session', entry.started_at, '', '', '', '', '', '', '', '', '', '', entry.mode || (mode === 'demo' ? 'demo' : 'real'), entry.id, entry.mode || 'real', entry.status]),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `jointcare-monitoring-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url); notify('CSV export prepared.');
  }
  const comparison = latestAngle == null || firstAngle == null ? 'Not enough relative-angle samples in both chronological groups to compare.' : `Earlier group avg ${firstAngle.toFixed(1)}° · later group avg ${latestAngle.toFixed(1)}° (difference ${(latestAngle - firstAngle).toFixed(1)}°). Relative observations only; not a clinical range.`;
  return <>
    {mode === 'demo' && <DemoNotice />}
    <div className="page-heading"><div><div className="eyebrow-line">Records / export</div><h1>Your movement history</h1><p>Filter available sessions and symptom entries; prepare a printable summary for discussion.</p></div><div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={exportCsv}><ArrowDownToLine size={14} /> Export CSV</button><button className="btn primary" onClick={() => window.print()}><FileText size={14} /> Print report</button></div></div>
    <section className="card" style={{ marginBottom: 16 }}><div className="card-head"><div><h2 className="card-title">Date range</h2><p className="card-subtitle">Filtering is applied to the records currently visible to your account.</p></div><CalendarDays size={15} color="#8dd9c2" /></div><div className="form-grid"><div className="field"><label htmlFor="history-from">From</label><input id="history-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div><div className="field"><label htmlFor="history-to">Through</label><input id="history-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div></div><div className="insight" style={{ marginTop: 17 }}><Activity size={14} color="#8dd9c2" /><p>{comparison}</p></div></section>
    <div className="grid two-column"><section className="card"><div className="card-head"><div><h2 className="card-title">Session comparison</h2><p className="card-subtitle">{filteredSessions.length} sessions in the selected range · relative angles are not clinical ranges</p></div></div>{filteredSessions.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Started</th><th>Source</th><th>Status</th><th>Duration</th><th>Mean angle</th><th>Observed span</th><th>Angle samples</th></tr></thead><tbody>{sessionComparisons.map(({ session: row, samples, mean, span }) => <tr key={row.id}><td>{formatDate(row.started_at)}</td><td>{row.mode === 'demo' || mode === 'demo' ? 'Simulated' : 'Hardware'}</td><td>{row.status}</td><td>{row.ended_at ? `${Math.max(1, Math.round((new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000))} min` : '—'}</td><td>{mean == null ? '—' : `${mean.toFixed(1)}°`}</td><td>{span == null ? '—' : `${span.toFixed(1)}°`}</td><td>{samples}</td></tr>)}</tbody></table></div> : <div className="empty-state">No movement sessions in the selected range.</div>}</section>
      <section className="card"><div className="card-head"><div><h2 className="card-title">Symptom records</h2><p className="card-subtitle">Patient-reported observations</p></div></div>{filteredSymptoms.length ? <><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Date</th><th>Joint</th><th>Pain</th><th>Stiffness</th></tr></thead><tbody>{filteredSymptoms.map((row) => <tr key={row.id}><td>{formatDate(row.recorded_at)}</td><td>{row.joint}</td><td>{row.pain_score}/10</td><td>{row.stiffness_score}/10</td></tr>)}</tbody></table></div><div className="section-label" style={{ marginTop: 18 }}>Daily reported scores</div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={symptomTrend}><CartesianGrid stroke="#262b2c" vertical={false} /><XAxis dataKey="day" minTickGap={18} tick={{ fill: '#838b8b', fontSize: 9 }} tickLine={false} axisLine={false} /><YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} /><Tooltip content={<ChartTooltip />} /><Line type="monotone" dataKey="pain" name="Reported pain (0–10)" stroke="#e4b779" strokeWidth={2} dot={{ r: 3 }} /><Line type="monotone" dataKey="stiffness" name="Reported stiffness (0–10)" stroke="#c7a3e5" strokeWidth={2} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div></> : <div className="empty-state">No symptom records match these dates.</div>}</section>
    </div>
    <div className="card" style={{ marginTop: 16 }}><div className="card-head"><div><h2 className="card-title">Movement plot</h2><p className="card-subtitle">Relative angle samples only · no measurement means no point plotted</p></div><span className={`chip ${mode === 'demo' ? 'amber' : ''}`}>{mode === 'demo' ? 'SIMULATED' : 'ACCOUNT DATA'}</span></div>{filteredReadings.some((row) => row.relative_angle_degrees != null) ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={[...filteredReadings].reverse().map((row) => ({ t: new Date(row.measured_at).toLocaleDateString([], { month: 'short', day: 'numeric' }), angle: row.relative_angle_degrees }))}><CartesianGrid stroke="#262b2c" vertical={false} /><XAxis dataKey="t" tick={{ fill: '#838b8b', fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={25} /><YAxis tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} unit="°" /><Tooltip content={<ChartTooltip />} /><Line type="monotone" dataKey="angle" name="Relative angle (°)" stroke="#8dd9c2" dot={false} connectNulls={false} /></LineChart></ResponsiveContainer></div> : <div className="empty-state">No movement samples match the selected range.</div>}<p className="help-text print-only">JointCare AI monitoring summary · Descriptive records only. This report is not a diagnosis or treatment recommendation.</p></div>
  </>;
}

function ProfilePage({ data, mode, userId, accessToken, onProfileSaved, onTrustedContactSaved, notify }: { data: WorkspaceData; mode: AppMode; userId?: string; accessToken?: string; onProfileSaved: (profile: Profile, settings: PatientSettings) => void; onTrustedContactSaved: (contact: TrustedEmergencyContact | null) => void; notify: (message: string) => void }) {
  const [name, setName] = useState(data.profile?.display_name || '');
  const [joint, setJoint] = useState(data.settings?.monitored_joint || 'Knee');
  const [side, setSide] = useState<'left' | 'right'>(data.settings?.affected_side || 'left');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [contactName, setContactName] = useState(data.trustedContact?.contact_name || '');
  const [contactPhone, setContactPhone] = useState(data.trustedContact?.phone_e164 || '');
  const [contactBusy, setContactBusy] = useState(false);
  const [contactMessage, setContactMessage] = useState('');
  const [contactError, setContactError] = useState('');
  useEffect(() => { setName(data.profile?.display_name || ''); setJoint(data.settings?.monitored_joint || 'Knee'); setSide(data.settings?.affected_side || 'left'); setContactName(data.trustedContact?.contact_name || ''); setContactPhone(data.trustedContact?.phone_e164 || ''); }, [data.profile, data.settings, data.trustedContact]);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      if (mode === 'account' && userId) {
        await saveProfile(userId, name, { monitored_joint: joint, affected_side: side, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
        const profile = { ...data.profile!, display_name: name.trim() || null };
        const settings = { ...data.settings, patient_id: userId, monitored_joint: joint, affected_side: side, preferred_units: data.settings?.preferred_units || 'metric', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } as PatientSettings;
        onProfileSaved(profile, settings); setMessage('Profile and monitoring preference saved to Supabase.'); notify('Profile saved.');
      } else {
        const profile = { ...data.profile!, display_name: name || 'Demo Patient' };
        const settings = { ...data.settings!, monitored_joint: joint, affected_side: side };
        onProfileSaved(profile, settings); localStorage.setItem('jointcare.demo.profile', JSON.stringify({ display_name: profile.display_name, monitored_joint: joint, affected_side: side }));
        setMessage('Saved in this browser’s simulated demo only; not sent to Supabase.');
    }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save profile.'); }
    finally { setBusy(false); }
  }
  async function saveContact(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); setContactBusy(true); setContactError(''); setContactMessage('');
    try {
      if (mode !== 'account' || !userId || data.profile?.role !== 'patient') throw new Error('Trusted contacts are available only to a signed-in patient account.');
      if (!isValidE164Phone(contactPhone.trim())) throw new Error('Use an international E.164 number, for example +15551234567.');
      const saved = await saveTrustedContact(userId, contactName, contactPhone);
      onTrustedContactSaved(saved); setContactMessage('Saved privately to your patient account. SOS will ask you to confirm before opening a call or text.'); notify('Trusted contact saved.');
    } catch (cause) { setContactError(cause instanceof Error ? cause.message : 'Could not save trusted contact.'); }
    finally { setContactBusy(false); }
  }
  async function removeContact() {
    if (mode !== 'account' || !userId || !data.trustedContact) return;
    if (!window.confirm('Remove this trusted contact? SOS will be unavailable until you add another contact.')) return;
    setContactBusy(true); setContactError(''); setContactMessage('');
    try {
      await deleteTrustedContact(userId); onTrustedContactSaved(null); setContactName(''); setContactPhone(''); setContactMessage('Trusted contact removed.'); notify('Trusted contact removed.');
    } catch (cause) { setContactError(cause instanceof Error ? cause.message : 'Could not remove trusted contact.'); }
    finally { setContactBusy(false); }
  }
  async function deleteData() {
    if (!accessToken) { setError('Sign in to request account deletion.'); return; }
    const accepted = window.confirm('Delete your JointCare AI account and associated Supabase Auth profile/data? This cannot be undone. Download any report you need first.');
    if (!accepted) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/account', { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(detail.detail || `Deletion request failed (${response.status})`); }
      await supabase?.auth.signOut(); window.location.hash = '/login'; window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete account data.'); }
    finally { setBusy(false); }
  }
  return <>
    {mode === 'demo' && <DemoNotice />}
    <div className="page-heading"><div><div className="eyebrow-line">Account / preferences</div><h1>Patient profile</h1><p>Keep only the details needed to organize your monitoring records.</p></div></div>
    <div className="grid two-column" style={{ alignItems: 'start' }}><section className="card"><div className="card-head"><div><h2 className="card-title">Profile details</h2><p className="card-subtitle">Your authentication identity is handled by Supabase Auth.</p></div><UserRound size={15} color="#8dd9c2" /></div>
      <form onSubmit={(event) => void submit(event)}><div className="form-grid"><div className="field full"><label htmlFor="display_name">Display name</label><input className="input" id="display_name" maxLength={160} value={name} onChange={(event) => setName(event.target.value)} placeholder="How should we address you?" /></div><div className="field"><label htmlFor="profile_joint">Joint being monitored</label><select className="select" id="profile_joint" value={joint} onChange={(event) => setJoint(event.target.value)}><option>Knee</option><option>Hip</option><option>Shoulder</option><option>Wrist</option><option>Ankle</option><option>Other</option></select></div><div className="field"><label htmlFor="profile_side">Affected side</label><select className="select" id="profile_side" value={side} onChange={(event) => setSide(event.target.value as 'left' | 'right')}><option value="left">Left</option><option value="right">Right</option></select></div></div>{error && <div className="form-error" style={{ marginTop: 14 }}>{error}</div>}{message && <div className="form-success" style={{ marginTop: 14 }}>{message}</div>}<div className="form-actions"><button className="btn primary" disabled={busy}><Save size={14} />{busy ? 'Saving…' : 'Save profile'}</button></div></form>
      </section><section className="grid"><div className="card"><div className="card-head"><div><h2 className="card-title">Access & account</h2><p className="card-subtitle">Your role and data visibility are enforced by database access policies.</p></div><LockKeyhole size={15} color="#8dd9c2" /></div><div className="data-list"><div className="data-row"><div><div className="data-main">Current view</div><div className="data-meta">{mode === 'demo' ? 'Synthetic sample data only' : 'Authenticated account records'}</div></div><span className="chip">{mode === 'demo' ? 'DEMO' : data.profile?.role || 'patient'}</span></div><div className="data-row"><div><div className="data-main">Monitored joint</div><div className="data-meta">Local preference</div></div><span className="data-value">{joint} · {side}</span></div></div></div>
        <div className="card"><div className="card-head"><div><h2 className="card-title">Privacy notice</h2><p className="card-subtitle">JointCare AI stores movement and symptom information only to support your monitoring journal. Access is scoped by Supabase RLS; clinician access requires an explicit assignment. Summary text describes available records and is not a diagnosis, inflammation measurement, or medication recommendation.</p></div><ShieldCheck size={15} color="#8dd9c2" /></div><p className="help-text">You can export a CSV or printable report from History. Demo records stay in local browser storage and are not mixed with account records.</p></div>
        {mode === 'account' && data.profile?.role === 'patient' && <div className="card">
          <div className="card-head"><div><h2 className="card-title">Trusted contact for SOS</h2><p className="card-subtitle">Save one person you may choose to call or text from this device.</p></div><Phone size={15} color="#e27878" /></div>
          <form onSubmit={(event) => void saveContact(event)}>
            <div className="form-grid">
              <div className="field"><label htmlFor="trusted-contact-name">Contact name</label><input className="input" id="trusted-contact-name" autoComplete="name" maxLength={100} value={contactName} onChange={(event) => setContactName(event.target.value)} required /></div>
              <div className="field"><label htmlFor="trusted-contact-phone">Phone (international format)</label><input className="input" id="trusted-contact-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={16} pattern="\+[1-9][0-9]{7,14}" placeholder="+15551234567" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} required aria-describedby="trusted-contact-help" /></div>
            </div>
            <p id="trusted-contact-help" className="help-text">Use E.164 format: +, country code, then digits. This record is visible only to you, not assigned clinicians.</p>
            {contactError && <div className="form-error" role="alert">{contactError}</div>}
            {contactMessage && <div className="form-success" role="status">{contactMessage}</div>}
            <p className="help-text">SOS asks before opening your phone or message app. The app does not auto-send messages, share location, or attach health/session data. Device support varies; this is not a replacement for local emergency services.</p>
            <div className="form-actions"><button className="btn primary" disabled={contactBusy}><Save size={14} />{contactBusy ? 'Saving…' : 'Save trusted contact'}</button>{data.trustedContact && <button type="button" className="btn danger" onClick={() => void removeContact()} disabled={contactBusy}>Remove contact</button>}</div>
          </form>
        </div>}
        {mode === 'demo' && <div className="card"><div className="card-head"><div><h2 className="card-title">SOS in simulated demo</h2><p className="card-subtitle">Demo mode never stores contact details or calls/messages a real person. Sign in to a patient account and configure a trusted contact in this profile.</p></div><Phone size={15} color="#e27878" /></div></div>}
        {mode === 'account' && <div className="card"><div className="card-head"><div><h2 className="card-title">Delete account data</h2><p className="card-subtitle">Permanently remove your Supabase account profile and linked records.</p></div></div><button className="btn danger" onClick={() => void deleteData()} disabled={busy}>Delete my account and data</button><p className="help-text" style={{ marginTop: 10 }}>This is irreversible. The server deletion route needs a configured service-role key.</p></div>}
      </section></div>
  </>;
}

interface ClinicianPatient { profile: Profile; sessions: MonitoringSession[]; symptoms: SymptomRecord[]; readings: SensorReading[]; }

async function loadClinicianPatients(userId: string): Promise<ClinicianPatient[]> {
  if (!supabase) return [];
  const access = await supabase.from('clinician_patient_access').select('patient_id').eq('clinician_id', userId);
  if (access.error) throw access.error;
  const ids = (access.data || []).map((row) => row.patient_id as string);
  if (!ids.length) return [];
  const [profiles, sessions, symptoms, readings] = await Promise.all([
    supabase.from('profiles').select('id,display_name,role').in('id', ids),
    supabase.from('monitoring_sessions').select('id,patient_id,device_id,mode,status,started_at,ended_at').in('patient_id', ids).order('started_at', { ascending: false }).limit(100),
    supabase.from('symptom_records').select('id,patient_id,recorded_at,joint,pain_score,stiffness_score,swelling,activity,notes,source').in('patient_id', ids).order('recorded_at', { ascending: false }).limit(100),
    supabase.from('sensor_readings').select('id,patient_id,session_id,device_id,measured_at,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,relative_angle_degrees,source,quality').in('patient_id', ids).order('measured_at', { ascending: false }).limit(500),
  ]);
  for (const result of [profiles, sessions, symptoms, readings]) if (result.error) throw result.error;
  return ((profiles.data || []) as Profile[]).map((profile) => ({ profile, sessions: (sessions.data || []).filter((row) => row.patient_id === profile.id) as MonitoringSession[], symptoms: (symptoms.data || []).filter((row) => row.patient_id === profile.id) as SymptomRecord[], readings: (readings.data || []).filter((row) => row.patient_id === profile.id) as SensorReading[] }));
}

function ClinicianPage({ profile, userId }: { profile: Profile | null; userId?: string }) {
  const [patients, setPatients] = useState<ClinicianPatient[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (!userId || profile?.role !== 'clinician') return () => { active = false; };
    setLoading(true); setError('');
    loadClinicianPatients(userId).then((rows) => { if (active) { setPatients(rows); setSelected((previous) => rows.some((row) => row.profile.id === previous) ? previous : rows[0]?.profile.id || ''); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load assigned patients.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId, profile?.role]);
  if (profile?.role !== 'clinician') return <><div className="page-heading"><div><div className="eyebrow-line">Clinician access</div><h1>Assigned patient view</h1><p>A separate workspace that reveals only records explicitly shared with the signed-in clinician.</p></div></div><div className="card"><div className="empty-state"><UsersRound size={22} style={{ marginBottom: 9 }} /><br />This account does not have the clinician role. A trusted administrator must provision the role and explicit patient assignments. Patients cannot grant this access themselves.</div></div></>;
  const patient = patients.find((item) => item.profile.id === selected);
  const selectedPatient = patient;
  const trend = selectedPatient ? buildDailyTrends(selectedPatient.readings, selectedPatient.symptoms, 7) : [];
  const summary = selectedPatient ? summarizeObserved(selectedPatient.readings, selectedPatient.symptoms) : 'No assigned patient records are currently available.';
  const qualityWarnings = selectedPatient ? getDataQualityWarnings(selectedPatient.readings) : [];
  function exportAssignedCsv() {
    if (!selectedPatient) return;
    const rows = [
      ['record_type', 'timestamp', 'joint', 'pain_score_0_10', 'stiffness_score_0_10', 'relative_angle_degrees', 'session_id', 'source'],
      ...selectedPatient.symptoms.map((row) => ['symptom', row.recorded_at, row.joint, row.pain_score, row.stiffness_score, '', '', row.source || 'patient']),
      ...selectedPatient.readings.map((row) => ['movement', row.measured_at, '', '', '', row.relative_angle_degrees ?? '', row.session_id, row.source]),
      ...selectedPatient.sessions.map((row) => ['session', row.started_at, '', '', '', '', row.id, row.mode || 'real']),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `jointcare-assigned-${selectedPatient.profile.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow-line">Clinician workspace / assigned access only</div><h1>Patient monitoring</h1><p>Read-only view of explicit active assignments. Health summaries remain descriptive.</p></div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{selectedPatient && <><button className="btn" onClick={exportAssignedCsv}><ArrowDownToLine size={13} /> Export assigned CSV</button><button className="btn" onClick={() => window.print()}><FileText size={13} /> Print report</button></>}<button className="btn" onClick={() => { setLoading(true); void loadClinicianPatients(userId!).then(setPatients).catch((cause) => setError(String(cause))).finally(() => setLoading(false)); }}><RefreshCw size={13} /> Refresh</button></div></div>
    {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}
    {loading && <div className="card"><div className="empty-state">Loading assigned records…</div></div>}
    {!loading && !patients.length && <div className="card"><div className="empty-state">No explicit patient assignments were found. Ask an authorized administrator to provision a clinician role and assignment in Supabase.</div></div>}
    {!loading && patients.length > 0 && <><div className="field" style={{ maxWidth: 380, marginBottom: 16 }}><label htmlFor="assigned_patient">Assigned patient</label><select className="select" id="assigned_patient" value={selected} onChange={(e) => setSelected(e.target.value)}>{patients.map((item) => <option key={item.profile.id} value={item.profile.id}>{item.profile.display_name || `Patient ${item.profile.id.slice(0, 8)}`}</option>)}</select></div>
      {selectedPatient && <><div className="grid metrics-grid"><MetricCard label="Movement sessions" value={selectedPatient.sessions.length} note="Only assigned, RLS-visible records" icon={<Activity size={13} />} /><MetricCard label="Symptom reports" value={selectedPatient.symptoms.length} note="Patient-reported entries" icon={<HeartPulse size={13} />} /><MetricCard label="Angle samples" value={selectedPatient.readings.filter((row) => row.relative_angle_degrees != null).length} note="Relative values only" icon={<Radio size={13} />} /><MetricCard label="Data quality" value={!selectedPatient.readings.length ? 'Limited' : qualityWarnings.length ? 'Review required' : 'No basic flags'} note={qualityWarnings.length ? qualityWarnings.join(' · ') : 'No simple continuity flags detected; not a clinical validity check'} icon={<AlertCircle size={13} />} /></div>
        {qualityWarnings.length > 0 && <div className="form-error" role="status" style={{ marginBottom: 15 }}><strong>Data-quality review:</strong> {qualityWarnings.join('; ')}. These checks do not indicate a medical problem.</div>}
        <div className="grid two-column"><section className="card"><div className="card-head"><div><h2 className="card-title">Movement and symptom trend · 7 days</h2><p className="card-subtitle">Exploratory views of measurements and patient reports.</p></div></div>{selectedPatient.readings.length || selectedPatient.symptoms.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={trend}><CartesianGrid stroke="#262b2c" vertical={false} /><XAxis dataKey="day" tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis tick={{ fill: '#838b8b', fontSize: 10 }} tickLine={false} axisLine={false} /><Tooltip content={<ChartTooltip />} /><Line type="monotone" dataKey="pain" name="Pain (0–10)" stroke="#e4b779" dot={{ r: 3 }} connectNulls /><Line type="monotone" dataKey="stiffness" name="Stiffness (0–10)" stroke="#c7a3e5" dot={{ r: 3 }} connectNulls /><Line type="monotone" dataKey="angle" name="Relative angle (°)" stroke="#8dd9c2" dot={false} connectNulls /></LineChart></ResponsiveContainer></div> : <div className="empty-state">No trend data available.</div>}</section>
          <section className="card"><div className="card-head"><div><h2 className="card-title">Session summary</h2><p className="card-subtitle">Patient {selectedPatient.profile.display_name || selectedPatient.profile.id.slice(0, 8)}</p></div><ShieldCheck size={15} color="#8dd9c2" /></div><div className="insight"><Info size={14} color="#8dd9c2" /><p>{summary}<small>Descriptive only · Not a diagnosis or clinical recommendation</small></p></div><div className="section-label" style={{ marginTop: 20 }}>Recent sessions</div>{selectedPatient.sessions.slice(0, 4).map((row) => <div className="data-row" key={row.id}><div><div className="data-main">{formatDate(row.started_at)}</div><div className="data-meta">{row.mode || 'hardware'} session</div></div><span className="chip">{row.status}</span></div>)}</section></div></>}
    </>}
    <div className="help-text">Patient records are visible here only through active assignments returned by Supabase RLS. Contact the authorized administrator for access changes; this view cannot grant access.</div>
  </>;
}

function LoginPage({ onSignedIn, notify }: { onSignedIn: () => void; notify: (message: string) => void }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset' | 'update'>(() => {
    if (typeof window === 'undefined') return 'signin';
    return new URLSearchParams(window.location.search).get('auth') === 'recovery' || new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery' ? 'update' : 'signin';
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!supabase) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') { setMode('update'); setError(''); setMessage(''); }
    });
    return () => subscription.unsubscribe();
  }, []);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage('');
    if (!supabase) { setError('Supabase Auth is not configured yet. Demo mode is available while the project setup is completed.'); return; }
    if (mode === 'update' && password !== confirmPassword) { setError('The new password entries do not match.'); return; }
    setBusy(true);
    try {
      if (mode === 'signin') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
        onSignedIn(); notify('You are signed in.');
      } else if (mode === 'signup') {
        const { data, error: authError } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName.trim() }, emailRedirectTo: window.location.origin } });
        if (authError) throw authError;
        if (!data.session) setMessage('Check your inbox to confirm your email, then sign in.');
        else { onSignedIn(); notify('Account created.'); }
      } else if (mode === 'reset') {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/?auth=recovery` });
        if (authError) throw authError;
        setMessage('If an account exists for that address, Supabase has sent password recovery instructions.');
      } else {
        const { error: authError } = await supabase.auth.updateUser({ password });
        if (authError) throw authError;
        onSignedIn(); notify('Your password was updated.');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Authentication request failed.'); }
    finally { setBusy(false); }
  }
  return <div className="auth-page"><section className="auth-aside"><div><Brand /><div style={{ marginTop: 'clamp(26px,10vh,92px)' }}><div className="eyebrow-line">Joint mobility journal</div><h1>Understand<br /><span style={{ color: '#8dd9c2' }}>every movement.</span></h1><p>Bring sensor readings and the symptoms you choose to record into one clear, private view—without turning patterns into diagnoses.</p></div></div><div className="help-text">JointCare AI is a monitoring and record-keeping tool, not a medical device or substitute for care.</div></section><section className="auth-form-side"><div className="auth-card"><div className="eyebrow-line">Account access</div><h2 style={{ fontSize: 25, letterSpacing: '-.045em', margin: '0 0 7px' }}>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create your account' : mode === 'update' ? 'Choose a new password' : 'Reset password'}</h2><p className="card-subtitle" style={{ marginBottom: 22 }}>{mode === 'signin' ? 'Use your Supabase Auth account to open your private records.' : mode === 'signup' ? 'New accounts start as patient accounts. Clinician access requires trusted provisioning.' : mode === 'update' ? 'Set a new password for your account. Your recovery link must still be valid.' : 'We’ll send recovery instructions to the email linked to your account.'}</p>
      {!supabaseConfigured && <div className="form-error" style={{ marginBottom: 15 }}>Supabase browser settings are missing. You can continue in simulated demo mode.</div>}
      <form onSubmit={(event) => void submit(event)}><div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>{mode === 'signup' && <div className="field"><label htmlFor="signup_name">Display name</label><input className="input" id="signup_name" autoComplete="name" maxLength={160} value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></div>}{mode !== 'update' && <div className="field"><label htmlFor="login_email">Email</label><input className="input" id="login_email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>}{mode !== 'reset' && <div className="field"><label htmlFor="login_password">{mode === 'update' ? 'New password' : 'Password'}</label><input className="input" id="login_password" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></div>}{mode === 'update' && <div className="field"><label htmlFor="confirm_password">Confirm new password</label><input className="input" id="confirm_password" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div>}</div>
        {error && <div className="form-error" role="alert" style={{ marginTop: 14 }}>{error}</div>}{message && <div className="form-success" role="status" style={{ marginTop: 14 }}>{message}</div>}
        <button className="btn primary" style={{ width: '100%', marginTop: 17 }} disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'update' ? 'Update password' : 'Send reset instructions'} <ArrowRight size={14} /></button>
      </form><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 17, flexWrap: 'wrap' }}>{mode !== 'signin' ? <button className="btn ghost" onClick={() => { setMode('signin'); setError(''); setMessage(''); }}>Back to sign in</button> : <><button className="btn ghost" onClick={() => { setMode('signup'); setError(''); setMessage(''); }}>Create account</button><button className="btn ghost" onClick={() => { setMode('reset'); setError(''); setMessage(''); }}>Forgot password?</button></>}</div>
      {mode !== 'update' && <button className="btn ghost" style={{ width: '100%', marginTop: 9 }} onClick={() => { window.location.hash = '/dashboard'; window.location.reload(); }}>Continue with simulated demo</button>}
      <p className="help-text" style={{ marginTop: 20 }}>By continuing, you acknowledge that records describe your own reports and sensor data only. No health diagnosis is generated.</p>
    </div></section></div>;
}

const SOS_TEXT_DRAFT = 'I need help. Please contact me as soon as you can.';

function SosDialog({ contact, onClose }: { contact: TrustedEmergencyContact; onClose: () => void }) {
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    const frame = window.requestAnimationFrame(() => document.getElementById('sos-cancel')?.focus());
    return () => { window.removeEventListener('keydown', onKeyDown); window.cancelAnimationFrame(frame); previouslyFocused?.focus(); };
  }, [onClose]);
  const smsHref = `sms:${contact.phone_e164}?body=${encodeURIComponent(SOS_TEXT_DRAFT)}`;
  return <div className="sos-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="sos-dialog" role="dialog" aria-modal="true" aria-labelledby="sos-title" aria-describedby="sos-description" tabIndex={-1}>
      <div className="sos-dialog-head"><span className="sos-symbol"><Phone size={19} /></span><IconButton title="Close SOS dialog" onClick={onClose}><X size={15} /></IconButton></div>
      <div className="eyebrow-line">Confirmation required</div>
      <h2 id="sos-title">Contact {contact.contact_name}?</h2>
      <p id="sos-description" className="card-subtitle">{contact.phone_e164} · Choose a call or text. Nothing has been sent. A call opens your phone app; a text opens an editable draft.</p>
      <div className="sos-choices"><a className="sos-choice call" href={`tel:${contact.phone_e164}`} onClick={onClose}><Phone size={16} />Call trusted contact</a><a className="sos-choice text" href={smsHref} onClick={onClose}><MessageCircle size={16} />Text trusted contact</a></div>
      <p className="sos-disclaimer">No location, sensor, symptom, or health/session information is attached. Device support varies; this does not replace local emergency services.</p>
      <button id="sos-cancel" type="button" className="btn ghost" onClick={onClose}>Cancel</button>
    </section>
  </div>;
}

function App() {
  const [view, setView] = useState<View>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    const recovering = new URLSearchParams(window.location.search).get('auth') === 'recovery' || new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery';
    return recovering ? 'login' : (window.location.hash.replace(/^#\/?/, '') as View) || 'dashboard';
  });
  const [mode, setMode] = useState<AppMode>('demo');
  const [authSession, setAuthSession] = useState<{ access_token: string; user: { id: string; email?: string } } | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceData>(() => getDemoWorkspace());
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [toast, setToast] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof window !== 'undefined' && localStorage.getItem('jointcare.sidebar-collapsed') === 'true');
  const [activeSession, setActiveSession] = useState<MonitoringSession | null>(null);
  const [sosOpen, setSosOpen] = useState(false);
  const userId = authSession?.user.id;
  const role = workspace.profile?.role;
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3300); }, []);
  const reloadWorkspace = useCallback(async () => {
    if (mode !== 'account' || !authSession) return;
    setLoading(true); setPageError('');
    try {
      const fresh = await loadWorkspace(authSession.user.id, authSession.access_token);
      setWorkspace(fresh);
      setActiveSession(fresh.sessions.find((item) => item.status === 'active') || null);
    } catch (cause) { setPageError(cause instanceof Error ? cause.message : 'Unable to load your account data.'); }
    finally { setLoading(false); }
  }, [mode, authSession]);
  useEffect(() => {
    const storedMode = localStorage.getItem('jointcare.mode') as AppMode | null;
    if (storedMode === 'account') setMode('account');
    try {
      const storedSymptoms = JSON.parse(localStorage.getItem('jointcare.demo.symptoms') || '[]') as SymptomRecord[];
      const storedProfile = JSON.parse(localStorage.getItem('jointcare.demo.profile') || 'null') as { display_name?: string; monitored_joint?: string; affected_side?: 'left' | 'right' } | null;
      setWorkspace((previous) => ({ ...previous, profile: { ...previous.profile!, display_name: storedProfile?.display_name || previous.profile?.display_name || 'Demo Patient' }, settings: { ...previous.settings!, monitored_joint: storedProfile?.monitored_joint || previous.settings?.monitored_joint || 'Knee', affected_side: storedProfile?.affected_side || previous.settings?.affected_side || 'left' }, symptoms: [...storedSymptoms, ...previous.symptoms.filter((entry) => !storedSymptoms.some((saved) => saved.id === entry.id))] }));
    } catch { /* Local demo storage is optional and can be cleared safely. */ }
  }, []);
  useEffect(() => {
    let alive = true;
    if (!supabase) return () => { alive = false; };
    void supabase.auth.getSession().then(({ data }) => { if (alive && data.session) { setAuthSession(data.session as typeof authSession); setMode('account'); localStorage.setItem('jointcare.mode', 'account'); } });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setAuthSession(session as typeof authSession);
      if (session) { setMode('account'); localStorage.setItem('jointcare.mode', 'account'); }
      else { setMode('demo'); localStorage.setItem('jointcare.mode', 'demo'); setWorkspace(getDemoWorkspace()); }
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, []);
  useEffect(() => { if (mode === 'demo') setWorkspace(getDemoWorkspace()); else if (authSession) void reloadWorkspace(); }, [mode, authSession, reloadWorkspace]);
  useEffect(() => {
    const onHash = () => { const next = window.location.hash.replace(/^#\/?/, '') as View; if (next && (NAV.some((item) => item.id === next) || next === 'login')) setView(next); };
    window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash);
  }, []);
  function navigate(next: View) { setView(next); setMenuOpen(false); window.location.hash = `/${next}`; }
  const closeSos = useCallback(() => setSosOpen(false), []);
  function openSos() {
    if (mode !== 'account') { notify('SOS is disabled in simulated demo mode. Sign in as a patient and add a trusted contact first.'); return; }
    if (role !== 'patient') return;
    if (!workspace.trustedContact) { notify('Add a trusted contact in Profile before using SOS.'); navigate('profile'); return; }
    setSosOpen(true);
  }
  function changeMode(next: AppMode) {
    if (next === 'account' && !authSession) { navigate('login'); return; }
    setMode(next); localStorage.setItem('jointcare.mode', next); setWorkspace(next === 'demo' ? getDemoWorkspace() : emptyWorkspace());
  }
  async function logout() { if (mode === 'account') await supabase?.auth.signOut(); setAuthSession(null); setMode('demo'); localStorage.setItem('jointcare.mode', 'demo'); setWorkspace(getDemoWorkspace()); navigate('dashboard'); }
  function addSymptom(record: SymptomRecord) { setWorkspace((current) => ({ ...current, symptoms: [record, ...current.symptoms] })); }
  function saveProfileInState(profile: Profile, settings: PatientSettings) { setWorkspace((current) => ({ ...current, profile, settings })); }
  function saveTrustedContactInState(contact: TrustedEmergencyContact | null) { setWorkspace((current) => ({ ...current, trustedContact: contact })); }
  function saveAnalysisInState(analysis: Record<string, unknown>) { setWorkspace((current) => ({ ...current, analysis })); }
  function sessionState(session: MonitoringSession | null) { setActiveSession(session); void reloadWorkspace(); }
  const activeTitle = TITLES[view];
  if (view === 'login') return <LoginPage onSignedIn={() => { setMode('account'); navigate('dashboard'); }} notify={notify} />;
  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <AppNav active={view} onNavigate={navigate} clinician={role === 'clinician'} onLogout={() => void logout()} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((value) => { const next = !value; localStorage.setItem('jointcare.sidebar-collapsed', String(next)); return next; })} />
    <main className="main-area">
      <header className="topbar"><div className="topbar-left"><span className="mobile-menu"><IconButton title="Open navigation" onClick={() => setMenuOpen((value) => !value)}><Menu size={15} /></IconButton></span><div><div className="eyebrow">JointCare AI / {mode === 'demo' ? 'sample workspace' : 'private workspace'}</div><div className="page-title">{activeTitle}</div></div></div><div className="topbar-actions">{(mode === 'demo' || role === 'patient') && <button type="button" className="sos-trigger" onClick={openSos} aria-label="Open SOS trusted contact options" title="Confirm before opening a call or text to your saved trusted contact"><Phone size={14} /><span>SOS</span></button>}<button className={`chip ${mode === 'demo' ? 'amber' : 'mint'}`} onClick={() => changeMode(mode === 'demo' ? 'account' : 'demo')} title="Switch between local simulated sample and signed-in account records"><span className="pulse-dot" />{mode === 'demo' ? 'SIMULATED DEMO' : 'MY RECORDS'}<ChevronDown size={11} /></button>{mode === 'account' && <span className="avatar" title={workspace.profile?.display_name || authSession?.user.email}>{(workspace.profile?.display_name || authSession?.user.email || 'U').slice(0, 1).toUpperCase()}</span>}</div></header>
      {menuOpen && <div style={{ position: 'fixed', zIndex: 50, top: 60, left: 10, right: 10, background: '#141718', border: '1px solid #353b3c', borderRadius: 13, padding: 10, boxShadow: '0 16px 40px #0008' }}>{NAV.filter((item) => item.id !== 'clinician' || role === 'clinician').map((item) => { const Icon = item.icon; return <button className={`nav-button ${view === item.id ? 'active' : ''}`} key={item.id} onClick={() => navigate(item.id)}><Icon size={15} />{item.label}</button>; })}</div>}
      <div className="content">{loading && mode === 'account' && <div className="chip" style={{ marginBottom: 12 }}><RefreshCw size={11} /> Loading permitted records…</div>}{pageError && <div className="form-error" role="alert" style={{ marginBottom: 14 }}>{pageError}<button className="btn ghost" style={{ marginLeft: 10 }} onClick={() => void reloadWorkspace()}>Retry</button></div>}
        {view === 'dashboard' && <Dashboard data={workspace} mode={mode} onNavigate={navigate} accessToken={authSession?.access_token} onAnalysisSaved={saveAnalysisInState} notify={notify} />}
        {view === 'symptoms' && <SymptomTracker data={workspace} mode={mode} userId={userId} onSaved={addSymptom} notify={notify} />}
        {view === 'monitor' && <MonitorPage data={workspace} mode={mode} session={activeSession} accessToken={authSession?.access_token} onReload={reloadWorkspace} onDataSaved={sessionState} notify={notify} />}
        {view === 'history' && <HistoryPage data={workspace} mode={mode} notify={notify} />}
        {view === 'profile' && <ProfilePage data={workspace} mode={mode} userId={userId} accessToken={authSession?.access_token} onProfileSaved={saveProfileInState} onTrustedContactSaved={saveTrustedContactInState} notify={notify} />}
        {view === 'clinician' && <ClinicianPage profile={workspace.profile} userId={userId} />}
      </div>
      <footer style={{ borderTop: '1px solid var(--line)', padding: '16px 34px 26px', color: '#7f8887', fontSize: 10, lineHeight: 1.6 }}>JointCare AI provides a personal monitoring record, not a diagnosis. MPU6050 data cannot directly confirm inflammation. If you have a health concern, consult a qualified clinician.</footer>
    </main>
    <AppNav active={view} onNavigate={navigate} clinician={role === 'clinician'} onLogout={() => void logout()} mobile collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((value) => !value)} />
    {sosOpen && mode === 'account' && role === 'patient' && workspace.trustedContact && <SosDialog contact={workspace.trustedContact} onClose={closeSos} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

export default App;
