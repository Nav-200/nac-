import type { WeaponId } from '../core/types';
import type { ReactNode } from 'react';

interface Props {
  id: string;
  className?: string;
  title?: string;
}

/** Simple silhouette glyphs, 48x24 viewBox, filled with currentColor. */
function shape(id: WeaponId | string): ReactNode {
  switch (id) {
    case 'fist':
      return (
        <>
          <rect x="14" y="8" width="20" height="13" rx="4" />
          <circle cx="17" cy="7.5" r="3" />
          <circle cx="22.5" cy="6.5" r="3" />
          <circle cx="28" cy="6.5" r="3" />
          <circle cx="33" cy="7.5" r="3" />
          <rect x="10" y="12" width="6" height="8" rx="3" />
        </>
      );
    case 'bat':
      return (
        <>
          <polygon points="3,13 6,11 40,6 45,7 46,10 45,13 40,14.5 6,15.5 3,15" />
          <circle cx="4.5" cy="14" r="2.4" />
        </>
      );
    case 'pistol':
      return (
        <>
          <rect x="10" y="5" width="30" height="7" rx="1.5" />
          <rect x="8" y="7" width="6" height="4" />
          <polygon points="24,12 34,12 31,22 21,22" />
          <path d="M18 12 h6 v2 h-3 a3 3 0 0 0 -3 3 z" />
          <rect x="38" y="4" width="3" height="3" />
        </>
      );
    case 'smg':
      return (
        <>
          <rect x="3" y="7" width="7" height="5" rx="1" />
          <rect x="9" y="6" width="27" height="7" rx="1.5" />
          <rect x="36" y="7.5" width="9" height="3" />
          <polygon points="27,13 33,13 33,22 27,22" />
          <polygon points="15,13 22,13 20,21 13,21" />
          <rect x="18" y="3" width="4" height="3" />
        </>
      );
    case 'shotgun':
      return (
        <>
          <polygon points="1,8 10,8 10,15 3,17" />
          <rect x="9" y="8" width="37" height="3.5" rx="1" />
          <rect x="9" y="11" width="13" height="3" />
          <rect x="22" y="11" width="10" height="4" rx="1" />
          <polygon points="14,14 19,14 17,20 12,20" />
        </>
      );
    case 'rifle':
      return (
        <>
          <polygon points="1,8 12,8 12,13 3,14" />
          <rect x="11" y="7" width="22" height="6" rx="1" />
          <rect x="32" y="8" width="15" height="3" />
          <rect x="34" y="6" width="2" height="5" />
          <rect x="16" y="3.5" width="12" height="3" rx="1" />
          <polygon points="19,13 26,13 24,21 16,20" />
          <polygon points="27,13 31,13 30,19 25,19" />
        </>
      );
    case 'sniper':
      return (
        <>
          <polygon points="0,8 10,8 10,14 2,16" />
          <rect x="9" y="8" width="21" height="5" rx="1" />
          <rect x="29" y="9" width="18" height="2.6" />
          <rect x="14" y="2.5" width="13" height="3.5" rx="1.5" />
          <rect x="17" y="6" width="2" height="2" />
          <rect x="23" y="6" width="2" height="2" />
          <polygon points="21,13 26,13 25,19 20,19" />
          <rect x="15" y="12.5" width="3" height="4" />
          <polygon points="36,11.5 34,17 35.5,17 37.5,11.5" />
          <polygon points="38,11.5 40,17 41.5,17 39.5,11.5" />
        </>
      );
    case 'rpg':
      return (
        <>
          <polygon points="1,6 6,9 6,13 1,16" />
          <rect x="6" y="9" width="32" height="4.5" rx="1" />
          <polygon points="38,6 47,11.2 38,16.5" />
          <polygon points="17,13.5 23,13.5 22,20 16,20" />
          <rect x="26" y="13.5" width="4" height="5" />
          <rect x="22" y="5" width="3" height="4" />
        </>
      );
    default:
      return <rect x="12" y="8" width="24" height="8" rx="2" />;
  }
}

export function WeaponIcon({ id, className, title }: Props) {
  return (
    <svg viewBox="0 0 48 24" className={className ?? 'w-12 h-6'} fill="currentColor" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {shape(id)}
    </svg>
  );
}
