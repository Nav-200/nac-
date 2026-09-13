import { useEffect, useState } from 'react';
import { useBridge, useHud } from './hooks';
import { LABEL } from './styles';
import { getUiBridge, type UiSettings } from './uiBridge';

const DEFAULTS: UiSettings = {
  sensitivity: 1,
  shadows: true,
  quality: 'medium',
  masterVolume: 0.8,
  sfxVolume: 0.8,
  musicVolume: 0.6,
  invertY: false,
  showFps: false,
};

export function SettingsPanel() {
  const bridge = useBridge();
  const hud = useHud();
  const [s, setS] = useState<UiSettings>(() => getUiBridge()?.settings() ?? DEFAULTS);
  const [stations, setStations] = useState<string[]>(() => getUiBridge()?.radioStations() ?? []);
  const [station, setStation] = useState<number>(() => getUiBridge()?.radioStation() ?? 0);

  useEffect(() => {
    if (!bridge) return;
    setS(bridge.settings());
    setStations(bridge.radioStations());
    setStation(bridge.radioStation());
  }, [bridge]);

  const patch = (p: Partial<UiSettings>) => {
    setS((prev) => ({ ...prev, ...p }));
    getUiBridge()?.applySettings(p);
  };
  const disabled = !bridge;

  return (
    <div className={`flex flex-col gap-5 ${disabled ? 'opacity-60' : ''}`}>
      {disabled && <div className="text-xs text-[#f5b700]">Engine not ready — settings will be available in a moment.</div>}

      <section>
        <div className={LABEL}>Controls</div>
        <Slider label="Mouse sensitivity" value={s.sensitivity} min={0.3} max={3} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => patch({ sensitivity: v })} disabled={disabled} />
        <Toggle label="Invert Y axis" value={s.invertY} onChange={(v) => patch({ invertY: v })} disabled={disabled} />
      </section>

      <section>
        <div className={LABEL}>Audio</div>
        <Slider label="Master volume" value={s.masterVolume} min={0} max={1} step={0.05} format={pct} onChange={(v) => patch({ masterVolume: v })} disabled={disabled} />
        <Slider label="Effects volume" value={s.sfxVolume} min={0} max={1} step={0.05} format={pct} onChange={(v) => patch({ sfxVolume: v })} disabled={disabled} />
        <Slider label="Music volume" value={s.musicVolume} min={0} max={1} step={0.05} format={pct} onChange={(v) => patch({ musicVolume: v })} disabled={disabled} />
        <Select
          label="Radio station"
          value={String(station)}
          options={stations.length ? stations.map((n, i) => ({ value: String(i), label: n })) : [{ value: '0', label: '—' }]}
          onChange={(v) => {
            const i = Number(v);
            setStation(i);
            getUiBridge()?.setRadioStation(i);
          }}
          disabled={disabled || stations.length === 0}
        />
      </section>

      <section>
        <div className={LABEL}>Graphics</div>
        <Select
          label="Quality"
          value={s.quality}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
          onChange={(v) => patch({ quality: v as UiSettings['quality'] })}
          disabled={disabled}
        />
        <Toggle label="Shadows" value={s.shadows} onChange={(v) => patch({ shadows: v })} disabled={disabled} />
        <Toggle label="Show FPS counter" value={s.showFps} onChange={(v) => patch({ showFps: v })} disabled={disabled} />
        <Select
          label="Camera"
          value={hud.cameraMode}
          options={[
            { value: 'near', label: 'Near (third person)' },
            { value: 'far', label: 'Far (third person)' },
            { value: 'first', label: 'First person' },
          ]}
          onChange={(v) => getUiBridge()?.setCameraMode(v as 'near' | 'far' | 'first')}
          disabled={disabled}
        />
      </section>
    </div>
  );
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}

function Slider({ label, value, min, max, step, format, onChange, disabled }: SliderProps) {
  return (
    <label className="flex items-center gap-3 py-1.5 text-sm">
      <span className="w-40 shrink-0 text-white/85">{label}</span>
      <input type="range" className="oc-range flex-1 min-w-0" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="w-12 text-right tabular-nums text-white/70">{format(value)}</span>
    </label>
  );
}

function Toggle({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-1.5 text-sm">
      <span className="w-40 shrink-0 text-white/85">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`relative w-11 h-6 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f5b700] ${value ? 'bg-[#f5b700] border-[#f5b700]' : 'bg-white/10 border-white/20'}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${value ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
      <span className="text-xs text-white/50 uppercase tracking-wider">{value ? 'On' : 'Off'}</span>
    </div>
  );
}

function Select({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-3 py-1.5 text-sm">
      <span className="w-40 shrink-0 text-white/85">{label}</span>
      <select
        className="oc-select flex-1 min-w-0 bg-white/10 border border-white/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f5b700] disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
