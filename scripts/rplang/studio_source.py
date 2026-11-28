"""Lower source constructs whose Studio representation uses regular RP/1 nodes."""
import copy
import json
import sys

from .core import ptr
from .frontend import Frontend

MACROS = {"searchable-list", "data-table"}


def prepare_source(spec):
    front = Frontend(spec)
    prepared = front.spec
    front.models = prepared.get("models", {})
    front.datasets = prepared.get("datasets", {})
    front.variables = prepared.setdefault("variables", {})

    def visit(node, path, scope):
        if not isinstance(node, dict):
            return
        for shorthand in MACROS:
            if shorthand in node:
                node.setdefault("id", node.pop(shorthand))
                node.setdefault("type", shorthand)
        if node.get("type") in MACROS:
            expanded = front.desugar_node(node, path, scope)
            node.clear()
            node.update(expanded)
        for index, child in enumerate(node.get("children") or []):
            visit(child, ptr(ptr(path, "children"), index), scope)
        for index, state in enumerate(node.get("states") or []):
            if isinstance(state, dict):
                visit(state.get("root"), ptr(ptr(ptr(path, "states"), index), "root"), scope)
        visit(node.get("template"), ptr(path, "template"), scope)

    for index, page in enumerate(prepared.get("pages", [])):
        visit(page.get("root"), ptr(ptr("/pages", index), "root"), page.get("id", ""))
    for name, component in prepared.get("components", {}).items():
        visit(component.get("root"), ptr(ptr("/components", name), "root"), name)
    if not spec.get("product"):
        if "computed" in spec:
            prepared["computed"] = copy.deepcopy(spec["computed"])
        # The frontend has materialized selection views into page bindings.
        prepared.pop("views", None)
        for page in prepared.get("pages", []):
            page.pop("views", None)
    return prepared


if __name__ == "__main__":
    print(json.dumps(prepare_source(json.load(sys.stdin)), ensure_ascii=False))
