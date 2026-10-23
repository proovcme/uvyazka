/** Presentation quality only: never drops geometry, properties, IDs or selectable objects. */
export function renderPolicy(physicalElements:number,devicePixelRatio:number){
  const large=physicalElements>2000;
  return {shadows:!large,pixelRatio:Math.min(devicePixelRatio,large?1.25:2),edgeBudget:large?100_000:600_000};
}
