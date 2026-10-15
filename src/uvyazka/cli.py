"""Explicit local setup/intake; MCP clients do not receive arbitrary filesystem registration."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import shutil

from .core import Workspace


def client_config(client: str, home: Path) -> str:
    command = str(Path(sys.executable).resolve())
    args = ["-m", "uvyazka.server"]
    if client == "codex":
        return "[mcp_servers.uvyazka]\ncommand = " + json.dumps(command) + "\nargs = " + json.dumps(args) + "\n\n[mcp_servers.uvyazka.env]\nUVYAZKA_HOME = " + json.dumps(str(home)) + "\n"
    return json.dumps({"mcpServers": {"uvyazka": {"command": command, "args": args, "env": {"UVYAZKA_HOME": str(home)}}}}, ensure_ascii=False, indent=2)


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(prog="uvyazka")
    parser.add_argument("--home", help="Local state directory, outside source roots")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("projects")
    sub.add_parser("demo")
    p = sub.add_parser("add-project"); p.add_argument("project_id"); p.add_argument("source_root"); p.add_argument("--name", required=True); p.add_argument("--location", default="")
    p = sub.add_parser("scan"); p.add_argument("project_id"); p.add_argument("--limit", type=int, default=100)
    p = sub.add_parser("status"); p.add_argument("project_id")
    p = sub.add_parser("search"); p.add_argument("project_id"); p.add_argument("query")
    p = sub.add_parser("client-config"); p.add_argument("client", choices=["codex", "claude-desktop", "gemini-cli"])
    p = sub.add_parser("dashboard"); p.add_argument("--port", type=int, default=8772)
    p = sub.add_parser("export-skills"); p.add_argument("destination")
    args = parser.parse_args(argv); workspace = Workspace(args.home)
    try:
        if args.action == "client-config":
            print(client_config(args.client, workspace.home)); return
        if args.action == "export-skills":
            checkout = Path(__file__).resolve().parents[2] / "skills"
            source = checkout if checkout.is_dir() else Path(sys.prefix) / "share/uvyazka/skills"
            if not source.is_dir():
                raise ValueError("Skill resources unavailable in this installation")
            destination = Path(args.destination).expanduser().resolve()
            if destination == source or destination.is_relative_to(source):
                raise ValueError("Choose a separate skill destination")
            files = [p for p in source.rglob("*") if p.is_file()]
            for p in files:
                target = destination / p.relative_to(source)
                if target.exists() and target.read_bytes() != p.read_bytes():
                    raise ValueError("Existing skill differs; choose a new destination: " + str(target))
            for p in files:
                target = destination / p.relative_to(source); target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, target)
            result = {"destination": str(destination), "skills": len(list(source.glob("*/SKILL.md"))), "note": "Configure the target client's skill mechanism separately."}
        elif args.action == "add-project":
            result = workspace.create_project(args.project_id, args.name, args.source_root, args.location)
        elif args.action == "scan":
            from .ingest import scan
            result = scan(workspace, args.project_id, args.limit)
        elif args.action == "demo":
            from .demo import create_demo
            result = create_demo(workspace)
        elif args.action == "dashboard":
            from .dashboard import serve
            serve(workspace, args.port); return
        elif args.action == "projects":
            result = workspace.list_projects()
        elif args.action == "search":
            result = workspace.search_project(args.project_id, args.query)
        else:
            result = workspace.project_status(args.project_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError) as exc:
        parser.exit(2, "uvyazka: " + str(exc) + "\n")


if __name__ == "__main__":
    main()
