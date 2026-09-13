/**
 * Spatial hashes for moving things (vehicles, pedestrians) so neighbour queries stay O(nearby).
 */
import { SpatialHash, type HasBounds } from '../core/spatialHash';
import type { BoxCollider } from '../core/collision';
import type { Vehicle } from '../entities/vehicle';
import type { Pedestrian } from '../entities/pedestrian';

export interface PedBounds extends HasBounds {
  ped: Pedestrian;
}

export interface VehicleBounds extends BoxCollider {
  vehicle: Vehicle;
}

export class DynamicWorld {
  readonly vehicles = new SpatialHash<VehicleBounds>(24);
  readonly peds = new SpatialHash<PedBounds>(12);
  private vehBuf: VehicleBounds[] = [];
  private pedBuf: PedBounds[] = [];

  vehiclesNear(x: number, z: number, r: number): VehicleBounds[] {
    return this.vehicles.queryCircle(x, z, r, this.vehBuf);
  }

  pedsNear(x: number, z: number, r: number): PedBounds[] {
    return this.peds.queryCircle(x, z, r, this.pedBuf);
  }

  vehiclesInRect(minX: number, minZ: number, maxX: number, maxZ: number): VehicleBounds[] {
    return this.vehicles.query(minX, minZ, maxX, maxZ, this.vehBuf);
  }

  pedsAlongRay(x0: number, z0: number, x1: number, z1: number): PedBounds[] {
    return this.peds.queryRay(x0, z0, x1, z1, this.pedBuf);
  }

  vehiclesAlongRay(x0: number, z0: number, x1: number, z1: number): VehicleBounds[] {
    return this.vehicles.queryRay(x0, z0, x1, z1, this.vehBuf);
  }
}
