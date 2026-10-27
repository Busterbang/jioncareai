import type { SensorReading, SymptomRecord } from '../types';

export interface DailyTrend {
  day: string;
  fullDate: string;
  angle: number | null;
  pain: number | null;
  stiffness: number | null;
}

export function localDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function buildDailyTrends(readings: SensorReading[], symptoms: SymptomRecord[], days = 7): DailyTrend[] {
  const result: DailyTrend[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = localDayKey(date);
    const dayReadings = readings.filter((reading) => localDayKey(reading.measured_at) === key && Number.isFinite(reading.relative_angle_degrees));
    const daySymptoms = symptoms.filter((entry) => localDayKey(entry.recorded_at) === key);
    const average = (values: number[]) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null;
    result.push({
      day: days > 7 ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : date.toLocaleDateString(undefined, { weekday: 'short' }),
      fullDate: key,
      angle: average(dayReadings.map((entry) => Number(entry.relative_angle_degrees))),
      pain: average(daySymptoms.map((entry) => entry.pain_score)),
      stiffness: average(daySymptoms.map((entry) => entry.stiffness_score)),
    });
  }
  return result;
}

export function summarizeObserved(readings: SensorReading[], symptoms: SymptomRecord[]): string {
  if (!readings.length && !symptoms.length) return 'No monitoring records are available in this date range.';
  const angles = [...readings]
    .filter((row): row is SensorReading & { relative_angle_degrees: number } => typeof row.relative_angle_degrees === 'number' && Number.isFinite(row.relative_angle_degrees))
    .sort((left, right) => new Date(left.measured_at).getTime() - new Date(right.measured_at).getTime())
    .map((row) => row.relative_angle_degrees);
  const latest = [...symptoms].sort((left, right) => new Date(right.recorded_at).getTime() - new Date(left.recorded_at).getTime())[0];
  if (!angles.length && latest) return `Your latest reported pain is ${latest.pain_score}/10 and stiffness is ${latest.stiffness_score}/10. Movement-angle data is not available for comparison.`;
  if (!angles.length) return 'Movement samples are present, but relative-angle data is missing. This summary is limited by data quality.';
  const mean = angles.reduce((sum, value) => sum + value, 0) / angles.length;
  const half = Math.floor(angles.length / 2);
  const early = half ? angles.slice(0, half) : angles;
  const late = half ? angles.slice(half) : angles;
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const sentences = [`Across ${angles.length} recorded angle samples, the observed average was ${mean.toFixed(1)}°. Earlier-to-later sample-group averages: ${avg(early).toFixed(1)}° to ${avg(late).toFixed(1)}° (difference ${(avg(late) - avg(early)).toFixed(1)}°).`];
  const daily = new Map<string, { angles: number[]; pains: number[]; stiffnesses: number[] }>();
  for (const reading of readings) {
    if (typeof reading.relative_angle_degrees !== 'number' || !Number.isFinite(reading.relative_angle_degrees)) continue;
    const day = localDayKey(reading.measured_at);
    const current = daily.get(day) || { angles: [], pains: [], stiffnesses: [] };
    current.angles.push(reading.relative_angle_degrees);
    daily.set(day, current);
  }
  for (const symptom of symptoms) {
    const day = localDayKey(symptom.recorded_at);
    const current = daily.get(day) || { angles: [], pains: [], stiffnesses: [] };
    current.pains.push(symptom.pain_score);
    current.stiffnesses.push(symptom.stiffness_score);
    daily.set(day, current);
  }
  const describeAssociation = (label: string, values: Array<{ angle: number; symptom: number }>) => {
    if (values.length < 3) return;
    const meanAngle = avg(values.map((day) => day.angle));
    const meanScore = avg(values.map((day) => day.symptom));
    const numerator = values.reduce((sum, day) => sum + (day.angle - meanAngle) * (day.symptom - meanScore), 0);
    const denomAngle = Math.sqrt(values.reduce((sum, day) => sum + (day.angle - meanAngle) ** 2, 0));
    const denomScore = Math.sqrt(values.reduce((sum, day) => sum + (day.symptom - meanScore) ** 2, 0));
    if (denomAngle > 0 && denomScore > 0) sentences.push(`Across ${values.length} dates with both records, the descriptive daily ${label}/angle association was r=${(numerator / (denomAngle * denomScore)).toFixed(2)}; this does not establish cause or clinical meaning.`);
    else sentences.push(`Movement and ${label} records overlap on ${values.length} dates, but there is not enough variation for a meaningful numerical association.`);
  };
  const painPairs = [...daily.values()].filter((day) => day.angles.length && day.pains.length).map((day) => ({ angle: avg(day.angles), symptom: avg(day.pains) }));
  const stiffnessPairs = [...daily.values()].filter((day) => day.angles.length && day.stiffnesses.length).map((day) => ({ angle: avg(day.angles), symptom: avg(day.stiffnesses) }));
  describeAssociation('pain', painPairs);
  describeAssociation('stiffness', stiffnessPairs);
  if (Math.max(painPairs.length, stiffnessPairs.length) < 3 && latest) sentences.push('Too few dates contain both movement and symptom records for a stable paired trend comparison.');
  const missingAngles = readings.length - angles.length;
  sentences.push(`Data coverage: ${angles.length} usable relative-angle samples of ${readings.length} sensor records${missingAngles ? `; ${missingAngles} missing/invalid angle values` : ''}. Interpret cautiously: sample count, missingness, sensor placement and stationary reference calibration limit comparisons. Relative measurements are not a clinical range. ${latest ? `Latest self-reported pain: ${latest.pain_score}/10; stiffness: ${latest.stiffness_score}/10.` : 'No symptom entry is available for the same period.'}`);
  return sentences.join(' ');
}

export function summarizeDemo(): string {
  return 'Simulated sample only: the example shows movement and symptom signals over several days. It does not represent a person, medical finding, or diagnosis.';
}
