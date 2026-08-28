import React, { useCallback, useRef } from 'react';
import { clamp } from '../engine/math';
import type { Input } from '../engine/input';

interface Props {
  input: Input;
  onPause: () => void;
  onCamera: () => void;
  visible: boolean;
  /** With auto-throttle on, the big right-thumb button is nitro, not gas. */
  autoThrottle: boolean;
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
export const TouchControls: React.FC<Props> = ({
  input,
  onPause,
  onCamera,
  visible,
  autoThrottle,
}) => {
  const activePointers = useRef(new Map<number, string>());

  const press = useCallback(
    (control: string, e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      activePointers.current.set(e.pointerId, control);
      switch (control) {
        case 'throttle':
          input.setThrottleInput(1);
          break;
        case 'brake':
          input.setBrakeInput(1);
          break;
        case 'handbrake':
          input.setHandbrakeInput(true);
          break;
        case 'nitro':
          input.setNitroInput(true);
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
        case 'throttle':
          input.setThrottleInput(0);
          break;
        case 'brake':
          input.setBrakeInput(0);
          break;
        case 'handbrake':
          input.setHandbrakeInput(false);
          break;
        case 'nitro':
          input.setNitroInput(false);
          break;
      }
    },
    [input],
  );

  const stripRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const stripPointer = useRef<number | null>(null);

  const applyStrip = useCallback(
    (clientX: number) => {
      const strip = stripRef.current;
      if (!strip) return;
      const rect = strip.getBoundingClientRect();
      const half = rect.width / 2 - 28;
      const rel = clamp((clientX - (rect.left + rect.width / 2)) / half, -1, 1);
      input.setSteerInput(rel);
      if (knobRef.current) {
        knobRef.current.style.transform = `translate(calc(-50% + ${rel * half}px), -50%)`;
      }
    },
    [input],
  );

  const onStripDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      stripPointer.current = e.pointerId;
      applyStrip(e.clientX);
    },
    [applyStrip],
  );

  const onStripMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (stripPointer.current !== e.pointerId) return;
      e.preventDefault();
      applyStrip(e.clientX);
    },
    [applyStrip],
  );

  const onStripUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (stripPointer.current !== e.pointerId) return;
      e.preventDefault();
      stripPointer.current = null;
      input.setSteerInput(0);
      if (knobRef.current) {
        knobRef.current.style.transform = 'translate(-50%, -50%)';
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
      {/* Steering: an analog drag strip for the left thumb. Sliding the thumb
          maps X within the strip to steering, so precision comes from travel,
          not from tapping. Writes go straight to Input and a knob is moved via
          direct DOM style — no React state in the loop. */}
      <div
        aria-label="Steering strip"
        onPointerDown={onStripDown}
        onPointerMove={onStripMove}
        onPointerUp={onStripUp}
        onPointerCancel={onStripUp}
        onContextMenu={(e) => e.preventDefault()}
        ref={stripRef}
        className="pointer-events-auto absolute bottom-6 left-4 flex h-20 w-56 touch-none items-center justify-between rounded-full border border-white/20 bg-white/8 px-4 backdrop-blur-md select-none sm:bottom-8 sm:left-7 sm:h-24 sm:w-64"
      >
        <span className="text-white/60">
          <Chevron direction="left" />
        </span>
        <div
          ref={knobRef}
          className="pointer-events-none absolute top-1/2 left-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-200/50 bg-cyan-300/25 transition-transform duration-75 sm:h-16 sm:w-16"
        />
        <span className="text-white/60">
          <Chevron direction="right" />
        </span>
      </div>

      {/* Pedals, right thumb. With auto-throttle the big button becomes nitro. */}
      <div className="absolute right-4 bottom-5 flex items-end gap-3 sm:right-7 sm:bottom-8">
        <div className="flex flex-col gap-3">
          <button
            aria-label="Handbrake"
            {...bind('handbrake')}
            className={`${PAD_BASE} h-14 w-14 border-amber-200/40 bg-amber-300/15 text-[10px] font-bold tracking-widest text-amber-100 active:bg-amber-300/45 sm:h-16 sm:w-16`}
          >
            E‑BRK
          </button>
          {!autoThrottle && (
            <button
              aria-label="Nitro"
              {...bind('nitro')}
              className={`${PAD_BASE} h-14 w-14 border-sky-200/45 bg-sky-400/20 text-[10px] font-black tracking-widest text-sky-50 active:bg-sky-400/55 sm:h-16 sm:w-16`}
            >
              NOS
            </button>
          )}
          <button
            aria-label="Brake"
            {...bind('brake')}
            className={`${PAD_BASE} h-16 w-16 border-rose-200/40 bg-rose-400/20 text-xs font-bold tracking-wider text-rose-50 active:bg-rose-400/50 sm:h-20 sm:w-20`}
          >
            BRAKE
          </button>
        </div>
        {autoThrottle ? (
          <button
            aria-label="Nitro"
            {...bind('nitro')}
            className={`${PAD_BASE} h-24 w-24 border-sky-200/45 bg-sky-400/25 text-sm font-black tracking-wider text-sky-50 active:bg-sky-400/60 sm:h-28 sm:w-28`}
          >
            NITRO
          </button>
        ) : (
          <button
            aria-label="Accelerate"
            {...bind('throttle')}
            className={`${PAD_BASE} h-24 w-24 border-emerald-200/45 bg-emerald-400/25 text-sm font-black tracking-wider text-emerald-50 active:bg-emerald-400/55 sm:h-28 sm:w-28`}
          >
            GO
          </button>
        )}
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
