"""Small deterministic orthographic review image of actual imported IFC triangles."""
import io
import math

import numpy as np
from PIL import Image, ImageDraw


def preview(model, binary, azimuth=45., elevation=35., cut_z=None):
    if not math.isfinite(azimuth) or not math.isfinite(elevation) or not -85 <= elevation <= 85:
        raise ValueError("Неверный ракурс")
    if cut_z is not None and not math.isfinite(cut_z):
        raise ValueError("Неверная отметка разреза")
    az, el = map(math.radians, (azimuth, elevation))
    right = np.array([-math.sin(az), math.cos(az), 0])
    view = np.array([math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)])
    up = np.cross(view, right)
    transform = np.column_stack((right, up, view))
    polygons, all_points = [], []
    origin = np.asarray(model['coordinate_system']['render_origin_m'])
    for element in model['elements']:
        mesh = element['mesh']
        if not mesh or element['role'] != 'element':
            continue
        vertices = np.frombuffer(binary, dtype='<f4', count=mesh['vertex_count'] * 3, offset=mesh['position_byte_offset']).reshape(-1, 3).astype(float)
        indices = np.frombuffer(binary, dtype='<u4', count=mesh['index_count'], offset=mesh['index_byte_offset']).reshape(-1, 3)
        for i, triangle in enumerate(vertices[indices]):
            points = list(triangle)
            if cut_z is not None:
                boundary = cut_z - origin[2]
                clipped = []
                for a, b in zip(points, points[1:] + points[:1]):
                    if a[2] <= boundary:
                        clipped.append(a)
                    if (a[2] <= boundary) != (b[2] <= boundary):
                        clipped.append(a + (b - a) * ((boundary - a[2]) / (b[2] - a[2])))
                points = clipped
            if len(points) < 3:
                continue
            projected = np.asarray(points) @ transform
            normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0]); normal /= max(np.linalg.norm(normal), 1e-12)
            shade = .55 + .45 * abs(normal @ np.array([.35, -.25, .9]))
            group = next((group for group in mesh['groups'] if group['start'] <= i * 3 < group['start'] + group['count']), None)
            color = mesh['styles'][group['material_index'] if group else 0]['color']
            color = tuple(int(max(0, min(255, component * shade * 255))) for component in color)
            polygons.append((projected[:, 2].mean(), projected[:, :2], color)); all_points.extend(projected[:, :2])
    if not all_points:
        raise ValueError("Нет геометрии для выбранного ракурса и разреза")
    points = np.asarray(all_points); lo = points.min(axis=0); hi = points.max(axis=0)
    scale = min(1400 / max(hi[0] - lo[0], .001), 980 / max(hi[1] - lo[1], .001))
    at = lambda p: (100 + (p[0] - lo[0]) * scale, 1120 - (p[1] - lo[1]) * scale)
    image = Image.new('RGB', (1600, 1200), '#edf0e9'); draw = ImageDraw.Draw(image)
    for _, polygon, color in sorted(polygons, key=lambda item: item[0]):
        points = [at(p) for p in polygon]
        draw.polygon(points, fill=color)
    draw.text((35, 25), 'IFCCS | Generated IFC review | Interpretation unverified', fill='#234238')
    stream = io.BytesIO(); image.save(stream, format='PNG'); return stream.getvalue()
