import { useEffect } from 'react';
import type { Catalog } from '../api';
import { TZ, addDays, localDay, rangeLabel, weekStart } from '../format';
import { DatePicker } from './DatePicker';

/** Filtro de análisis. `to` es EXCLUSIVO, como en la API; la interfaz muestra «Hasta» incluido (to − 1 día). */
export interface StatsFilter { from: string; to: string; center_id: string; doctor_id: string; specialty_id: string; preset: Preset }
export type Preset = 'week' | 'last7' | 'last30' | 'next30' | 'custom';
const PRESETS: [Preset, string][] = [['week', 'Esta semana'], ['last7', 'Últimos 7 días'], ['last30', 'Últimos 30 días'], ['next30', 'Próximos 30 días'], ['custom', 'Rango']];

export function presetRange(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const today = localDay(0);
  if (p === 'week') { const mon = weekStart(today); return { from: mon, to: addDays(mon, 7) }; }
  if (p === 'last7') return { from: addDays(today, -6), to: addDays(today, 1) };
  if (p === 'last30') return { from: addDays(today, -29), to: addDays(today, 1) };
  return { from: today, to: addDays(today, 30) };
}
export const defaultFilter = (): StatsFilter => ({ ...presetRange('last30'), center_id: '', doctor_id: '', specialty_id: '', preset: 'last30' });

/** Médicos compatibles con el centro y la especialidad elegidos (según los servicios del catálogo). */
function compatibleDoctors(catalog: Catalog | null, f: StatsFilter) {
  if (!catalog) return [];
  const ok = new Set(catalog.services.filter((s) => (!f.center_id || s.center_id === f.center_id) && (!f.specialty_id || s.specialty_id === f.specialty_id))
    .map((s) => s.doctor_id));
  return catalog.doctors.filter((d) => ok.has(d.id));
}

export function Filters({ value, onChange, catalog }: { value: StatsFilter; onChange: (f: StatsFilter) => void; catalog: Catalog | null }) {
  const doctors = compatibleDoctors(catalog, value);
  const lastIncluded = addDays(value.to, -1);
  const invalid = value.from > lastIncluded;
  // Si el médico elegido deja de ser compatible con centro o especialidad, se quita (y se avisa)
  const doctorDropped = Boolean(value.doctor_id && catalog && !doctors.some((d) => d.id === value.doctor_id));
  useEffect(() => { if (doctorDropped) onChange({ ...value, doctor_id: '' }); }, [doctorDropped]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: 'center_id' | 'doctor_id' | 'specialty_id') => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const pick = (p: Preset) => onChange(p === 'custom' ? { ...value, preset: 'custom' } : { ...value, ...presetRange(p), preset: p });
  const active = [value.center_id, value.doctor_id, value.specialty_id].filter(Boolean).length + (value.preset !== 'last30' ? 1 : 0);
  const filtered = active > 0;
  return (
    <form className="filters period toolbar" onSubmit={(e) => e.preventDefault()} aria-label="Periodo y filtros">
      <div className="presets segmented" role="group" aria-label="Periodo">
        {PRESETS.map(([k, l]) => <button key={k} type="button" aria-pressed={value.preset === k} onClick={() => pick(k)}>{l}</button>)}
      </div>
      {value.preset === 'custom' && <>
        <div className="field"><span className="field-label">Desde</span><DatePicker label="Desde" value={value.from} onChange={(from) => from && onChange({ ...value, from })} /></div>
        <div className="field"><span className="field-label">Hasta (incluido)</span><DatePicker label="Hasta (incluido)" value={lastIncluded} invalid={invalid}
          onChange={(d) => d && onChange({ ...value, to: addDays(d, 1) })} /></div>
      </>}
      <label>Centro<select value={value.center_id} onChange={set('center_id')}><option value="">Todos</option>
        {catalog?.centers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (inactivo)'}</option>)}</select></label>
      <label>Especialidad<select value={value.specialty_id} onChange={set('specialty_id')}><option value="">Todas</option>
        {catalog?.specialties.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (inactiva)'}</option>)}</select></label>
      <label>Médico<select value={value.doctor_id} onChange={set('doctor_id')}><option value="">Todos</option>
        {doctors.map((d) => <option key={d.id} value={d.id}>{d.display_name}{d.active ? '' : ' (inactivo)'}</option>)}</select></label>
      <p className="period-line" aria-live="polite">
        <strong>{rangeLabel(value.from, lastIncluded)}</strong> · zona {TZ.replace('_', ' ')}
        {filtered && <> · <span className="badge info">{active} {active === 1 ? 'filtro activo' : 'filtros activos'}</span>
          <button type="button" className="ghost small" onClick={() => onChange(defaultFilter())}>Restablecer filtros</button></>}
        {invalid && <span className="field-error" role="alert"> · «Desde» debe ser anterior o igual a «Hasta».</span>}
      </p>
    </form>
  );
}

export const filterValid = (f: StatsFilter) => f.from < f.to;
export const filterQuery = (f: StatsFilter) => ({ from: f.from, to: f.to, center_id: f.center_id, doctor_id: f.doctor_id, specialty_id: f.specialty_id });
