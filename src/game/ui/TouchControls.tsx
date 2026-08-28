import React, { useCallback, useRef } from 'react';
import type { Input } from '../engine/input';

interface Props {
  input: Input;
  onPause: () => void;
  onCamera: () => void;
  visible: boolean;
}

const PAD_BASE =
  'select-none touch-none flex items-center justify-center rounded-full ' +
  'border backdrop-blur-md transition-[transform,background-color] duration-75 ' +
  'active:scale-95 pointer-events-auto';

/**
 * On-screen driving controls.
 *
 * Every button writes straight into the shared `Input` object rather than React
 * state, so pressing one never triggers a re-render mid-corner. Pointer capture
 * means a thumb that slides off a pedal still releases it, which is the usual
 * way touch controls go wrong.
 */
export const TouchControls: React.FC<Props> = ({ input, onPause, onCamera, visible }) => {
  const activePointers = useRef(new Map<number, string>());

  const press = useCallback(
    (control: string, e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      activePointers.current.set(e.pointerId, control);
      switch (control) {
        case 'left':
          input.setSteerInput(-1);
          break;
        case 'right':
          input.setSteerInput(1);
          break;
        case 'throttle':
          input.setThrottleInput(1);
          break;
        case 'brake':
          input.setBrakeInput(1);
          break;
        case 'handbrake':
          input.setHandbrakeInput(true);
          break;
      }
    },
    [input],
  );

  const release = useCallback(
    (control: string, e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      activePointers.current.delete(e.pointerId);
      const stillHeld = [...activePointers.current.values()].includes(control);
      if (stillHeld) return;
      switch (control) {
        case 'left':
        case 'right': {
          // Only centre if neither direction is held by another finger.
          const held = [...activePointers.current.values()];
          if (!held.includes('left') && !held.includes('right')) input.setSteerInput(0);
          else input.setSteerInput(held.includes('left') ? -1 : 1);
          break;
        }
        case 'throttle':
          input.setThrottleInput(0);
          break;
        case 'brake':
          input.setBrakeInput(0);
          break;
        case 'handbrake':
          input.setHandbrakeInput(false);
          break;
      }
    },
    [input],
  );

  const bind = (control: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => press(control, e),
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => release(control, e),
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => release(control, e),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  if (!visible) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 select-none"
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Steering, left thumb. */}
      <div className="absolute bottom-5 left-4 flex items-end gap-3 sm:bottom-8 sm:left-7">
        <button
          aria-label="Steer left"
          {...bind('left')}
          className={`${PAD_BASE} h-20 w-20 border-white/25 bg-white/10 text-white/90 active:bg-cyan-300/35 sm:h-24 sm:w-24`}
        >
          <Chevron direction="left" />
        </button>
        <button
          aria-label="Steer right"
          {...bind('right')}
          className={`${PAD_BASE} h-20 w-20 border-white/25 bg-white/10 text-white/90 active:bg-cyan-300/35 sm:h-24 sm:w-24`}
        >
          <Chevron direction="right" />
        </button>
      </div>

      {/* Pedals, right thumb. */}
      <div className="absolute right-4 bottom-5 flex items-end gap-3 sm:right-7 sm:bottom-8">
        <div className="flex flex-col gap-3">
          <button
            aria-label="Handbrake"
            {...bind('handbrake')}
            className={`${PAD_BASE} h-14 w-14 border-amber-200/40 bg-amber-300/15 text-[10px] font-bold tracking-widest text-amber-100 active:bg-amber-300/45 sm:h-16 sm:w-16`}
          >
            E‑BRK
          </button>
          <button
            aria-label="Brake"
            {...bind('brake')}
            className={`${PAD_BASE} h-16 w-16 border-rose-200/40 bg-rose-400/20 text-xs font-bold tracking-wider text-rose-50 active:bg-rose-400/50 sm:h-20 sm:w-20`}
          >
            BRAKE
          </button>
        </div>
        <button
          aria-label="Accelerate"
          {...bind('throttle')}
          className={`${PAD_BASE} h-24 w-24 border-emerald-200/45 bg-emerald-400/25 text-sm font-black tracking-wider text-emerald-50 active:bg-emerald-400/55 sm:h-28 sm:w-28`}
        >
          GO
        </button>
      </div>

      {/* Utility buttons, out of the way of both thumbs. */}
      <div className="pointer-events-auto absolute top-3 right-3 flex gap-2">
        <button
          aria-label="Change camera"
          onClick={onCamera}
          className="h-10 w-10 touch-none rounded-full border border-white/20 bg-black/35 text-white/85 backdrop-blur-md active:bg-white/20"
        >
          <CameraIcon />
        </button>
        <button
          aria-label="Pause"
          onClick={onPause}
          className="h-10 w-10 touch-none rounded-full border border-white/20 bg-black/35 text-white/85 backdrop-blur-md active:bg-white/20"
        >
          <PauseIcon />
        </button>
      </div>
    </div>
  );
};

const Chevron: React.FC<{ direction: 'left' | 'right' }> = ({ direction }) => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d={direction === 'left' ? 'M15 5 L8 12 L15 19' : 'M9 5 L16 12 L9 19'}
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CameraIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="mx-auto h-5 w-5" fill="none" aria-hidden="true">
    <path
      d="M4 8h3l1.5-2h7L17 8h3v10H4z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="13" r="3.1" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const PauseIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="mx-auto h-5 w-5" fill="currentColor" aria-hidden="true">
    <rect x="7" y="5" width="3.6" height="14" rx="1.2" />
    <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
  </svg>
);
