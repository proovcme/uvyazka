import * as THREE from 'three';
import type { ModelPackage } from './model';
import type { RunPackage } from './simulation';
import { activeLease, compileLeases, lerpPoint, liftPose, progress, smooth, truckPose } from './site-motion';
import type { Lease, Point } from './site-motion';
import { MOBILE_CRANE, mobileCraneRig } from './crane-rig';
import { TemporarySite } from './temporary-site';
import { CREWS, layoutSite } from './site-layout';
import { findWalkRoute, makeWorkerTask, sampleWorkerTask, reserveWorkerTask, distance, taskAction } from './worker-task';
import type { WorkerTask, WorkerRoute, WorkerTool, NavigationWorld } from './worker-task';
import { OBB } from 'three/addons/math/OBB.js';

type SourceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>;
interface Person { root: THREE.Group; body: THREE.Group; tools: Map<WorkerTool,THREE.Group>; arms: THREE.Group[]; forearms: THREE.Group[]; legs: THREE.Group[]; marker:THREE.Mesh }
interface Crane { root: THREE.Group; slew: THREE.Group; boom: THREE.Group; sections: THREE.Mesh[]; outriggers: { beam: THREE.Mesh; foot: THREE.Group; side: number; z: number }[]; rope: THREE.Mesh; hook: THREE.Group; slings: THREE.Mesh[]; mast: Point }
interface Truck { root: THREE.Group; wheels: THREE.Mesh[]; load: THREE.Group; gate: THREE.Mesh }
export interface SiteActorState {
  id: string; resource: string; slot: number; operationId: string | null; active: boolean; phase: string;
  position: Point; workers?: { position: Point; supportId: string | null; supported: boolean; fallback: boolean; visible: boolean; action: string; arm: number;
    phase:string; targetId:string|null; targetName:string; tool:string|null; route:Point[]; routeBasis:string[]; reason:string|null; contact:Point|null; workProgress:number }[];
  equipment?: { type: string; boomLength: number; boomAngle: number; deployed: number; tip: Point; loadMassKg: null; status: string };
}

/** Presentation layer only: all movement is sampled from immutable resource leases. */
export class ConstructionSite {
  private temporary?: TemporarySite;
  readonly group = new THREE.Group();
  readonly bounds: THREE.Box3;
  readonly siteBounds: THREE.Box3;
  readonly leases: Lease[];
  readonly states: SiteActorState[] = [];
  readonly warnings = new Map<string, string>();
  readonly hiddenTargets = new Set<string>();
  private geom = new Set<THREE.BufferGeometry>();
  private materials = new Set<THREE.Material>();
  private cube = this.ownGeometry(new THREE.BoxGeometry(1, 1, 1));
  private cylinder = this.ownGeometry(new THREE.CylinderGeometry(1, 1, 1, 7));
  private sphere = this.ownGeometry(new THREE.SphereGeometry(1, 9, 6));
  private yellow = this.material(0xd6ac3c);
  private dark = this.material(0x273d43);
  private white = this.material(0xe9e8da);
  private orange = this.material(0xdd783b);
  private blue = this.material(0x547b90);
  private wood = this.material(0x9b815b);
  private metal = this.material(0x84938e);
  private skin = this.material(0xc39d7b);
  private black = this.material(0x26302c);
  private window = this.material(0x769b9d);
  private cranes: Crane[] = [];
  private trucks: Truck[] = [];
  private crews = new Map<string, Person[][]>();
  private mixers: { root: THREE.Group; drum: THREE.Group }[] = [];
  private machines = new Map<string, { root: THREE.Group; moving: THREE.Object3D[]; hose?: THREE.Mesh[] }[]>();
  private forms: { unitId: string; root: THREE.Group; mesh: THREE.Mesh; triangles: number; install: { start: number; finish: number }; strip: { start: number; finish: number }; pour: number }[] = [];
  private formStates: { unitId: string; fraction: number; phase: string }[] = [];
  private pit?: THREE.Mesh;
  private cargo = new Map<string, THREE.Group>();
  private boxes = new Map<string, THREE.Box3>();
  private completion = new Map<string, number>();
  private ray = new THREE.Raycaster();
  private floorMeshes: SourceMesh[];
  private transitY: number;
  private cargoMaxHalf = 0.3;
  private roadX: number;
  private stock: THREE.Group[] = [];
  readonly layout: ReturnType<typeof layoutSite>;
  private spatialIssues: {actor: string; obstacle: string}[] = [];
  private workerTasks=new Map<string,WorkerTask>();
  private workerLeases:Lease[]=[];
  private plannedWorkerLeases=0;
  private workerPaths=new Map<string,THREE.Line>();
  private accessRamps:{base:Point;landing:Point;top:Point;floorId:string;root:THREE.Group;ready:number}[]=[];

  constructor(readonly model: ModelPackage, readonly run: RunPackage, readonly meshes: Map<string, SourceMesh>) {
    this.group.name = 'Event-driven construction site';
    this.leases = compileLeases(run);
    for (const [id, mesh] of meshes) this.boxes.set(id, new THREE.Box3().setFromObject(mesh));
    this.temporary = new TemporarySite(model, run, this.boxes);
    this.group.add(this.temporary.group);
    this.bounds = new THREE.Box3();
    for (const element of model.elements) if (element.role === 'element' && this.boxes.has(element.id)) this.bounds.union(this.boxes.get(element.id)!);
    if(this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-1,0,-1),new THREE.Vector3(1,1,1));
    for (const unit of run.scenario.units) for (const id of unit.target_ids) this.completion.set(id, run.operation_states[unit.operation_ids.at(-1)!].finish);
    this.floorMeshes = model.elements.filter((element) => element.hierarchy.includes('IfcSlab') && meshes.has(element.id)).map((element) => meshes.get(element.id)!);
    const size = this.bounds.getSize(new THREE.Vector3());
    let maxCargoRadius = 1;
    for (const lease of this.leases.filter((lease) => lease.resource === 'crane')) {
      const box = this.targetBox(lease);
      const extent = box.getSize(new THREE.Vector3());
      this.cargoMaxHalf = Math.max(this.cargoMaxHalf, extent.y / 2);
      maxCargoRadius = Math.max(maxCargoRadius, Math.hypot(extent.x, extent.z) / 2);
    }
    this.transitY = this.bounds.max.y + this.cargoMaxHalf + 2.2;
    this.layout = layoutSite({minX:this.bounds.min.x,maxX:this.bounds.max.x,minZ:this.bounds.min.z,maxZ:this.bounds.max.z},run.scenario.resources,maxCargoRadius);
    this.roadX = this.layout.bays.get('truck:0')?.park[0] ?? this.layout.bounds.minX+3;
    const capacity = (id: string) => run.scenario.resources.find((resource) => resource.id === id)?.capacity ?? 0;
    const area=this.layout.bounds;
    this.siteBounds = new THREE.Box3(new THREE.Vector3(area.minX,0,area.minZ),new THREE.Vector3(area.maxX,this.transitY+3,area.maxZ));
    this.makeEnvironment(size);
    for (let slot = 0; slot < capacity('crane'); slot++) {
      const mast = this.layout.cranes[slot];
      this.cranes.push(this.makeCrane(mast));
    }
    for (let slot = 0; slot < capacity('truck'); slot++) this.trucks.push(this.makeTruck());
    for (const id of CREWS) {
      if(!run.scenario.operations.some(operation=>operation.demands[id]))continue;
      const slots: Person[][] = [];
      for (let slot = 0; slot < capacity(id); slot++) {
        const count = run.scenario.resources.find((resource) => resource.id === id)?.people_per_slot ?? (id === 'inspector' ? 1 : 2);
        const people = Array.from({ length: count }, () => this.makePerson(id === 'concrete_crew' ? this.blue : id === 'inspector' || id === 'surveyor' ? this.white : this.orange));
        if (id === 'surveyor') {
          const root = people[0].root;
          for (const angle of [0, Math.PI * 2 / 3, Math.PI * 4 / 3]) this.rod(root, [.7, 1.35, 0], [.7 + Math.cos(angle) * .4, 0, Math.sin(angle) * .4], .025, this.yellow);
          this.box(root, [.24, .3, .26], [.7, 1.5, 0], this.yellow);
          this.box(root, [.1, .1, .3], [.7, 1.52, .12], this.dark);
        }
        slots.push(people);
      }
      this.crews.set(id, slots);
    }
    for (let slot = 0; slot < capacity('mixer'); slot++) this.mixers.push(this.makeMixer(slot));
    for (const resource of ['concrete_pump', 'excavator', 'dump_truck', 'compactor', 'vibrator']) {
      this.machines.set(resource, Array.from({ length: capacity(resource) }, (_, slot) => this.makeMachine(resource, slot)));
    }
    this.makeFormwork();
    const earth = run.scenario.work_packages?.find((pack) => pack.pit_bounds_m);
    if (earth?.pit_bounds_m) {
      const [a, b] = earth.pit_bounds_m, origin = model.coordinate_system.render_origin_m;
      this.pit = this.box(this.group, [b[0] - a[0], .05, b[1] - a[1]], [(a[0] + b[0]) / 2 - origin[0], .005, -(a[1] + b[1]) / 2 + origin[1]], this.material(0x8f7654));
      this.pit.visible = false; // Plan-view excavation proxy; no invented safe slope geometry.
    }
    for (let index = 0; index < 10; index++) {
      const pallet = new THREE.Group();
      this.box(pallet, [.9, .12, .8], [0, .08, 0], this.wood);
      for (let layer = 0; layer < 3; layer++) this.box(pallet, [.85, .17, .72], [0, .24 + layer * .18, 0], layer === 2 ? this.white : this.wood);
      pallet.position.set(this.layout.stock[0] + (index % 2) * 1.2, 0, this.layout.stock[2] + Math.floor(index / 2) * 1.1);
      this.group.add(pallet); this.stock.push(pallet);
    }
    this.makePedestrianAccess();
    this.workerLeases=this.leases.filter(l=>this.crews.has(l.resource)).sort((a,b)=>a.start-b.start||a.resource.localeCompare(b.resource)||a.slot-b.slot);
    this.update(0);
  }

  private ownGeometry<T extends THREE.BufferGeometry>(value: T) { this.geom.add(value); return value; }
  private material(color: number) { const material = new THREE.MeshStandardMaterial({ color, roughness: .85, flatShading: true }); this.materials.add(material); return material; }
  private mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material) {
    const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  private box(parent: THREE.Object3D, size: Point, position: Point, material: THREE.Material) {
    const mesh = this.mesh(parent, this.cube, material); mesh.scale.set(...size); mesh.position.set(...position); return mesh;
  }
  private rod(parent: THREE.Object3D, a: Point, b: Point, radius: number, material: THREE.Material) {
    const mesh = this.mesh(parent, this.cylinder, material); this.moveRod(mesh, a, b, radius); return mesh;
  }
  private moveRod(mesh: THREE.Mesh, a: Point, b: Point, radius: number) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.sub(start);
    mesh.position.copy(start).addScaledVector(delta, .5); mesh.scale.set(radius, Math.max(.001, delta.length()), radius);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  }
  private makeEnvironment(size: THREE.Vector3) {
    const min = this.siteBounds.min, max = this.siteBounds.max;
    this.box(this.group, [max.x - min.x, .08, max.z - min.z], [(max.x + min.x) / 2, -.09, (max.z + min.z) / 2], this.material(0xdad9ca));
    for(const bay of this.layout.bays.values()) if(!bay.id.startsWith('crane:')&&!bay.id.startsWith('vibrator:')) {
      const e=bay.envelope;
      this.box(this.group,[e.maxX-e.minX-.3,.025,e.maxZ-e.minZ],[bay.park[0],-.025,(e.minZ+e.maxZ)/2],this.material(0xb0b5ac));
    }
    const fenceMaterial = this.material(0x72847b);
    const fenceSegment = (a: Point, b: Point) => {
      this.rod(this.group, [a[0], .05, a[2]], [a[0], 1.3, a[2]], .035, fenceMaterial);
      this.rod(this.group, [a[0], 1.2, a[2]], [b[0], 1.2, b[2]], .025, fenceMaterial);
      this.rod(this.group, [a[0], .4, a[2]], [b[0], .4, b[2]], .018, fenceMaterial);
    };
    for (const z of [min.z, max.z]) for (let x = min.x; x < max.x; x += 2.5) {
      if (z === min.z && Math.abs(x - this.roadX) < 3.5) continue;
      fenceSegment([x, 0, z], [Math.min(x + 2.5, max.x), 0, z]);
    }
    for (const x of [min.x, max.x]) for (let z = min.z; z < max.z; z += 2.5) fenceSegment([x, 0, z], [x, 0, Math.min(z + 2.5, max.z)]);
    const cabin = new THREE.Group();
    this.box(cabin, [2.5, 2.1, 4], [0, 1.05, 0], this.material(0x79958b));
    this.box(cabin, [2.7, .16, 4.2], [0, 2.16, 0], this.white);
    this.box(cabin, [.04, .8, 1], [1.26, 1.3, -.8], this.window);
    this.box(cabin, [.04, 1.7, .75], [1.26, .85, .8], this.white);
    cabin.position.set(...this.layout.cabin); this.group.add(cabin);
    this.sign('IFC / CS', [this.layout.cabin[0]+1.3, 2, this.layout.cabin[2]], 2.3);
    this.sign('СКЛАД', [this.layout.stock[0], 1.7, this.layout.stock[2] + 5], 2.3);
    this.sign('УСЛОВНАЯ ПЛОЩАДКА', [(min.x + max.x) / 2, .03, max.z - 1.5], 5, true);
  }
  private sign(text: string, point: Point, width: number, horizontal = false) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#e6e6d6'; ctx.fillRect(0, 0, 512, 96);
    ctx.font = '600 32px Segoe UI'; ctx.fillStyle = '#435950'; ctx.textAlign = 'center'; ctx.fillText(text, 256, 60);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }); this.materials.add(material);
    const mesh = this.mesh(this.group, this.ownGeometry(new THREE.PlaneGeometry(width, width * 96 / 512)), material);
    mesh.position.set(...point); if (horizontal) mesh.rotation.x = -Math.PI / 2;
    mesh.userData.ownedTexture = texture;
  }
  private makeCrane(mast: Point): Crane {
    const root = new THREE.Group(); root.position.set(...mast); this.group.add(root);
    root.name = 'Mobile telescopic crane';
    this.box(root, [2.4, .4, 7.2], [0, .85, 0], this.dark);
    this.box(root, [2.35, .35, 6.7], [0, 1.2, 0], this.yellow);
    this.box(root, [2.3, 1.45, 1.65], [0, 1.85, 2.65], this.yellow);
    this.box(root, [2.05, .7, .035], [0, 2.05, 3.49], this.window);
    for (const side of [-1, 1]) {
      this.box(root, [.035, .65, 1.1], [side * 1.16, 2.05, 2.6], this.window);
      this.box(root, [.3, .2, .08], [side * .8, 1.4, 3.5], this.white);
      for (const z of [-2.5, -1.25, 1.5, 2.8]) {
        const wheel = this.mesh(root, this.cylinder, this.black); wheel.scale.set(.46, .25, .46);
        wheel.rotation.z = Math.PI / 2; wheel.position.set(side * 1.15, .48, z);
        const hub = this.mesh(root, this.cylinder, this.metal); hub.scale.set(.2, .27, .2); hub.rotation.z = Math.PI / 2; hub.position.copy(wheel.position);
      }
    }
    const outriggers: Crane['outriggers'] = [];
    for (const side of [-1, 1]) for (const z of [-2, 1.4]) {
      const beam = this.box(root, [1.3, .23, .3], [side * 1.1, .65, z], this.yellow);
      const foot = new THREE.Group(); root.add(foot);
      this.box(foot, [1, .1, 1], [0, .08, 0], this.wood);
      this.rod(foot, [0, .15, 0], [0, .72, 0], .07, this.metal);
      outriggers.push({ beam, foot, side, z });
    }
    const slew = new THREE.Group(); slew.position.y = MOBILE_CRANE.pivotHeight; root.add(slew);
    this.box(slew, [1.6, .7, 2.1], [-.5, -.25, 0], this.yellow);
    this.box(slew, [.9, 1.2, 1.15], [.05, .25, 1.1], this.yellow);
    this.box(slew, [.04, .75, .9], [.52, .4, 1.1], this.window);
    this.box(slew, [.7, .6, 1.8], [-1.25, -.05, 0], this.dark);
    const boom = new THREE.Group(); slew.add(boom);
    const sections = [.6, .5, .4, .3, .2].map((width, index) => this.box(boom, [MOBILE_CRANE.retractedLength, width, width], [MOBILE_CRANE.retractedLength / 2, 0, 0], index === 4 ? this.dark : this.yellow));
    this.rod(slew, [.4, -.45, 0], [2.4, .45, 0], .09, this.metal);
    const rope = this.rod(this.group, [mast[0], 3, mast[2]], [mast[0], 2, mast[2]], .018, this.dark);
    const hook = new THREE.Group(); this.group.add(hook);
    this.box(hook, [.24, .35, .18], [0, -.1, 0], this.yellow);
    this.rod(hook, [0, -.2, 0], [0, -.47, 0], .035, this.dark);
    const slings = Array.from({ length: 4 }, () => this.rod(this.group, [0, 0, 0], [0, 1, 0], .012, this.dark));
    return { root, slew, boom, sections, outriggers, rope, hook, slings, mast };
  }
  private makeTruck(): Truck {
    const root = new THREE.Group(); this.group.add(root);
    this.box(root, [2.05, .28, 5.5], [0, .68, 0], this.dark);
    this.box(root, [2, 1.35, 1.45], [0, 1.5, 1.85], this.orange);
    this.box(root, [1.7, .65, .035], [0, 1.75, 2.59], this.window);
    this.box(root, [2.05, .2, 3.75], [0, .94, -.75], this.wood);
    this.box(root, [2.08, .27, .16], [0, .55, 2.7], this.white);
    const wheels: THREE.Mesh[] = [];
    for (const x of [-1.02, 1.02]) for (const z of [-1.9, -.65, 1.9]) {
      const wheel = this.mesh(root, this.cylinder, this.black); wheel.scale.set(.36, .22, .36); wheel.rotation.z = Math.PI / 2; wheel.position.set(x, .4, z); wheels.push(wheel);
    }
    const load = new THREE.Group(); root.add(load);
    for (let index = 0; index < 3; index++) this.box(load, [1.65, .45, .9], [0, 1.27, -1.8 + index * 1.15], index === 1 ? this.wood : this.white);
    const gate = this.box(root, [1.9, .08, .95], [0, .9, -3.05], this.dark);
    return { root, wheels, load, gate };
  }
  private makeMixer(slot: number) {
    const root = new THREE.Group(); this.group.add(root);
    this.box(root, [2, .3, 4.8], [0, .7, 0], this.dark);
    this.box(root, [1.9, 1.4, 1.35], [0, 1.5, 1.7], this.white);
    this.box(root, [1.65, .6, .04], [0, 1.7, 2.4], this.window);
    for (const x of [-1, 1]) for (const z of [-1.5, 1.6]) { const wheel = this.mesh(root, this.cylinder, this.black); wheel.scale.set(.36, .2, .36); wheel.rotation.z = Math.PI / 2; wheel.position.set(x, .4, z); }
    const drum = new THREE.Group(); drum.position.set(0, 1.65, -.5); root.add(drum);
    const barrel = this.mesh(drum, this.cylinder, this.white); barrel.scale.set(.9, 2.5, .9); barrel.rotation.x = Math.PI / 2;
    this.box(drum, [1.6, .1, .16], [0, .5, 0], this.blue);
    root.position.set(...this.layout.bays.get(`mixer:${slot}`)!.park); return { root, drum };
  }
  private makePerson(vest: THREE.Material): Person {
    const root = new THREE.Group(); this.group.add(root);
    this.box(root, [.38, .52, .23], [0, 1.06, 0], vest);
    for (const x of [-.12, .12]) this.box(root, [.055, .45, .245], [x, 1.06, .005], this.yellow);
    const head = this.mesh(root, this.sphere, this.skin); head.position.y = 1.48; head.scale.set(.15, .18, .15);
    const helmet = this.mesh(root, this.sphere, this.yellow); helmet.position.y = 1.62; helmet.scale.set(.19, .10, .19);
    const forearms:THREE.Group[]=[];
    const arms = [-1, 1].map((side) => {
      const joint = new THREE.Group(); joint.position.set(side * .25, 1.26, 0); root.add(joint);
      this.box(joint, [.12, .28, .14], [0, -.14, 0], vest);
      const forearm=new THREE.Group();forearm.position.y=-.28;joint.add(forearm);forearms.push(forearm);
      this.box(forearm,[.1,.26,.12],[0,-.13,0],vest);
      const hand = this.mesh(forearm, this.sphere, this.skin); hand.scale.set(.075, .09, .075); hand.position.set(0, -.28, 0); return joint;
    });
    const legs = [-1, 1].map((side) => {
      const joint = new THREE.Group(); joint.position.set(side * .105, .8, 0); root.add(joint);
      this.box(joint, [.16, .68, .18], [0, -.35, 0], this.dark);
      this.box(joint, [.18, .12, .29], [0, -.73, .045], this.black); return joint;
    });
    const body=new THREE.Group(); body.position.y=.8; root.add(body);
    for(const child of [...root.children]) if(child!==body&&!legs.includes(child as THREE.Group)) {root.updateMatrixWorld(true);body.attach(child);}
    const tools=new Map<WorkerTool,THREE.Group>();
    for(const kind of ['hammer','trowel','wrench','pliers','hose','meter','probe'] as WorkerTool[]) {
      const tool=new THREE.Group();forearms[0].add(tool);tool.position.y=-.28;tool.visible=false;tools.set(kind,tool);
      if(kind==='meter')this.box(tool,[.18,.08,.27],[0,-.08,0],this.blue);
      else if(kind==='hose')this.rod(tool,[0,.1,0],[0,-.23,0],.04,this.black);
      else if(kind==='trowel'){this.box(tool,[.05,.17,.06],[0,-.06,0],this.wood);this.box(tool,[.18,.025,.25],[0,-.15,0],this.metal);}
      else {this.box(tool,[.045,.22,.05],[0,-.07,0],kind==='hammer'?this.wood:this.metal);
        this.box(tool,[kind==='probe'?.05:.16,.06,.065],[0,-.17,0],this.metal);}
    }
    const marker=this.mesh(this.group,this.sphere,this.orange);marker.scale.setScalar(.055);marker.visible=false;
    return { root, body, tools, arms, forearms, legs, marker };
  }
  private makeFormwork() {
    for (const unit of this.run.scenario.units.filter((unit) => unit.kind === 'concrete')) {
      const install = this.run.operation_states[`${unit.id}:formwork`], strip = this.run.operation_states[`${unit.id}:stripping`];
      if (!install || !strip) continue;
      const positions: number[] = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
      for (const id of unit.target_ids) {
        const source = this.meshes.get(id); if (!source) continue;
        const geometry = source.geometry, vertices = geometry.getAttribute('position'), index = geometry.index;
        if (!index) continue;
        for (let i = 0; i < index.count; i += 3) {
          a.fromBufferAttribute(vertices, index.getX(i)).applyMatrix4(source.matrixWorld);
          b.fromBufferAttribute(vertices, index.getX(i + 1)).applyMatrix4(source.matrixWorld);
          c.fromBufferAttribute(vertices, index.getX(i + 2)).applyMatrix4(source.matrixWorld);
          normal.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
          // Same contact selection as backend quantity measurement (world Y up).
          const soffit = unit.lower[2] > (this.run.scenario.work_packages?.[0]?.ground_level_m ?? 0) + .1;
          if (!(Math.abs(normal.y) < .5 || soffit && normal.y < -.5)) continue;
          for (const point of [a, b, c]) positions.push(...point.clone().addScaledVector(normal, .045).toArray());
        }
      }
      if (!positions.length) continue;
      const geometry = this.ownGeometry(new THREE.BufferGeometry()); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
      const root = new THREE.Group(); this.group.add(root);
      const material = this.material(0xc29551); material.side = THREE.DoubleSide;
      const mesh = this.mesh(root, geometry, material);
      const edges = this.ownGeometry(new THREE.EdgesGeometry(geometry, 25));
      const lines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x453f32 })); this.materials.add(lines.material); root.add(lines);
      // Timber bearers at contact face boundaries; the actual IFC openings remain open.
      const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
      for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) {
        this.rod(root, [x, box.min.y, z], [x, box.max.y, z], .04, this.dark);
      }
      this.forms.push({ unitId: unit.id, root, mesh, triangles: positions.length / 9, install, strip,
        pour: this.run.operation_states[`${unit.id}:concreting`].start });
    }
  }
  private makeMachine(resource: string, slot: number) {
    const root = new THREE.Group(); this.group.add(root);
    const moving: THREE.Object3D[] = [], hose: THREE.Mesh[] = [];
    if (resource === 'vibrator') {
      this.box(root, [.5, .45, .5], [0, .25, 0], this.yellow);
      moving.push(this.rod(root, [0, .4, 0], [.5, .4, .5], .025, this.black));
    } else if (resource === 'excavator') {
      for (const z of [-.95, .95]) this.box(root, [3.5, .6, .5], [0, .4, z], this.dark);
      const cab = new THREE.Group(); root.add(cab); moving.push(cab);
      this.box(cab, [2.4, .65, 1.8], [0, .95, 0], this.yellow);
      this.box(cab, [1.1, 1.4, .9], [-.3, 1.9, .5], this.yellow);
      this.box(cab, [1.12, .8, .04], [-.3, 2.1, 1], this.window);
      this.rod(cab, [.7, 1.3, 0], [2.2, 3.4, 0], .16, this.yellow);
      this.rod(cab, [2.2, 3.4, 0], [3.7, .8, 0], .12, this.yellow);
      this.box(cab, [.8, .55, 1], [3.8, .55, 0], this.dark);
    } else {
      this.box(root, [2.2, .3, resource === 'compactor' ? 3.2 : 5.8], [0, .75, 0], this.dark);
      this.box(root, [2, 1.5, 1.5], [0, 1.6, 1.8], resource === 'concrete_pump' ? this.white : this.yellow);
      this.box(root, [1.7, .7, .04], [0, 1.9, 2.57], this.window);
      for (const x of [-1, 1]) for (const z of [-1.6, 1.7]) {
        const wheel = this.mesh(root, this.cylinder, this.black); wheel.scale.set(.4, .23, .4); wheel.rotation.z = Math.PI / 2;
        wheel.position.set(x, .45, z);
      }
      if (resource === 'concrete_pump') {
        this.box(root, [2.2, .7, 3.4], [0, 1.2, -.8], this.white);
        for (const x of [-1.7, 1.7]) this.box(root, [2.2, .12, .18], [x, .55, -.4], this.dark);
        for (let i = 0; i < 4; i++) hose.push(this.rod(this.group, [0, 0, 0], [0, 1, 0], i === 3 ? .045 : .09, i === 3 ? this.black : this.orange));
      } else if (resource === 'dump_truck') {
        const bed = new THREE.Group(); root.add(bed); moving.push(bed);
        this.box(bed, [2.15, .25, 3.4], [0, 1.1, -.65], this.orange);
        for (const x of [-1, 1]) this.box(bed, [.14, 1.1, 3.4], [x, 1.7, -.65], this.yellow);
        this.box(bed, [1.8, .8, 3], [0, 1.6, -.65], this.wood);
      } else this.box(root, [2.1, .8, 1], [0, .5, -1.5], this.metal);
    }
    root.position.set(...this.layout.bays.get(`${resource}:${slot}`)!.park);
    return { root, moving, hose };
  }
  private targetBox(lease: Lease) {
    const result = new THREE.Box3();
    for (const id of lease.operation.target_ids) if (this.boxes.has(id)) result.union(this.boxes.get(id)!);
    if (result.isEmpty()) result.setFromCenterAndSize(new THREE.Vector3((this.bounds.min.x+this.bounds.max.x)/2, .2, this.bounds.min.z-2), new THREE.Vector3(2,.4,1));
    return result;
  }
  private completedAt(tick: number) {
    const ids=new Set([...(this.run.scenario.initial_element_ids??[]), ...[...this.completion].filter(([, time])=>time<=tick).map(([id])=>id)]);
    for(const unit of this.run.scenario.units) if((unit.kind==='demolition'||this.run.scenario.element_phase_states?.[unit.id]==='temporary')&&this.run.operation_states[unit.operation_ids.at(-1)!].finish<=tick) for(const id of unit.target_ids)ids.delete(id);
    return ids;
  }
  private support(x: number, z: number, maxY: number, completed: Set<string>): { y: number; id: string | null } | null {
    this.ray.set(new THREE.Vector3(x, maxY + .15, z), new THREE.Vector3(0, -1, 0));
    for (const hit of this.ray.intersectObjects(this.floorMeshes.filter((mesh) => completed.has(String(mesh.userData.elementId))), false)) {
      const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld);
      if (normal && Math.abs(normal.y) > .8) return { y: hit.point.y, id: String(hit.object.userData.elementId) };
    }
    const outside = x < this.bounds.min.x - .3 || x > this.bounds.max.x + .3 || z < this.bounds.min.z - .3 || z > this.bounds.max.z + .3;
    return outside ? { y: 0, id: null } : null;
  }
  private stagingPoint(resource: string, slot: number, member: number): Point {
    const base=this.layout.staging.get(`${resource}:${slot}`) ?? this.layout.cabin;
    return [base[0]+member*1.3,0,base[2]];
  }
  private makePedestrianAccess() {
    // The educational model explicitly uses proposed temporary access steps.
    // Imported projects never acquire invented stairs from this demonstration rule.
    if(this.model.source?.schema!=='SyntheticDemo')return;
    for(const mesh of this.floorMeshes) {
      const id=String(mesh.userData.elementId),b=this.boxes.get(id)!;
      if(b.max.y<.2||b.max.y>.8||b.max.x-b.min.x<2)continue;
      const x=(b.min.x+b.max.x)/2+this.accessRamps.length*1.2;
      const base:Point=[x,0,b.max.z+2.5],landing:Point=[x,b.max.y,b.max.z+.05],top:Point=[x,b.max.y,b.max.z-.4];
      const root=new THREE.Group();this.group.add(root);
      const n=Math.ceil(b.max.y/.16),length=(base[2]-landing[2])/n;
      for(let i=0;i<n;i++)this.box(root,[.95,b.max.y*(i+1)/n,length],[x,b.max.y*(i+1)/n/2,base[2]-(i+.5)*length],this.wood);
      this.accessRamps.push({base,landing,top,floorId:id,root,ready:this.completion.get(id)??0});
    }
  }
  private navigationWorld(occupied:Set<string>,level:number,home:Point,available:Set<string>=occupied):NavigationWorld {
    const surfaces=new Map<string,number|null>();
    const floorBoxes=this.floorMeshes.filter(m=>available.has(String(m.userData.elementId))).map(m=>({mesh:m,box:this.boxes.get(String(m.userData.elementId))!}));
    return {minX:this.siteBounds.min.x+.5,maxX:this.siteBounds.max.x-.5,minZ:this.siteBounds.min.z+.5,maxZ:this.siteBounds.max.z-.5,
      surface:(x,z)=>{
        const key=`${x.toFixed(4)},${z.toFixed(4)}`;if(surfaces.has(key))return surfaces.get(key)!;
        let height:number|null=null;
        for(const f of floorBoxes)if(Math.abs(f.box.max.y-level)<=.2&&x-.23>=f.box.min.x&&x+.23<=f.box.max.x&&z-.23>=f.box.min.z&&z+.23<=f.box.max.z) {
          const supported=[[0,0],[-.23,-.23],[.23,-.23],[-.23,.23],[.23,.23]].every(([dx,dz])=>{
            this.ray.set(new THREE.Vector3(x+dx,f.box.max.y+.1,z+dz),new THREE.Vector3(0,-1,0));
            const hit=this.ray.intersectObject(f.mesh,false)[0];return hit&&Math.abs(hit.point.y-f.box.max.y)<.04;
          });
          if(supported)height=Math.max(height??-Infinity,f.box.max.y);
        }
        if(height===null&&Math.abs(level)<.2&&(x<this.bounds.min.x-.25||x>this.bounds.max.x+.25||z<this.bounds.min.z-.25||z>this.bounds.max.z+.25))height=0;
        surfaces.set(key,height);return height;
      },clear:p=>this.routeBodyClear(p,occupied)&&![...this.crews].some(([resource,slots])=>slots.some((people,slot)=>people.some((_,member)=>{
        const other=this.stagingPoint(resource,slot,member);return distance(other,home)>.1&&Math.abs(p[1]-other[1])<1.75&&Math.hypot(p[0]-other[0],p[2]-other[2])<.6;
      })))};
  }
  private routeBodyClear(p:Point,occupied:Set<string>) {
    const body=new THREE.Box3(new THREE.Vector3(p[0]-.28,p[1]+.16,p[2]-.28),new THREE.Vector3(p[0]+.28,p[1]+1.8,p[2]+.28));
    if([...occupied].some(id=>this.boxes.get(id)?.intersectsBox(body)))return false;
    if(p[1]<3&&[...this.layout.bays.values()].some(b=>p[0]-.3<b.envelope.maxX&&p[0]+.3>b.envelope.minX&&p[2]-.3<b.envelope.maxZ&&p[2]+.3>b.envelope.minZ))return false;
    const cabin=this.layout.cabin,stock=this.layout.stock;
    if(Math.abs(p[0]-cabin[0])<1.7&&Math.abs(p[2]-cabin[2])<2.5)return false;
    if(p[0]>stock[0]-.8&&p[0]<stock[0]+2&&p[2]>stock[2]-.8&&p[2]<stock[2]+5.4)return false;
    return true;
  }
  private contactAt(point:Point,targetId:string|null,box:THREE.Box3):Point|null {
    const shoulder=new THREE.Vector3(point[0],point[1]+1,point[2]);
    const aim=box.clampPoint(shoulder,new THREE.Vector3()).lerp(box.getCenter(new THREE.Vector3()),.002);
    if(shoulder.distanceTo(aim)>1.3)return null;
    if(!targetId)return aim.toArray() as Point;
    const mesh=this.meshes.get(targetId);if(!mesh)return null;
    this.ray.set(shoulder,aim.clone().sub(shoulder).normalize());
    const hit=this.ray.intersectObject(mesh,false)[0];
    return hit&&hit.distance<1.3?hit.point.toArray() as Point:null;
  }
  private routeTo(home:Point,destination:Point,occupied:Set<string>,start:number):WorkerRoute|null {
    const finished=this.completedAt(start);
    const ground=this.navigationWorld(occupied,0,home,finished);
    if(Math.abs(destination[1])<.2) {
      const points=findWalkRoute(home,destination,ground);if(points)return {points,modes:points.slice(1).map(()=>'walk'),basis:['mesh_support_and_body_clearance']};
    }
    for(const ramp of this.accessRamps)if(ramp.ready<=start&&Math.abs(ramp.top[1]-destination[1])<=.2) {
      const before=findWalkRoute(home,ramp.base,ground);if(!before)continue;
      const after=findWalkRoute(ramp.top,destination,this.navigationWorld(occupied,ramp.top[1],home,finished));if(!after)continue;
      const clear=Array.from({length:30},(_,i)=>i/29).every(t=>this.routeBodyClear(ramp.base.map((v,k)=>v+(ramp.landing[k]-v)*t) as Point,occupied));
      if(!clear)continue;
      const points=[...before,ramp.landing,...after];return {points,modes:points.slice(1).map(()=>'walk'),basis:['mesh_support_and_body_clearance','synthetic_demo_proposed_access_steps']};
    }
    return null;
  }
  private planWorker(lease:Lease,member:number):WorkerTask {
    const home=this.stagingPoint(lease.resource,lease.slot,member),completed=this.completedAt(lease.start);
    // Reserve structures that appear before return as well: a route cannot close behind a worker.
    const occupied=new Set([...completed,...this.completedAt(lease.end),...[...this.completion].filter(([,t])=>t>=lease.start&&t<=lease.end).map(([id])=>id),...lease.operation.target_ids]);
    const ids=lease.operation.target_ids.filter(id=>this.boxes.has(id));
    const targetId=ids.length?ids[member%ids.length]:null;
    const target=targetId?this.boxes.get(targetId)!:this.targetBox(lease);
    const name=targetId?this.model.elements.find(e=>e.id===targetId)?.name??targetId:'Условный участок подготовительных работ';
    const candidates:{position:Point;base?:Point;top?:Point;entry?:Point;basis?:string;until?:number}[]=[];
    const access=this.temporary?.accessFor(lease.operation.id,lease.start,member);
    if(access)candidates.push({position:access.position.toArray() as Point,base:access.base.toArray() as Point,top:access.top.toArray() as Point,entry:access.entry.toArray() as Point,basis:access.basis,until:access.availableUntil});
    const center=target.getCenter(new THREE.Vector3()),offset=(member%2?1:-1)*(.4+Math.floor(member/2)*.7);
    for(const [x,z] of [[target.min.x-.55,center.z+offset],[target.max.x+.55,center.z+offset],[center.x+offset,target.min.z-.55],[center.x+offset,target.max.z+.55]]) {
      const floor=this.support(x,z,target.max.y,completed);if(floor)candidates.push({position:[x,floor.y,z]});
    }
    let reason='Не найден непрерывный маршрут с опорой от места сбора до рабочего места и обратно.';
    for(const candidate of candidates) {
      const contact=this.contactAt(candidate.position,targetId,target);if(!contact){reason='Элемент вне досягаемости инструмента с доступной опоры.';continue;}
      if(!this.reachableContact(candidate.position,contact,taskAction(lease.operation.kind).tool)){reason='Инструмент не достаёт до поверхности из доступной рабочей позы.';continue;}
      if(!this.routeBodyClear(candidate.position,occupied))continue;
      const route=this.routeTo(home,candidate.base??candidate.position,occupied,lease.start);if(!route)continue;
      if(candidate.base&&candidate.top&&candidate.entry) {
        if(candidate.until!<lease.end){reason='Подмости разбираются до возвращения работника.';continue;}
        const extra=[candidate.base,candidate.top,candidate.entry,candidate.position];
        const clear=extra.slice(1).every((b,i)=>Array.from({length:Math.ceil(distance(extra[i],b)/.12)+1},(_,n)=>n/Math.max(1,Math.ceil(distance(extra[i],b)/.12))).every(t=>this.routeBodyClear(extra[i].map((v,k)=>v+(b[k]-v)*t) as Point,occupied)));
        if(!clear){reason='Лестница или выход с неё пересекает конструкцию.';continue;}
        route.points.push(candidate.top,candidate.entry,candidate.position);route.modes.push('climb','walk','walk');route.basis.push(candidate.basis!);
      }
      const reserved=reserveWorkerTask(makeWorkerTask(lease,home,candidate.position,contact,targetId,name,route),[...this.workerTasks.values()]);
      if(reserved)return reserved;
      reason='Маршрут или рабочая позиция конфликтует с другой назначенной бригадой; свободное окно не найдено.';
    }
    return makeWorkerTask(lease,home,home,target.getCenter(new THREE.Vector3()).toArray() as Point,targetId,name,{points:[home],modes:[],basis:[]},reason);
  }
  private ensureWorkerPlans(tick:number) {
    while(this.plannedWorkerLeases<this.workerLeases.length&&this.workerLeases[this.plannedWorkerLeases].start<=tick) {
      const lease=this.workerLeases[this.plannedWorkerLeases++],people=this.crews.get(lease.resource)![lease.slot];
      for(let member=0;member<people.length;member++) {
        const key=`${lease.resource}/${lease.slot}/${lease.operation.id}/${member}`,task=this.planWorker(lease,member);
        this.workerTasks.set(key,task);
        if(!task.blocked){const geometry=this.ownGeometry(new THREE.BufferGeometry().setFromPoints(task.route.points.map(p=>new THREE.Vector3(p[0],p[1]+.06,p[2]))));
          const material=new THREE.LineDashedMaterial({color:0x228b8d,dashSize:.3,gapSize:.2,transparent:true,opacity:.65});this.materials.add(material);
          const line=new THREE.Line(geometry,material);line.computeLineDistances();line.visible=false;this.group.add(line);this.workerPaths.set(key,line);}
      }
    }
  }
  private reachableContact(point:Point,contact:Point,tool:WorkerTool) {
    const lean=Math.max(.05,Math.min(1.2,(1.15-(contact[1]-point[1]))*1.1));
    const heading=Math.atan2(contact[0]-point[0],contact[2]-point[2]);
    const shoulder=new THREE.Vector3(-.25,.46,0).applyAxisAngle(new THREE.Vector3(1,0,0),lean);
    shoulder.y+=.8-lean*.35;
    shoulder.applyAxisAngle(new THREE.Vector3(0,1,0),heading).add(new THREE.Vector3(point[0],point[1]+.035,point[2]));
    const reach=tool==='meter'?.08:tool==='trowel'?.15:tool==='hose'?.23:.17;
    const length=shoulder.distanceTo(new THREE.Vector3(...contact))-reach;
    return length>=.12&&length<=.56;
  }
  private aimWorkingHand(person:Person,contact:Point,tool:WorkerTool,stroke:number) {
    person.root.updateMatrixWorld(true);
    const shoulder=person.arms[0].getWorldPosition(new THREE.Vector3());
    const direction=new THREE.Vector3(...contact).sub(shoulder).normalize();
    const reach=tool==='meter'?.08:tool==='trowel'?.15:tool==='hose'?.23:.17;
    const withdraw=tool==='hammer'?Math.max(0,Math.min(1,(stroke+1.5)/1.2))*.11:0;
    const handWorld=new THREE.Vector3(...contact).addScaledVector(direction,-reach-withdraw);
    const hand=person.body.worldToLocal(handWorld.clone()),start=person.arms[0].position;
    const delta=hand.clone().sub(start),length=delta.length(),v=delta.normalize();
    const perpendicular=new THREE.Vector3(0,-1,0).addScaledVector(v,v.y).normalize();
    const cosine=Math.min(1,length/.56),sine=Math.sqrt(Math.max(0,1-cosine*cosine));
    const upper=v.clone().multiplyScalar(cosine).addScaledVector(perpendicular,sine);
    person.arms[0].quaternion.setFromUnitVectors(new THREE.Vector3(0,-1,0),upper);
    const lower=hand.clone().sub(start).addScaledVector(upper,-.28).normalize().applyQuaternion(person.arms[0].quaternion.clone().invert());
    person.forearms[0].quaternion.setFromUnitVectors(new THREE.Vector3(0,-1,0),lower);
    person.root.updateMatrixWorld(true);
    const toolObject=person.tools.get(tool)!;
    const localDirection=direction.applyQuaternion(person.forearms[0].getWorldQuaternion(new THREE.Quaternion()).invert());
    toolObject.quaternion.setFromUnitVectors(new THREE.Vector3(0,-1,0),localDirection);
  }
  private getCargo(lease: Lease) {
    if (this.cargo.has(lease.operation.id)) return this.cargo.get(lease.operation.id)!;
    const pivot = new THREE.Group(), ifc = new THREE.Group(); ifc.rotation.x = -Math.PI / 2; pivot.add(ifc);
    const center = this.targetBox(lease).getCenter(new THREE.Vector3());
    for (const id of lease.operation.target_ids) {
      const source = this.meshes.get(id); if (!source) continue;
      const clone = source.clone(false); clone.material = source.material.map((material) => { const copy = material.clone(); copy.clippingPlanes = []; copy.color.set(0xe4b65c); this.materials.add(copy); return copy; });
      clone.visible = true; clone.position.set(-center.x, center.z, -center.y); ifc.add(clone);
    }
    this.group.add(pivot); this.cargo.set(lease.operation.id, pivot); return pivot;
  }
  private safeLift(lease: Lease, destination: Point, half: THREE.Vector3) {
    const bottom = destination[1] + half.y + .18;
    const sweep = new THREE.Box3(new THREE.Vector3(destination[0] - half.x, bottom, destination[2] - half.z), new THREE.Vector3(destination[0] + half.x, this.transitY + half.y, destination[2] + half.z));
    for (const id of this.completedAt(lease.start)) if (!lease.operation.target_ids.includes(id) && this.boxes.get(id)?.intersectsBox(sweep)) return false;
    return true;
  }

  private equipmentObjects() {
    return [
      ...this.cranes.map((c,slot)=>({id:`crane:${slot}`,roots:[c.root,c.rope,c.hook,...c.slings,...(this.states.find(s=>s.id===`crane:${slot}`)?.operationId ? [this.cargo.get(this.states.find(s=>s.id===`crane:${slot}`)!.operationId!)].filter((v):v is THREE.Group=>Boolean(v)):[])]})),
      ...this.trucks.map((c,slot)=>({id:`truck:${slot}`,roots:[c.root]})),
      ...this.mixers.map((c,slot)=>({id:`mixer:${slot}`,roots:[c.root]})),
      ...[...this.machines].flatMap(([resource,slots])=>slots.map((c,slot)=>({id:`${resource}:${slot}`,roots:[c.root,...c.hose??[]]}))),
    ];
  }
  private parts(roots: THREE.Object3D[]) {
    const parts: {box:THREE.Box3; obb:OBB}[]=[];
    for(const root of roots) root.traverseVisible(object=>{
      if(!(object instanceof THREE.Mesh))return;
      object.geometry.computeBoundingBox();
      const local=object.geometry.boundingBox as THREE.Box3;
      if(!local||local.isEmpty())return;
      parts.push({box:local.clone().applyMatrix4(object.matrixWorld),obb:new OBB().fromBox3(local).applyMatrix4(object.matrixWorld)});
    });
    return parts;
  }
  /** Conservative mesh envelopes. Contacts are reported and the unsafe visual action is withheld. */
  private equipmentContacts(completed: Set<string>) {
    this.group.updateMatrixWorld(true);
    const actors=this.equipmentObjects().map(a=>({...a,parts:this.parts(a.roots)}));
    const obstacles=[...[...completed].filter(id=>this.boxes.has(id)).map(id=>({id:`element:${id}`,box:this.boxes.get(id)!})),
      ...this.temporary!.objects.filter(o=>o.root.visible).map(o=>({id:`temporary:${o.asset.id}`,box:new THREE.Box3().setFromObject(o.root)}))];
    const contacts: {actor:string;obstacle:string}[]=[];
    for(let i=0;i<actors.length;i++) {
      const a=actors[i];
      for(const o of obstacles) if(a.parts.some(p=>p.box.intersectsBox(o.box)&&p.obb.intersectsOBB(new OBB().fromBox3(o.box)))) {
        contacts.push({actor:a.id,obstacle:o.id});break;
      }
      for(const b of actors.slice(i+1)) if(a.parts.some(p=>b.parts.some(q=>p.box.intersectsBox(q.box)&&p.obb.intersectsOBB(q.obb)))) contacts.push({actor:a.id,obstacle:b.id});
    }
    return contacts;
  }
  private enforceEquipmentClearance(completed: Set<string>) {
    const contacts=this.equipmentContacts(completed);
    this.spatialIssues=contacts;
    const blocked=new Set(contacts.flatMap(c=>[c.actor,c.obstacle]));
    for(const id of blocked) {
      const state=this.states.find(s=>s.id===id);if(!state)continue;
      const {resource,slot}=state;
      if(resource==='crane') {
        const c=this.cranes[slot], pivot:Point=[c.mast[0],MOBILE_CRANE.pivotHeight,c.mast[2]];
        const hook:Point=[pivot[0],pivot[1]+Math.sin(.22)*MOBILE_CRANE.retractedLength-.8,pivot[2]-Math.cos(.22)*MOBILE_CRANE.retractedLength];
        const rig=mobileCraneRig(pivot,hook);
        c.slew.rotation.y=Math.PI/2;c.boom.rotation.z=rig.angle;
        c.sections.forEach(s=>s.position.x=MOBILE_CRANE.retractedLength/2);
        c.outriggers.forEach(o=>{o.beam.scale.x=1.3;o.beam.position.x=o.side*1.1;o.foot.position.set(o.side*1.65,.3,o.z);});
        this.moveRod(c.rope,rig.head,hook,.018);c.hook.position.set(...hook);c.slings.forEach(s=>s.visible=false);
        const cargo=state.operationId?this.cargo.get(state.operationId):undefined;if(cargo)cargo.visible=false;
        state.position=hook;
        if(state.equipment)Object.assign(state.equipment,{boomLength:rig.length,boomAngle:rig.angle,deployed:0,tip:rig.head});
      } else {
        const object=resource==='truck'?this.trucks[slot]:resource==='mixer'?this.mixers[slot]:this.machines.get(resource)?.[slot];
        if(object) {object.root.position.set(...this.layout.bays.get(id)!.park);state.position=object.root.position.toArray() as Point;}
        this.machines.get(resource)?.[slot].hose?.forEach(h=>h.visible=false);
      }
      state.phase='ожидание · пространственный конфликт';
      this.warnings.set(`collision:${id}`,`${id}: движение или рабочая зона пересекает препятствие. Визуальное действие остановлено; требуется изменить размещение/очерёдность. Расчётный график не пересчитан.`);
    }
  }

  update(tick: number) {
    this.temporary?.update(tick);
    this.states.length = 0; this.hiddenTargets.clear(); this.warnings.clear(); this.spatialIssues=[];
    for(const asset of this.temporary?.states??[])if(!asset.placementValid)this.warnings.set(asset.id,
      'Для вышки-туры не найдено свободное место с опорой в предварительной геометрической проверке. Требуется уточнить размещение; показано сопровождение с площадки.');
    this.formStates.length = 0;
    for (const form of this.forms) {
      const fraction = tick < form.install.start || tick >= form.strip.finish ? 0 : tick < form.install.finish ? (tick - form.install.start) / (form.install.finish - form.install.start) : tick >= form.strip.start ? 1 - (tick - form.strip.start) / (form.strip.finish - form.strip.start) : 1;
      form.root.visible = fraction > 0;
      form.mesh.geometry.setDrawRange(0, Math.floor(form.triangles * fraction) * 3);
      form.root.children.forEach((child) => { if (child !== form.mesh) child.visible = fraction > .25; });
      if (fraction > 0) this.formStates.push({ unitId: form.unitId, fraction, phase: tick < form.install.finish ? 'монтаж опалубки' : tick >= form.strip.start ? 'распалубка' : 'опалубка установлена' });
      if (tick < form.pour) for (const id of this.run.scenario.units.find((unit) => unit.id === form.unitId)!.target_ids) this.hiddenTargets.add(id);
    }
    const dig = this.run.operation_states['site:excavation'], fill = this.run.operation_states['site:compaction'];
    if (this.pit) this.pit.visible = Boolean(dig && tick >= dig.start && (!fill || tick < fill.finish));
    for (const cargo of this.cargo.values()) cargo.visible = false;
    const completed = this.completedAt(tick);
    for (const [slot, crane] of this.cranes.entries()) {
      const lease = activeLease(this.leases, 'crane', slot, tick);
      const pivot: Point = [crane.mast[0], MOBILE_CRANE.pivotHeight, crane.mast[2]];
      const idleHook: Point = [pivot[0], pivot[1] + Math.sin(.22) * MOBILE_CRANE.retractedLength - .8, pivot[2] - Math.cos(.22) * MOBILE_CRANE.retractedLength];
      let hookPoint: Point = idleHook, phase = 'стоянка · стрела сложена', deployed = 0;
      const obstacles = [...completed].map((id) => this.boxes.get(id)).filter((box): box is THREE.Box3 => Boolean(box)).map((box) => ({ min: box.min.toArray() as Point, max: box.max.toArray() as Point }));
      if (lease) {
        const target = this.targetBox(lease), center = target.getCenter(new THREE.Vector3()), half = target.getSize(new THREE.Vector3()).multiplyScalar(.5);
        const destination: Point = [center.x, center.y, center.z];
        const source=this.layout.pickups[slot];
        const pickup: Point = [source[0], .35 + half.y, source[2]];
        const p = progress(lease, tick);
        deployed = Math.min(smooth(p / .05), smooth((1 - p) / .02));
        const prior: Point = [pickup[0], this.transitY, pickup[2]];
        const pose = liftPose(Math.max(0, Math.min(1, (p - .08) / .84)), crane.mast, pickup, destination, prior, this.transitY, half.y);
        const workHook: Point = [pose.hook[0], pose.hook[1] + half.y + .55, pose.hook[2]];
        if (p < .08) {
          hookPoint = lerpPoint(idleHook, workHook, p / .08); phase = 'развёртывание автокрана';
        } else if (p >= .92) {
          const highIdle: Point = [idleHook[0], workHook[1], idleHook[2]];
          hookPoint = p < .96 ? lerpPoint(workHook, highIdle, (p - .92) / .04) : lerpPoint(highIdle, idleHook, (p - .96) / .04);
          phase = 'складывание стрелы';
        } else { hookPoint = workHook; phase = pose.phase; }
        const rig = mobileCraneRig(pivot, hookPoint, obstacles);
        const safe = this.safeLift(lease, destination, half) && rig.reachable;
        if (safe) {
          const cargo = this.getCargo(lease); cargo.visible = pose.loadVisible; cargo.position.set(...pose.position);
          cargo.traverse((object) => { if (object instanceof THREE.Mesh) for (const material of object.material as THREE.MeshStandardMaterial[]) { material.transparent = pose.opacity < 1; material.opacity = pose.opacity; } });
          for (const id of lease.operation.target_ids) if (!pose.installed) this.hiddenTargets.add(id);
          for (let index = 0; index < crane.slings.length; index++) {
            const sling = crane.slings[index]; sling.visible = pose.attached && pose.loadVisible;
            this.moveRod(sling, hookPoint, [pose.position[0] + (index % 2 ? 1 : -1) * half.x * .7, pose.position[1] + half.y, pose.position[2] + (index < 2 ? 1 : -1) * half.z * .7], .012);
          }
        } else {
          hookPoint = idleHook; deployed = 0;
          phase = 'траектория не подтверждена'; this.warnings.set(lease.operation.id, 'Подъём выходит за условный вылет стрелы или пересекает завершённую конструкцию; требуется уточнение техники и позиции.');
          crane.slings.forEach((sling) => { sling.visible = false; });
        }
      } else crane.slings.forEach((sling) => { sling.visible = false; });
      const rig = mobileCraneRig(pivot, hookPoint, obstacles);
      crane.slew.rotation.y = -Math.atan2(hookPoint[2] - pivot[2], hookPoint[0] - pivot[0]);
      crane.boom.rotation.z = rig.angle;
      crane.sections.forEach((section, index) => {
        section.position.x = MOBILE_CRANE.retractedLength / 2 + index * (rig.length - MOBILE_CRANE.retractedLength) / (crane.sections.length - 1);
      });
      for (const outrigger of crane.outriggers) {
        const extension = .2 + (MOBILE_CRANE.outriggerWidth / 2 - 1.2) * deployed;
        outrigger.beam.scale.x = extension; outrigger.beam.position.x = outrigger.side * (1 + extension / 2);
        outrigger.foot.visible = deployed > .05; outrigger.foot.position.set(outrigger.side * (1 + extension), 0, outrigger.z);
      }
      this.moveRod(crane.rope, rig.head, hookPoint, .018);
      crane.hook.position.set(...hookPoint);
      this.states.push({ id: `crane:${slot}`, resource: 'crane', slot, operationId: lease?.operation.id ?? null, active: Boolean(lease), phase, position: hookPoint,
        equipment: { type: MOBILE_CRANE.type, boomLength: rig.length, boomAngle: rig.angle, deployed, tip: rig.head, loadMassKg: null, status: MOBILE_CRANE.evidence } });
    }
    for (const [slot, truck] of this.trucks.entries()) {
      const lease = activeLease(this.leases, 'truck', slot, tick);
      const {park,dock}=this.layout.bays.get(`truck:${slot}`)!;
      const pose = truckPose(lease, tick, park, dock);
      truck.root.position.set(...pose.position);
      truck.root.rotation.y = 0; // Reverse along the same isolated access lane after unloading.
      truck.wheels.forEach((wheel) => { wheel.rotation.x = pose.moving ? pose.travel * 34 : 0; });
      const p = lease ? progress(lease, tick) : 0;
      truck.load.visible = Boolean(lease) && p < .63;
      truck.load.position.y = pose.unloading ? -.35 * smooth((p - .42) / .2) : 0;
      truck.gate.scale.y = .08;
      this.states.push({ id: `truck:${slot}`, resource: 'truck', slot, operationId: lease?.operation.id ?? null, active: Boolean(lease), phase: pose.phase, position: pose.position });
    }
    this.ensureWorkerPlans(tick);
    for(const path of this.workerPaths.values())path.visible=false;
    for(const ramp of this.accessRamps)ramp.root.visible=ramp.ready<=tick;
    for (const [resource, slots] of this.crews) for (const [slot, people] of slots.entries()) {
      const lease=activeLease(this.leases,resource,slot,tick);
      const workers:NonNullable<SiteActorState['workers']>=[];
      for(const [member,person] of people.entries()) {
        const task=lease?this.workerTasks.get(`${resource}/${slot}/${lease.operation.id}/${member}`):undefined;
        person.root.visible=Boolean(task);person.marker.visible=false;
        for(const tool of person.tools.values()){tool.visible=false;tool.quaternion.identity();}
        person.forearms.forEach(arm=>arm.quaternion.identity());
        if(!task)continue;
        const path=this.workerPaths.get(`${resource}/${slot}/${lease!.operation.id}/${member}`);if(path)path.visible=true;
        const pose=sampleWorkerTask(task,tick,member),point=pose.position;
        person.root.position.set(point[0],point[1]+.035,point[2]);
        const heading=pose.phase==='climb'?[0,0,1]:pose.direction;
        person.root.rotation.y=Math.atan2(heading[0],heading[2]);
        person.body.rotation.x=pose.phase==='work'?Math.max(.05,Math.min(1.2,(1.15-(task.contact[1]-point[1]))*1.1)):0;
        person.body.position.y=.8-person.body.rotation.x*.35;
        person.legs.forEach((leg,i)=>leg.rotation.x=pose.walk*(i?-1:1));
        person.arms.forEach((arm,i)=>{arm.quaternion.identity();arm.rotation.x=pose.phase==='climb'?-2+pose.walk*(i?-1:1):pose.arm*(i&&pose.phase!=='work'?-1:1);});
        const tool=person.tools.get(task.tool)!;tool.visible=pose.phase!=='blocked';
        if(pose.phase==='work') {
          this.aimWorkingHand(person,task.contact,task.tool,pose.arm);
          person.marker.visible=true;person.marker.position.set(...task.contact);
        }
        if(task.blocked)this.warnings.set(`worker:${resource}:${slot}:${member}`,`${task.targetName}: ${task.blocked} Назначение по графику не подтверждает выполнение работы.`);
        workers.push({position:point,supportId:task.route.basis.includes('assumed_external_tower_ladder')?'temporary-access':null,
          supported:!task.blocked,fallback:Boolean(task.blocked),visible:true,action:pose.action,arm:pose.arm,phase:pose.phase,
          targetId:task.targetId,targetName:task.targetName,tool:task.tool,route:task.route.points,routeBasis:task.route.basis,
          reason:task.blocked,contact:task.contact,workProgress:pose.progress});
      }
      this.states.push({id:`${resource}:${slot}`,resource,slot,operationId:lease?.operation.id??null,active:Boolean(lease),
        phase:workers.map(w=>w.action).filter((v,i,a)=>a.indexOf(v)===i).join(' / ')||'нет назначения',
        position:people[0].root.position.toArray() as Point,workers});
    }
    for (const [slot, mixer] of this.mixers.entries()) {
      const lease = activeLease(this.leases, 'mixer', slot, tick);
      const {park,dock}=this.layout.bays.get(`mixer:${slot}`)!;
      const pose = truckPose(lease, tick, park, dock); mixer.root.position.set(...pose.position); mixer.root.visible = Boolean(lease);
      mixer.drum.rotation.z = lease ? progress(lease, tick) * 18 : 0;
      this.states.push({ id: `mixer:${slot}`, resource: 'mixer', slot, operationId: lease?.operation.id ?? null, active: Boolean(lease), phase: lease ? 'доставка и подача бетонной смеси' : 'ожидание назначения', position: pose.position });
    }
    for (const [resource, machines] of this.machines) for (const [slot, machine] of machines.entries()) {
      const lease = activeLease(this.leases, resource, slot, tick), p = lease ? progress(lease, tick) : 0;
      const bay=this.layout.bays.get(`${resource}:${slot}`)!;
      const point: Point = [...bay.dock];
      machine.root.visible = Boolean(lease);
      if (lease) {
        if (resource === 'excavator') { machine.root.rotation.y = Math.PI; }
        if (resource === 'dump_truck'||resource==='compactor') {const pose=truckPose(lease,tick,bay.park,bay.dock);point[2]=pose.position[2];}
        if (resource === 'vibrator') { const target = this.targetBox(lease); point[0] = target.getCenter(new THREE.Vector3()).x+.8+slot*.85; point[1] = target.max.y+.05; point[2] = target.getCenter(new THREE.Vector3()).z; }
        machine.moving.forEach((object) => { if (resource === 'excavator') object.rotation.y = Math.sin(p * 30) * .6; if (resource === 'dump_truck') object.rotation.x = p > .65 && p < .85 ? -.3 : 0; });
      }
      machine.root.position.set(...point);
      if (machine.hose?.length) {
        machine.hose.forEach((rod) => { rod.visible = Boolean(lease); });
        if (lease) {
          const target = this.targetBox(lease).getCenter(new THREE.Vector3());
          const top = Math.max(this.bounds.max.y + 3, 5), dx = target.x - point[0], dz = target.z - point[2];
          const joints: Point[] = [[point[0], 1.8, point[2]], [point[0], top, point[2]], [point[0] + dx * .5, top + 1, point[2] + dz * .5], [target.x, top, target.z], [target.x, target.y + .3, target.z]];
          machine.hose.forEach((rod, i) => this.moveRod(rod, joints[i], joints[i + 1], i === 3 ? .045 : .09));
        }
      }
      const phase: Record<string, string> = { concrete_pump: 'подача бетонной смеси к фронту', excavator: 'разработка / перемещение грунта', dump_truck: 'погрузка и вывоз / подвоз грунта', compactor: 'уплотнение слоя', vibrator: 'виброуплотнение бетона' };
      this.states.push({ id: `${resource}:${slot}`, resource, slot, operationId: lease?.operation.id ?? null, active: Boolean(lease), phase: lease ? phase[resource] : 'ожидание назначения', position: point });
    }
    const batches = this.run.scenario.units.filter((unit) => {
      const delivery = this.run.scenario.operations.find((operation) => operation.unit_id === unit.id && operation.kind === 'delivery');
      if (!delivery || this.run.operation_states[delivery.id].finish > tick) return false;
      const work = unit.operation_ids.find((id) => this.run.scenario.operations.find((operation) => operation.id === id)?.visual_phase === 'work');
      return work && this.run.operation_states[work].start > tick;
    }).length;
    this.stock.forEach((stock, index) => { stock.visible = index < Math.min(this.stock.length, batches); });
    this.enforceEquipmentClearance(completed);
  }

  snapshot() {
    return { actors: structuredClone(this.states), warnings: [...this.warnings].map(([operationId, message]) => ({ operationId, message })),
      hiddenTargets: [...this.hiddenTargets], formwork: structuredClone(this.formStates), equipmentProfile: MOBILE_CRANE,
      temporaryAccess: structuredClone(this.temporary?.states ?? []),
      excavationProxyVisible: Boolean(this.pit?.visible),
      spatialConflicts:structuredClone(this.spatialIssues),
      layoutBasis:'expandable_visual_site_not_surveyed',
      truckRoadClearance: this.bounds.min.x - this.roadX, animationVersion: '0.6.0' };
  }
  dispose() {
    this.temporary?.dispose();
    this.group.removeFromParent();
    this.group.traverse((object) => { (object.userData.ownedTexture as THREE.Texture | undefined)?.dispose(); });
    this.geom.forEach((geometry) => geometry.dispose()); this.materials.forEach((material) => material.dispose());
    this.group.clear();
  }
}
