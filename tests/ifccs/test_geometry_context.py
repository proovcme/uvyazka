import ifcopenshell
import pytest
from uvyazka.construction.importer import import_model

def test_native_geometry_rejects_library_context_that_disables_unit_detection(tmp_path):
    model=ifcopenshell.file(schema='IFC4')
    unit=model.createIfcSIUnit(UnitType='LENGTHUNIT',Prefix='MILLI',Name='METRE')
    assignment=model.createIfcUnitAssignment([unit])
    model.create_entity('IfcProject',GlobalId=ifcopenshell.guid.new(),UnitsInContext=assignment)
    model.create_entity('IfcProjectLibrary',GlobalId=ifcopenshell.guid.new())
    source=tmp_path/'library.ifc';model.write(str(source))
    with pytest.raises(ValueError,match='контекст единиц'):
        import_model(str(source),str(tmp_path/'out'))
    assert not (tmp_path/'out/manifest.json').exists()
