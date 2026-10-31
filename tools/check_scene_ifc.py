"""Independent IFC4 schema, property and world-coordinate acceptance check.

Uses only the synthetic multi-source scene. Requires the web dependencies,
Node.js 24 and IfcOpenShell; never discovers or reads private project models.
"""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.ifcopenshell_wrapper
import ifcopenshell.util.element
import ifcopenshell.util.placement
import ifcopenshell.validate

ROOT = Path(__file__).resolve().parents[1]


def check(folder):
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js 24 is required for the shared scene exporter')
    subprocess.run([node, '--experimental-strip-types', str(ROOT/'tools/check_scene_ifc.mjs'), str(folder)], cwd=ROOT, check=True)
    source = ifcopenshell.open(str(folder/'synthetic.ifc'))
    assert source.schema == 'IFC4'
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(source, logger, express_rules=True)
    assert not logger.statements, logger.statements
    roots = source.by_type('IfcRoot')
    assert len({row.GlobalId for row in roots}) == len(roots)
    expected = json.loads((folder/'expected.json').read_text(encoding='utf-8'))
    objects = {}
    for item in source.by_type('IfcObject'):
        psets = ifcopenshell.util.element.get_psets(item)
        if 'Uvyazka_Source' in psets:
            objects[psets['Uvyazka_Source']['SceneElementId']] = (item, psets)
    assert set(objects) == {row['id'] for row in expected['expected']}
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.DIMENSIONALITY, ifcopenshell.ifcopenshell_wrapper.CURVES_SURFACES_AND_SOLIDS)
    for row in expected['expected']:
        item, psets = objects[row['id']]
        assert item.Name == row['name']
        assert psets['Uvyazka_Source']['RevitElementId'] == row['revit_id']
        assert psets['Uvyazka_Source']['QuantitiesApproved'] is False
        for group, properties in row['properties'].items():
            for key, value in properties.items():
                actual = psets[group][key]
                if isinstance(actual, (list, tuple)):
                    actual = ''.join(actual)
                if isinstance(value, (dict, list)):
                    actual = json.loads(actual)
                assert actual == value, (row['id'], group, key, actual, value)
        if row['points']:
            shape = ifcopenshell.geom.create_shape(settings, item)
            vertices = shape.geometry.verts
            actual = {tuple(round(n, 5) for n in vertices[i:i+3]) for i in range(0, len(vertices), 3)}
            assert actual == {tuple(round(n, 5) for n in p) for p in row['points']}, (row['id'], actual, row['points'])
    colors = source.by_type('IfcSurfaceStyleRendering')
    assert any(abs(s.Transparency-.65) < 1e-8 and abs(s.SurfaceColour.Blue-.8) < 1e-8 for s in colors)
    level = source.by_type('IfcBuildingStorey')[0]
    placement = ifcopenshell.util.placement.get_local_placement(level.ObjectPlacement)
    assert tuple(placement[:3, 3]) == (1000000, 2000000, 37)
    assert ifcopenshell.util.element.get_psets(level)['Uvyazka_Level']['SourceElevationMetres'] is None
    system = source.by_type('IfcSystem')[0]
    assert ifcopenshell.util.element.get_psets(system)['Uvyazka_System']['ConnectivityVerified'] is False
    assert not source.by_type('IfcElementQuantity'), 'Scene export must not invent validated quantities'
    print('IFC4/EXPRESS, Unicode, source IDs, properties, colors, lines, systems and placed geometry OK')


if __name__ == '__main__':
    if len(sys.argv) > 1:
        output = Path(sys.argv[1]).resolve()
        output.mkdir(parents=True, exist_ok=True)
        check(output)
    else:
        with tempfile.TemporaryDirectory(prefix='uvyazka-scene-ifc-') as directory:
            check(Path(directory))
