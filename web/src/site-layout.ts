import type { Point } from './site-motion';

export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }
export interface Bay { id: string; park: Point; dock: Point; envelope: Rect }
export const CREWS = ['crew','concrete_crew','inspector','surveyor','hvac_crew','pipe_crew','electrical_crew','scaffold_crew','commissioning_crew'];
export function overlaps(a: Rect, b: Rect, gap = 0) {
  return a.minX < b.maxX + gap && a.maxX + gap > b.minX && a.minZ < b.maxZ + gap && a.maxZ + gap > b.minZ;
}

/** Illustrative, expandable site. Reserved swept envelopes, not a surveyed construction plan. */
export function layoutSite(building: Rect, resources: {id: string; capacity: number; people_per_slot?: number | null}[], cargoRadius: number) {
  const capacity = (id: string) => resources.find(r => r.id === id)?.capacity ?? 0;
  const bays = new Map<string, Bay>();
  const cranes: Point[] = [], pickups: Point[] = [];
  const centerZ = (building.minZ + building.maxZ) / 2;
  const pitch = Math.max(13, 2 * cargoRadius + 4);
  for (let slot = 0; slot < capacity('crane'); slot++) {
    const side = slot % 2 ? 1 : -1, row = Math.floor(slot / 2);
    const z = centerZ + row * pitch;
    const x = side < 0 ? building.minX - 5 : building.maxX + 5;
    cranes.push([x, 0, z]);
    pickups.push([x + side * (cargoRadius + 5), .6, z]);
    bays.set(`crane:${slot}`, {id: `crane:${slot}`, park: [x,0,z], dock: [x,0,z],
      envelope: {minX:x-3.9,maxX:x+3.9,minZ:z-7,maxZ:z+4}});
  }
  const extent = Math.max(15, 2 * cargoRadius + 12);
  let left = building.minX - extent, right = building.maxX + extent;
  const parkZ = building.minZ - 12, dockZ = centerZ;
  // Each slot owns its complete swept corridor, including the excavator's rotating arm.
  for (const [resource, width, halfLength] of [
    ['truck',3.4,3.7], ['mixer',3.4,3], ['concrete_pump',6.8,3.3],
    ['excavator',10,5], ['dump_truck',3.6,3.4], ['compactor',3.6,3.2], ['vibrator',1.8,1],
  ] as const) {
    for (let slot=0;slot<capacity(resource);slot++) {
      const x = resource === 'truck' ? left-width/2 : right+width/2;
      if(resource === 'truck') left-=width+.3; else right+=width+.3;
      bays.set(`${resource}:${slot}`, {id:`${resource}:${slot}`,park:[x,0,parkZ],dock:[x,0,dockZ],
        envelope:{minX:x-width/2,maxX:x+width/2,minZ:parkZ-halfLength,maxZ:dockZ+halfLength}});
    }
  }
  const north = Math.max(building.maxZ+4, ...[...bays.values()].map(b=>b.envelope.maxZ+3));
  const crewRows = CREWS.reduce((n,id)=>n+capacity(id),0);
  const crewWidth = Math.max(4,...resources.map(r=>(r.people_per_slot ?? 2)*1.3));
  const staging = new Map<string,Point>();
  let row=0;
  for(const id of CREWS) for(let slot=0;slot<capacity(id);slot++) staging.set(`${id}:${slot}`, [building.maxX+2+(row++%4)*crewWidth,0,north+Math.floor((row-1)/4)*1.8]);
  const stock: Point = [building.minX-6,0,north];
  const cabin: Point = [building.maxX+4,0,north+Math.ceil(crewRows/4)*1.8+5];
  const bounds: Rect = {minX:left-3,maxX:Math.max(right+3,building.maxX+2+crewWidth*4+2),minZ:parkZ-7,
    maxZ:cabin[2]+5};
  return {bays,cranes,pickups,staging,stock,cabin,bounds};
}
