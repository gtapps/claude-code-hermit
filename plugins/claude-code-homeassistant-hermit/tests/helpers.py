from pathlib import Path


def write_artifact(directory: Path, content: str, name: str = "automation.yaml") -> Path:
    path = directory / name
    path.write_text(content, encoding="utf-8")
    return path
