"""Offline structural validation of the source distribution (stdlib only).

This does not certify acceptance by any desktop client's plugin installer.
"""
from pathlib import Path
import json
import re
import sys
import tomllib
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def validate():
    package = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    plugin = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    mcp = json.loads((ROOT / "mcp.json").read_text(encoding="utf-8"))
    assert package["project"]["name"] == plugin["name"] == "uvyazka"
    assert package["project"]["version"] == "0.4.0a1"
    assert plugin["version"] == "0.4.0-alpha.1"
    assert '"' + package["project"]["version"] + '"' in (ROOT / "src/uvyazka/__init__.py").read_text(encoding="utf-8")
    assert plugin["extensions"]["com.openai"]["requires_local_executor"] is True
    assert len(plugin["extensions"]["com.openai"]["interface"]["shortDescription"]) <= 30
    assert not {"skills", "mcpServers", "apps"}.intersection(plugin)
    server = mcp["mcpServers"]["uvyazka"]
    assert server["type"] == "stdio" and server["command"] == "uv"
    assert "${PLUGIN_ROOT}" in server["args"]
    assert package["project"]["license"] == "Apache-2.0"
    assert package["project"]["license-files"] == ["LICENSE", "NOTICE"]
    assert "Apache License" in (ROOT / "LICENSE").read_text(encoding="utf-8")
    assert "Third-party" in (ROOT / "NOTICE").read_text(encoding="utf-8")
    for source, copy in (("LICENSE", "UVYAZKA-LICENSE.txt"), ("NOTICE", "UVYAZKA-NOTICE.txt")):
        assert (ROOT / source).read_bytes() == (ROOT / "web/public" / copy).read_bytes()
    assert not package["project"]["dependencies"], "Core must not require a model API or SDK"
    for file in ROOT.joinpath("clients").iterdir():
        if file.suffix == ".json":
            json.loads(file.read_text(encoding="utf-8"))
        elif file.suffix == ".toml":
            tomllib.loads(file.read_text(encoding="utf-8"))
    skills = sorted(ROOT.joinpath("skills").glob("*/SKILL.md"))
    assert len(skills) == 6
    for skill in skills:
        text = skill.read_text(encoding="utf-8")
        assert text.startswith("---\n"), skill
        frontmatter = text.split("---", 2)[1]
        fields = dict(line.split(":", 1) for line in frontmatter.strip().splitlines())
        assert set(fields) == {"name", "description"}, skill
        assert fields["name"].strip() == skill.parent.name
        assert 1 <= len(fields["description"].strip()) <= 1024
        assert len(text.splitlines()) < 500
    markdown = [ROOT / "README.md"]
    for directory in (ROOT / "skills", ROOT / "docs"):
        markdown.extend(directory.rglob("*.md"))
    for file in markdown:
        for link in re.findall(r"\]\(([^)]+)\)", file.read_text(encoding="utf-8")):
            if "://" not in link and not link.startswith("#"):
                assert (file.parent / link.split("#")[0]).is_file(), (file, link)
    cover = ET.parse(ROOT / "docs/assets/cover.svg").getroot()
    assert cover.attrib["viewBox"] == "0 0 1280 440"
    assert not any(node.tag.endswith(("script", "foreignObject")) for node in cover.iter())
    screenshots = list(ROOT.joinpath("docs/assets").glob("*.jpg"))
    assert len(screenshots) >= 8
    assert ROOT / "docs/assets/measurement-history.jpg" in screenshots
    assert all(path.read_bytes().startswith(b"\xff\xd8\xff") for path in screenshots)
    resources = json.loads((ROOT / "src/uvyazka/resources/technology-sources.json").read_text(encoding="utf-8"))
    assert len(resources["items"]) == 3
    assert all(item["applicability"] == "not_assessed" for item in resources["items"])
    packaged_skills = {Path(f).as_posix() for files in package["tool"]["setuptools"]["data-files"].values() for f in files}
    actual_skills = {p.relative_to(ROOT).as_posix() for p in (ROOT / "skills").rglob("*") if p.is_file()}
    assert actual_skills == packaged_skills, "Wheel must contain every canonical skill resource"
    vendor = ROOT / "src/uvyazka/_vendor/les_list"
    provenance = json.loads((vendor / "provenance.json").read_text(encoding="utf-8"))
    assert provenance["commit"] == "f6bedb34eff75c2d47e772810220ff738183f804"
    assert provenance["license"] == "MIT"
    assert "Copyright (c) 2026 OVC" in (vendor / "LICENSE.txt").read_text(encoding="utf-8")
    assert {"LICENSE.txt", "provenance.json"} <= set(package["tool"]["setuptools"]["package-data"]["uvyazka._vendor.les_list"])
    print("Package structure OK: 6 skills, 3 reference cards, stdio manifest, client templates, resource mapping")


if __name__ == "__main__":
    try:
        validate()
    except (AssertionError, ValueError, KeyError, OSError) as exc:
        print("Package validation failed:", exc, file=sys.stderr)
        raise SystemExit(1)
