import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BimElement, ModelPackage } from './model';
import { validatePackage } from './model';
import { ConstructionSite } from './site';
import type { RunPackage } from './simulation';

type ElementMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>;
export type ConstructionState = 'future' | 'active' | 'complete' | 'absent';

/** Owns presentation only. No scheduling, resources, or simulation clocks. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10000);
  readonly controls: OrbitControls;
  readonly root = new THREE.Group();
  readonly meshes = new Map<string, ElementMesh>();
  readonly raycaster = new THREE.Raycaster();
  readonly bounds = new THREE.Box3();
  private grid?: THREE.GridHelper;
  private ground?: THREE.Mesh;
  private selected?: string;
  private highlight?: THREE.Box3Helper;
  private edges = new Map<string, THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>>();
  private xray = false;
  private sourceColors = false;
  private construction: Map<string, ConstructionState> | null = null;
  private showFuture = false;
  private site?: ConstructionSite;
  private model?: ModelPackage;
  private clipHeight: number | null = null;
  private currentElements: BimElement[] = [];
  private observer: ResizeObserver;
  private frame = 0;
  private pointerStart = { x: 0, y: 0 };
  private onPick: (id: string | null) => void;

  constructor(readonly host: HTMLElement, onPick: (id: string | null) => void) {
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x12181d, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.localClippingEnabled = true;
    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-label', '3D-модель. Мышь: вращение, правая кнопка: перемещение, колесо: масштаб. Стрелки: перемещение. F: вся модель. Escape: снять выделение.');
    canvas.tabIndex = 0;
    this.host.append(canvas);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.listenToKeyEvents(canvas);
    this.controls.addEventListener('change', this.invalidate);
    this.root.rotation.x = -Math.PI / 2; // IFC Z-up -> Three.js Y-up, once.
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xe7edf4, 0x53606d, 2.1));
    const sun = new THREE.DirectionalLight(0xfff5df, 3);
    sun.position.set(18, 28, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.035;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xd9e7f7, 1.3);
    fill.position.set(-15, 10, -10);
    this.scene.add(fill);
    this.observer = new ResizeObserver(() => {
      const { width, height } = this.host.getBoundingClientRect();
      this.renderer.setSize(width, height);
      this.camera.aspect = width / Math.max(height, 1);
      this.camera.updateProjectionMatrix();
      this.invalidate();
    });
    this.observer.observe(host);
    canvas.addEventListener('pointerdown', (event) => { this.pointerStart = { x: event.clientX, y: event.clientY }; });
    canvas.addEventListener('pointerup', (event) => {
      if (event.button !== 0 || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 4) return;
      const rect = canvas.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
      const targets = [...this.meshes.values()].filter((mesh) => mesh.visible);
      const hit = this.raycaster.intersectObjects(targets, false).find((hit) => this.clipHeight === null || hit.point.y <= this.clipHeight);
      this.onPick(hit ? String(hit.object.userData.elementId) : null);
    });
    canvas.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); this.fit(); }
      if (event.key === 'Escape') this.onPick(null);
    });
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      host.dispatchEvent(new CustomEvent('viewer-error', { detail: 'Графический контекст потерян. Перезагрузите страницу, чтобы восстановить 3D-просмотр.' }));
    });
  }

  readonly invalidate = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    });
  };

  load(pkg: ModelPackage, binary: ArrayBuffer) {
    validatePackage(pkg, binary);
    this.clearModel();
    this.model = pkg;
    this.currentElements = pkg.elements;
    // Bound edge extraction work on large imports; meshes beyond the budget retain solid geometry.
    let edgeBudget = 600_000;
    for (const element of pkg.elements) {
      const data = element.mesh;
      if (!data) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(binary, data.position_byte_offset, data.vertex_count * 3), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(binary, data.index_byte_offset, data.index_count), 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      for (const group of data.groups) geometry.addGroup(group.start, group.count, group.material_index);
      const materials = data.styles.map((style) => {
        const isFeature = element.role === 'feature' || element.role === 'space';
        const color = isFeature ? new THREE.Color(element.role === 'space' ? 0x60a5b8 : 0xe5a44c) : new THREE.Color().setRGB(...style.color, THREE.SRGBColorSpace);
        return new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide,
          roughness: 0.85, metalness: 0.02, flatShading: true, transparent: isFeature || style.opacity < 1,
          opacity: isFeature ? 0.16 : style.opacity, depthWrite: !isFeature && style.opacity >= 1 });
      });
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.userData.elementId = element.id;
      mesh.userData.role = element.role;
      mesh.userData.filterVisible = element.role === 'element';
      mesh.userData.baseColors = materials.map((material) => material.color.clone());
      mesh.castShadow = element.role === 'element';
      mesh.receiveShadow = true;
      mesh.visible = element.role === 'element';
      if(element.role==='element' && data.index_count<=Math.min(edgeBudget,150_000)) {
        const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geometry,25),new THREE.LineBasicMaterial({color:0x586877,transparent:true,opacity:.25,depthWrite:false}));
        mesh.add(edges);this.edges.set(element.id,edges);edgeBudget-=data.index_count;
        materials.forEach(material=>{material.polygonOffset=true;material.polygonOffsetFactor=1;material.polygonOffsetUnits=1;});
      }
      this.root.add(mesh);
      this.meshes.set(element.id, mesh);
    }
    this.root.updateMatrixWorld(true);
    const origin = pkg.coordinate_system.render_origin_m;
    const convert = (point: number[]) => new THREE.Vector3(point[0] - origin[0], point[2] - origin[2], -(point[1] - origin[1]));
    this.bounds.setFromPoints([convert(pkg.coordinate_system.bounds_min_m), convert(pkg.coordinate_system.bounds_max_m)]);
    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 5);
    this.grid = new THREE.GridHelper(Math.ceil(span * 2.4), 28, 0x37434d, 0x253039);
    this.grid.position.set(this.bounds.getCenter(new THREE.Vector3()).x,this.bounds.min.y-.04,this.bounds.getCenter(new THREE.Vector3()).z);
    this.scene.add(this.grid);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 5, span * 5), new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.3 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.copy(this.grid.position);this.ground.position.y=this.bounds.min.y-.025;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    const sun = this.scene.children.find((item) => item instanceof THREE.DirectionalLight && item.castShadow) as THREE.DirectionalLight;
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, far: span * 8 });
    sun.position.set(span, span * 1.8, span);
    sun.shadow.camera.updateProjectionMatrix();
    this.camera.near = Math.max(span / 10000, 0.001);
    this.camera.far = span * 1000;
    this.controls.minDistance = span * 0.015;
    this.controls.maxDistance = span * 50;
    this.fit();
    this.host.dataset.renderReady = 'true';
    this.host.dataset.meshCount = String(this.meshes.size);
  }

  fit(direction: 'iso' | 'top' | 'front' = 'iso', selectedOnly = false) {
    this.camera.up.set(0,1,0);
    if (this.bounds.isEmpty()) return;
    let bounds = this.site?.group.visible ? this.site.siteBounds : this.bounds;
    const mesh = this.selected ? this.meshes.get(this.selected) : null;
    if (selectedOnly && mesh) bounds = new THREE.Box3().setFromObject(mesh);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const axis = direction === 'top' ? new THREE.Vector3(0, 1, 0.0001) : direction === 'front' ? new THREE.Vector3(0, 0.14, 1) : new THREE.Vector3(1, 0.82, 1.2);
    axis.normalize();
    const right=new THREE.Vector3(0,1,0).cross(axis).normalize(), up=axis.clone().cross(right);
    let distance=1;
    for(const x of [-.5,.5])for(const y of [-.5,.5])for(const z of [-.5,.5]) {
      const corner=new THREE.Vector3(size.x*x,size.y*y,size.z*z), depth=corner.dot(axis);
      distance=Math.max(distance,depth+Math.abs(corner.dot(right))/(Math.tan(halfFov)*this.camera.aspect),depth+Math.abs(corner.dot(up))/Math.tan(halfFov));
    }
    distance*=1.08;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(axis.normalize(), distance);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  /** Reconstruct orientation only: native view directions are unitless Z-up.
   * Origin/scale/crop/visibility are deliberately not inferred. */
  orient(direction:[number,number,number],up:[number,number,number]) {
    if(this.bounds.isEmpty())return;
    const axis=new THREE.Vector3(direction[0],direction[2],-direction[1]).normalize();
    const vertical=new THREE.Vector3(up[0],up[2],-up[1]).normalize();
    const right=vertical.clone().cross(axis).normalize();vertical.copy(axis).cross(right).normalize();
    const center=this.bounds.getCenter(new THREE.Vector3()),size=this.bounds.getSize(new THREE.Vector3());
    const tangent=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2));let distance=1;
    for(const x of [-.5,.5])for(const y of [-.5,.5])for(const z of [-.5,.5]){
      const corner=new THREE.Vector3(size.x*x,size.y*y,size.z*z),depth=corner.dot(axis);
      distance=Math.max(distance,depth+Math.abs(corner.dot(right))/(tangent*this.camera.aspect),depth+Math.abs(corner.dot(vertical))/tangent);
    }
    this.camera.up.copy(vertical);this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(axis,distance*1.08);this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();this.controls.update();this.invalidate();
  }

  show(ids: Set<string>) {
    let count = 0;
    for (const [id, mesh] of this.meshes) {
      mesh.userData.filterVisible = ids.has(id);
      mesh.visible = ids.has(id);
      if (mesh.visible) count++;
    }
    this.host.dataset.visibleMeshes = String(count);
    this.refreshPresentation();
    this.invalidate();
  }

  select(id: string | null) {
    this.selected = id ?? undefined;
    if (this.highlight) { this.scene.remove(this.highlight); this.highlight.dispose(); this.highlight = undefined; }
    for (const [key, mesh] of this.meshes) {
      for (const material of mesh.material) {
        material.emissive.set(key === id ? 0x805b16 : 0x000000);
        material.emissiveIntensity = key === id ? 0.34 : 0;
      }
    }
    const mesh = id ? this.meshes.get(id) : undefined;
    if (mesh) {
      this.highlight = new THREE.Box3Helper(new THREE.Box3().setFromObject(mesh), new THREE.Color(0xefb65e));
      this.scene.add(this.highlight);
    }
    this.refreshPresentation();
  }

  setXray(active: boolean, elements: BimElement[]) {
    this.xray = active;
    this.currentElements = elements;
    this.refreshPresentation();
  }
  setSourceColors(active:boolean) {this.sourceColors=active;this.refreshPresentation();}

  setConstruction(states: Map<string, ConstructionState> | null, showFuture = false) {
    this.showFuture = showFuture;
    this.construction = states;
    this.refreshPresentation();
  }

  setSite(run: RunPackage | null, time = 0) {
    if (!run) { if (this.site) this.site.group.visible = false; return; }
    if (this.site?.run.run_id !== run.run_id && this.model) {
      this.site?.dispose();
      this.site = new ConstructionSite(this.model, run, this.meshes);
      this.scene.add(this.site.group);
    }
    if (this.site) { this.site.group.visible = true; this.site.update(time); this.invalidate(); }
  }

  siteState() { return this.site?.snapshot() ?? null; }

  focusWorkerRoute(operationId:string) {
    const workers=this.site?.states.filter(a=>a.operationId===operationId).flatMap(a=>a.workers??[])??[];
    const points=workers.flatMap(w=>w.route.length?w.route:[w.position]);if(!points.length)return;
    const bounds=new THREE.Box3().setFromPoints(points.map(p=>new THREE.Vector3(...p)));bounds.max.y+=1.8;
    const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
    const distance=Math.max(8,size.length()*1.6)*Math.max(1,1/this.camera.aspect);
    this.controls.target.copy(center);this.camera.position.copy(center).addScaledVector(new THREE.Vector3(1,.9,1.2).normalize(),distance);
    this.camera.lookAt(center);this.controls.update();this.invalidate();
  }

  focusTargets(ids: string[], azimuth = .8, elevation = .65) {
    const box = new THREE.Box3();
    for (const id of ids) { const mesh = this.meshes.get(id); if (mesh) box.union(new THREE.Box3().setFromObject(mesh)); }
    if (box.isEmpty()) { this.cameraOrbit(azimuth, elevation, .86, 'site'); return; }
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const distance = Math.max(9, size.length() * 1.7) * Math.max(1, 1/this.camera.aspect);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(Math.cos(azimuth)*Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth)*Math.cos(elevation)).multiplyScalar(distance));
    this.camera.lookAt(center); this.controls.update(); this.invalidate();
  }

  cutaway(height: number | null) {
    this.clipHeight = height;
    const planes = height === null ? [] : [new THREE.Plane(new THREE.Vector3(0, -1, 0), height)];
    for (const mesh of this.meshes.values()) for (const material of mesh.material) {
      material.clippingPlanes = planes; material.clipShadows = true; material.needsUpdate = true;
    }
    for(const edge of this.edges.values()){edge.material.clippingPlanes=planes;edge.material.needsUpdate=true;}
    this.invalidate();
  }

  cameraOrbit(azimuth: number, elevation: number, scale = 1, scope: 'site' | 'model' = 'site', offset = [0, 0, 0]) {
    const bounds = scope === 'site' && this.site ? this.site.siteBounds : this.bounds;
    const center = bounds.getCenter(new THREE.Vector3()).add(new THREE.Vector3(...offset));
    const size = bounds.getSize(new THREE.Vector3());
    const distance = size.length() / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * scale * Math.max(1, 1 / this.camera.aspect);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)).multiplyScalar(distance));
    this.camera.lookAt(center); this.controls.update(); this.invalidate();
  }

  modelHeight() { return { min: this.bounds.min.y, max: this.bounds.max.y }; }

  private refreshPresentation() {
    for (const element of this.currentElements) {
      const mesh = this.meshes.get(element.id);
      if (!mesh || !element.mesh) continue;
      const state = this.construction?.get(element.id);
      mesh.visible = Boolean(mesh.userData.filterVisible) && (!this.construction || state === 'active' || state === 'complete' || state === 'future' && this.showFuture);
      if (this.construction && this.site?.group.visible && this.site.hiddenTargets.has(element.id)) mesh.visible = false;
      mesh.material.forEach((material, index) => {
        const opacity = element.role === 'space' || element.role === 'feature' ? 0.16 : element.mesh!.styles[index].opacity;
        material.color.copy((mesh.userData.baseColors as THREE.Color[])[index]);
        if(this.sourceColors&&element.role==='element') {
          const source=this.model?.federation?.members.findIndex(member=>member.instance_id===element.source_instance_id)??-1;
          if(source>=0)material.color.set([0xc9b792,0x5794b9,0x77a28a,0xa47991][source%4]);
        }
        if (state === 'active' || this.selected===element.id) material.color.set(0xefb65e);
        const alpha = state === 'future' && this.showFuture ? (this.edges.has(element.id)?.035:.12) : state === 'active' ? 0.85 : this.xray && element.role === 'element' ? Math.min(opacity, 0.2) : opacity;
        material.transparent = alpha < 1;
        material.opacity = alpha;
        material.depthWrite = alpha >= 1;
        material.needsUpdate = true;
      });
      const edges=this.edges.get(element.id);
      if(edges){edges.material.opacity=state==='future'?.5:.3;edges.material.color.set(this.selected===element.id||state==='active'?0xefb65e:state==='future'?0x8c9ba8:0x40505c);}
    }
    this.invalidate();
  }

  private clearModel() {
    this.site?.dispose(); this.site = undefined; this.clipHeight = null;
    this.select(null);
    for(const edge of this.edges.values()){edge.geometry.dispose();edge.material.dispose();}
    this.edges.clear();
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      for (const material of mesh.material) material.dispose();
    }
    this.meshes.clear();
    this.root.clear();
    this.xray = false;
    this.construction = null;
    this.currentElements = [];
    for (const helper of [this.grid, this.ground]) {
      if (!helper) continue;
      this.scene.remove(helper);
      helper.geometry.dispose();
      const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
      materials.forEach((material) => material.dispose());
    }
    this.grid = undefined;
    this.ground = undefined;
  }

  dispose() {
    this.clearModel();
    this.observer.disconnect();
    this.controls.dispose();
    cancelAnimationFrame(this.frame);
    this.renderer.dispose();
  }
}
