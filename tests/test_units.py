"""Engineering regressions: exact rates, offsets and unsafe semantic shortcuts."""
from decimal import Decimal
from fractions import Fraction
import unittest

from uvyazka.core import compare_quantity
from uvyazka.coordination import inspect_graph
from uvyazka.construction.planning import duration_from_quantity
from uvyazka.units import unit_catalog, resolve_unit, convert_value, number_text


def observation(value, unit, **scope):
    return {"entity": "fixture", "property": "quantity", "basis": "design",
            "revision_set": "issued", "value": value, "unit": unit, **scope}


class ProjectUnitTests(unittest.TestCase):
    def test_cross_discipline_equivalences(self):
        cases = [
            ("3600", "м³/ч", "1000", "л/с"), ("86.4", "м3/сут", "1", "l/s"),
            ("60", "л/мин", "1", "л/с"), ("3.6", "т/ч", "1", "кг/с"),
            ("1", "МПа", "10", "бар"), ("100", "мм вод. ст.", "980.665", "Па"),
            ("1", "кгс/см²", "98066.5", "Па"), ("1", "тс", "9.80665", "кН"),
            ("2", "кН/м²", "2000", "Н/м2"), ("1", "т/м³", "1000", "кг/м3"),
            ("36", "км/ч", "10", "м/с"), ("0", "°С", "273.15", "К"),
            ("-20", "°C", "253.15", "K"), ("20", "Δ°C", "20", "ΔK"),
            ("3.6", "МДж", "1", "кВт·ч"), ("3600", "Кл", "1", "А·ч"),
            ("1", "Гкал(IT)", "1163", "кВт·ч"), ("1", "Гкал(IT)/ч", "1163", "кВт"),
            ("1", "кВА", "1000", "ВА"), ("1", "МОм", "1000", "кОм"),
            ("1", "мкФ", "1000", "нФ"), ("3600", "1/ч", "1", "Гц"),
            ("2", "100 м²", "200", "m2"), ("1", "л", "0.001", "м³"),
            ("1", "тыс. руб.", "1000", "₽"), ("0.5", "%", "5", "мм/м"),
            ("1", "компл.", "1", "set"), ("10", "чел.-ч", "10", "person-h"),
        ]
        for av, au, bv, bu in cases:
            with self.subTest(units=(au, bu)):
                result = compare_quantity(observation(av, au), observation(bv, bu))
                self.assertEqual(result["status"], "matches", result)
                self.assertEqual(result["difference_exact"], "0")

    def test_exact_nonterminating_conversions_and_tolerance_boundaries(self):
        # Repeating factors must not create a false difference at tolerance 0.
        result = compare_quantity(observation("1", "m3/h"), observation("1000", "l/h"))
        self.assertEqual(result["status"], "matches")
        result = compare_quantity(observation("0", "l/s"), observation("1", "m3/h"), ".2777777777777777777777777777")
        self.assertEqual(result["status"], "question")
        self.assertEqual(result["difference_exact"], "5/18")
        self.assertEqual(result["base_unit"], "l/s")
        self.assertEqual(compare_quantity(observation("0", "l/s"), observation("1", "m3/h"), ".278")["status"], "matches")
        self.assertEqual(number_text(Fraction(-1, 8)), "-0.125")
        self.assertEqual(number_text(Fraction(1, 10**100)), "0." + "0" * 99 + "1")

    def test_dimensions_and_semantic_scope_prevent_unsafe_conversions(self):
        for left, right in [("кВт", "кВА"), ("кВт", "квар"), ("ч", "чел.-ч"), ("маш.-ч", "чел.-ч"),
                            ("смена", "ч"), ("компл", "шт"), ("пара", "шт"), ("упак", "шт"),
                            ("kg", "N"), ("m", "mH2O"), ("kg/m2", "kN/m2"), ("°C", "Δ°C"),
                            ("RUB", "USD"), ("DN", "mm"), ("Гкал", "Gcal_IT"), ("AH", "Ah"),
                            ("нм3/ч", "м3/ч"), ("календарный день", "h")]:
            with self.subTest(units=(left, right)):
                self.assertEqual(compare_quantity(observation("1", left), observation("1", right))["status"], "not_comparable")
        self.assertEqual(compare_quantity(observation("1", "bar", basis="gauge"), observation("100", "kPa", basis="absolute"))["status"], "question")
        self.assertEqual(compare_quantity(observation("1", "RUB", basis="VAT included"), observation("1", "RUB", basis="VAT excluded"))["status"], "question")

    def test_numeric_requirements_use_same_temperature_and_rate_conversions(self):
        for unit, value, target, minimum, maximum, failed in [
            ("K", "293.15", "°C", "20", "20", False),
            ("°C", "19.99", "K", "293.15", None, True),
            ("m3/h", "3.6", "l/s", "1", "1", False),
        ]:
            graph = {"entities": [{"id": "fixture", "kind": "building", "claims": [
                {"property": "quantity", "basis": "design", "value": value, "unit": unit}],
                "requirements": [{"id": "test", "kind": "numeric_range", "property": "quantity",
                                  "basis": "design", "unit": target, "min": minimum, "max": maximum,
                                  "reason": "Synthetic criterion", "assumption": "Test"}]}]}
            codes = {i["code"] for i in inspect_graph(graph)["issues"]}
            self.assertNotIn("requirement_value_unconfirmed", codes)
            self.assertEqual("project_requirement_not_met" in codes, failed)

    def test_planning_accepts_work_units_but_not_temperature_or_operating_rates(self):
        calc = {"quantity": "2", "quantity_unit": "100 м²", "production_per_hour": "3", "production_unit": "m2"}
        self.assertEqual(duration_from_quantity(calc), 4000)
        self.assertEqual(duration_from_quantity({**calc, "quantity": "100", "quantity_unit": "чел.-ч",
                                                "production_per_hour": "10", "production_unit": "person-h"}), 600)
        for unit in ("°C", "RUB", "l/s", "h", "USD", "%"):
            with self.assertRaises(ValueError):
                duration_from_quantity({**calc, "quantity_unit": unit, "production_unit": unit})

    def test_catalog_is_unambiguous_and_conversions_round_trip(self):
        catalog = unit_catalog()
        self.assertEqual(catalog["units"], [])
        entries = [e for kind in catalog["dimensions"] for e in unit_catalog(kind)["units"]]
        self.assertEqual(len(entries), catalog["count"])
        for entry in entries:
            symbol = entry["symbol"]
            self.assertGreater(Fraction(entry["scale_exact"]), 0)
            for alias in entry["aliases"]:
                self.assertEqual(resolve_unit(alias), resolve_unit(symbol))
            base = convert_value(Decimal("12.345"), symbol, entry["base_unit"])
            self.assertEqual(convert_value(base, entry["base_unit"], symbol), Fraction(Decimal("12.345")))
        self.assertTrue(all(e["dimension"] == "pressure" for e in unit_catalog("pressure")["units"]))
        with self.assertRaises(ValueError):
            unit_catalog("guess")
