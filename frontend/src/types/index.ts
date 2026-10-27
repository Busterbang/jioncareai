export type UserRole = 'patient' | 'clinician' | 'admin';
export type AppMode = 'demo' | 'account';

export interface Profile {
  id: string;
  display_name: string | null;
  role: UserRole;
  email?: string;
}

export interface PatientSettings {
  patient_id: string;
  monitored_joint: string;
  affected_side: 'left' | 'right';
  preferred_units: 'metric' | 'imperial';
  timezone: string;
}

export interface SymptomRecord {
  id: string;
  patient_id?: string;
  recorded_at: string;
  joint: string;
  pain_score: number;
  stiffness_score: number;
  swelling: boolean;
  discomfort?: string | null;
  activity?: string | null;
  notes?: string | null;
  source?: string;
}

export interface SensorReading {
  id?: string;
  patient_id?: string;
  session_id: string;
  device_id?: string | null;
  measured_at: string;
  accel_x: number;
  accel_y: number;
  accel_z: number;
  gyro_x: number;
  gyro_y: number;
  gyro_z: number;
  relative_angle_degrees?: number | null;
  source: 'device' | 'patient' | 'simulated_demo_only';
  quality?: 'unknown' | 'valid' | 'low' | 'invalid';
}

export interface MonitoringSession {
  id: string;
  patient_id?: string;
  device_id?: string | null;
  mode?: 'real' | 'demo';
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  started_at: string;
  ended_at?: string | null;
}

export interface TrustedEmergencyContact {
  patient_id: string;
  contact_name: string;
  phone_e164: string;
  updated_at?: string;
}

export interface WorkspaceData {
  profile: Profile | null;
  settings: PatientSettings | null;
  sessions: MonitoringSession[];
  readings: SensorReading[];
  symptoms: SymptomRecord[];
  analysis: Record<string, unknown> | null;
  devices: Array<{ id: string; device_identifier: string; is_active: boolean; status: 'active' | 'inactive' | 'revoked'; last_seen_at?: string | null }>;
  trustedContact: TrustedEmergencyContact | null;
}
