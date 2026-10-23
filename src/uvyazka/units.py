"""Versioned case-sensitive AEC vocabulary. Exact arithmetic, no dimensional guessing.

UNITS retains (dimension, scale); scales may be rational strings. Use the
shared conversion functions rather than parsing scale as Decimal directly.
"""
from decimal import Decimal, localcontext
from fractions import Fraction

UNIT_REVISION = "aec-units-2"
UNITS, ALIASES, BASE_UNITS, OFFSETS = {}, {}, {}, {}


def _group(dimension, base, entries):
    BASE_UNITS[dimension] = base
    for symbol, scale, aliases in entries:
        if symbol in UNITS or symbol in ALIASES:
            raise ValueError("Duplicate unit: " + symbol)
        UNITS[symbol] = (dimension, scale)
        for alias in aliases.split("|") if aliases else []:
            if alias in ALIASES or alias in UNITS:
                raise ValueError("Duplicate unit alias: " + alias)
            ALIASES[alias] = symbol


_group("length", "m", [
    ("m", "1", "м"), ("mm", ".001", "мм"), ("cm", ".01", "см"), ("km", "1000", "км"),
    ("100 m", "100", "100 м"), ("1000 m", "1000", "1000 м")])
_group("area", "m2", [
    ("m2", "1", "м2|кв. м|кв.м"), ("mm2", ".000001", "мм2"), ("cm2", ".0001", "см2"),
    ("ha", "10000", "га"), ("10 m2", "10", "10 м2"), ("100 m2", "100", "100 м2"), ("1000 m2", "1000", "1000 м2")])
_group("volume", "m3", [
    ("m3", "1", "м3|куб. м|куб.м"), ("l", ".001", "л|L"), ("ml", ".000001", "мл|mL"),
    ("10 m3", "10", "10 м3"), ("100 m3", "100", "100 м3"), ("1000 m3", "1000", "1000 м3")])
_group("mass", "kg", [
    ("kg", "1", "кг"), ("g", ".001", "г"), ("mg", ".000001", "мг"), ("t", "1000", "т"), ("100 kg", "100", "100 кг")])
# Packaging and work items require project data to convert into pieces.
_group("count", "piece", [("piece", "1", "шт|шт.|pcs"), ("100 piece", "100", "100 шт|100 шт."), ("1000 piece", "1000", "1000 шт|1000 шт.")])
_group("set_count", "set", [("set", "1", "компл|компл.|комплект")])
_group("pair_count", "pair", [("pair", "1", "пара|пар")])
_group("point_count", "point", [("point", "1", "точка|точек")])
_group("pack_count", "pack", [("pack", "1", "упак|упак.|упаковка")])
_group("time", "s", [
    ("s", "1", "с|сек"), ("min", "60", "мин|минута|минут"),
    ("h", "3600", "ч|час|часа|часы|часов|hr|hour|hours"), ("day", "86400", "сут|сутки")])
_group("labor", "person-h", [("person-h", "1", "чел.-ч|чел-ч|чел. ч|чел·ч|чел.-час|чел-часы")])
_group("machine_work", "machine-h", [("machine-h", "1", "маш.-ч|маш-ч|маш. ч|маш·ч|маш.-час")])
# Calendar/working days and shifts have no fixed number of productive hours.
_group("shift_count", "shift", [("shift", "1", "смена|смен")])
_group("power", "kW", [("kW", "1", "кВт"), ("W", ".001", "Вт"), ("MW", "1000", "МВт"),
                         ("kcal_IT/h", ".001163", "ккал(IT)/ч"), ("Gcal_IT/h", "1163", "Гкал(IT)/ч")])
_group("apparent_power", "VA", [("VA", "1", "В·А|В*А|ВА"), ("kVA", "1000", "кВ·А|кВА"), ("MVA", "1000000", "МВА")])
_group("reactive_power", "var", [("var", "1", "вар"), ("kvar", "1000", "квар"), ("Mvar", "1000000", "Мвар")])
_group("energy", "Wh", [
    ("Wh", "1", "Вт·ч|Вт*ч|Вт ч|W·h|W*h"), ("kWh", "1000", "кВт·ч|кВт*ч|кВт ч|kW·h|kW*h"),
    ("MWh", "1000000", "МВт·ч|МВт*ч"), ("J", "1/3600", "Дж"), ("kJ", "5/18", "кДж"), ("MJ", "2500/9", "МДж"),
    ("kcal_IT", "1.163", "ккал(IT)"), ("Gcal_IT", "1163000", "Гкал(IT)"),
    ("kcal_th", "523/450", "ккал(th)"), ("Gcal_th", "10460000/9", "Гкал(th)")])
_group("electric_charge", "Ah", [
    ("Ah", "1", "Ач|А·ч|А*ч|А ч|A·h|A*h|A h"), ("mAh", ".001", "мАч|мА·ч|мА*ч|mA·h|mA*h"), ("C", "1/3600", "Кл")])
_group("electric_current", "A", [("A", "1", "А"), ("mA", ".001", "мА"), ("kA", "1000", "кА")])
_group("voltage", "V", [("V", "1", "В"), ("mV", ".001", "мВ"), ("kV", "1000", "кВ")])
_group("resistance", "ohm", [("ohm", "1", "Ω|Ом"), ("kohm", "1000", "kΩ|кОм"), ("Mohm", "1000000", "MΩ|МОм")])
_group("capacitance", "F", [("F", "1", "Ф"), ("uF", ".000001", "µF|μF|мкФ"), ("nF", ".000000001", "нФ")])
_group("frequency", "Hz", [("Hz", "1", "Гц"), ("kHz", "1000", "кГц"), ("1/s", "1", "1/с|с-1"), ("1/h", "1/3600", "1/ч|ч-1")])
_group("rotational_speed", "rpm", [("rpm", "1", "об/мин"), ("rps", "60", "об/с")])
_group("flow", "l/s", [
    ("l/s", "1", "л/с|L/s"), ("l/min", "1/60", "л/мин|L/min"), ("l/h", "1/3600", "л/ч|L/h"),
    ("m3/s", "1000", "м3/с"), ("m3/h", "5/18", "м3/ч"), ("m3/day", "5/432", "м3/сут|м3/сутки|m3/d")])
_group("mass_flow", "kg/s", [("kg/s", "1", "кг/с"), ("kg/h", "1/3600", "кг/ч"), ("t/h", "5/18", "т/ч")])
_group("velocity", "m/s", [("m/s", "1", "м/с"), ("m/min", "1/60", "м/мин"), ("km/h", "5/18", "км/ч")])
_group("pressure", "Pa", [("Pa", "1", "Па"), ("kPa", "1000", "кПа"), ("MPa", "1000000", "МПа"), ("bar", "100000", "бар"),
                            ("kgf/cm2", "98066.5", "кгс/см2"), ("mmH2O", "9.80665", "мм вод. ст.|мм.вод.ст."),
                            ("mH2O", "9806.65", "м вод. ст.|м.вод.ст.")])
_group("force", "N", [("N", "1", "Н"), ("kN", "1000", "кН"), ("MN", "1000000", "МН"), ("kgf", "9.80665", "кгс"), ("tf", "9806.65", "тс")])
_group("line_load", "N/m", [("N/m", "1", "Н/м"), ("kN/m", "1000", "кН/м"), ("kgf/m", "9.80665", "кгс/м")])
# Surface load and pressure stay distinct to preserve quantity kind.
_group("surface_load", "N/m2", [("N/m2", "1", "Н/м2"), ("kN/m2", "1000", "кН/м2"), ("kgf/m2", "9.80665", "кгс/м2"), ("tf/m2", "9806.65", "тс/м2")])
_group("moment", "N·m", [("N·m", "1", "N*m|Н·м|Н*м"), ("kN·m", "1000", "kN*m|кН·м|кН*м")])
_group("density", "kg/m3", [("kg/m3", "1", "кг/м3"), ("t/m3", "1000", "т/м3"), ("g/cm3", "1000", "г/см3")])
_group("area_mass", "kg/m2", [("kg/m2", "1", "кг/м2"), ("t/m2", "1000", "т/м2")])
_group("linear_mass", "kg/m", [("kg/m", "1", "кг/м"), ("g/m", ".001", "г/м")])
_group("temperature", "K", [("K", "1", "К"), ("°C", "1", "°С|degC|град. С")])
OFFSETS["°C"] = "273.15"
_group("temperature_difference", "delta_K", [("delta_K", "1", "ΔK|ΔК"), ("delta_degC", "1", "Δ°C|Δ°С")])
_group("thermal_conductivity", "W/(m·K)", [("W/(m·K)", "1", "Вт/(м·К)|W/(m*K)|Вт/(м*К)")])
_group("heat_transfer", "W/(m2·K)", [("W/(m2·K)", "1", "Вт/(м2·К)|W/(m2*K)|Вт/(м2*К)")])
_group("thermal_resistance", "m2·K/W", [("m2·K/W", "1", "м2·К/Вт|m2*K/W|м2*К/Вт")])
_group("specific_heat", "J/(kg·K)", [("J/(kg·K)", "1", "Дж/(кг·К)"), ("kJ/(kg·K)", "1000", "кДж/(кг·К)")])
_group("illuminance", "lx", [("lx", "1", "лк")])
_group("luminous_flux", "lm", [("lm", "1", "лм")])
_group("ratio", "1", [("1", "1", "д.е.|доля"), ("%", ".01", "процент"), ("‰", ".001", "промилле"), ("mm/m", ".001", "мм/м")])
_group("currency_RUB", "RUB", [("RUB", "1", "руб|руб.|₽"), ("1000 RUB", "1000", "тыс. руб.|тыс.руб.|тыс руб"),
                                ("1000000 RUB", "1000000", "млн руб|млн руб.|млн. руб.")])
_group("currency_USD", "USD", [("USD", "1", "")])
_group("currency_EUR", "EUR", [("EUR", "1", "€")])

WORK_DIMENSIONS = frozenset({"length", "area", "volume", "mass", "count", "set_count", "pair_count", "point_count", "pack_count", "labor", "machine_work"})


def canonical_unit(unit):
    if not isinstance(unit, str):
        return None
    key = " ".join(unit.replace("²", "2").replace("³", "3").replace("⋅", "·").split())
    return ALIASES.get(key, key)


def resolve_unit(unit):
    return UNITS.get(canonical_unit(unit))


def base_value(value, unit):
    """Exact base value including affine offsets. Caller bounds numeric input."""
    symbol = canonical_unit(unit)
    if symbol not in UNITS:
        raise ValueError("Unknown unit: " + str(unit))
    return Fraction(value) * Fraction(UNITS[symbol][1]) + Fraction(OFFSETS.get(symbol, "0"))


def convert_value(value, source_unit, target_unit):
    source, target = resolve_unit(source_unit), resolve_unit(target_unit)
    if not source or not target or source[0] != target[0]:
        raise ValueError("Units need an explicit compatible conversion")
    symbol = canonical_unit(target_unit)
    return (base_value(value, source_unit) - Fraction(OFFSETS.get(symbol, "0"))) / Fraction(target[1])


def number_text(value):
    """Exact finite decimal or 50 significant digits for display; retain fraction too."""
    value = Fraction(value)
    denominator = value.denominator
    twos = fives = 0
    while denominator % 2 == 0:
        denominator //= 2
        twos += 1
    while denominator % 5 == 0:
        denominator //= 5
        fives += 1
    places = max(twos, fives)
    if denominator == 1:
        scaled = abs(value.numerator) * 2 ** (places - twos) * 5 ** (places - fives)
        digits = str(scaled).rjust(places + 1, "0")
        result = digits if not places else digits[:-places] + "." + digits[-places:]
        return ("-" if value < 0 else "") + result
    with localcontext() as ctx:
        ctx.prec = 50
        return str(Decimal(value.numerator) / Decimal(value.denominator))


def unit_catalog(dimension=None):
    """Read-only reference. Formula coefficients are exact rational strings."""
    dimensions = sorted(BASE_UNITS)
    if dimension is not None and dimension not in BASE_UNITS:
        raise ValueError("Unknown dimension; choose one of: " + ", ".join(dimensions))
    visible_dimensions = dimensions if dimension is None else [dimension]
    entries = []
    for symbol, (kind, scale) in UNITS.items():
        if dimension is None or dimension != kind:
            continue
        entries.append({"symbol": symbol, "dimension": kind, "base_unit": BASE_UNITS[kind],
                        "scale_exact": str(Fraction(scale)), "offset_exact": str(Fraction(OFFSETS.get(symbol, "0"))),
                        "aliases": sorted(a for a, target in ALIASES.items() if target == symbol),
                        "work_quantity": kind in WORK_DIMENSIONS})
    return {"revision": UNIT_REVISION, "dimensions": visible_dimensions,
            "dimension_counts": {kind: sum(u[0] == kind for u in UNITS.values()) for kind in visible_dimensions},
            "units": entries, "count": len(entries) if dimension is not None else len(UNITS),
            "next_step": "Select dimension to read its unit entries." if dimension is None else None,
            "base_formula": "base = value * scale_exact + offset_exact; tolerance is in base_unit",
            "limits": ["Matching entity/property/basis/revision/specification still required.",
                       "No inference of density, power factor, packing, shift duration, currency rates or VAT.",
                       "Pressure basis, gas reference conditions and calendar/working time must be explicit.",
                       "Unknown symbols require clarification, never case folding or prefix guessing."]}
