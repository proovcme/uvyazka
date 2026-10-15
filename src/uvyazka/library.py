"""Offline metadata only; never silently downloads a normative corpus."""
from importlib.resources import files
import json


def list_technology_sources(query: str = "") -> dict:
    data = json.loads(files("uvyazka").joinpath("resources/technology-sources.json").read_text(encoding="utf-8"))
    terms = query.casefold().split()
    data["items"] = [item for item in data["items"] if all(term in json.dumps(item, ensure_ascii=False).casefold() for term in terms)]
    return data
