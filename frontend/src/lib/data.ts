import { supabase } from './supabase';
import { summarizeObserved } from './analytics';
import type { MonitoringSession, PatientSettings, Profile, SensorReading, SymptomRecord, TrustedEmergencyContact, WorkspaceData } from '../types';

export const emptyWorkspace = (): WorkspaceData => ({ profile: null, settings: null, sessions: [], readings: [], symptoms: [], analysis: null, devices: [], trustedContact: null });

const daysAgo = (days: number, hour = 9) => {
  const value = new Date();
  value.setDate(value.getDate() - days);
  value.setHours(hour, 0, 0, 0);
  return value.toISOString();
};

export function getDemoWorkspace(): WorkspaceData {
  const symptoms: SymptomRecord[] = [
    { id: 'demo-s-1', recorded_at: daysAgo(0, 8), joint: 'Knee', pain_score: 3, stiffness_score: 2, swelling: false, activity: 'Morning walk', source: 'simulated_demo_only' },
    { id: 'demo-s-2', recorded_at: daysAgo(1), joint: 'Knee', pain_score: 4, stiffness_score: 3, swelling: false, activity: 'Light stretching', source: 'simulated_demo_only' },
    { id: 'demo-s-3', recorded_at: daysAgo(2), joint: 'Knee', pain_score: 3, stiffness_score: 3, swelling: false, activity: 'Desk work', source: 'simulated_demo_only' },
    { id: 'demo-s-4', recorded_at: daysAgo(3), joint: 'Knee', pain_score: 5, stiffness_score: 4, swelling: false, activity: 'Long walk', source: 'simulated_demo_only' },
    { id: 'demo-s-5', recorded_at: daysAgo(4), joint: 'Knee', pain_score: 4, stiffness_score: 3, swelling: false, activity: 'Household activity', source: 'simulated_demo_only' },
    { id: 'demo-s-6', recorded_at: daysAgo(5), joint: 'Knee', pain_score: 3, stiffness_score: 2, swelling: false, activity: 'Rest day', source: 'simulated_demo_only' },
    { id: 'demo-s-7', recorded_at: daysAgo(6), joint: 'Knee', pain_score: 4, stiffness_score: 3, swelling: false, activity: 'Easy cycling', source: 'simulated_demo_only' },
  ];
  const angles = [24, 25, 22, 21, 23, 26, 25];
  const readings: SensorReading[] = angles.flatMap((angle, index) => [0, 1, 2].map((sample) => ({
    id: `demo-r-${index}-${sample}`, session_id: `demo-session-${index}`, measured_at: daysAgo(6 - index, 9 + sample),
    accel_x: 0.1 + sample * 0.02, accel_y: 0.04, accel_z: 9.7, gyro_x: 0.02, gyro_y: 0.01, gyro_z: 0.03,
    relative_angle_degrees: angle + sample * 0.4, source: 'simulated_demo_only' as const, quality: 'valid' as const,
  })));
  const sessions: MonitoringSession[] = Array.from({ length: 5 }, (_, index) => ({
    id: `demo-session-${index}`, mode: 'demo', status: 'completed', started_at: daysAgo(index, 9), ended_at: daysAgo(index, 9.25),
  }));
  const workspace: WorkspaceData = {
    profile: { id: 'demo-patient', display_name: 'Demo Patient', role: 'patient' },
    settings: { patient_id: 'demo-patient', monitored_joint: 'Knee', affected_side: 'left', preferred_units: 'metric', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    sessions,
    readings,
    symptoms,
    analysis: { summary: 'Simulated sample only: observed movement-angle readings vary across the example sessions. This is not a medical finding.' },
    devices: [],
    trustedContact: null,
  };
  if (typeof window !== 'undefined') {
    try {
      const savedSymptoms = JSON.parse(localStorage.getItem('jointcare.demo.symptoms') || '[]') as SymptomRecord[];
      const savedProfile = JSON.parse(localStorage.getItem('jointcare.demo.profile') || 'null') as { display_name?: string; monitored_joint?: string; affected_side?: 'left' | 'right' } | null;
      workspace.symptoms = [...savedSymptoms, ...symptoms.filter((entry) => !savedSymptoms.some((saved) => saved.id === entry.id))];
      if (workspace.profile && savedProfile?.display_name) workspace.profile.display_name = savedProfile.display_name;
      if (workspace.settings && savedProfile) {
        workspace.settings.monitored_joint = savedProfile.monitored_joint || workspace.settings.monitored_joint;
        workspace.settings.affected_side = savedProfile.affected_side || workspace.settings.affected_side;
      }
    } catch { /* Optional local demo data may be cleared without affecting account records. */ }
  }
  return workspace;
}

export async function loadWorkspace(userId: string, accessToken: string): Promise<WorkspaceData> {
  if (!supabase) throw new Error('Supabase is not configured. Use demo mode or configure the browser-safe project variables.');
  
  // Safely attempt device fetch from backend, returning empty list if backend is not running
  const fetchDevices = async (): Promise<WorkspaceData['devices']> => {
    try {
      return await postApi<WorkspaceData['devices']>('/api/v1/sensor/devices/status', accessToken);
    } catch {
      return [];
    }
  };

  const [profileResult, settingResult, sessionsResult, readingsResult, symptomsResult, analysisResult, devices, contactResult] = await Promise.all([
    supabase.from('profiles').select('id,display_name,role').eq('id', userId).maybeSingle(),
    supabase.from('patient_settings').select('patient_id,monitored_joint,affected_side,preferred_units,timezone').eq('patient_id', userId).maybeSingle(),
    supabase.from('monitoring_sessions').select('id,patient_id,device_id,mode,status,started_at,ended_at').eq('patient_id', userId).order('started_at', { ascending: false }).limit(50),
    supabase.from('sensor_readings').select('id,patient_id,session_id,device_id,measured_at,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,relative_angle_degrees,source,quality').eq('patient_id', userId).order('measured_at', { ascending: false }).limit(500),
    supabase.from('symptom_records').select('id,patient_id,recorded_at,joint,pain_score,stiffness_score,swelling,discomfort,activity,notes,source').eq('patient_id', userId).order('recorded_at', { ascending: false }).limit(100),
    supabase.from('analysis_results').select('summary,metrics,quality,generated_at').eq('patient_id', userId).order('generated_at', { ascending: false }).limit(1).maybeSingle(),
    fetchDevices(),
    supabase.from('trusted_emergency_contacts').select('patient_id,contact_name,phone_e164,updated_at').eq('patient_id', userId).maybeSingle(),
  ]);
  const errors = [profileResult.error, settingResult.error, sessionsResult.error, readingsResult.error, symptomsResult.error, analysisResult.error, contactResult.error].filter(Boolean);
  if (errors.length) throw new Error(errors[0]?.message || 'Could not load your permitted Supabase records. Apply the migration and check RLS policies.');
  return {
    profile: profileResult.data as Profile | null,
    settings: settingResult.data as PatientSettings | null,
    sessions: (sessionsResult.data || []) as MonitoringSession[],
    readings: (readingsResult.data || []) as SensorReading[],
    symptoms: (symptomsResult.data || []) as SymptomRecord[],
    analysis: analysisResult.data ? { summary: analysisResult.data.summary, metrics: analysisResult.data.metrics, quality: analysisResult.data.quality, generated_at: analysisResult.data.generated_at } : (sessionsResult.data?.length ? { summary: summarizeObserved((readingsResult.data || []) as SensorReading[], (symptomsResult.data || []) as SymptomRecord[]) } : null),
    devices,
    trustedContact: contactResult.data as TrustedEmergencyContact | null,
  };
}

export async function saveSymptom(userId: string, entry: Omit<SymptomRecord, 'id'>) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.from('symptom_records').insert({ ...entry, patient_id: userId, source: 'patient' }).select().single();
  if (error) throw error;
  return data as SymptomRecord;
}

export async function saveProfile(userId: string, displayName: string, settings: Partial<PatientSettings>) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const profile = await supabase.from('profiles').update({ display_name: displayName.trim() || null }).eq('id', userId);
  if (profile.error) throw profile.error;
  const setting = await supabase.from('patient_settings').upsert({ patient_id: userId, monitored_joint: settings.monitored_joint || 'Knee', affected_side: settings.affected_side || 'left', preferred_units: settings.preferred_units || 'metric', timezone: settings.timezone || 'UTC' }, { onConflict: 'patient_id' });
  if (setting.error) throw setting.error;
}

export function isValidE164Phone(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export async function saveTrustedContact(userId: string, contactName: string, phoneE164: string): Promise<TrustedEmergencyContact> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const name = contactName.trim();
  const phone = phoneE164.trim();
  if (!name || name.length > 100) throw new Error('Enter a trusted contact name (up to 100 characters).');
  if (!isValidE164Phone(phone)) throw new Error('Enter the trusted contact number in international E.164 format, for example +15551234567.');
  const { data, error } = await supabase.from('trusted_emergency_contacts').upsert({ patient_id: userId, contact_name: name, phone_e164: phone }, { onConflict: 'patient_id' }).select('patient_id,contact_name,phone_e164,updated_at').single();
  if (error) throw error;
  return data as TrustedEmergencyContact;
}

export async function deleteTrustedContact(userId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.from('trusted_emergency_contacts').delete().eq('patient_id', userId);
  if (error) throw error;
}

export async function postApi<T>(path: string, accessToken: string, body?: unknown): Promise<T> {
  const send = (token: string) => fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let token = accessToken;
  if (supabase) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) token = data.session.access_token;
    } catch { /* Fall back to the token supplied by the current auth state. */ }
  }
  let response = await send(token);
  const readResult = async (candidate: Response): Promise<Record<string, unknown>> => {
    const value = await candidate.json().catch(() => ({}));
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  };
  let result = await readResult(response);
  const detail = typeof result.detail === 'string' ? result.detail : '';
  // Every caller of postApi is an authenticated application request. A 401 may
  // occur after the page's auth state captured an older token, so refresh once
  // regardless of the safe server detail and retry with the current user session.
  if (response.status === 401 && supabase) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session?.access_token) {
      throw new Error('Your sign-in session has expired or could not be refreshed. Sign out and sign in again, then retry.');
    }
    response = await send(data.session.access_token);
    result = await readResult(response);
  }
  if (!response.ok) {
    const errorDetail = typeof result.detail === 'string' ? result.detail : '';
    if (response.status === 401) {
      throw new Error('Your sign-in session is no longer valid. Sign out and sign in again, then retry.');
    }
    throw new Error(errorDetail || `Request failed (${response.status})`);
  }
  return result as T;
}
