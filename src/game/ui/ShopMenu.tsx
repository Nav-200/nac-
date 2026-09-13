import { Heart, Shield } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useBridge, useHud } from './hooks';
import { BTN_GHOST, BTN_SMALL, BTN_SMALL_ACCENT, LABEL, OVERLAY, PANEL, formatMoney } from './styles';
import { getUiBridge, type ShopItem, type UiBridge } from './uiBridge';
import { WeaponIcon } from './WeaponIcon';

const ARMOR_PRICE = 250;
const MEDKIT_PRICE = 100;

export function ShopMenu() {
  const hud = useHud();
  const bridge = useBridge();
  const [items, setItems] = useState<ShopItem[]>(() => getUiBridge()?.shopItems() ?? []);
  const [money, setMoney] = useState<number>(() => getUiBridge()?.money() ?? hud.money);
  const [flash, setFlash] = useState<{ ok: boolean; text: string; key: number } | null>(null);

  useEffect(() => {
    if (!bridge) return;
    setItems(bridge.shopItems());
    setMoney(bridge.money());
  }, [bridge]);
  useEffect(() => setMoney(hud.money), [hud.money]);
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const act = (fn: (b: UiBridge) => boolean, okText: string, failText: string) => {
    const b = getUiBridge();
    if (!b) return;
    const ok = fn(b);
    setItems(b.shopItems());
    setMoney(b.money());
    setFlash({ ok, text: ok ? okText : failText, key: Date.now() });
  };

  const message = hud.shopMessage || flash?.text || '';
  const messageOk = hud.shopMessage ? !/not enough|can't|cannot|already|no /i.test(hud.shopMessage) : (flash?.ok ?? true);

  return (
    <div className={`${OVERLAY} z-30 flex items-center justify-center bg-black/65 backdrop-blur-[2px] p-3`}>
      <div className={`${PANEL} w-[min(96vw,940px)] max-h-[94vh] flex flex-col`}>
        <div className="flex items-center justify-between gap-4 px-6 py-3 border-b border-white/10" style={{ background: 'linear-gradient(90deg, rgba(245,183,0,0.12), transparent 60%)' }}>
          <div>
            <div className="gta-font text-5xl leading-none tracking-wider text-[#f5b700] hud-text">AMMU-NATION</div>
            <div className="mt-1 text-xs text-white/55 uppercase tracking-[0.18em]">Guns, ammo and body armor — no questions asked</div>
          </div>
          <div className="text-right">
            <div className={LABEL}>Cash</div>
            <div className="gta-font text-4xl leading-none tabular-nums text-green-400 hud-text">{formatMoney(money)}</div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto oc-scroll px-4 py-2.5">
          {items.length === 0 && <div className="px-2 py-6 text-center text-sm text-white/50">{bridge ? 'Nothing in stock.' : 'Opening the shutters…'}</div>}
          <div className="flex flex-col gap-1">
            {items.map((it) => {
              const melee = it.clipSize === 0;
              const canBuy = !it.owned && money >= it.price;
              const canAmmo = it.owned && !melee && money >= it.ammoPrice;
              return (
                <div key={it.id} className={`flex items-center gap-3 rounded-lg px-3 py-1.5 border ${it.owned ? 'border-[#f5b700]/30 bg-[#f5b700]/5' : 'border-white/10 bg-white/3'}`}>
                  <WeaponIcon id={it.id} className="w-14 h-7 text-white shrink-0" title={it.name} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold truncate">{it.name}</span>
                      {it.owned && <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-[#f5b700] text-black">Owned</span>}
                    </div>
                    <div className="text-xs text-white/55">{melee ? 'Melee weapon' : `Clip ${it.clipSize} · Ammo pack ${it.ammoAmount} rounds`}</div>
                  </div>
                  <div className="hidden sm:flex flex-col items-end text-xs text-white/70 tabular-nums w-28">
                    <span>
                      Weapon <span className="text-white font-semibold">{it.price > 0 ? formatMoney(it.price) : 'Free'}</span>
                    </span>
                    {!melee && (
                      <span>
                        Ammo <span className="text-white font-semibold">{formatMoney(it.ammoPrice)}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col sm:flex-row gap-1.5 shrink-0">
                    <button
                      className={`${BTN_SMALL_ACCENT} min-w-[88px]`}
                      disabled={!canBuy}
                      onClick={() => act((b) => b.buyWeapon(it.id), `Bought ${it.name}`, it.owned ? 'Already owned' : 'Not enough cash')}
                    >
                      {it.owned ? 'Owned' : `Buy ${formatMoney(it.price)}`}
                    </button>
                    {!melee && (
                      <button
                        className={`${BTN_SMALL} min-w-[88px]`}
                        disabled={!canAmmo}
                        onClick={() => act((b) => b.buyAmmo(it.id), `+${it.ammoAmount} rounds for ${it.name}`, it.owned ? 'Not enough cash' : 'Buy the weapon first')}
                        title={it.owned ? undefined : 'Buy the weapon first'}
                      >
                        Ammo {formatMoney(it.ammoPrice)}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="flex items-center gap-3 rounded-lg px-3 py-2 border border-blue-400/30 bg-blue-500/5">
              <Shield className="text-blue-300 shrink-0" size={28} />
              <div className="flex-1 min-w-0">
                <div className="font-bold">Body armor</div>
                <div className="text-xs text-white/55">Full armor · current {Math.round(hud.armor)}</div>
              </div>
              <button className={BTN_SMALL_ACCENT} disabled={money < ARMOR_PRICE} onClick={() => act((b) => b.buyArmor(), 'Armor equipped', 'Not enough cash')}>
                Buy {formatMoney(ARMOR_PRICE)}
              </button>
            </div>
            <div className="flex items-center gap-3 rounded-lg px-3 py-2 border border-red-400/30 bg-red-500/5">
              <Heart className="text-red-300 shrink-0" size={28} />
              <div className="flex-1 min-w-0">
                <div className="font-bold">Medkit</div>
                <div className="text-xs text-white/55">
                  Full health · current {Math.round(hud.health)}/{hud.maxHealth}
                </div>
              </div>
              <button className={BTN_SMALL_ACCENT} disabled={money < MEDKIT_PRICE} onClick={() => act((b) => b.buyHealth(), 'Patched up', 'Not enough cash')}>
                Buy {formatMoney(MEDKIT_PRICE)}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 px-6 py-3 border-t border-white/10">
          <div key={flash?.key ?? hud.shopMessage} className={`text-sm font-semibold fade-in min-h-[1.25rem] ${message ? (messageOk ? 'text-green-400' : 'text-red-400') : ''}`}>
            {message}
          </div>
          <button className={BTN_GHOST} onClick={() => getUiBridge()?.closeShop()} autoFocus>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
