import { LABEL } from './styles';

const ROWS: { keys: string[]; action: string }[] = [
  { keys: ['W', 'A', 'S', 'D'], action: 'Move / drive' },
  { keys: ['Shift'], action: 'Sprint' },
  { keys: ['Space'], action: 'Jump / handbrake' },
  { keys: ['Mouse'], action: 'Look around' },
  { keys: ['LMB'], action: 'Fire / punch' },
  { keys: ['RMB'], action: 'Aim' },
  { keys: ['R'], action: 'Reload' },
  { keys: ['F', 'E'], action: 'Enter / exit vehicle · interact' },
  { keys: ['Q', 'Tab', 'Scroll', '1–7'], action: 'Switch weapon' },
  { keys: ['H'], action: 'Horn' },
  { keys: ['L'], action: 'Headlights' },
  { keys: ['V'], action: 'Camera mode' },
  { keys: ['N'], action: 'Radio station' },
  { keys: ['M'], action: 'Map' },
  { keys: ['Esc'], action: 'Pause' },
];

export function ControlsPanel() {
  return (
    <div>
      <div className={LABEL}>Controls</div>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.action} className="border-b border-white/5 last:border-0">
              <td className="py-1.5 pr-3 whitespace-nowrap align-middle w-[45%]">
                {r.keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </td>
              <td className="py-1.5 text-white/85 align-middle">{r.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
