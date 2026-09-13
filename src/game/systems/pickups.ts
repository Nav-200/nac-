/**
 * Pickups (health / armor / money / weapons) with respawn timers, plus the shop + garage
 * interactions (Ammu-Nation and Pay n Spray).
 */
import { PICKUP_RESPAWN_SEC, PLAYER_MAX_ARMOR, PLAYER_MAX_HEALTH } from '../core/constants';
import { WEAPON_ORDER, WEAPON_SPECS, type GameEvent, type PickupSpawn, type WeaponId, type WorldData } from '../core/types';
import type { Player } from '../entities/player';
import type { ShopItem } from '../ui/uiBridge';

export interface PickupInstance {
  spawn: PickupSpawn;
  active: boolean;
  respawnTimer: number;
}

export interface PickupCallbacks {
  onStateChange(item: PickupInstance): void;
  notify(text: string, kind: 'info' | 'money' | 'mission' | 'warning'): void;
}

export const ARMOR_PRICE = 250;
export const MEDKIT_PRICE = 100;
export const RESPRAY_PRICE = 300;

export class PickupSystem {
  readonly items: PickupInstance[];
  shopMessage = '';

  constructor(
    private world: WorldData,
    private cb: PickupCallbacks,
  ) {
    this.items = world.pickups.map((spawn) => ({ spawn, active: true, respawnTimer: 0 }));
  }

  update(dt: number, player: Player, events: GameEvent[]): void {
    for (const it of this.items) {
      if (!it.active) {
        it.respawnTimer -= dt;
        if (it.respawnTimer <= 0) {
          it.active = true;
          this.cb.onStateChange(it);
        }
        continue;
      }
      if (player.dead) continue;
      const dx = it.spawn.x - player.x;
      const dz = it.spawn.z - player.z;
      const r = player.vehicle ? 2.6 : 1.4;
      if (dx * dx + dz * dz > r * r) continue;
      if (this.collect(it, player, events)) {
        it.active = false;
        it.respawnTimer = PICKUP_RESPAWN_SEC;
        this.cb.onStateChange(it);
      }
    }
  }

  private collect(it: PickupInstance, player: Player, events: GameEvent[]): boolean {
    const s = it.spawn;
    switch (s.kind) {
      case 'health':
        if (player.health >= PLAYER_MAX_HEALTH) return false;
        player.heal(s.amount);
        this.cb.notify('Health restored', 'info');
        break;
      case 'armor':
        if (player.armor >= PLAYER_MAX_ARMOR) return false;
        player.addArmor(s.amount);
        this.cb.notify('Body armor', 'info');
        break;
      case 'money':
        player.addMoney(s.amount);
        this.cb.notify(`+$${s.amount}`, 'money');
        break;
      case 'weapon': {
        const id = s.weaponId ?? 'pistol';
        const spec = WEAPON_SPECS[id];
        if (player.hasWeapon(id)) {
          if (!player.giveAmmo(id, Math.max(1, spec.clipSize * 2))) return false;
          this.cb.notify(`${spec.name} ammo`, 'info');
        } else {
          player.giveWeapon(id, spec.clipSize > 0 ? spec.clipSize * 3 : 0);
          this.cb.notify(`Picked up ${spec.name}`, 'info');
        }
        break;
      }
    }
    events.push({ type: 'pickup', x: s.x, y: 1, z: s.z, ref: s.kind === 'weapon' ? 'weapon' : s.kind, byPlayer: true });
    return true;
  }

  // ------------------------------------------------------------------ shop
  /** Index of the gun shop the player is standing at, or -1. */
  shopNear(player: Player): number {
    if (player.vehicle) return -1;
    for (let i = 0; i < this.world.gunShops.length; i++) {
      const g = this.world.gunShops[i];
      if (Math.hypot(g.x - player.x, g.z - player.z) < 3) return i;
    }
    return -1;
  }

  /** Index of the garage the player is parked at (must be in a vehicle), or -1. */
  garageNear(player: Player): number {
    if (!player.vehicle) return -1;
    const g = this.world.poi.find((p) => p.icon === 'garage');
    if (!g) return -1;
    return Math.hypot(g.x - player.x, g.z - player.z) < 7 ? 0 : -1;
  }

  shopItems(player: Player): ShopItem[] {
    return WEAPON_ORDER.filter((w) => w !== 'fist').map((id) => {
      const s = WEAPON_SPECS[id];
      return { id, name: s.name, price: s.price, ammoPrice: Math.max(20, Math.round(s.price * 0.12)), ammoAmount: Math.max(1, s.clipSize * 2), owned: player.hasWeapon(id), clipSize: s.clipSize };
    });
  }

  buyWeapon(player: Player, id: WeaponId): boolean {
    const s = WEAPON_SPECS[id];
    if (player.hasWeapon(id)) {
      this.shopMessage = 'You already own that.';
      return false;
    }
    if (player.money < s.price) {
      this.shopMessage = 'Not enough cash.';
      return false;
    }
    player.addMoney(-s.price);
    player.giveWeapon(id, s.clipSize > 0 ? s.clipSize * 3 : 0);
    this.shopMessage = `Bought ${s.name}.`;
    return true;
  }

  buyAmmo(player: Player, id: WeaponId): boolean {
    const s = WEAPON_SPECS[id];
    if (!player.hasWeapon(id)) {
      this.shopMessage = 'Buy the weapon first.';
      return false;
    }
    if (s.clipSize === 0) {
      this.shopMessage = 'That does not need ammo.';
      return false;
    }
    const price = Math.max(20, Math.round(s.price * 0.12));
    if (player.money < price) {
      this.shopMessage = 'Not enough cash.';
      return false;
    }
    if (!player.giveAmmo(id, s.clipSize * 2)) {
      this.shopMessage = 'Ammo already full.';
      return false;
    }
    player.addMoney(-price);
    this.shopMessage = `Bought ${s.name} ammo.`;
    return true;
  }

  buyArmor(player: Player): boolean {
    if (player.armor >= PLAYER_MAX_ARMOR) {
      this.shopMessage = 'Armor already full.';
      return false;
    }
    if (player.money < ARMOR_PRICE) {
      this.shopMessage = 'Not enough cash.';
      return false;
    }
    player.addMoney(-ARMOR_PRICE);
    player.addArmor(PLAYER_MAX_ARMOR);
    this.shopMessage = 'Body armor equipped.';
    return true;
  }

  buyHealth(player: Player): boolean {
    if (player.health >= PLAYER_MAX_HEALTH) {
      this.shopMessage = 'Health already full.';
      return false;
    }
    if (player.money < MEDKIT_PRICE) {
      this.shopMessage = 'Not enough cash.';
      return false;
    }
    player.addMoney(-MEDKIT_PRICE);
    player.heal(PLAYER_MAX_HEALTH);
    this.shopMessage = 'Patched up.';
    return true;
  }
}
