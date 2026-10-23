/** ModelPackage 0.1.0: renderer-independent, SI coordinates, explicit provenance. */
export type Vec3 = [number, number, number];
export interface MeshData {
  bbox_min_m: Vec3;
  bbox_max_m: Vec3;
  position_byte_offset: number;
  index_byte_offset: number;
  vertex_count: number;
  index_count: number;
  representation_id: number;
  styles: { name: string; color: Vec3; opacity: number }[];
  groups: { start: number; count: number; material_index: number }[];
  source: { kind: 'derived'; method: string; version: string; representation_id: number };
}
export interface BimElement {
  long_name?:string|null;
  tag?:string|null;
  source_quantities?:Record<string,Record<string,unknown>>;
  id: string;
  step_id: number;
  global_id: string;
  class: string;
  hierarchy: string[];
  name: string;
  role: 'element' | 'space' | 'feature' | 'spatial' | 'other';
  storey_id: string | null;
  predefined_type: string | null;
  materials: string[];
  property_sets: Record<string, Record<string, unknown>>;
  quantity_sets: Record<string, Record<string, unknown>>;
  source: { kind: 'explicit'; file_sha256: string; step_id: number };
  mesh: MeshData | null;
  geometry_error: string | null;
  geometry_evidence?: { engine: string; body_source: string | null; status: string; quantity_eligible: boolean; requires_review: boolean; reason: string };
  source_model_id?: string;
  source_instance_id?: string;
  source_element_id?: string;
  source_step_id?: number;
  revit?: { element_id: string; unique_id?: string; id_basis?:string; phase_status: string; phase_created_id?: string | null; phase_demolished_id?: string | null };
}
export interface Storey {
  id: string;
  name: string;
  elevation_m: number | null;
  placement_origin_m: Vec3 | null;
  element_count: number;
}
export interface ModelPackage {
  attribution?: Record<string,unknown>;
  contract: 'ModelPackage';
  contract_version: '0.1.0';
  importer_version: string;
  model_id: string;
  source: { filename: string; sha256: string; size_bytes: number; schema: string; exported_at: string; exporter: string; format?: string;
    conversion?: { engine: string; local_patches?: string[]; warnings: string[]; unsupported_features: string[]; ifc_sha256: string; confidence: { level?: string }; source_revision: string } };
  coordinate_system: { length_to_m: number; render_origin_m: Vec3; up_axis: 'Z'; bounds_min_m: Vec3; bounds_max_m: Vec3 };
  storeys: Storey[];
  elements: BimElement[];
  relationships: { step_id: number; class: string; parent_id: string; child_ids: string[] }[];
  diagnostics: { element_id: string; kind: string; message: string }[];
  statistics: { products: number; physical_elements: number; meshes: number; triangles: number; geometry_errors: number; binary_bytes: number };
  capabilities: { read: boolean; geometry_ready: boolean; technology_resolved: boolean; schedule_ready: boolean };
  federation?: { members: ModelMember[]; note: string };
  revit?: RevitPhases;
  phase_sources?: Record<string, RevitPhases>;
  systems?: {id:string;name:string;class:string;member_ids:string[];connectivity_verified:false;global_id?:string;description?:string|null;property_sets?:Record<string,Record<string,unknown>>}[];
}
export interface RevitPhases { status: string; phases: { id: string; name: string; order: number | null }[]; phase_order_known?: boolean }
export interface ModelMember { model_id: string; instance_id: string; label: string; offset_m: number[]; rotation_deg: number }

export function validatePackage(pkg: ModelPackage, binary: ArrayBuffer) {
  if (pkg.contract !== 'ModelPackage' || pkg.contract_version !== '0.1.0') throw new Error('Неподдерживаемая версия пакета модели');
  if (binary.byteLength !== pkg.statistics.binary_bytes) throw new Error('Геометрия загружена не полностью');
  for (const element of pkg.elements) {
    const mesh = element.mesh;
    if (!mesh) continue;
    for (const [offset, count, components] of [[mesh.position_byte_offset, mesh.vertex_count, 3], [mesh.index_byte_offset, mesh.index_count, 1]]) {
      if (!Number.isInteger(offset) || offset < 0 || offset % 4 !== 0 || !Number.isInteger(count) || count < 0 || offset + count * components * 4 > binary.byteLength) {
        throw new Error(`Неверный диапазон геометрии элемента #${element.step_id}`);
      }
    }
  }
}

export function matchesFilters(element: BimElement, storeys: Set<string>, selectedClass: string, query: string, showSpaces: boolean, showFeatures: boolean) {
  if (element.role === 'space' && !showSpaces) return false;
  if (element.role === 'feature' && !showFeatures) return false;
  if (element.role !== 'element' && element.role !== 'space' && element.role !== 'feature') return false;
  if (!storeys.has(element.storey_id ?? 'unassigned')) return false;
  if (selectedClass && !element.hierarchy.includes(selectedClass)) return false;
  if (/^#\d+$/.test(query)) return element.step_id === Number(query.slice(1));
  if (query.startsWith('#')&&query.includes(':'))return element.id===query.slice(1);
  return !query || `${element.name} ${element.class} #${element.step_id} ${element.global_id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}
