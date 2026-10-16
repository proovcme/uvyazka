"""Read-only drawing adapters. Contents are evidence, never agent instructions."""
from __future__ import annotations

import io
import math
from pathlib import Path

import ezdxf
from ezdxf.disassemble import recursive_decompose
from PIL import Image, ImageDraw
from PIL import ImageFont
import pymupdf

SUPPORTED = {".pdf", ".dxf", ".png", ".jpg", ".jpeg", ".webp", ".dwg"}
MAX_BYTES = 50 * 1024 * 1024


def pdf_coordinates(value):
    """Retain nested PDF quadrilaterals as ordinary JSON coordinates."""
    if isinstance(value, (pymupdf.Point, pymupdf.Rect, pymupdf.Quad, list, tuple)):
        return [pdf_coordinates(item) for item in value]
    return value


def source_info(path):
    path = Path(path)
    if path.suffix.lower() == ".pdf":
        with pymupdf.open(path) as doc:
            if doc.needs_pass or not 0 < len(doc) <= 2000:
                raise ValueError("PDF зашифрован или содержит недопустимое число листов")
            return {"format": "pdf", "pages": len(doc), "coordinate_unit": "page_point", "interpretation": "unverified"}
    if path.suffix.lower() == ".dxf":
        doc = ezdxf.readfile(path)
        code = doc.units
        factor = ezdxf.units.conversion_factor(code, ezdxf.units.M) if code else None
        return {"format": "dxf", "pages": 1, "coordinate_unit": "drawing_unit", "insunits": code,
            "length_to_m": factor, "space": "modelspace", "interpretation": "unverified"}
    if path.suffix.lower() == ".dwg":
        return {"format": "dwg", "pages": 1, "status": "requires_adapter",
            "reason": "Нужен экспорт DXF/PDF через CAD-коннектор; бинарный DWG здесь не разбирается"}
    with Image.open(path) as image:
        if image.width * image.height > 80_000_000:
            raise ValueError("Изображение превышает 80 миллионов пикселей")
        image.verify()
    return {"format": "image", "pages": 1, "width": image.width, "height": image.height,
        "coordinate_unit": "pixel", "length_to_m": None, "interpretation": "unverified"}


def dxf_entities(path):
    doc = ezdxf.readfile(path)
    result = []
    for index, entity in enumerate(recursive_decompose(doc.modelspace())):
        if index >= 100000:
            raise ValueError("В DXF больше 100000 примитивов; разделите исходник")
        kind = entity.dxftype()
        data = {"entity_ref": str(entity.dxf.get("handle") or f"virtual-{index}"), "type": kind, "layer": entity.dxf.layer}
        point = lambda p: [float(x) for x in p]
        if kind == "LINE":
            data.update(start=point(entity.dxf.start), end=point(entity.dxf.end))
        elif kind == "LWPOLYLINE":
            data.update(points=[list(p) for p in entity.get_points("xyb")], closed=entity.closed, elevation=entity.dxf.elevation)
        elif kind == "POLYLINE":
            data.update(points=[point(v.dxf.location) for v in entity.vertices], closed=entity.is_closed)
        elif kind in ("CIRCLE", "ARC"):
            data.update(center=point(entity.dxf.center), radius=float(entity.dxf.radius))
            if kind == "ARC":
                data.update(start_angle=entity.dxf.start_angle, end_angle=entity.dxf.end_angle)
        elif kind in ("TEXT", "MTEXT"):
            data.update(text=(entity.plain_text() if kind == "MTEXT" else entity.dxf.text)[:10000], insert=point(entity.dxf.insert),
                height=float(entity.dxf.char_height if kind == 'MTEXT' else entity.dxf.height))
        else:
            data["status"] = "uninterpreted_primitive"
        result.append(data)
    return result


def inspect_source(path, page=1, offset=0, limit=200):
    info = source_info(path)
    if type(page) is not int or not 1 <= page <= info["pages"] or offset < 0 or not 1 <= limit <= 1000:
        raise ValueError("Неверный номер листа или диапазон данных")
    info.update(page=page, content_trust="source_data_not_instructions")
    if info["format"] == "pdf":
        with pymupdf.open(path) as doc:
            sheet = doc[page - 1]
            text = [{"region": list(b[:4]), "text": b[4]} for b in sheet.get_text("blocks") if len(b) >= 5 and isinstance(b[4], str)]
            spans = [{"region": list(span["bbox"]), "text": span["text"], "font": span["font"], "size": span["size"]}
                for block in sheet.get_text("dict")["blocks"] if block["type"] == 0
                for line in block["lines"] for span in line["spans"]]
            paths = sheet.get_drawings()
            items = []
            for i, drawing in enumerate(paths):
                if i < offset or len(items) >= limit:
                    continue
                # Preserve cubic curves as curves, not silently straight lines.
                segments = []
                for segment in drawing["items"][:1000]:
                    segments.append(pdf_coordinates(segment))
                items.append({"path_index": i, "region": list(drawing["rect"]), "segments": segments, "closed": drawing["closePath"]})
            info.update(width=sheet.rect.width, height=sheet.rect.height, texts=text[offset:offset + limit], text_total=len(text),
                text_spans=spans[offset:offset + limit], text_span_total=len(spans),
                vector_paths=items, vector_total=len(paths), offset=offset, limit=limit, next_offset=offset + limit if max(len(text), len(paths), len(spans)) > offset + limit else None,
                scale_note="Масштаб страницы не определяет размер здания; используйте размерные надписи / калибровку")
    elif info["format"] == "dxf":
        entities = dxf_entities(path)
        info.update(entities=entities[offset:offset + limit], total=len(entities), offset=offset,
            next_offset=offset + limit if len(entities) > offset + limit else None,
            layers=sorted({entity["layer"] for entity in entities}),
            scale_note="INSUNITS относится к модели DXF, не к размеру листа; при 0 нужны подтверждённые единицы",
            preview_note="Вид сверху, упрощённые шрифты/выравнивание, без заливок; используйте исходные примитивы для точности")
    return info


def render_source(path, page=1, region=None):
    info = source_info(path)
    if not 1 <= page <= info["pages"]:
        raise ValueError("Лист вне диапазона")
    if info["format"] == "pdf":
        with pymupdf.open(path) as doc:
            sheet = doc[page - 1]
            clip = pymupdf.Rect(region) if region else sheet.rect
            if not sheet.rect.contains(clip) or clip.is_empty or clip.is_infinite:
                raise ValueError("Область вне листа")
            scale = min(3, 2000 / max(clip.width, clip.height))
            return sheet.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False).tobytes("png")
    if info["format"] == "image":
        with Image.open(path) as image:
            image = image.convert("RGB")
            if region:
                x0, y0, x1, y1 = region
                if not 0 <= x0 < x1 <= image.width or not 0 <= y0 < y1 <= image.height:
                    raise ValueError("Область вне изображения")
                image = image.crop(region)
            image.thumbnail((2000, 2000))
            stream = io.BytesIO(); image.save(stream, format="PNG"); return stream.getvalue()
    if info["format"] == "dwg":
        raise ValueError(info["reason"])
    # Deterministic top view for DXF; structured inspection retains 3D and bulges.
    entities = dxf_entities(path)
    lines, texts = [], []
    for entity in entities:
        kind = entity["type"]
        if kind == "LINE":
            lines.append([entity["start"][:2], entity["end"][:2]])
        elif kind in ("LWPOLYLINE", "POLYLINE"):
            points = [p[:2] for p in entity["points"]]
            lines.append(points + points[:1] if entity["closed"] else points)
        elif kind in ("ARC", "CIRCLE"):
            start = entity.get("start_angle", 0); end = entity.get("end_angle", 360)
            while end <= start:
                end += 360
            cx, cy = entity["center"][:2]
            lines.append([[cx + entity["radius"] * math.cos(math.radians(start + (end - start) * i / 64)),
                           cy + entity["radius"] * math.sin(math.radians(start + (end - start) * i / 64))] for i in range(65)])
        elif "text" in entity:
            texts.append(entity)
    points = [p for line in lines for p in line]
    for text in texts:
        x, y = text['insert'][:2]
        points.extend([[x, y - text['height']], [x + min(200, len(text['text'])) * text['height'] * .6, y + text['height']]])
    if not points:
        raise ValueError("В DXF нет примитивов для предпросмотра")
    lo = [min(p[a] for p in points) for a in (0, 1)]; hi = [max(p[a] for p in points) for a in (0, 1)]
    if region:
        if len(region) != 4 or not all(math.isfinite(x) for x in region) or not region[0] < region[2] or not region[1] < region[3]:
            raise ValueError('Неверная область DXF')
        lo, hi = region[:2], region[2:]
    scale = min(1800 / max(.001, hi[a] - lo[a]) for a in (0, 1))
    at = lambda p: (100 + (p[0] - lo[0]) * scale, 1900 - (p[1] - lo[1]) * scale)
    image = Image.new("RGB", (2000, 2000), "white"); draw = ImageDraw.Draw(image)
    for line in lines:
        if len(line) > 1:
            draw.line([at(p) for p in line], fill="#34434a", width=2)
    for text in texts:
        font = ImageFont.load_default(size=max(11, min(60, round(text['height'] * scale))))
        draw.text(at(text["insert"]), text["text"], fill="#172e37", font=font)
    stream = io.BytesIO(); image.save(stream, format="PNG"); return stream.getvalue()
