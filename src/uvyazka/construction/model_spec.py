"""Provider-independent drawing interpretation contract; SI only, no executable input."""
from __future__ import annotations

from typing import Annotated, Literal
import math

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator
from shapely.geometry import Polygon

Number = Annotated[float, Field(allow_inf_nan=False, strict=True)]
Positive = Annotated[Number, Field(gt=0, le=100000)]
Point2 = tuple[Number, Number]
Point3 = tuple[Number, Number, Number]
Key = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_default=True)


class Evidence(StrictModel):
    source_id: str
    page: int = Field(ge=1)
    basis: Literal["drawing_dimension", "drawing_geometry", "assumed"]
    note: str = Field(min_length=1, max_length=2000)
    region: tuple[Number, Number, Number, Number] | None = None
    entity_handles: list[str] = Field(default_factory=list, max_length=200)
    frame_id: Key | None = None

    @model_validator(mode="after")
    def valid_region(self):
        if self.region and not (self.region[0] < self.region[2] and self.region[1] < self.region[3]):
            raise ValueError("Область источника должна иметь положительные ширину и высоту")
        return self


class WallGeometry(StrictModel):
    kind: Literal["wall"]
    start: Point2
    end: Point2
    thickness: Positive
    height: Positive
    base_offset: Number = 0

    @model_validator(mode="after")
    def not_zero(self):
        if math.dist(self.start, self.end) < .001:
            raise ValueError("Длина стены меньше 1 мм")
        return self


class ExtrusionGeometry(StrictModel):
    kind: Literal["extrusion"]
    outer: list[Point2] = Field(min_length=3, max_length=10000)
    holes: list[list[Point2]] = Field(default_factory=list, max_length=100)
    depth: Positive
    origin: Point3 = (0, 0, 0)
    x_axis: Point3 = (1, 0, 0)
    z_axis: Point3 = (0, 0, 1)

    @model_validator(mode="after")
    def valid_profile(self):
        polygon = Polygon(self.outer, self.holes)
        if not polygon.is_valid or polygon.area < 1e-8:
            raise ValueError("Контур выдавливания самопересекается, вырожден или содержит неверные отверстия")
        x, z = np.asarray(self.x_axis), np.asarray(self.z_axis)
        if abs(np.linalg.norm(x) - 1) > 1e-6 or abs(np.linalg.norm(z) - 1) > 1e-6 or abs(x @ z) > 1e-6:
            raise ValueError("Оси размещения должны быть единичными и перпендикулярными")
        return self


class MeshGeometry(StrictModel):
    kind: Literal["mesh"]
    vertices: list[Point3] = Field(min_length=4, max_length=100000)
    triangles: list[tuple[int, int, int]] = Field(min_length=4, max_length=200000)

    @model_validator(mode="after")
    def valid_mesh(self):
        v, f = np.asarray(self.vertices), np.asarray(self.triangles)
        if f.min() < 0 or f.max() >= len(v):
            raise ValueError("Индекс треугольника вне диапазона вершин")
        if (np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1) < 1e-10).any():
            raise ValueError("Вырожденный треугольник")
        return self


class OpeningGeometry(StrictModel):
    kind: Literal["opening"]
    host_id: Key
    offset: Number = Field(ge=0)
    width: Positive
    height: Positive
    sill: Number = Field(default=0, ge=0)
    margin: Positive = .02


class DoorGeometry(StrictModel):
    kind: Literal["door"]
    opening_id: Key
    operation_type: Literal["SINGLE_SWING_LEFT", "SINGLE_SWING_RIGHT", "DOUBLE_DOOR_SINGLE_SWING"] = "SINGLE_SWING_LEFT"


class WindowGeometry(StrictModel):
    kind: Literal["window"]
    opening_id: Key


Geometry = Annotated[WallGeometry | ExtrusionGeometry | MeshGeometry | OpeningGeometry | DoorGeometry | WindowGeometry,
                     Field(discriminator="kind")]
IfcClass = Literal["IfcWall", "IfcSlab", "IfcRoof", "IfcFooting", "IfcColumn", "IfcBeam", "IfcMember", "IfcStair",
    "IfcStairFlight", "IfcRailing", "IfcCovering", "IfcFurnishingElement", "IfcBuildingElementProxy", "IfcSpace",
    "IfcOpeningElement", "IfcDoor", "IfcWindow"]


class Material(StrictModel):
    id: Key
    name: str = Field(min_length=1, max_length=256)
    color: tuple[Number, Number, Number] = (.7, .72, .7)

    @model_validator(mode="after")
    def valid_color(self):
        if not all(0 <= value <= 1 for value in self.color):
            raise ValueError("RGB должен быть в диапазоне 0…1")
        return self


class DrawingFrame(StrictModel):
    id: Key
    source_id: str
    page: int = Field(ge=1)
    source_origin: Point2
    model_origin: Point2 = (0, 0)
    metres_per_unit: Positive
    x_axis_angle_deg: Number = 0
    source_y_down: bool = False
    description: str = Field(min_length=1, max_length=2000)

    def transform(self, points):
        angle = math.radians(self.x_axis_angle_deg)
        x, y = math.cos(angle), math.sin(angle)
        result = []
        for point in points:
            a = (point[0] - self.source_origin[0]) * self.metres_per_unit
            b = (point[1] - self.source_origin[1]) * self.metres_per_unit * (-1 if self.source_y_down else 1)
            result.append([self.model_origin[0] + a * x - b * y, self.model_origin[1] + a * y + b * x])
        return result


class Storey(StrictModel):
    id: Key
    name: str = Field(min_length=1, max_length=256)
    elevation: Number
    evidence: list[Evidence] = Field(min_length=1, max_length=100)


class Element(StrictModel):
    id: Key
    ifc_class: IfcClass
    name: str = Field(min_length=1, max_length=256)
    storey_id: Key
    predefined_type: str | None = Field(default=None, max_length=64)
    material_id: Key | None = None
    geometry: Geometry
    evidence: list[Evidence] = Field(min_length=1, max_length=100)
    assumptions: list[str] = Field(default_factory=list, max_length=100)
    load_bearing: bool | None = None
    is_external: bool | None = None


class ModelSpec(StrictModel):
    contract: Literal["DrawingModelSpec"] = "DrawingModelSpec"
    version: Literal["0.1.0"] = "0.1.0"
    schema_name: Literal["IFC4"] = "IFC4"
    units: Literal["m"] = "m"
    name: str = Field(min_length=1, max_length=256)
    storeys: list[Storey] = Field(min_length=1, max_length=1000)
    materials: list[Material] = Field(default_factory=list, max_length=1000)
    drawing_frames: list[DrawingFrame] = Field(default_factory=list, max_length=1000)
    elements: list[Element] = Field(min_length=1, max_length=2000)
    assumptions: list[str] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def references(self):
        def unique(rows):
            keys = [row.id for row in rows]
            if len(set(keys)) != len(keys):
                raise ValueError("Идентификаторы не должны повторяться")
            return {row.id: row for row in rows}
        levels, materials, elements = unique(self.storeys), unique(self.materials), unique(self.elements)
        frames = unique(self.drawing_frames)
        for row in [*self.storeys, *self.elements]:
            for evidence in row.evidence:
                if evidence.frame_id and (evidence.frame_id not in frames or frames[evidence.frame_id].source_id != evidence.source_id or frames[evidence.frame_id].page != evidence.page):
                    raise ValueError('Калибровка не соответствует источнику/листу')
        filled = set()
        for element in self.elements:
            if element.storey_id not in levels or element.material_id is not None and element.material_id not in materials:
                raise ValueError(f"Неизвестный уровень или материал: {element.id}")
            if element.ifc_class == 'IfcSpace' and element.material_id is not None:
                raise ValueError('IfcSpace — пространство, ему нельзя назначать строительный материал через IfcRelAssociatesMaterial')
            geom = element.geometry
            special = {"opening": "IfcOpeningElement", "door": "IfcDoor", "window": "IfcWindow", "wall": "IfcWall"}
            if geom.kind in special and element.ifc_class != special[geom.kind]:
                raise ValueError("Класс IFC не соответствует виду геометрии")
            if element.ifc_class in ("IfcOpeningElement", "IfcDoor", "IfcWindow") and geom.kind not in special:
                raise ValueError("Для проёмов и заполнений обязательна связь хозяина")
            if isinstance(geom, OpeningGeometry):
                host = elements.get(geom.host_id)
                if host is None or not isinstance(host.geometry, WallGeometry) or host.storey_id != element.storey_id:
                    raise ValueError("Проём должен ссылаться на прямую стену того же уровня")
                if geom.offset + geom.width > math.dist(host.geometry.start, host.geometry.end) + 1e-6 or geom.sill + geom.height > host.geometry.height + 1e-6:
                    raise ValueError("Проём выходит за габариты стены")
            if isinstance(geom, (DoorGeometry, WindowGeometry)):
                opening = elements.get(geom.opening_id)
                if not opening or not isinstance(opening.geometry, OpeningGeometry) or opening.storey_id != element.storey_id or geom.opening_id in filled:
                    raise ValueError("Нужен отдельный проём того же уровня, без второго заполнения")
                filled.add(geom.opening_id)
        return self
