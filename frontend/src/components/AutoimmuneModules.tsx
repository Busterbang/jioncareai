import { useState, useMemo } from 'react';
import {
  Pill, AlertTriangle, Activity, ShieldAlert, CheckCircle2,
  Bell, Flame, Heart, TrendingUp, Info, Plus, ChevronRight,
  Sparkles, Clock, AlertCircle, Dumbbell, Compass, RefreshCw
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, Legend, ReferenceLine
} from 'recharts';
import type { WorkspaceData, SymptomRecord } from '../types';

// Types for Autoimmune Features
export interface MedicationItem {
  id: string;
  name: string;
  dosage: string;
  frequency: string;
  category: 'Biologic' | 'DMARD' | 'NSAID' | 'Corticosteroid' | 'Immunosuppressant';
  startDate: string;
  knownSideEffects: string[];
}

export interface MedicationLog {
  id: string;
  medicationId: string;
  takenAt: string;
  status: 'taken' | 'missed' | 'delayed';
  sideEffectsReported?: string[];
  severity?: 'mild' | 'moderate' | 'severe';
  notes?: string;
}

export interface ActivityPainCorrelation {
  day: string;
  steps: number;
  activeMinutes: number;
  strainScore: number; // 0 - 100
  reportedPain: number; // 0 - 10
  swellingNoted: boolean;
}

export interface ExercisePrescription {
  id: string;
  name: string;
  targetJoint: string;
  prescribedRepGoal: number;
  prescribedAngleMin: number;
  prescribedAngleMax: number;
  durationSec: number;
  instructions: string;
}

export function AutoimmuneModules({ data, mode, notify }: { data: WorkspaceData; mode: string; notify: (msg: string) => void }) {
  const [activeTab, setActiveTab] = useState<'meds' | 'analyzer' | 'overuse' | 'rehab'>('meds');

  // 1. Medication & Side-Effect State
  const [medications, setMedications] = useState<MedicationItem[]>([
    {
      id: 'm1',
      name: 'Methotrexate',
      dosage: '15mg',
      frequency: 'Once weekly',
      category: 'DMARD',
      startDate: '2026-08-01',
      knownSideEffects: ['Nausea', 'Fatigue', 'Liver enzyme elevation', 'Mouth sores', 'Headache']
    },
    {
      id: 'm2',
      name: 'Adalimumab (Humira)',
      dosage: '40mg/0.8mL',
      frequency: 'Every 2 weeks',
      category: 'Biologic',
      startDate: '2026-09-15',
      knownSideEffects: ['Injection site rash', 'Upper respiratory infection', 'Headache', 'Fever']
    },
    {
      id: 'm3',
      name: 'Celecoxib (Celebrex)',
      dosage: '100mg',
      frequency: 'As needed (PRN)',
      category: 'NSAID',
      startDate: '2026-10-01',
      knownSideEffects: ['Stomach upset', 'Fluid retention', 'Dizziness', 'Elevated BP']
    }
  ]);

  const [medLogs, setMedLogs] = useState<MedicationLog[]>([
    { id: 'l1', medicationId: 'm1', takenAt: '2026-10-25 09:00', status: 'taken', sideEffectsReported: ['Nausea', 'Fatigue'], severity: 'mild' },
    { id: 'l2', medicationId: 'm2', takenAt: '2026-10-20 18:30', status: 'taken', sideEffectsReported: ['Injection site rash'], severity: 'mild' },
    { id: 'l3', medicationId: 'm3', takenAt: '2026-10-27 12:00', status: 'taken', sideEffectsReported: ['Stomach upset'], severity: 'moderate' }
  ]);

  // New med log form modal/state
  const [selectedMed, setSelectedMed] = useState(medications[0].id);
  const [selectedSideEffect, setSelectedSideEffect] = useState('');
  const [severity, setSeverity] = useState<'mild' | 'moderate' | 'severe'>('mild');
  const [logNotes, setLogNotes] = useState('');

  // 2. Activity vs Pain Correlation Data
  const correlationData: ActivityPainCorrelation[] = useMemo(() => [
    { day: 'Wed (22nd)', steps: 4200, activeMinutes: 35, strainScore: 40, reportedPain: 3, swellingNoted: false },
    { day: 'Thu (23rd)', steps: 6800, activeMinutes: 55, strainScore: 68, reportedPain: 4, swellingNoted: false },
    { day: 'Fri (24th)', steps: 9400, activeMinutes: 80, strainScore: 88, reportedPain: 7, swellingNoted: true },
    { day: 'Sat (25th)', steps: 3100, activeMinutes: 20, strainScore: 30, reportedPain: 6, swellingNoted: true },
    { day: 'Sun (26th)', steps: 2800, activeMinutes: 15, strainScore: 25, reportedPain: 4, swellingNoted: false },
    { day: 'Mon (27th)', steps: 5900, activeMinutes: 50, strainScore: 62, reportedPain: 5, swellingNoted: false },
    { day: 'Today', steps: 7200, activeMinutes: 65, strainScore: 78, reportedPain: 6, swellingNoted: true }
  ], []);

  // 3. Smart Overuse Warning Calculation
  const currentJointStrain = 82; // 0-100 scale computed from IMU angular acceleration + repetitive flexion
  const continuousMotionMinutes = 48; // Continuous motion without adequate rest
  const restingThresholdMinutes = 15;
  const isOveruseTriggered = currentJointStrain > 75 || continuousMotionMinutes >= 45;

  // 4. Activity Recognition & Rehab Exercise Adherence
  const prescriptions: ExercisePrescription[] = [
    {
      id: 'ex1',
      name: 'Controlled Knee Extension',
      targetJoint: 'Knee (Left)',
      prescribedRepGoal: 10,
      prescribedAngleMin: 15,
      prescribedAngleMax: 85,
      durationSec: 180,
      instructions: 'Smooth extension seated on chair. Hold 2s at peak angle (target: 80°-85°).'
    },
    {
      id: 'ex2',
      name: 'Gentle Heel Slides',
      targetJoint: 'Knee (Left)',
      prescribedRepGoal: 8,
      prescribedAngleMin: 20,
      prescribedAngleMax: 90,
      durationSec: 150,
      instructions: 'Slide heel smoothly along flat surface without jerky acceleration.'
    }
  ];

  // Simulated Exercise Session Live Recognition
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [exerciseProgress, setExerciseProgress] = useState({ reps: 6, correctFormPercent: 88, currentAngle: 78, status: 'Matching Prescribed Motion' });

  const handleRecordMed = () => {
    const med = medications.find(m => m.id === selectedMed);
    const newEntry: MedicationLog = {
      id: `l_${Date.now()}`,
      medicationId: selectedMed,
      takenAt: new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'taken',
      sideEffectsReported: selectedSideEffect ? [selectedSideEffect] : [],
      severity: selectedSideEffect ? severity : undefined,
      notes: logNotes
    };
    setMedLogs([newEntry, ...medLogs]);
    notify(`Logged dose of ${med?.name || 'medication'}${selectedSideEffect ? ' with side-effect notice' : ''}`);
    setSelectedSideEffect('');
    setLogNotes('');
  };

  return (
    <div className="section-card" style={{ marginBottom: 24, border: '1px solid #2e3838', background: '#121617' }}>
      {/* Sub-Navigation Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #273030', paddingBottom: 16, marginBottom: 20, gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ padding: '6px 8px', borderRadius: 8, background: 'rgba(57, 196, 172, 0.15)', color: '#39c4ac' }}>
              <Sparkles size={18} />
            </span>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#f0f3f2' }}>
                Autoimmune & Intelligent Joint Care Suite
              </h2>
              <p style={{ margin: 0, fontSize: 12, color: '#8d9997' }}>
                Medication tracking, side-effect vigilance, activity vs. pain analytics, overuse protection & exercise compliance
              </p>
            </div>
          </div>
        </div>

        {/* Tab Switcher */}
        <div style={{ display: 'flex', background: '#191f20', borderRadius: 10, padding: 4, gap: 4 }}>
          <button
            onClick={() => setActiveTab('meds')}
            className={`btn small ${activeTab === 'meds' ? 'primary' : 'ghost'}`}
            style={{ borderRadius: 8, padding: '6px 12px', fontSize: 12 }}
          >
            <Pill size={14} style={{ marginRight: 6 }} />
            Meds & Side Effects
          </button>
          <button
            onClick={() => setActiveTab('analyzer')}
            className={`btn small ${activeTab === 'analyzer' ? 'primary' : 'ghost'}`}
            style={{ borderRadius: 8, padding: '6px 12px', fontSize: 12 }}
          >
            <TrendingUp size={14} style={{ marginRight: 6 }} />
            Activity vs Pain
          </button>
          <button
            onClick={() => setActiveTab('overuse')}
            className={`btn small ${activeTab === 'overuse' ? 'primary' : 'ghost'}`}
            style={{ borderRadius: 8, padding: '6px 12px', fontSize: 12 }}
          >
            <ShieldAlert size={14} style={{ marginRight: 6 }} />
            Overuse & Rest Alert
          </button>
          <button
            onClick={() => setActiveTab('rehab')}
            className={`btn small ${activeTab === 'rehab' ? 'primary' : 'ghost'}`}
            style={{ borderRadius: 8, padding: '6px 12px', fontSize: 12 }}
          >
            <Dumbbell size={14} style={{ marginRight: 6 }} />
            Prescribed Exercise Check
          </button>
        </div>
      </div>

      {/* TAB 1: Autoimmune Disease Medication & Symptom / Side-Effect Tracker */}
      {activeTab === 'meds' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
          {/* Active Prescriptions & Side-Effect Alert Matrix */}
          <div style={{ background: '#171c1d', padding: 18, borderRadius: 12, border: '1px solid #283233' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0e5e4', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pill size={16} color="#39c4ac" /> Autoimmune Medications & Alert Radar
              </h3>
              <span className="chip mint" style={{ fontSize: 10 }}>{medications.length} Active Protocols</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {medications.map((m) => (
                <div key={m.id} style={{ background: '#1c2224', padding: 12, borderRadius: 10, border: '1px solid #2a3536' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 600, color: '#f3f6f5', fontSize: 13 }}>{m.name}</div>
                      <div style={{ fontSize: 11, color: '#889593' }}>{m.dosage} • {m.frequency}</div>
                    </div>
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, background: 'rgba(57, 196, 172, 0.1)', color: '#39c4ac', border: '1px solid rgba(57, 196, 172, 0.2)' }}>
                      {m.category}
                    </span>
                  </div>

                  {/* Side-Effect Warning Radar */}
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #283435' }}>
                    <div style={{ fontSize: 11, color: '#f39c12', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                      <AlertTriangle size={12} /> Monitored Adverse Reactions:
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {m.knownSideEffects.map((se) => (
                        <span key={se} style={{ fontSize: 10, background: '#252d2f', color: '#b5c0be', padding: '2px 6px', borderRadius: 4 }}>
                          {se}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Side-Effect Warning Box */}
            <div style={{ marginTop: 14, background: 'rgba(231, 76, 60, 0.08)', border: '1px solid rgba(231, 76, 60, 0.25)', borderRadius: 10, padding: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
              <ShieldAlert size={24} color="#e74c3c" style={{ flexShrink: 0 }} />
              <div style={{ fontSize: 11, color: '#f8d7da', lineHeight: 1.4 }}>
                <strong>Vigilance System Active:</strong> Any sudden rash, prolonged fever, or gastrointestinal distress logged alongside DMARD/Biologics will alert your clinician dashboard immediately.
              </div>
            </div>
          </div>

          {/* Quick Log Dose & Symptoms */}
          <div style={{ background: '#171c1d', padding: 18, borderRadius: 12, border: '1px solid #283233' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0e5e4', margin: '0 0 14px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Clock size={16} color="#39c4ac" /> Log Dose & Symptoms / Side-Effects
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: '#909d9b', display: 'block', marginBottom: 4 }}>Select Medication</label>
                <select
                  className="input-select"
                  value={selectedMed}
                  onChange={(e) => setSelectedMed(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', background: '#202728', border: '1px solid #333e3f', color: '#e1e5e4', borderRadius: 8, fontSize: 12 }}
                >
                  {medications.map(m => (
                    <option key={m.id} value={m.id}>{m.name} ({m.dosage})</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: 11, color: '#909d9b', display: 'block', marginBottom: 4 }}>Report Adverse Reaction / Side-Effect (Optional)</label>
                <select
                  className="input-select"
                  value={selectedSideEffect}
                  onChange={(e) => setSelectedSideEffect(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', background: '#202728', border: '1px solid #333e3f', color: '#e1e5e4', borderRadius: 8, fontSize: 12 }}
                >
                  <option value="">No adverse side effects observed</option>
                  {medications.find(m => m.id === selectedMed)?.knownSideEffects.map(se => (
                    <option key={se} value={se}>{se}</option>
                  ))}
                  <option value="Severe Joint Flare">Severe Joint Flare Post-Dose</option>
                  <option value="Other Unusual Symptom">Other Unusual Symptom</option>
                </select>
              </div>

              {selectedSideEffect && (
                <div>
                  <label style={{ fontSize: 11, color: '#909d9b', display: 'block', marginBottom: 4 }}>Severity Assessment</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['mild', 'moderate', 'severe'] as const).map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSeverity(s)}
                        className={`btn small ${severity === s ? (s === 'severe' ? 'destructive' : 'primary') : 'ghost'}`}
                        style={{ flex: 1, textTransform: 'capitalize', fontSize: 11, borderRadius: 6 }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label style={{ fontSize: 11, color: '#909d9b', display: 'block', marginBottom: 4 }}>Notes & Patient Sensations</label>
                <input
                  type="text"
                  placeholder="e.g. Mild headache 1h post-injection, knee warmth"
                  value={logNotes}
                  onChange={(e) => setLogNotes(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', background: '#202728', border: '1px solid #333e3f', color: '#e1e5e4', borderRadius: 8, fontSize: 12 }}
                />
              </div>

              <button
                type="button"
                onClick={handleRecordMed}
                className="btn primary"
                style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, padding: 10, borderRadius: 8 }}
              >
                <CheckCircle2 size={15} /> Confirm Dose & Check Side-Effects
              </button>
            </div>

            {/* Recent Log History */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, color: '#7a8785', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Recent Intake Log
              </div>
              <div style={{ maxHeight: 130, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {medLogs.map(l => {
                  const m = medications.find(item => item.id === l.medicationId);
                  return (
                    <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1c2223', padding: '6px 10px', borderRadius: 6, fontSize: 11, border: '1px solid #283132' }}>
                      <div>
                        <span style={{ fontWeight: 600, color: '#e2e7e6' }}>{m?.name}</span>
                        <span style={{ color: '#788684', marginLeft: 6 }}>{l.takenAt}</span>
                      </div>
                      {l.sideEffectsReported && l.sideEffectsReported.length > 0 ? (
                        <span style={{ color: l.severity === 'severe' ? '#e74c3c' : '#f39c12', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <AlertTriangle size={11} /> {l.sideEffectsReported[0]} ({l.severity})
                        </span>
                      ) : (
                        <span style={{ color: '#39c4ac', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <CheckCircle2 size={11} /> Normal
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Smart Daily Activity vs Joint Pain Analyzer */}
      {activeTab === 'analyzer' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 20 }}>
            <div style={{ background: '#171c1d', padding: 16, borderRadius: 10, border: '1px solid #273030' }}>
              <div style={{ fontSize: 11, color: '#8c9896', textTransform: 'uppercase' }}>7-Day Strain Impact</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#f2f6f5', marginTop: 4 }}>
                +1.8 Pain / 3k Steps
              </div>
              <p style={{ margin: '6px 0 0 0', fontSize: 12, color: '#f39c12', display: 'flex', alignItems: 'center', gap: 5 }}>
                <TrendingUp size={14} /> Correlated threshold: Days exceeding 7,000 steps trigger acute pain spikes on the following day.
              </p>
            </div>

            <div style={{ background: '#171c1d', padding: 16, borderRadius: 10, border: '1px solid #273030' }}>
              <div style={{ fontSize: 11, color: '#8c9896', textTransform: 'uppercase' }}>Recommended Safe Mobility Window</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#39c4ac', marginTop: 4 }}>
                4,500 – 6,000 Steps
              </div>
              <p style={{ margin: '6px 0 0 0', fontSize: 12, color: '#97a3a1' }}>
                Maintains synovial fluid circulation without aggravating cartilage inflammation.
              </p>
            </div>

            <div style={{ background: '#171c1d', padding: 16, borderRadius: 10, border: '1px solid #273030' }}>
              <div style={{ fontSize: 11, color: '#8c9896', textTransform: 'uppercase' }}>Flare Risk Predictor</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#e74c3c', marginTop: 4 }}>
                Elevated (Friday Spike)
              </div>
              <p style={{ margin: '6px 0 0 0', fontSize: 12, color: '#b5c0be' }}>
                Swelling detected after 9,400 steps on Friday required 48h to return to baseline pain levels.
              </p>
            </div>
          </div>

          {/* Dual Correlation Chart */}
          <div style={{ background: '#171c1d', padding: 20, borderRadius: 12, border: '1px solid #283233' }}>
            <h4 style={{ margin: '0 0 16px 0', fontSize: 13, color: '#e3e8e7', fontWeight: 600 }}>
              Daily Step Volume & Motion Strain vs. Reported Joint Pain Score (0–10)
            </h4>
            <div style={{ height: 260, width: '100%' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={correlationData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="strainGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#39c4ac" stopOpacity={0.4}/>
                      <stop offset="95%" stopColor="#39c4ac" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="painGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#e74c3c" stopOpacity={0.5}/>
                      <stop offset="95%" stopColor="#e74c3c" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#252d2f" />
                  <XAxis dataKey="day" stroke="#687574" fontSize={11} />
                  <YAxis yAxisId="left" stroke="#39c4ac" fontSize={11} domain={[0, 100]} />
                  <YAxis yAxisId="right" orientation="right" stroke="#e74c3c" fontSize={11} domain={[0, 10]} />
                  <Tooltip
                    contentStyle={{ background: '#181e1f', border: '1px solid #323d3e', borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: '#abb6b4', fontWeight: 600 }}
                  />
                  <ReferenceLine yAxisId="left" y={75} stroke="#f39c12" strokeDasharray="3 3" label={{ value: 'Overuse Danger Zone', fill: '#f39c12', fontSize: 10 }} />
                  <Area yAxisId="left" type="monotone" dataKey="strainScore" name="Motion Strain (0-100)" stroke="#39c4ac" strokeWidth={2} fillOpacity={1} fill="url(#strainGrad)" />
                  <Area yAxisId="right" type="monotone" dataKey="reportedPain" name="Joint Pain (0-10)" stroke="#e74c3c" strokeWidth={2.5} fillOpacity={1} fill="url(#painGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginTop: 12, fontSize: 11, color: '#8e9c9a' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 12, height: 3, background: '#39c4ac', borderRadius: 2 }} /> Motion Strain Index</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 12, height: 3, background: '#e74c3c', borderRadius: 2 }} /> Patient Pain Score</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 12, height: 0, borderTop: '2px dashed #f39c12' }} /> Overuse Threshold</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Smart Joint Overuse Warning System (Rest eduka use agum) */}
      {activeTab === 'overuse' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
          {/* Overuse Gauge & Current Status */}
          <div style={{ background: '#171c1d', padding: 20, borderRadius: 12, border: '1px solid #283233' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0e5e4', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <ShieldAlert size={18} color={isOveruseTriggered ? '#e74c3c' : '#39c4ac'} />
                Live Joint Overuse Guard
              </h3>
              <span className={`chip ${isOveruseTriggered ? 'destructive' : 'mint'}`} style={{ fontSize: 10 }}>
                {isOveruseTriggered ? 'REST REQUIRED NOW' : 'NORMAL LOAD'}
              </span>
            </div>

            {/* Overuse Warning Card */}
            <div style={{
              background: isOveruseTriggered ? 'rgba(231, 76, 60, 0.12)' : 'rgba(57, 196, 172, 0.08)',
              border: `1px solid ${isOveruseTriggered ? '#e74c3c' : '#39c4ac'}`,
              borderRadius: 12,
              padding: 16,
              marginBottom: 16
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Bell size={20} color={isOveruseTriggered ? '#e74c3c' : '#39c4ac'} className="pulse-dot" />
                <div style={{ fontSize: 14, fontWeight: 700, color: isOveruseTriggered ? '#ff8577' : '#39c4ac' }}>
                  {isOveruseTriggered ? '⚠️ High Joint Strain Detected: Rest Eduka Use Agum!' : 'Joint Strain Within Safe Physiological Limits'}
                </div>
              </div>
              <p style={{ margin: 0, fontSize: 12, color: '#d1dbd9', lineHeight: 1.5 }}>
                {isOveruseTriggered
                  ? 'Continuous weight-bearing motion has exceeded safe limits (48 mins active without decompression). Please sit down, elevate the affected knee, and take a 15-minute rest interval to prevent inflammatory flare-ups.'
                  : 'Your continuous joint loading is monitored in real-time using IMU angular acceleration. You are currently within a safe joint movement window.'}
              </p>
            </div>

            {/* Metrics Breakdown */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ background: '#1c2224', padding: 12, borderRadius: 8, border: '1px solid #2a3435' }}>
                <div style={{ fontSize: 11, color: '#83918f' }}>Current Strain Score</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: currentJointStrain > 75 ? '#e74c3c' : '#39c4ac', marginTop: 2 }}>
                  {currentJointStrain}/100
                </div>
                <div style={{ fontSize: 10, color: '#f39c12', marginTop: 4 }}>Threshold: 75/100</div>
              </div>

              <div style={{ background: '#1c2224', padding: 12, borderRadius: 8, border: '1px solid #2a3435' }}>
                <div style={{ fontSize: 11, color: '#83918f' }}>Continuous Motion</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: continuousMotionMinutes >= 45 ? '#e74c3c' : '#f2f6f5', marginTop: 2 }}>
                  {continuousMotionMinutes} mins
                </div>
                <div style={{ fontSize: 10, color: '#83918f', marginTop: 4 }}>Rest trigger: 45 mins</div>
              </div>
            </div>

            {/* Rest Timer Guide */}
            <div style={{ marginTop: 16, background: '#1d2426', padding: 12, borderRadius: 8, border: '1px solid #2d3839' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Clock size={16} color="#39c4ac" />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e5e9e8' }}>Prescribed Rest Interval</div>
                    <div style={{ fontSize: 11, color: '#8a9795' }}>Target: {restingThresholdMinutes} mins non-weight bearing</div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn small primary"
                  onClick={() => notify('15-Minute Joint Rest Timer started! Please relax and elevate your joint.')}
                  style={{ fontSize: 11, borderRadius: 6 }}
                >
                  Start Rest Timer
                </button>
              </div>
            </div>
          </div>

          {/* Clinical Rest Guidelines & Flare Prevention */}
          <div style={{ background: '#171c1d', padding: 20, borderRadius: 12, border: '1px solid #283233' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0e5e4', margin: '0 0 14px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Info size={16} color="#39c4ac" /> Joint Protection Protocol (Arthritis / Lupus / RA)
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, color: '#b2bebc' }}>
              <div style={{ display: 'flex', gap: 10, background: '#1d2325', padding: 10, borderRadius: 8 }}>
                <span style={{ color: '#39c4ac', fontWeight: 700 }}>1.</span>
                <div>
                  <strong style={{ color: '#f0f3f2' }}>The "20-Minute Rule":</strong> Avoid sitting or standing in a single fixed joint angle for more than 20–30 minutes to reduce stiffness.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, background: '#1d2325', padding: 10, borderRadius: 8 }}>
                <span style={{ color: '#39c4ac', fontWeight: 700 }}>2.</span>
                <div>
                  <strong style={{ color: '#f0f3f2' }}>Pain Lag Phenomenon:</strong> Joint inflammation from overuse often peaks 12–24 hours after excessive loading. Stop activities before acute pain sets in.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, background: '#1d2325', padding: 10, borderRadius: 8 }}>
                <span style={{ color: '#39c4ac', fontWeight: 700 }}>3.</span>
                <div>
                  <strong style={{ color: '#f0f3f2' }}>Elevation & Cold Packs:</strong> When the overuse warning fires, elevate the knee to hip level and apply cold therapy for 10–15 minutes if warmth or swelling is noted.
                </div>
              </div>
            </div>

            <div style={{ marginTop: 18, borderTop: '1px solid #273132', paddingTop: 14 }}>
              <div style={{ fontSize: 11, color: '#7e8c8a', marginBottom: 6 }}>Auto-notification to Clinician</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1c2223', padding: '8px 12px', borderRadius: 8, fontSize: 11 }}>
                <span style={{ color: '#c4cecc' }}>Repeated Overuse Flares (&gt;3/week)</span>
                <span className="chip mint" style={{ fontSize: 9 }}>Flagged for Review</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Smart Joint Assessment With Activity Recognition (Patient crt ah prescribe panna excercise than seirangala nu pakka) */}
      {activeTab === 'rehab' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
          {/* Active Prescribed Exercises */}
          <div style={{ background: '#171c1d', padding: 20, borderRadius: 12, border: '1px solid #283233' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0e5e4', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Dumbbell size={16} color="#39c4ac" /> Prescribed Exercises (Clinician Prescription)
              </h3>
              <span className="chip mint" style={{ fontSize: 10 }}>2 Prescribed</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {prescriptions.map((ex) => (
                <div key={ex.id} style={{ background: '#1c2224', padding: 14, borderRadius: 10, border: '1px solid #2b3536' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 600, color: '#f4f7f6', fontSize: 13 }}>{ex.name}</div>
                      <div style={{ fontSize: 11, color: '#889593' }}>Target: {ex.targetJoint} • Goal: {ex.prescribedRepGoal} repetitions</div>
                    </div>
                    <span style={{ fontSize: 10, background: 'rgba(57, 196, 172, 0.1)', color: '#39c4ac', padding: '2px 8px', borderRadius: 4 }}>
                      Angle Range: {ex.prescribedAngleMin}° – {ex.prescribedAngleMax}°
                    </span>
                  </div>

                  <p style={{ margin: '8px 0 0 0', fontSize: 11, color: '#b0bbba', lineHeight: 1.4 }}>
                    {ex.instructions}
                  </p>
                </div>
              ))}
            </div>

            {/* Sensor Activity Recognition Summary */}
            <div style={{ marginTop: 16, background: '#1b2223', padding: 14, borderRadius: 10, border: '1px solid #293335' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#e0e5e4', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Compass size={14} color="#39c4ac" /> Exercise Adherence Verification
              </div>
              <div style={{ fontSize: 11, color: '#8f9c9a', lineHeight: 1.4 }}>
                The IMU sensor measures angle amplitude, hold time, and angular acceleration to verify whether the patient is performing the exact exercise as prescribed or compensating with incorrect motion.
              </div>
            </div>
          </div>

          {/* Real-time Recognition & Form Verification Camera/IMU Panel */}
          <div style={{ background: '#171c1d', padding: 20, borderRadius: 12, border: '1px solid #283233' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0e5e4', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Activity size={16} color="#39c4ac" /> Live Motion & Rep Form Verifier
              </h3>
              <span className={`chip ${isRecognizing ? 'mint' : 'ghost'}`} style={{ fontSize: 10 }}>
                {isRecognizing ? 'AI TRACKING ACTIVE' : 'STANDBY'}
              </span>
            </div>

            {/* Recognition Status Screen */}
            <div style={{
              background: '#131718',
              borderRadius: 12,
              padding: 20,
              border: `2px dashed ${isRecognizing ? '#39c4ac' : '#333e40'}`,
              textAlign: 'center',
              marginBottom: 16
            }}>
              <div style={{ fontSize: 13, color: '#8e9c9a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Detected Activity & Form Accuracy
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: isRecognizing ? '#39c4ac' : '#f0f3f2', margin: '8px 0' }}>
                {isRecognizing ? 'Controlled Knee Extension (Correct Form)' : 'Knee Extension Ready'}
              </div>

              {/* Progress and Rep Count */}
              <div style={{ display: 'flex', justifyContent: 'space-around', margin: '16px 0', borderTop: '1px solid #222a2b', paddingTop: 12 }}>
                <div>
                  <div style={{ fontSize: 10, color: '#7a8785' }}>REPS COMPLETED</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#f3f6f5' }}>
                    {exerciseProgress.reps} / 10
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: '#7a8785' }}>CURRENT ANGLE</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#39c4ac' }}>
                    {exerciseProgress.currentAngle}°
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: '#7a8785' }}>FORM COMPLIANCE</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#2ecc71' }}>
                    {exerciseProgress.correctFormPercent}%
                  </div>
                </div>
              </div>

              <div style={{
                background: 'rgba(57, 196, 172, 0.1)',
                padding: '8px 12px',
                borderRadius: 8,
                fontSize: 11,
                color: '#39c4ac',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6
              }}>
                <CheckCircle2 size={13} /> Motion matched prescribed trajectory (No compensatory hip hike detected)
              </div>
            </div>

            {/* Control Button */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                className={`btn ${isRecognizing ? 'ghost' : 'primary'}`}
                style={{ flex: 1, padding: 10, fontSize: 12, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={() => {
                  const next = !isRecognizing;
                  setIsRecognizing(next);
                  if (next) {
                    notify('AI Activity Recognition Active: Tracking prescribed knee exercise motion!');
                  } else {
                    notify('Exercise session paused. Form data logged for clinician review.');
                  }
                }}
              >
                {isRecognizing ? (
                  <>Pause Exercise Session</>
                ) : (
                  <>
                    <Dumbbell size={15} /> Start Prescribed Exercise Verification
                  </>
                )}
              </button>

              <button
                type="button"
                className="btn ghost"
                style={{ padding: '10px 14px', borderRadius: 8, fontSize: 12 }}
                onClick={() => {
                  setExerciseProgress({
                    reps: Math.min(10, exerciseProgress.reps + 1),
                    correctFormPercent: 91,
                    currentAngle: 82,
                    status: 'Perfect Full Extension'
                  });
                  notify('Rep verified! Angle reached 82° with steady 2s hold.');
                }}
              >
                <Plus size={14} /> Simulate Rep
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
