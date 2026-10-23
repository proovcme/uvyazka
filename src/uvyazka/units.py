"""Explicit unit vocabulary. Symbols are case-sensitive; no dimensional guessing."""
UNITS = {"m": ("length", "1"), "mm": ("length", ".001"), "cm": ("length", ".01"), "km": ("length", "1000"),
         "m2": ("area", "1"), "ha": ("area", "10000"), "10 m2": ("area", "10"), "1000 m2": ("area", "1000"),
         "m3": ("volume", "1"), "100 m3": ("volume", "100"), "kg": ("mass", "1"), "t": ("mass", "1000"),
         "piece": ("count", "1"), "kW": ("power", "1"), "W": ("power", ".001"), "m3/day": ("daily_water", "1"), "l/s": ("flow", "1"),
         "s": ("time", "1"), "min": ("time", "60"), "h": ("time", "3600"), "day": ("time", "86400"),
         "Ah": ("electric_charge", "1"), "mAh": ("electric_charge", ".001"),
         "A": ("electric_current", "1"), "mA": ("electric_current", ".001"),
         "V": ("voltage", "1"), "kV": ("voltage", "1000"), "Wh": ("energy", "1"), "kWh": ("energy", "1000")}
ALIASES = {"ч": "h", "час": "h", "часа": "h", "часы": "h", "часов": "h", "hr": "h", "hour": "h", "hours": "h",
           "мин": "min", "минута": "min", "минут": "min", "с": "s", "сек": "s", "сут": "day", "сутки": "day",
           "Ач": "Ah", "А·ч": "Ah", "А*ч": "Ah", "А ч": "Ah", "A·h": "Ah", "A*h": "Ah", "A h": "Ah",
           "мАч": "mAh", "мА·ч": "mAh", "мА*ч": "mAh", "mA·h": "mAh", "mA*h": "mAh",
           "А": "A", "мА": "mA", "В": "V", "кВ": "kV", "Вт": "W", "кВт": "kW", "Вт·ч": "Wh", "кВт·ч": "kWh",
           "м": "m", "мм": "mm", "см": "cm", "км": "km", "м2": "m2", "м3": "m3", "га": "ha", "кг": "kg", "т": "t", "шт": "piece", "шт.": "piece"}
BASE_UNITS = {'length':'m','area':'m2','volume':'m3','mass':'kg','count':'piece','power':'kW','daily_water':'m3/day','flow':'l/s',
              'time':'s','electric_charge':'Ah','electric_current':'A','voltage':'V','energy':'Wh'}


def canonical_unit(unit):
    if not isinstance(unit, str):
        return None
    key = " ".join(unit.replace("²", "2").replace("³", "3").replace("⋅", "·").split())
    return ALIASES.get(key, key)


def resolve_unit(unit):
    return UNITS.get(canonical_unit(unit))
