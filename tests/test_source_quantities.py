import importlib.util
import unittest


@unittest.skipUnless(importlib.util.find_spec('ifcopenshell'),'IFC extra not installed')
class SourceQuantityTests(unittest.TestCase):
    def fixture(self,with_area_unit):
        import ifcopenshell.api
        import ifcopenshell.guid
        f=ifcopenshell.api.run('project.create_file',version='IFC4')
        ifcopenshell.api.run('root.create_entity',f,ifc_class='IfcProject',name='Synthetic')
        length=ifcopenshell.api.run('unit.add_si_unit',f,unit_type='LENGTHUNIT')
        units=[length]
        if with_area_unit:units.append(ifcopenshell.api.run('unit.add_si_unit',f,unit_type='AREAUNIT'))
        ifcopenshell.api.run('unit.assign_unit',f,units=units)
        room=ifcopenshell.api.run('root.create_entity',f,ifc_class='IfcSpace',name='101')
        q=f.create_entity('IfcQuantityArea',Name='Room area',AreaValue=0)
        qto=f.create_entity('IfcElementQuantity',GlobalId=ifcopenshell.guid.new(),Name='Custom space quantities',Quantities=[q])
        f.create_entity('IfcRelDefinesByProperties',GlobalId=ifcopenshell.guid.new(),RelatedObjects=[room],RelatingPropertyDefinition=qto)
        return f,room

    def test_nonstandard_quantity_set_keeps_zero_and_explicit_units_without_changing_planner(self):
        from uvyazka.construction.quantities import source_quantity_values,explicit_quantities
        f,room=self.fixture(True)
        item=source_quantity_values(room,f)['Custom space quantities']['Room area']
        self.assertEqual(item['value'],0);self.assertEqual(item['unit'],'m2');self.assertEqual(item['kind'],'explicit')
        self.assertGreater(item['quantity_id'],0)
        self.assertEqual(explicit_quantities(room,f),{})

    def test_missing_area_unit_is_not_inferred_from_length(self):
        from uvyazka.construction.quantities import source_quantity_values
        f,room=self.fixture(False)
        item=source_quantity_values(room,f)['Custom space quantities']['Room area']
        self.assertIsNone(item['unit']);self.assertEqual(item['source_value'],0)
        self.assertEqual(item['kind'],'explicit_unit_unresolved')

    def test_context_dependent_unit_does_not_silently_become_square_metres(self):
        from uvyazka.construction.quantities import source_quantity_values
        f,room=self.fixture(True)
        dimensions=f.create_entity('IfcDimensionalExponents',LengthExponent=2,MassExponent=0,TimeExponent=0,ElectricCurrentExponent=0,ThermodynamicTemperatureExponent=0,AmountOfSubstanceExponent=0,LuminousIntensityExponent=0)
        unit=f.create_entity('IfcContextDependentUnit',Dimensions=dimensions,UnitType='AREAUNIT',Name='unknown_custom_area')
        f.by_type('IfcQuantityArea')[0].Unit=unit
        item=source_quantity_values(room,f)['Custom space quantities']['Room area']
        self.assertIsNone(item['unit']);self.assertEqual(item['kind'],'explicit_unit_unresolved')
