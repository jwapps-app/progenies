"""A small, dependency-free GEDCOM 5.5 parser.

Parses raw GEDCOM text into a tree of `GedNode` records. Each line follows the
form `LEVEL [@XREF@] TAG [VALUE]`. CONT/CONC continuation lines are folded into
their parent's value. This is intentionally lenient: unknown tags are kept so
that callers can inspect them, and malformed lines are skipped with a warning.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class GedNode:
    level: int
    tag: str
    xref: str | None = None  # The record's own xref (level-0 records) e.g. "@I1@"
    value: str = ""
    children: list["GedNode"] = field(default_factory=list)

    def child(self, tag: str) -> "GedNode | None":
        for c in self.children:
            if c.tag == tag:
                return c
        return None

    def children_with(self, tag: str) -> list["GedNode"]:
        return [c for c in self.children if c.tag == tag]

    def value_of(self, tag: str) -> str | None:
        node = self.child(tag)
        return node.value if node is not None and node.value != "" else None


@dataclass
class GedcomDocument:
    records: list[GedNode]
    warnings: list[str] = field(default_factory=list)

    def records_with_tag(self, tag: str) -> list[GedNode]:
        return [r for r in self.records if r.tag == tag]


def _parse_line(line: str) -> tuple[int, str | None, str, str] | None:
    """Parse one GEDCOM line into (level, xref, tag, value), or None if invalid."""
    line = line.rstrip("\r\n")
    if not line.strip():
        return None
    parts = line.split(" ", 1)
    try:
        level = int(parts[0])
    except ValueError:
        return None
    remainder = parts[1] if len(parts) > 1 else ""

    xref: str | None = None
    if remainder.startswith("@"):
        # Form: @XREF@ TAG [VALUE]
        end = remainder.find("@", 1)
        if end == -1:
            return None
        xref = remainder[: end + 1]
        remainder = remainder[end + 1 :].lstrip()

    if not remainder:
        return None
    tag_parts = remainder.split(" ", 1)
    tag = tag_parts[0]
    value = tag_parts[1] if len(tag_parts) > 1 else ""
    return level, xref, tag, value


def parse_gedcom(text: str) -> GedcomDocument:
    """Parse raw GEDCOM text into a document of level-0 records."""
    doc = GedcomDocument(records=[])
    # Stack of (level, node) tracking the current open record path.
    stack: list[GedNode] = []

    for lineno, raw in enumerate(text.splitlines(), start=1):
        parsed = _parse_line(raw)
        if parsed is None:
            if raw.strip():
                doc.warnings.append(f"Skipped malformed line {lineno}: {raw!r}")
            continue
        level, xref, tag, value = parsed

        # Fold continuation lines into the parent value.
        if tag in ("CONT", "CONC") and stack:
            parent = _node_at_level(stack, level - 1)
            if parent is not None:
                sep = "\n" if tag == "CONT" else ""
                parent.value = f"{parent.value}{sep}{value}"
                continue

        node = GedNode(level=level, tag=tag, xref=xref, value=value)

        if level == 0:
            doc.records.append(node)
            stack = [node]
        else:
            parent = _node_at_level(stack, level - 1)
            if parent is None:
                doc.warnings.append(f"Orphaned line {lineno} (no parent at level {level - 1})")
                continue
            parent.children.append(node)
            # Trim stack to this level and push the new node.
            stack = stack[:level] + [node]
    return doc


def _node_at_level(stack: list[GedNode], level: int) -> GedNode | None:
    if level < 0 or level >= len(stack):
        return None
    return stack[level]
