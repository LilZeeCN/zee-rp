"""Lower ordered business logic to editable RP9 event graphs."""
from copy import deepcopy
from dataclasses import dataclass, field
from hashlib import sha256
import json
import re

from .core import EVENTS, fail, fields, ptr

RESET_CASE_TITLE = "初始化任务状态"


def lower_native_program(spec, program=None, *, programs=None, shared_routines=None):
    if (program is None) == (programs is None):
        fail("E_PROGRAM_INPUT", "/programs", "Supply either program or programs")
    spec = deepcopy(spec)
    sources = programs if programs is not None else [program]
    shared = shared_routines if shared_routines is not None else {}
    if not isinstance(sources, list) or not sources:
        fail("E_PROGRAM_INPUT", "/programs", "Expected programs on one or more pages")
    if not isinstance(shared, dict):
        fail("E_PROGRAM_ROUTINE", "/sharedRoutines", "Expected a named routine map")
    reports, seen = [], set()
    for index, item in enumerate(sources):
        path = f"/programs/{index}" if programs is not None else "/program"
        if isinstance(item, dict) and isinstance(item.get("page"), str):
            if item["page"] in seen:
                fail("E_PROGRAM_PAGE", ptr(path, "page"), "Only one program per page is allowed")
            seen.add(item["page"])
        spec, report = ProgramLowering(spec, item, path=path, shared=shared).compile()
        reports.append(report)
    return spec, reports[0] if programs is None else {"pages": reports}


def _uses_wait(value, routines, seen=()):
    if isinstance(value, list):
        return any(_uses_wait(item, routines, seen) for item in value)
    if not isinstance(value, dict):
        return False
    if "wait" in value or value.get("type") == "wait" or "intervalMs" in value:
        return True
    if ("repeat" in value or "while" in value) and type(value.get("limit")) is int and value["limit"] > 32:
        return True
    name = value.get("call")
    if isinstance(name, str) and name in routines and name not in seen:
        if _uses_wait(routines[name], routines, (*seen, name)):
            return True
    return any(_uses_wait(child, routines, seen) for child in value.values())


_reference_token = re.compile(r"""(?P<quoted>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?P<scope>\$|@|\bvar\.|\bwidget\.)(?P<name>[A-Za-z_][\w-]*)""")


def _localize(node, names, targets, field=None):
    if isinstance(node, list):
        return [_localize(value, names, targets, field) for value in node]
    if isinstance(node, dict):
        def key_of(key):
            if field == "set" and key.startswith(("$", "@")):
                aliases = names if key.startswith("$") else targets
                return key[0] + aliases.get(key[1:], key[1:])
            if field == "set" and key.startswith("var."):
                return "var." + names.get(key[4:], key[4:])
            return key
        return {key_of(key): _localize(value, names, targets, key) for key, value in node.items()}
    if not isinstance(node, str):
        return node
    if field == "variable" and node.startswith("$"):
        return "$" + names.get(node[1:], node[1:])
    if field in {"variable", "var", "globalVariable", "set-variable"}:
        return names.get(node, node)
    if field in {"target", "widget", "panel", "repeater", "widgetPath", "ref"}:
        return targets.get(node, node)
    if node.startswith(("=", "[[")) or field in {"if", "match", "while", "when", "expr", "repeat"}:
        def token(match):
            scope, name = match.group("scope"), match.group("name")
            aliases = names if scope in {"$", "var."} else targets
            return scope + aliases[name] if name in aliases else match.group()
        return _reference_token.sub(token, node)
    return node


def _expr(value):
    return {"expr": value} if isinstance(value, str) else value


def _both(left, right):
    return {"op": "&&", "left": _expr(left), "right": _expr(right)}


@dataclass
class Task:
    name: str
    source: str
    policy: str
    body: list
    names: dict
    defaults: dict
    # The stored value is idle (0), executing (-1), or a parked continuation (>0).
    resume: str
    native_prefix: str
    wait_ms: str | None = None
    entry: dict | None = None
    wakes: dict = field(default_factory=dict)


class ProgramLowering:
    def __init__(self, spec, program, *, path, shared):
        self.spec = spec
        self.path = path
        fields(program, {"page", "on", "bind", "routines", "locals", "targets", "tasks"}, self.path)
        self.program = program
        page_id = program.get("page")
        matches = [page for page in spec.get("pages", []) if page.get("id") == page_id]
        if not isinstance(page_id, str) or len(matches) != 1:
            fail("E_PROGRAM_PAGE", ptr(path, "page"), "Choose an existing page ID")
        self.page = matches[0]
        self.page_index = spec["pages"].index(self.page)
        self.root = self.page.get("root", {})
        if not isinstance(self.root.get("children"), list):
            fail("E_PROGRAM_PAGE", ptr(path, "page"), "The program page needs an editable root container with children")
        self.widgets = {}
        self.index(self.root)
        routines = program.get("routines", {})
        if not isinstance(routines, dict):
            fail("E_PROGRAM_ROUTINE", ptr(path, "routines"), "Expected named action blocks")
        self.callbacks = {}
        self.nodes = {}
        self.routine_entries = {}
        self.continuations = {}
        self.statement_count = 0
        self.variables = []
        self.generated_variables = []
        self.loops = 0
        self.async_loops = 0
        self.prefix = "rp1flow_" + sha256(page_id.encode()).hexdigest()[:10]
        self.native_prefix = self.name_part(page_id, "Page")
        variables = self.spec.get("variables", {})
        if isinstance(variables, list):
            variable_names = [v.get("name", v.get("id", "")) for v in variables if isinstance(v, dict)]
        else:
            variable_names = variables if isinstance(variables, dict) else ()
        self.variable_names = {str(name).lower() for name in variable_names}
        self.triggers = []
        self.entries = []
        local_names = self.local_variables(program.get("locals", {}), self.native_prefix, ptr(path, "locals"))
        self.target_names = program.get("targets", {})
        if not isinstance(self.target_names, dict) or any(not isinstance(value, str) for value in self.target_names.values()):
            fail("E_PROGRAM_TARGET", ptr(path, "targets"), "For RP/1 source, targets maps aliases to widget IDs")
        self.raw_routines = {**shared, **routines}
        self.routines = _localize(self.raw_routines, local_names, self.target_names)
        self.routine_paths = {name: ptr(ptr(path, "routines") if name in routines else "/sharedRoutines", name)
                              for name in self.routines}
        self.tasks = self.declare_tasks(program.get("tasks", {}), local_names)
        for key in ("on", "bind"):
            if key in program:
                self.program[key] = _localize(program[key], local_names, self.target_names)
        self.asynchronous = any(_uses_wait(self.program.get(key), self.routines) for key in ("on", "bind"))
        self.busy = (self.add_variable(f"{self.native_prefix}_Running", {"type": "number", "value": 0}, path)
                     if self.asynchronous else None)

    @staticmethod
    def name_part(value, fallback):
        label = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_")
        if not label:
            return fallback
        return f"{fallback}_{label}" if label[0].isdigit() else label

    def local_variables(self, declarations, prefix, source):
        if not isinstance(declarations, dict):
            fail("E_PROGRAM_VARIABLE", source, "Expected a map of local variable declarations")
        names = {}
        for name, definition in declarations.items():
            origin = ptr(source, name)
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                fail("E_PROGRAM_VARIABLE", origin, "Expected a variable identifier")
            private = f"{prefix}_{name}"
            names[name] = self.add_variable(private, definition, origin)
        return names

    def declare_tasks(self, declarations, page_names):
        source = ptr(self.path, "tasks")
        if not isinstance(declarations, dict):
            fail("E_PROGRAM_TASK", source, "Expected a map of named tasks")
        tasks = {}
        for name, task in declarations.items():
            at = ptr(source, name)
            fields(task, {"policy", "locals", "do"}, at)
            policy = task.get("policy", "restart")
            if policy not in ("restart", "ignore"):
                fail("E_PROGRAM_TASK_POLICY", ptr(at, "policy"), "Choose restart or ignore")
            body = task.get("do")
            if not isinstance(body, list) or not body:
                fail("E_PROGRAM_BLOCK", ptr(at, "do"), "Expected a nonempty task body")
            prefix = f"{self.native_prefix}_{self.name_part(name, 'Task')}"
            definitions = task.get("locals", {})
            names = self.local_variables(definitions, f"{prefix}_local", ptr(at, "locals"))
            resume = self.add_variable(f"{prefix}_NextStep", {"type": "number", "value": 0}, at)
            tasks[name] = Task(name, at, policy, body, {**page_names, **names},
                               {key: (variable, definitions[key]["value"]) for key, variable in names.items()},
                               resume, prefix)
        return tasks

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

    def reserve_callback(self, source, *, name=None, label="继续执行"):
        if len(self.callbacks) >= 256:
            fail("E_PROGRAM_SIZE", source, "Program exceeds 256 native control-flow blocks")
        name = name or f"{self.prefix}_{len(self.callbacks) + 1}"
        if name in self.widgets:
            fail("E_PROGRAM_NAME", source, f"Generated ID {name} collides with a widget")
        widget = {"type": "label", "id": name, "text": "", "hidden": True,
                  "_hidden_lookup": True, "x": 0, "y": 0, "w": 1, "h": 1}
        self.callbacks[name] = {
            "sourcePointer": source,
            "label": label,
            "loweredPointer": f"/pages/{self.page_index}/root/children/{len(self.root['children'])}",
        }
        self.nodes[name] = widget
        self.root["children"].append(widget)
        return widget

    @staticmethod
    def jump(widget):
        return {"type": "raise-event", "target": {"ref": widget["id"]}}

    def continuation(self, actions, source):
        if not actions:
            return actions
        target = actions[0].get("target")
        if len(actions) == 1 and actions[0].get("type") == "raise-event" and isinstance(target, dict) and target.get("ref") in self.nodes:
            return actions
        key = json.dumps(actions, sort_keys=True, ensure_ascii=False)
        if key not in self.continuations:
            callback = self.reserve_callback(source)
            callback["on"] = {"click": actions}
            self.continuations[key] = callback
        return [self.jump(self.continuations[key])]

    def add_variable(self, name, definition, source):
        if not isinstance(definition, dict) or "value" not in definition:
            fail("E_PROGRAM_VARIABLE", source, "Define a variable with type and value")
        variables = self.spec.setdefault("variables", {})
        stem = name
        suffix = 2
        while name.lower() in self.variable_names:
            name = f"{stem}_{suffix}"
            suffix += 1
        if isinstance(variables, list):
            variables.append({**definition, "name": name})
        elif isinstance(variables, dict):
            variables[name] = definition
        else:
            fail("E_PROGRAM_VARIABLE", "/variables", "Expected a variable map or array")
        self.generated_variables.append(name)
        self.variable_names.add(name.lower())
        return name

    def counter(self, source, numeric_limit):
        name = self.add_variable(f"{self.native_prefix}_Loop{len(self.variables) + 1}_Remaining",
                                 {"type": "number", "value": 0}, source)
        self.variables.append({"name": name, "limit": numeric_limit, "sourcePointer": source})
        return name

    def start_task(self, task, overrides, source):
        if not isinstance(overrides, dict) or any(key not in task.defaults for key in overrides):
            fail("E_PROGRAM_TASK_LOCAL", ptr(source, "with"), "Only declared task locals can be initialized")
        if task.entry is None:
            task.entry = self.reserve_callback(task.source, label=f"运行 {task.name}")
            body = _localize(task.body, task.names, self.target_names)
            finish = [{"set": {f"${task.resume}": 0}}]
            task.entry["on"] = {"click": self.block(body, ptr(task.source, "do"), finish, task=task)}
        assignments = {f"${variable}": overrides.get(name, {"_program_literal": default})
                       for name, (variable, default) in task.defaults.items()}
        start = [{"set": {f"${task.resume}": -1, **assignments}}, self.jump(task.entry)]
        launch = self.reserve_callback(source, label=f"启动 {task.name}")
        condition = f"${task.resume} == 0" if task.policy == "ignore" else f"${task.resume} >= 0"
        launch["on"] = {"click": {"cases": [{"when": condition, "actions": start}]}}
        return self.jump(launch)

    def suspend(self, task, ms, actions, source):
        # Axure Wait uses window.setTimeout. Equal effective delays complete
        # in submission order. Normalize short waits to avoid nesting-dependent
        # clamping reordering a restarted wait ahead of an older one.
        ms = max(ms, 4)
        if ms not in task.wakes:
            if not task.wakes:
                task.wait_ms = self.add_variable(f"{task.native_prefix}_WaitMs", {"type": "number", "value": 0}, task.source)
            pending = self.add_variable(f"{task.native_prefix}_Pending{ms}ms", {"type": "number", "value": 0}, task.source)
            wake = self.reserve_callback(source, label=f"处理 {task.name} 的 {ms} ms 唤醒")
            wake["on"] = {"click": {"cases": [
                {"when": f"${pending} == 1 && ${task.wait_ms} == {ms} && ${task.resume} > 0",
                 "actions": [{"set": {f"${pending}": 0}}, {"_program_resume": task.resume}]},
                {"when": f"${pending} > 0", "actions": [{"set": {f"${pending}": f"=${pending} - 1"}}]},
            ]}}
            task.wakes[ms] = (wake, pending)
        wake, pending = task.wakes[ms]
        resume, = self.continuation(actions, source)
        # Each wake consumes its own position in this FIFO. Only its newest
        # position can own the active continuation, even across wait sites.
        return [{"set": {f"${task.wait_ms}": ms, f"${pending}": f"=${pending} + 1"}},
                {"_program_park": resume["target"]["ref"], "variable": task.resume},
                {"type": "wait", "ms": ms}, self.jump(wake)]

    def block(self, statements, source, following=(), stack=(), in_repeat=False, depth=0, task=None):
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
            next_block = self.continuation(actions, at) if any(key in step for key in ("call", "if", "match", "repeat", "while")) else actions
            if "call" in step:
                fields(step, {"call"}, at)
                name = step["call"]
                if not isinstance(name, str) or name not in self.routines:
                    fail("E_PROGRAM_ROUTINE", ptr(at, "call"), f"Unknown routine {name!r}")
                if name in stack:
                    fail("E_PROGRAM_RECURSION", ptr(at, "call"), "Routine cycle: " + " → ".join((*stack, name)))
                tail = next_block[0]["target"]["ref"] if next_block else None
                key = (task.resume if task else None, name, tail, in_repeat)
                if key not in self.routine_entries:
                    origin = self.routine_paths[name]
                    routine_body = (_localize(self.raw_routines[name], task.names, self.target_names)
                                    if task else self.routines[name])
                    body = self.block(routine_body, origin, next_block, (*stack, name), in_repeat, depth + 1, task)
                    routine = self.reserve_callback(origin, label=f"执行 {name}")
                    routine["on"] = {"click": body}
                    self.routine_entries[key] = routine
                actions = [self.jump(self.routine_entries[key])]
            elif "if" in step:
                fields(step, {"if", "then", "else"}, at)
                branch = self.reserve_callback(at, label="判断条件")
                yes = self.block(step.get("then"), ptr(at, "then"), next_block, stack, in_repeat, depth + 1, task)
                no = self.block(step["else"], ptr(at, "else"), next_block, stack, in_repeat, depth + 1, task) if "else" in step else next_block
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
                branch = self.reserve_callback(at, label="按值选择")
                compiled = [{"when": {"op": "==", "left": {"expr": step["match"]}, "right": {"expr": json.dumps(key, ensure_ascii=False)}},
                             "actions": self.block(body, ptr(ptr(at, "cases"), key), next_block, stack, in_repeat, depth + 1, task)}
                            for key, body in cases.items()]
                fallback = self.block(step["else"], ptr(at, "else"), next_block, stack, in_repeat, depth + 1, task) if "else" in step else next_block
                if fallback:
                    compiled.append({"else": True, "actions": fallback})
                branch["on"] = {"click": {"cases": compiled}}
                actions = [self.jump(branch)]
            elif "repeat" in step or "while" in step:
                fields(step, {"repeat", "while", "limit", "intervalMs", "do", "then", "else"}, at)
                condition = step.get("while")
                counted = "repeat" in step
                if counted == ("while" in step):
                    fail("E_PROGRAM_LOOP", at, "Use either repeat or while")
                interval = step.get("intervalMs")
                if "intervalMs" in step and (type(interval) is not int or not 1 <= interval <= 30000):
                    fail("E_PROGRAM_INTERVAL", ptr(at, "intervalMs"), "Interval must be from 1 to 30000 milliseconds")
                limit = step.get("limit", 32)
                yielding = interval is not None or (type(limit) is int and limit > 32) or _uses_wait(step.get("do"), self.routines)
                maximum = 1024 if yielding else 32
                if type(limit) is not int or not 1 <= limit <= maximum:
                    fail("E_PROGRAM_LOOP_LIMIT", ptr(at, "limit"), f"Loop limit must be an integer from 1 to {maximum}")
                counter = self.counter(at, limit)
                self.loops += 1
                self.async_loops += int(yielding)
                loop = self.reserve_callback(at, label="循环步骤")
                repeat = [self.jump(loop)]
                body = self.block(step.get("do"), ptr(at, "do"), repeat, stack, not yielding, depth + 1, task)
                iteration = [{"set": {f"${counter}": f"=${counter} - 1"}}]
                if yielding:
                    if not task:
                        body = [{"type": "wait", "ms": interval or 0}, *body]
                    elif interval is not None or limit > 32:
                        body = self.suspend(task, interval or 0, body, at)
                iteration.extend(body)
                finished = self.block(step["then"], ptr(at, "then"), next_block, stack, in_repeat, depth + 1, task) if "then" in step else next_block
                failed = self.block(step["else"], ptr(at, "else"), next_block, stack, in_repeat, depth + 1, task) if "else" in step else next_block
                if counted:
                    cases = [{"when": f"${counter} > 0", "actions": iteration}]
                    if finished:
                        cases.append({"else": True, "actions": finished})
                    gate = self.reserve_callback(at, label="检查循环次数")
                    gate_cases = [{"when": f"${counter} >= 0 && ${counter} <= {limit} && number(fixed(${counter}, 0)) == ${counter}",
                                   "actions": repeat}]
                    if failed:
                        gate_cases.append({"else": True, "actions": failed})
                    gate["on"] = {"click": {"cases": gate_cases}}
                    actions = [{"set": {f"${counter}": step["repeat"]}}, self.jump(gate)]
                else:
                    cases = [{"when": _both(f"${counter} > 0", condition), "actions": iteration}]
                    if failed:
                        cases.append({"when": condition, "actions": failed})
                    elif finished:
                        cases.append({"when": {"fn": "not", "args": [_expr(condition)]}, "actions": finished})
                    if failed and finished:
                        cases.append({"else": True, "actions": finished})
                    actions = [{"set": {f"${counter}": limit}}, self.jump(loop)]
                loop["on"] = {"click": {"cases": cases}}
            elif "start" in step or "cancel" in step:
                command = "start" if "start" in step else "cancel"
                fields(step, {"start", "with"} if command == "start" else {"cancel"}, at)
                name = step[command]
                if task:
                    fail("E_PROGRAM_TASK_SCOPE", at, "Start and cancel tasks in page event handlers")
                if not isinstance(name, str) or name not in self.tasks:
                    fail("E_PROGRAM_TASK", ptr(at, command), f"Unknown task {name!r}")
                flow = self.tasks[name]
                if command == "start":
                    actions.insert(0, self.start_task(flow, step.get("with", {}), at))
                else:
                    actions.insert(0, {"set": {f"${flow.resume}": 0}})
            elif task and ("wait" in step or step.get("type") == "wait"):
                fields(step, {"wait"} if "wait" in step else {"type", "ms"}, at)
                ms = step.get("wait", step.get("ms"))
                if type(ms) is not int or not 0 <= ms <= 2147483647:
                    fail("E_PROGRAM_TASK_WAIT", at, "Wait must be a nonnegative integer in milliseconds")
                actions = self.suspend(task, ms, actions, at)
            else:
                if in_repeat and ("wait" in step or step.get("type") in {"wait", "raise-event"}):
                    fail("E_PROGRAM_LOOP_ACTION", at, "Repeat bodies must complete synchronously")
                actions.insert(0, step)
        return actions

    def bind(self, target, event, statements, source):
        native = EVENTS.get(event, event) if isinstance(event, str) else None
        if native not in EVENTS.values():
            fail("E_PROGRAM_EVENT", source, f"Unknown event {event!r}")
        target = self.target_names.get(target, target)
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
        if self.busy and (not self.tasks or _uses_wait(statements, self.routines)):
            lock = {"set": {f"${self.busy}": 1}}
            release = {"set": {f"${self.busy}": 0}}
            body = self.block(statements, source, [release])
            declarations[event] = {"cases": [{"when": f"${self.busy} == 0", "actions": [lock, *body]}]}
        else:
            declarations[event] = self.block(statements, source)
        self.entries.append((declarations, event))
        self.triggers.append({"widget": target, "event": native, "sourcePointer": source})

    def reset_on_load(self, slots):
        declarations = self.page.setdefault("on", {})
        # Existing source load handlers may declare the canonical event or its
        # normal RP/1 shorthand. The reset precedes both, including conditional cases.
        load = next((key for key in declarations if EVENTS.get(key, key) == "OnLoad"), "load")
        payload = declarations.get(load)
        if payload is None:
            payload = self.page.pop("onLoad", [])
        reset = {"_program_case": RESET_CASE_TITLE, "actions": [{"set": {f"${slot}": 0 for slot in slots}}]}
        if isinstance(payload, dict) and "cases" in payload:
            declarations[load] = {"_program_groups": True, "cases": [reset, *payload["cases"]]}
        elif payload:
            declarations[load] = {"cases": [{**reset,
                "actions": [*reset["actions"], *(payload if isinstance(payload, list) else [payload])]}]}
        else:
            declarations[load] = {"cases": [reset]}
            self.triggers.append({"widget": "$page", "event": "OnLoad", "sourcePointer": self.path, "resetOnly": True})

    def optimize(self):
        """Inline small linear callbacks, then pack remaining branches into one driver."""
        original = len(self.nodes)
        def target(action):
            ref = action.get("target")
            if action.get("type") == "raise-event" and isinstance(ref, dict):
                return ref.get("ref")
            return None

        def expand(actions, path=()):
            if not actions:
                return actions
            name = target(actions[-1])
            hook = self.nodes.get(name, {}).get("on", {}).get("click")
            if isinstance(hook, list) and name not in path and len(hook) <= 6:
                return [*actions[:-1], *expand(hook, (*path, name))]
            return actions

        def sync_prefix(action):
            return (action.get("type") == "set-variable" or
                    (isinstance(action.get("set"), dict) and all(key.startswith("$") for key in action["set"])))

        def inline_payload(payload):
            if isinstance(payload, list):
                payload = expand(payload)
                if not payload or not isinstance(payload[-1], dict):
                    return payload
                name = target(payload[-1])
                hook = self.nodes.get(name, {}).get("on", {}).get("click")
                prefix = payload[:-1]
                if isinstance(hook, dict) and "cases" in hook and all(sync_prefix(action) for action in prefix):
                    cases = [{**case, "_program_case": self.callbacks[name]["label"],
                              "actions": expand(case["actions"])} for case in hook["cases"]]
                    return {"_program_groups": True, "cases": [{"actions": prefix}, *cases] } if prefix else {"cases": cases}
                return payload
            return {**payload, "cases": [{**case, "actions": expand(case["actions"])} for case in payload["cases"]]}

        for declarations, event in self.entries:
            declarations[event] = inline_payload(declarations[event])
        for widget in self.nodes.values():
            payload = widget["on"]["click"]
            # Retained callbacks must still be one conditional group for the dispatcher.
            widget["on"]["click"] = (expand(payload) if isinstance(payload, list) else
                                     {**payload, "cases": [{**case, "actions": expand(case["actions"])} for case in payload["cases"]]})

        def actions_of(payload):
            return payload if isinstance(payload, list) else [action for case in payload["cases"] for action in case["actions"]]

        def edge(action):
            return action.get("_program_park") or target(action)

        pending = [edge(a) for declarations, event in self.entries for a in actions_of(declarations[event])]
        live = set()
        while pending:
            name = pending.pop()
            if name in self.nodes and name not in live:
                live.add(name)
                pending.extend(edge(a) for a in actions_of(self.nodes[name]["on"]["click"]))
        self.root["children"] = [child for child in self.root["children"] if child.get("id") not in self.nodes]
        if not live:
            self.callbacks = {}
            return original
        ordered = [name for name in self.nodes if name in live]
        position = {name: index for index, name in enumerate(ordered, 1)}
        driver = self.reserve_callback(self.path, name=f"{self.prefix}_dispatch")
        driver["name"] = "交互调度"
        pc = self.add_variable(f"{self.native_prefix}_DispatchStep", {"type": "number", "value": 0}, self.path)

        def rewrite(actions):
            out = []
            for action in actions:
                name = target(action)
                if name in position:
                    out.extend(({"set": {f"${pc}": position[name]}}, self.jump(driver)))
                elif "_program_park" in action:
                    out.append({"set": {f"${action['variable']}": position[action["_program_park"]]}})
                elif "_program_resume" in action:
                    slot = action["_program_resume"]
                    out.extend(({"set": {f"${pc}": {"variable": slot}, f"${slot}": -1}}, self.jump(driver)))
                else:
                    out.append(action)
            return out

        cases, case_pointers = [], []
        for name in ordered:
            payload = self.nodes[name]["on"]["click"]
            origin = self.callbacks[name]
            for case in [{"actions": payload}] if isinstance(payload, list) else payload["cases"]:
                guard = f"${pc} == {position[name]}"
                cases.append({"when": _both(guard, case["when"]) if "when" in case else guard,
                              "_program_case": origin["label"], "actions": rewrite(case["actions"])})
                case_pointers.append(origin["sourcePointer"])
        driver["on"] = {"click": {"cases": cases}}
        self.callbacks[driver["id"]]["casePointers"] = case_pointers
        self.callbacks = {driver["id"]: self.callbacks[driver["id"]]}
        for declarations, event in self.entries:
            payload = declarations[event]
            declarations[event] = rewrite(payload) if isinstance(payload, list) else {
                **payload, "cases": [{**case, "actions": rewrite(case["actions"])} for case in payload["cases"]]}
        return original

    def compile(self):
        bindings = self.program.get("on", {})
        if not isinstance(bindings, dict):
            fail("E_PROGRAM_EVENT", ptr(self.path, "on"), "Expected a map of widgets and their events")
        for target, events in bindings.items():
            source = ptr(ptr(self.path, "on"), target)
            if not isinstance(events, dict) or not events:
                fail("E_PROGRAM_EVENT", source, "Expected a nonempty event map")
            for event, block in events.items():
                self.bind(target, event, block, ptr(source, event))
        groups = self.program.get("bind", [])
        if not isinstance(groups, list):
            fail("E_PROGRAM_BIND", ptr(self.path, "bind"), "Expected a list of parameterized event bindings")
        for index, group in enumerate(groups):
            at = ptr(ptr(self.path, "bind"), index)
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
        original_callbacks = self.optimize()
        active_tasks = {name: task for name, task in self.tasks.items() if task.entry is not None}
        reset_slots = [self.busy] if self.busy else []
        for task in active_tasks.values():
            reset_slots.extend([task.resume, *(pending for _, pending in task.wakes.values())])
        if reset_slots:
            self.reset_on_load(reset_slots)
        return self.spec, {"page": self.page["id"], "triggers": self.triggers, "callbacks": self.callbacks,
                           "loopCount": self.loops, "asyncLoopCount": self.async_loops, "reentry": "skip-while-active" if self.busy else None,
                           "unoptimizedCallbackCount": original_callbacks, "counters": self.variables,
                           "generatedVariables": self.generated_variables, "resetSlots": reset_slots, "routines": list(self.routines),
                           "tasks": [{"name": name, "policy": task.policy} for name, task in active_tasks.items()]}
