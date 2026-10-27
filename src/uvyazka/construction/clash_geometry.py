"""Bounded mesh queries in SI coordinates. No CAD application or LLM dependency.

Intersection evidence is a point strictly inside two closed meshes. Surface-only
contacts and unclosed/approximate meshes are reported separately by the caller.
"""
from __future__ import annotations

from dataclasses import dataclass
import heapq
import itertools
import math

EPS = 1e-8


def add(a, b): return tuple(x+y for x, y in zip(a, b))
def sub(a, b): return tuple(x-y for x, y in zip(a, b))
def mul(a, s): return tuple(x*s for x in a)
def dot(a, b): return sum(x*y for x, y in zip(a, b))
def cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def length(a): return math.sqrt(dot(a, a))
def midpoint(a, b): return mul(add(a, b), .5)
def unit(a): return mul(a, 1/max(length(a), EPS))


def bounds(points):
    return tuple(min(p[i] for p in points) for i in range(3)), tuple(max(p[i] for p in points) for i in range(3))


def box_distance(a, b):
    return math.sqrt(sum(max(a[0][i]-b[1][i], b[0][i]-a[1][i], 0)**2 for i in range(3)))


def closest_triangle(p, tri):
    """Closest point using triangle Voronoi regions, including edges."""
    a, b, c = tri; ab = sub(b, a); ac = sub(c, a); ap = sub(p, a)
    d1, d2 = dot(ab, ap), dot(ac, ap)
    if d1 <= 0 and d2 <= 0: return a
    bp = sub(p, b); d3, d4 = dot(ab, bp), dot(ac, bp)
    if d3 >= 0 and d4 <= d3: return b
    vc = d1*d4-d3*d2
    if vc <= 0 and d1 >= 0 and d3 <= 0: return add(a, mul(ab, d1/(d1-d3)))
    cp = sub(p, c); d5, d6 = dot(ab, cp), dot(ac, cp)
    if d6 >= 0 and d5 <= d6: return c
    vb = d5*d2-d1*d6
    if vb <= 0 and d2 >= 0 and d6 <= 0: return add(a, mul(ac, d2/(d2-d6)))
    va = d3*d6-d5*d4
    if va <= 0 and d4-d3 >= 0 and d5-d6 >= 0:
        return add(b, mul(sub(c, b), (d4-d3)/((d4-d3)+(d5-d6))))
    den = va+vb+vc
    if abs(den) < 1e-30: return min(tri, key=lambda v: length(sub(v, p)))
    return add(a, add(mul(ab, vb/den), mul(ac, vc/den)))


def closest_segments(p, q, r, s):
    u, v, w = sub(q, p), sub(s, r), sub(p, r)
    a, b, c, d, e = dot(u, u), dot(u, v), dot(v, v), dot(u, w), dot(v, w)
    if a < 1e-30: return p, add(r, mul(v, max(0, min(1, e/c)))) if c > 1e-30 else r
    if c < 1e-30: return add(p, mul(u, max(0, min(1, -d/a)))), r
    den = a*c-b*b
    t = max(0, min(1, (b*e-c*d)/den)) if den > 1e-30 else 0
    z = (b*t+e)/c
    if z < 0: z = 0; t = max(0, min(1, -d/a))
    elif z > 1: z = 1; t = max(0, min(1, (b-d)/a))
    return add(p, mul(u, t)), add(r, mul(v, z))


def ray_triangle(p, direction, tri):
    a, b, c = tri; e1, e2 = sub(b, a), sub(c, a)
    h = cross(direction, e2); det = dot(e1, h)
    if abs(det) < 1e-14: return None
    s = sub(p, a); u = dot(s, h)/det
    if u < -1e-9 or u > 1+1e-9: return None
    q = cross(s, e1); v = dot(direction, q)/det
    if v < -1e-9 or u+v > 1+1e-9: return None
    t = dot(e2, q)/det
    return t if t >= -EPS else None


def triangle_distance(a, b):
    hits = []
    best = (math.inf, a[0], b[0])
    for first, second in ((a, b), (b, a)):
        for i, p in enumerate(first):
            q = first[(i+1) % 3]; direction = sub(q, p)
            t = ray_triangle(p, direction, second)
            if t is not None and -EPS <= t <= 1+EPS: hits.append(add(p, mul(direction, t)))
            near = closest_triangle(p, second); distance = length(sub(p, near))
            if distance < best[0]: best = (distance, p, near) if first is a else (distance, near, p)
    if hits: return 0., hits[0], hits[0], hits
    for i in range(3):
        for j in range(3):
            p, q = closest_segments(a[i], a[(i+1) % 3], b[j], b[(j+1) % 3])
            d = length(sub(p, q))
            if d < best[0]: best = d, p, q
    return *best, []


@dataclass
class Node:
    box: tuple
    indices: list[int]
    left: Node | None = None
    right: Node | None = None


class Mesh:
    def __init__(self, vertices, indices):
        self.vertices = vertices
        self.triangles = [tuple(vertices[indices[i+j]] for j in range(3)) for i in range(0, len(indices), 3)]
        self.boxes = [bounds(t) for t in self.triangles]
        self.box = bounds(vertices)
        self.root = self._node(list(range(len(self.triangles))))
        # Weld equal coordinates for exporters which duplicate face vertices.
        welded = [tuple(round(x, 8) for x in p) for p in vertices]
        edges = {}
        for i in range(0, len(indices), 3):
            face = [welded[indices[i+j]] for j in range(3)]
            for j in range(3):
                p, q = face[j], face[(j+1) % 3]
                key = tuple(sorted((p, q))); edges[key] = edges.get(key, 0)+1
        self.closed = bool(edges) and all(n == 2 for n in edges.values())

    def _node(self, indices):
        box = bounds([p for i in indices for p in self.boxes[i]])
        if len(indices) <= 8: return Node(box, indices)
        axis = max(range(3), key=lambda i: box[1][i]-box[0][i])
        indices.sort(key=lambda i: sum(p[axis] for p in self.boxes[i]))
        split = len(indices)//2
        return Node(box, [], self._node(indices[:split]), self._node(indices[split:]))

    def inside(self, p, budget):
        if not self.closed: return False
        if any(p[i] <= self.box[0][i]+EPS or p[i] >= self.box[1][i]-EPS for i in range(3)): return False
        votes = 0
        for direction in ((1., .371, .127), (.193, 1., .531), (.417, .233, 1.)):
            hits = []; stack = [self.root]
            while stack:
                node = stack.pop()
                lo, hi = -math.inf, math.inf
                for i in range(3):
                    a, b = (node.box[0][i]-p[i])/direction[i], (node.box[1][i]-p[i])/direction[i]
                    lo, hi = max(lo, min(a, b)), min(hi, max(a, b))
                if hi < max(0, lo): continue
                if node.indices:
                    for i in node.indices:
                        budget.step(); t = ray_triangle(p, direction, self.triangles[i])
                        if t is not None and t > EPS: hits.append(t)
                else: stack.extend((node.left, node.right))
            hits.sort(); unique = [t for i, t in enumerate(hits) if not i or abs(t-hits[i-1]) > EPS*10]
            votes += len(unique) % 2
        return votes >= 2

    def boundary_distance(self,p,budget):
        box=(p,p);best=math.inf;queue=[];serial=itertools.count()
        heapq.heappush(queue,(box_distance(box,self.box),next(serial),self.root))
        while queue:
            lower,_,node=heapq.heappop(queue)
            if lower>=best:continue
            if node.indices:
                for index in node.indices:
                    budget.step();best=min(best,length(sub(p,closest_triangle(p,self.triangles[index]))))
            else:
                for child in (node.left,node.right):heapq.heappush(queue,(box_distance(box,child.box),next(serial),child))
        return best


class BudgetExceeded(Exception): pass
class Cancelled(Exception): pass


class Budget:
    def __init__(self, maximum=2_000_000, cancelled=lambda: False, progress=None):
        self.maximum, self.tests, self.cancelled, self.progress = maximum, 0, cancelled, progress

    def step(self):
        self.tests += 1
        if self.tests > self.maximum: raise BudgetExceeded('Triangle-query budget exhausted')
        if self.tests % 128 == 0 and self.cancelled(): raise Cancelled()
        if self.tests % 1024 == 0 and self.progress:self.progress(self.tests)


def compare(a, b, clearance, tolerance, budget):
    """Return distance/witness evidence, or an explicit uncertain contact."""
    queue = []; sequence = itertools.count(); candidates = []
    cutoff = clearance if clearance > 0 else EPS*10
    heapq.heappush(queue, (box_distance(a.box, b.box), next(sequence), a.root, b.root))
    closest = None
    while queue:
        lower, _, na, nb = heapq.heappop(queue)
        if lower > cutoff+EPS: continue
        if na.indices and nb.indices:
            for ia in na.indices:
                for ib in nb.indices:
                    if box_distance(a.boxes[ia], b.boxes[ib]) > cutoff+EPS: continue
                    budget.step(); d, pa, pb, hits = triangle_distance(a.triangles[ia], b.triangles[ib])
                    if closest is None or d < closest[0]: closest = d, pa, pb
                    if d < cutoff: cutoff = d
                    if d <= EPS*10:
                        candidates.append((midpoint(pa, pb), ia, ib))
                        if hits:
                            candidates.append((tuple(sum(h[k] for h in hits)/len(hits) for k in range(3)), ia, ib))
        else:
            children = [(na, nb.left), (na, nb.right)] if nb.left and (not na.left or len(na.indices)) else [(na.left, nb), (na.right, nb)]
            for x, y in children: heapq.heappush(queue, (box_distance(x.box, y.box), next(sequence), x, y))
    # Containment must be checked even if the two surfaces never intersect.
    def interior_witness(q):
        if not a.inside(q,budget) or not b.inside(q,budget):return None
        radius=min(a.boundary_distance(q,budget),b.boundary_distance(q,budget))
        if 2*radius<=tolerance+EPS:return None
        return {'kind':'intersection','point_m':q,'proof':'interior_witness','distance_m':0.,'penetration_lower_bound_m':2*radius}
    containment=False
    if a.closed and b.closed:
        # A centroid is only a candidate: concave solids may have it outside.
        # Verify it in BOTH solids rather than assuming convexity.
        for original in (a,b):
            center=tuple(sum(v[i] for v in original.vertices)/len(original.vertices) for i in range(3))
            witness=interior_witness(center)
            if witness:return witness
        for original, other in ((a, b), (b, a)):
            for p in original.vertices:
                if other.inside(p, budget):
                    containment=True
                    # Move off the first mesh's boundary before claiming a witness.
                    center = tuple(sum(v[i] for v in original.vertices)/len(original.vertices) for i in range(3))
                    q = add(p, mul(unit(sub(center, p)), max(tolerance*4, 1e-6)))
                    witness=interior_witness(q)
                    if witness:return witness
        for p, ia, ib in candidates:
            normals = [unit(cross(sub(t[1], t[0]), sub(t[2], t[0]))) for t in (a.triangles[ia], b.triangles[ib])]
            offset = max(tolerance, 1e-6)
            for sa, sb in itertools.product((-1, 1), repeat=2):
                direction = unit(add(mul(normals[0], sa), mul(normals[1], sb)))
                q = add(p, mul(direction, offset))
                witness=interior_witness(q)
                if witness:return witness
    if closest and clearance > 0 and closest[0]+EPS < clearance:
        return {'kind':'clearance', 'distance_m':closest[0], 'point_m':midpoint(closest[1], closest[2]), 'proof':'mesh_surface_distance'}
    if containment and not candidates:
        return {'kind':'question','distance_m':0.,'point_m':center,'proof':'contained_vertex_without_above_tolerance_witness'}
    if candidates:
        flat_bounds = any(min(a.box[1][i],b.box[1][i])-max(a.box[0][i],b.box[0][i]) <= EPS for i in range(3))
        return {'kind':'contact' if a.closed and b.closed and flat_bounds else 'question', 'distance_m':0., 'point_m':candidates[0][0], 'proof':'surface_contact_without_interior_witness'}
    return None
