"""Lower ordered business logic to editable RP9 event graphs."""
from copy import deepcopy
from hashlib import sha256
import json

from .core import EVENTS, fail, fields, ptr


def lower_native_program(spec, program):
    spec = deepcopy(spec)
    return ProgramLowering(spec, program).compile()


class ProgramLowering:
    def __init__(self, spec, program):
        self.spec = spec
        self.program = program
        self.path = "/program"
        fields(program, {"page", "on", "bind", "routines"}, self.path)
        page_id = program.get("page")
        matches = [page for page in spec.get("pages", []) if page.get("id") == page_id]
        if not isinstance(page_id, str) or len(matches) != 1:
            fail("E_PROGRAM_PAGE", "/program/page", "Choose an existing page ID")
        self.page = matches[0]
        self.page_index = spec["pages"].index(self.page)
        self.root = self.page.get("root", {})
        if not isinstance(self.root.get("children"), list):
            fail("E_PROGRAM_PAGE", "/program/page", "The program page needs an editable root container with children")
        self.widgets = {}
        self.index(self.root)
        self.routines = program.get("routines", {})
        if not isinstance(self.routines, dict):
            fail("E_PROGRAM_ROUTINE", "/program/routines", "Expected named action blocks")
        self.callbacks = {}
        self.routine_entries = {}
        self.statement_count = 0
        self.variables = []
        self.loops = 0
        self.prefix = "rp1flow_" + sha256(page_id.encode()).hexdigest()[:10]
        self.triggers = []

    def index(self, node):
        if not isinstance(node, dict):
            return
        if isinstance(node.get("id"), str):
            self.widgets.setdefault(node["id"], []).append(node)
        for child in node.get("children", []):
            self.index(child)
        for state in node.get("states", []):
            if isinstance(state, dict):
                self.index(state.get("root"))
        self.index(node.get("template"))

    def reserve_callback(self, source):
        if len(self.callbacks) >= 256:
            fail("E_PROGRAM_SIZE", source, "Program exceeds 256 native control-flow blocks")
        name = f"{self.prefix}_{len(self.callbacks) + 1}"
        if name in self.widgets:
            fail("E_PROGRAM_NAME", source, f"Generated ID {name} collides with a widget")
        widget = {"type": "label", "id": name, "text": "", "hidden": True,
                  "_hidden_lookup": True, "x": 0, "y": 0, "w": 1, "h": 1}
        self.callbacks[name] = {
            "sourcePointer": source,
            "loweredPointer": f"/pages/{self.page_index}/root/children/{len(self.root['children'])}",
        }
        self.root["children"].append(widget)
        return widget

    @staticmethod
    def jump(widget):
        return {"type": "raise-event", "target": {"ref": widget["id"]}}

    def continuation(self, actions, source):
        if not actions or (len(actions) == 1 and actions[0].get("type") == "raise-event"):
            return actions
        callback = self.reserve_callback(source)
        callback["on"] = {"click": actions}
        return [self.jump(callback)]

    def counter(self, source, numeric_limit):
        name = f"{self.prefix}_count_{len(self.variables) + 1}"
        variables = self.spec.setdefault("variables", {})
        if isinstance(variables, list):
            matches = [v for v in variables if isinstance(v, dict) and str(v.get("name", v.get("id", ""))).lower() == name]
            if matches:
                fail("E_PROGRAM_NAME", source, f"Generated counter {name} collides with a variable")
            variables.append({"name": name, "type": "number", "value": 0})
        elif isinstance(variables, dict):
            if any(key.lower() == name for key in variables):
                fail("E_PROGRAM_NAME", source, f"Generated counter {name} collides with a variable")
            variables[name] = {"type": "number", "value": 0}
        else:
            fail("E_PROGRAM_VARIABLE", "/variables", "Expected a variable map or array")
        self.variables.append({"name": name, "limit": numeric_limit, "sourcePointer": source})
        return name

    def block(self, statements, source, following=(), stack=(), in_repeat=False, depth=0):
        if depth >= 24:
            fail("E_PROGRAM_DEPTH", source, "Program nesting exceeds 24 levels")
        if not isinstance(statements, list) or not statements:
            fail("E_PROGRAM_BLOCK", source, "Expected a nonempty array of actions")
        self.statement_count += len(statements)
        if self.statement_count > 4096:
            fail("E_PROGRAM_SIZE", source, "Program expands beyond 4096 statements")
        actions = list(following)
        for index in range(len(statements) - 1, -1, -1):
            step = statements[index]
            at = ptr(source, index)
            if not isinstance(step, dict):
                fail("E_PROGRAM_ACTION", at, "Expected an RP/1 action object or an if, repeat, or call block")
            next_block = self.continuation(actions, at) if any(key in step for key in ("call", "if", "match", "repeat")) else actions
            if "call" in step:
                fields(step, {"call"}, at)
                name = step["call"]
                if not isinstance(name, str) or name not in self.routines:
                    fail("E_PROGRAM_ROUTINE", ptr(at, "call"), f"Unknown routine {name!r}")
                if name in stack:
                    fail("E_PROGRAM_RECURSION", ptr(at, "call"), "Routine cycle: " + " → ".join((*stack, name)))
                tail = next_block[0]["target"]["ref"] if next_block else None
                key = (name, tail, in_repeat)
                if key not in self.routine_entries:
                    origin = ptr("/program/routines", name)
                    body = self.block(self.routines[name], origin, next_block, (*stack, name), in_repeat, depth + 1)
                    routine = self.reserve_callback(origin)
                    routine["on"] = {"click": body}
                    self.routine_entries[key] = routine
                actions = [self.jump(self.routine_entries[key])]
            elif "if" in step:
                fields(step, {"if", "then", "else"}, at)
                branch = self.reserve_callback(at)
                yes = self.block(step.get("then"), ptr(at, "then"), next_block, stack, in_repeat, depth + 1)
                no = self.block(step["else"], ptr(at, "else"), next_block, stack, in_repeat, depth + 1) if "else" in step else next_block
                cases = [{"when": step["if"], "actions": yes}]
                if no:
                    cases.append({"else": True, "actions": no})
                branch["on"] = {"click": {"cases": cases}}
                actions = [self.jump(branch)]
            elif "match" in step:
                fields(step, {"match", "cases", "else"}, at)
                cases = step.get("cases")
                if not isinstance(step["match"], str) or not isinstance(cases, dict) or not cases:
                    fail("E_PROGRAM_MATCH", at, "Match needs a text expression and a nonempty value-to-actions map")
                branch = self.reserve_callback(at)
                compiled = [{"when": {"op": "==", "left": {"expr": step["match"]}, "right": {"expr": json.dumps(key, ensure_ascii=False)}},
                             "actions": self.block(body, ptr(ptr(at, "cases"), key), next_block, stack, in_repeat, depth + 1)}
                            for key, body in cases.items()]
                fallback = self.block(step["else"], ptr(at, "else"), next_block, stack, in_repeat, depth + 1) if "else" in step else next_block
                if fallback:
                    compiled.append({"else": True, "actions": fallback})
                branch["on"] = {"click": {"cases": compiled}}
                actions = [self.jump(branch)]
            elif "repeat" in step:
                fields(step, {"repeat", "limit", "do", "then", "else"}, at)
                limit = step.get("limit", 32)
                if type(limit) is not int or not 1 <= limit <= 32:
                    fail("E_PROGRAM_LOOP_LIMIT", ptr(at, "limit"), "Repeat limit must be an integer from 1 to 32")
                counter = self.counter(at, limit)
                self.loops += 1
                loop = self.reserve_callback(at)
                repeat = [self.jump(loop)]
                body = self.block(step.get("do"), ptr(at, "do"), repeat, stack, True, depth + 1)
                cases = [{"when": f"${counter} > 0", "actions": [{"set": {f"${counter}": f"=${counter} - 1"}}, *body]}]
                finished = self.block(step["then"], ptr(at, "then"), next_block, stack, in_repeat, depth + 1) if "then" in step else next_block
                if finished:
                    cases.append({"else": True, "actions": finished})
                loop["on"] = {"click": {"cases": cases}}
                gate = self.reserve_callback(at)
                failed = self.block(step["else"], ptr(at, "else"), next_block, stack, in_repeat, depth + 1) if "else" in step else next_block
                gate_cases = [{"when": f"${counter} == 0", "actions": finished or repeat},
                              {"when": f"${counter} > 0 && ${counter} <= {limit} && number(fixed(${counter}, 0)) == ${counter}", "actions": repeat}]
                if failed:
                    gate_cases.append({"else": True, "actions": failed})
                gate["on"] = {"click": {"cases": gate_cases}}
                actions = [{"set": {f"${counter}": step["repeat"]}}, self.jump(gate)]
            else:
                if in_repeat and ("wait" in step or step.get("type") in {"wait", "raise-event"}):
                    fail("E_PROGRAM_LOOP_ACTION", at, "Repeat bodies must complete synchronously")
                actions.insert(0, step)
        return actions

    def bind(self, target, event, statements, source):
        native = EVENTS.get(event, event) if isinstance(event, str) else None
        if native not in EVENTS.values():
            fail("E_PROGRAM_EVENT", source, f"Unknown event {event!r}")
        if target == "$page":
            node = self.page
        else:
            found = self.widgets.get(target, [])
            if len(found) != 1:
                fail("E_PROGRAM_TARGET", source, f"Target {target!r} matches {len(found)} widgets on this page")
            node = found[0]
        declarations = node.setdefault("on", {})
        if any(EVENTS.get(key, key) == native for key in declarations):
            fail("E_PROGRAM_EVENT", source, f"{event!r} already exists on {target!r}")
        declarations[event] = self.block(statements, source)
        self.triggers.append({"widget": target, "event": native, "sourcePointer": source})

    def compile(self):
        bindings = self.program.get("on", {})
        if not isinstance(bindings, dict):
            fail("E_PROGRAM_EVENT", "/program/on", "Expected a map of widgets and their events")
        for target, events in bindings.items():
            source = ptr("/program/on", target)
            if not isinstance(events, dict) or not events:
                fail("E_PROGRAM_EVENT", source, "Expected a nonempty event map")
            for event, block in events.items():
                self.bind(target, event, block, ptr(source, event))
        groups = self.program.get("bind", [])
        if not isinstance(groups, list):
            fail("E_PROGRAM_BIND", "/program/bind", "Expected a list of parameterized event bindings")
        for index, group in enumerate(groups):
            at = ptr("/program/bind", index)
            fields(group, {"targets", "variable", "event", "call"}, at)
            targets = group.get("targets")
            variable = group.get("variable")
            if not isinstance(targets, dict) or not targets or not isinstance(variable, str) or not variable.startswith("$"):
                fail("E_PROGRAM_BIND", at, "Provide a widget-to-value map and a $variable")
            for target, value in targets.items():
                self.bind(target, group.get("event", "click"), [{"set": {variable: value}}, {"call": group.get("call")}],
                          ptr(ptr(at, "targets"), target))
        if not self.triggers:
            fail("E_PROGRAM_EVENT", self.path, "The program needs at least one event binding")
        return self.spec, {"page": self.page["id"], "triggers": self.triggers, "callbacks": self.callbacks,
                           "loopCount": self.loops, "counters": self.variables, "routines": list(self.routines)}
