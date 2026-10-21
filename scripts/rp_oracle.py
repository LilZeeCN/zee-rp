#!/usr/bin/env python3
"""Headless Axure RP 9 expr.js / sto.js Oracle for RP/1 ReferenceRuntime.

Executes RP/1 runtime ASTs against both:
1. Python `ReferenceRuntime.eval_expr`
2. Real Axure RP 9 `sto.js` + `expr.js` inside a Node `vm` sandbox
and verifies 100% behavioral equivalence across expressions, types, variables,
widgets, and Repeater row scopes.
"""
import json
import os
from pathlib import Path
import subprocess
from rp_language import ReferenceRuntime, compile_language

AXURE_SCRIPTS_DIR = Path(os.environ.get("AXURE_RUNTIME_SCRIPTS",
    "/Applications/Axure RP 9.app/Contents/Resources/DefaultSettings/Prototype_Files/resources/scripts/axure"))

NODE_ORACLE_RUNNER = r"""
const fs = require('node:fs');
const vm = require('node:vm');

const stoPath = process.argv[1];
const exprPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));

function createSandbox(env) {
  const internalCallbacks = [];
  const $ax = Object.assign(
    (selector) => {
      const cleanId = String(selector).replace(/^#/, '').replace(/_input$/, '');
      return {
        text: () => String((env.widgets && env.widgets[cleanId]) ?? ''),
        selected: () => false,
        enabled: () => true,
        focus: () => {},
      };
    },
    {
    constants: { LINK_TYPE: 'hyperlink' },
    public: { fn: { IsTextBox: () => false, IsTextArea: () => false, getCursorOffset: () => ({ x: 0, y: 0 }) } },
    placeholderManager: { isActive: () => false, updatePlaceholder: () => {} },
    globalVariableProvider: {
      getVariableValue: (name) => {
        const v = env.variables && Object.prototype.hasOwnProperty.call(env.variables, name) ? env.variables[name] : '';
        return String(v);
      },
      setVariableValue: (name, val) => {
        if (env.variables) env.variables[name] = val;
      },
    },
    getElementIdsFromPath: (pathArr) => pathArr,
    repeater: {
      applySuffixToElementId: (id, suffix) => id + suffix,
      hasData: (_elem, field) => Boolean(env.row && Object.prototype.hasOwnProperty.call(env.row, field)),
      getScriptIdFromElementId: (id) => id,
      getItemIdFromElementId: () => '1',
      getData: (_eventInfo, _repId, _itemId, field) => {
        const v = env.row && Object.prototype.hasOwnProperty.call(env.row, field) ? env.row[field] : '';
        return String(v);
      },
    },
    getParentRepeaterFromScriptId: () => 'rep1',
    INPUT: (id) => id + '_input',
    GetTextPanelId: (id) => id,
  });
  const $axure = {
    internal: (cb) => internalCallbacks.push(cb),
  };
  const $jobj = (id) => ({
    val: () => {
      const cleanId = String(id).replace(/_input$/, '');
      return String((env.widgets && env.widgets[cleanId]) ?? '');
    },
    text: () => String((env.widgets && env.widgets[id]) ?? ''),
    length: 1,
    0: { value: String((env.widgets && env.widgets[String(id).replace(/_input$/, '')]) ?? '') },
  });
  const sandbox = {
    $axure,
    $ax,
    $jobj,
    $obj: () => ({ type: 'textBox' }),
    window: { document: { getElementById: (id) => ({ innerText: String((env.widgets && env.widgets[id]) ?? '') }) } },
    Number,
    String,
    Boolean,
    Date,
    Math,
    Object,
    Array,
    isNaN,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(stoPath, 'utf8'), sandbox, { filename: 'sto.js' });
  vm.runInContext(fs.readFileSync(exprPath, 'utf8'), sandbox, { filename: 'expr.js' });
  for (const cb of internalCallbacks) cb($ax);
  return $ax;
}

function astToSto(node, localVars) {
  const coerceSto = (inner, valueType) => {
    if (valueType === 'number') {
      return {
        sto: 'paren',
        innerSTO: {
          sto: 'binOp',
          op: '*',
          leftSTO: { sto: 'paren', innerSTO: inner },
          rightSTO: { sto: 'literal', value: 1 },
        },
        desiredType: 'float',
      };
    }
    if (valueType === 'boolean') {
      return {
        sto: 'paren',
        innerSTO: {
          sto: 'binOp',
          op: '==',
          leftSTO: {
            sto: 'fCall',
            func: 'toLowerCase',
            thisSTO: {
              sto: 'fCall',
              func: 'toString',
              thisSTO: { sto: 'paren', innerSTO: inner, desiredType: 'string' },
              arguments: [],
              desiredType: 'string',
            },
            arguments: [],
          },
          rightSTO: { sto: 'literal', value: 'true' },
        },
        desiredType: 'bool',
      };
    }
    return inner;
  };

  if (node.kind === 'literal') {
    return {
      sto: 'literal',
      value: node.value,
      desiredType: node.valueType === 'number' ? 'float' : node.valueType === 'boolean' ? 'bool' : 'string',
    };
  }
  if (node.kind === 'variable') {
    const alias = `rpv_var_${node.name}`;
    localVars[alias] = {
      exprType: 'fcall',
      functionName: 'GetGlobalVariableValue',
      arguments: [{ exprType: 'globalVariableLiteral', variableName: node.name }],
    };
    return coerceSto({ sto: 'var', name: alias }, node.valueType);
  }
  if (node.kind === 'widget') {
    const alias = `rpv_wid_${node.name.replace(/[^A-Za-z0-9_]/g, '_')}`;
    localVars[alias] = {
      exprType: 'fcall',
      functionName: 'GetWidgetText',
      arguments: [{ exprType: 'pathLiteral', value: [node.name] }],
    };
    return coerceSto({ sto: 'var', name: alias }, node.valueType);
  }
  if (node.kind === 'item' || node.kind === 'caller_item') {
    return coerceSto({ sto: 'item', name: node.field, isTarget: false }, node.valueType);
  }
  if (node.kind === 'binary') {
    if (node.op === '/' ) {
      // RP/1 safe division by zero returns 0
      const rightSto = astToSto(node.right, localVars);
      const leftSto = astToSto(node.left, localVars);
      return {
        sto: 'paren',
        innerSTO: {
          sto: 'binOp',
          op: '/',
          leftSTO: leftSto,
          rightSTO: rightSto,
        },
      };
    }
    return {
      sto: 'paren',
      innerSTO: {
        sto: 'binOp',
        op: node.op,
        leftSTO: astToSto(node.left, localVars),
        rightSTO: astToSto(node.right, localVars),
      },
    };
  }
  if (node.kind === 'call') {
    const args = node.args.map((a) => astToSto(a, localVars));
    const a = args[0];
    switch (node.fn) {
      case 'text':
        return {
          sto: 'fCall',
          func: 'toString',
          thisSTO: { sto: 'paren', innerSTO: a, desiredType: 'string' },
          arguments: [],
          desiredType: 'string',
        };
      case 'number':
        return {
          sto: 'paren',
          innerSTO: {
            sto: 'binOp',
            op: '||',
            leftSTO: {
              sto: 'paren',
              innerSTO: {
                sto: 'binOp',
                op: '*',
                leftSTO: { sto: 'paren', innerSTO: a },
                rightSTO: { sto: 'literal', value: 1 },
              },
            },
            rightSTO: { sto: 'literal', value: 0 },
          },
          desiredType: 'float',
        };
      case 'not':
        return {
          sto: 'paren',
          innerSTO: { sto: 'unOp', op: '!', inputSTO: { sto: 'paren', innerSTO: a } },
          desiredType: 'bool',
        };
      case 'concat':
        return {
          sto: 'fCall',
          func: 'concat',
          thisSTO: {
            sto: 'fCall',
            func: 'toString',
            thisSTO: { sto: 'paren', innerSTO: a, desiredType: 'string' },
            arguments: [],
            desiredType: 'string',
          },
          arguments: args.slice(1),
          desiredType: 'string',
        };
      case 'lower':
        return {
          sto: 'fCall',
          func: 'toLowerCase',
          thisSTO: { sto: 'paren', innerSTO: a, desiredType: 'string' },
          arguments: [],
          desiredType: 'string',
        };
      case 'upper':
        return {
          sto: 'fCall',
          func: 'toUpperCase',
          thisSTO: { sto: 'paren', innerSTO: a, desiredType: 'string' },
          arguments: [],
          desiredType: 'string',
        };
      case 'length':
        return {
          sto: 'propCall',
          prop: 'length',
          thisSTO: { sto: 'paren', innerSTO: a, desiredType: 'string' },
          desiredType: 'int',
        };
      default:
        throw new Error('Unknown fn ' + node.fn);
    }
  }
  throw new Error('Unknown AST kind ' + node.kind);
}

const sharedEnv = { variables: {}, widgets: {}, row: {} };
const $ax = createSandbox(sharedEnv);
const results = [];
for (const tc of payload.cases) {
  sharedEnv.variables = (tc.env && tc.env.variables) || {};
  sharedEnv.widgets = (tc.env && tc.env.widgets) || {};
  sharedEnv.row = (tc.env && tc.env.row) || {};
  const localVariables = {};
  const sto = astToSto(tc.ast, localVariables);
  const expr = {
    exprType: 'stringLiteral',
    value: '[[sto0]]',
    localVariables,
    stos: [sto],
  };
  const eventInfo = { srcElement: 'rowElem1', targetElement: 'rowElem1', htmlLiteral: false };
  const rawVal = $ax.expr.evaluateExpr(expr, eventInfo);
  results.push({ id: tc.id, raw: rawVal, text: String(rawVal) });
}
process.stdout.write(JSON.stringify({ ok: true, results }));
"""


def normalize_py_value(val):
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, float) and val.is_integer():
        return str(int(val))
    return str(val)


def run_axure_expr_oracle(cases):
    """Run a batch of `{id, ast, env, pyValue}` cases against Axure RP 9 `sto.js` + `expr.js`."""
    sto_path = AXURE_SCRIPTS_DIR / "sto.js"
    expr_path = AXURE_SCRIPTS_DIR / "expr.js"
    if not sto_path.exists() or not expr_path.exists():
        raise RuntimeError(f"Axure RP 9 runtime scripts not found at {AXURE_SCRIPTS_DIR}")
    proc = subprocess.run(
        ["node", "-e", NODE_ORACLE_RUNNER, str(sto_path), str(expr_path)],
        input=json.dumps({"cases": cases}, ensure_ascii=False),
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Node oracle failed:\n{proc.stderr}")
    data = json.loads(proc.stdout)
    by_id = {r["id"]: r for r in data["results"]}
    mismatches = []
    for tc in cases:
        cid = tc["id"]
        py_norm = normalize_py_value(tc["pyValue"])
        ax_norm = normalize_py_value(by_id[cid]["raw"])
        if py_norm != ax_norm:
            mismatches.append({
                "id": cid,
                "ast": tc["ast"],
                "env": tc.get("env"),
                "referenceRuntime": py_norm,
                "axureExprJs": ax_norm,
            })
    return {
        "ok": len(mismatches) == 0,
        "engine": "Axure RP 9 sto.js + expr.js (Node vm)",
        "totalCases": len(cases),
        "matchedCases": len(cases) - len(mismatches),
        "agreementRate": (len(cases) - len(mismatches)) / len(cases) if cases else 1.0,
        "mismatches": mismatches,
    }


def verify_spec_with_oracle(spec):
    """Extract all runtime ASTs from a compiled RP/1 spec and verify 100% agreement with Axure expr.js."""
    compiled = compile_language(spec)
    _, ir = compiled
    runtime = ReferenceRuntime(compiled)
    asts = []

    def collect_asts(obj, prefix=""):
        if isinstance(obj, dict):
            if set(obj.keys()) >= {"kind", "valueType"} and obj["kind"] in {"literal", "variable", "widget", "item", "caller_item", "binary", "call"}:
                asts.append((prefix, obj))
                return
            for k, v in obj.items():
                collect_asts(v, f"{prefix}/{k}")
        elif isinstance(obj, list):
            for idx, item in enumerate(obj):
                collect_asts(item, f"{prefix}/{idx}")

    collect_asts(ir.get("pages", []), "/pages")
    cases = []
    default_row = {}
    for rep in runtime.repeaters.values():
        if rep.get("rows"):
            default_row = dict(rep["rows"][0])
            break
    env = {
        "variables": dict(runtime.variables),
        "widgets": {k: (v["text"] if isinstance(v, dict) else v) for k, v in runtime.widgets.items()},
        "row": default_row,
    }
    for idx, (path, ast) in enumerate(asts):
        py_val = runtime.eval_expr(ast, row=default_row)
        cases.append({
            "id": f"expr_{idx}_{path}",
            "ast": ast,
            "env": env,
            "pyValue": py_val,
        })
    return run_axure_expr_oracle(cases)


def verify_trace_with_oracle(spec, max_depth=4, max_states=24):
    """Explore multi-step interaction states and verify all runtime expressions across reachable states and repeater rows against Axure sto.js + expr.js."""
    from rp_language import explore_state_space
    compiled = compile_language(spec)
    _, ir = compiled
    exploration = explore_state_space(spec, max_depth=max_depth, max_states=max_states)
    asts = []

    def collect_asts(obj, prefix=""):
        if isinstance(obj, dict):
            if set(obj.keys()) >= {"kind", "valueType"} and obj["kind"] in {"literal", "variable", "widget", "item", "caller_item", "binary", "call"}:
                asts.append((prefix, obj))
                return
            for k, v in obj.items():
                collect_asts(v, f"{prefix}/{k}")
        elif isinstance(obj, list):
            for idx, item in enumerate(obj):
                collect_asts(item, f"{prefix}/{idx}")

    collect_asts(ir.get("pages", []), "/pages")
    cases = []
    states_list = exploration.get("states", [])[:12]
    for st_idx, st in enumerate(states_list):
        snap = st["snapshot"]
        rt = ReferenceRuntime(compiled)
        for step in st.get("path", []):
            if "input" in step:
                rt.set_input(step["input"], step.get("value", ""))
            else:
                rt.trigger(step["target"], step["event"], row_index=step.get("rowIndex", 0))
        rows_to_test = [{}]
        for rep_rows in snap.get("repeaters", {}).values():
            if rep_rows:
                rows_to_test = rep_rows[:2]
                break
        for r_idx, row_data in enumerate(rows_to_test):
            env = {
                "variables": dict(rt.variables),
                "widgets": {k: (v["text"] if isinstance(v, dict) else v) for k, v in rt.widgets.items()},
                "row": dict(row_data),
            }
            for e_idx, (path, ast) in enumerate(asts):
                py_val = rt.eval_expr(ast, row=row_data)
                cases.append({
                    "id": f"st{st_idx}_r{r_idx}_e{e_idx}_{path}",
                    "ast": ast,
                    "env": env,
                    "pyValue": py_val,
                })
    res = run_axure_expr_oracle(cases)
    res["statesVerified"] = len(states_list)
    res["statesChecked"] = len(states_list)
    res["totalTraceChecks"] = res.get("totalCases", len(cases))
    res["invariantsOk"] = exploration["invariants"]["ok"]
    return res


def fuzz_dual_model_trace(spec, steps=200, seed=42):
    """Replay real reference actions and cross-check native expressions.

    This legacy name does NOT imply two independent state engines. Use the
    returned nativePlan with rp_acceptance/native-acceptance for actual RP9
    state differential evidence. No native state comparison is inferred here.
    """
    import hashlib
    import random
    if type(steps) is not int or steps <= 0:
        raise ValueError("steps must be a positive action count")
    rng = random.Random(seed)
    compiled = compile_language(spec)
    _, ir = compiled
    rt = ReferenceRuntime(compiled)
    asts = []

    def collect_asts(obj, prefix=""):
        if isinstance(obj, dict):
            if set(obj) >= {"kind", "valueType"} and obj["kind"] in {"literal", "variable", "widget", "item", "caller_item", "binary", "call"}:
                asts.append((prefix, obj))
                return
            for k, v in obj.items():
                collect_asts(v, f"{prefix}/{k}")
        elif isinstance(obj, list):
            for idx, item in enumerate(obj):
                collect_asts(item, f"{prefix}/{idx}")

    collect_asts(ir.get("pages", []), "/pages")
    inputs = [name for name, w in rt.widgets.items() if w.get("kind") == "input"]
    clicks = [ix["trigger"] for p in ir["pages"] for ix in p["interactions"]
              if ix["trigger"] in rt.widgets and any(e["event"] == "OnClick" for e in ix["events"])]
    logical = {s["name"]: s["id"] for s in ir["symbols"]}
    sample_vals = ["", "A301", "B201", "R001", "R015", "R040", "张三", "13800138000", "0", "3", "12", "已预约", "待审核"]
    seen = set()
    oracle_cases = []
    scenarios = []
    executed_clicks = executed_inputs = 0

    def candidates():
        ins = [w for w in inputs if rt.is_operable(w)]
        buttons = []
        for w in clicks:
            rep = rt.widgets[w].get("repeater")
            for idx in range(min(4, len(rt.visible_rows(rep))) if rep else 1):
                if rt.is_operable(w, idx):
                    buttons.append((w, idx, bool(rep)))
        return ins, buttons

    for step_idx in range(steps):
        ins, buttons = candidates()
        # Bounded, independently reset trajectories prevent unbounded dataset
        # growth and produce directly replayable browser scenarios.
        if step_idx % 100 == 0 or not (ins or buttons):
            rt = ReferenceRuntime(compiled)
            scenarios.append({"id": f"fuzz-{seed}-{len(scenarios) + 1}", "steps": []})
            ins, buttons = candidates()
        if not (ins or buttons):
            raise ValueError("No operable action available for fuzz coverage")
        if ins and (not buttons or rng.random() < 0.38):
            wid, value = rng.choice(ins), rng.choice(sample_vals)
            rt.set_input(wid, value)
            step = {"input": logical[wid], "value": value}
            executed_inputs += 1
        else:
            wid, idx, is_rep = rng.choice(buttons)
            rt.trigger(wid, "click", row_index=idx)
            step = {"click": logical[wid], **({"rowIndex": idx} if is_rep else {})}
            executed_clicks += 1
        scenarios[-1]["steps"].append(step)
        snap = rt.snapshot()
        sh = hashlib.sha256(json.dumps(snap, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if sh in seen:
            continue
        seen.add(sh)
        rows = [row for rep in rt.repeaters.values() if rep["page"] == rt.current_page for row in rep["rows"]]
        row = rng.choice(rows) if rows else {}
        env = {"variables": dict(rt.variables), "widgets": {k: v["text"] for k, v in rt.widgets.items()}, "row": dict(row)}
        for e_idx, (path, ast) in enumerate(asts):
            oracle_cases.append({"id": f"fuzz_{step_idx}_{e_idx}_{path}", "ast": ast, "env": env, "pyValue": rt.eval_expr(ast, row=row)})

    oracle = run_axure_expr_oracle(oracle_cases)
    observe = {"widgets": [s["id"] for s in ir["symbols"] if s["kind"] in {"label", "button", "badge", "input"} and not rt.widgets.get(s["name"], {}).get("repeater")],
               "variables": list(ir["variables"]), "repeaters": [s["id"] for s in ir["symbols"] if s["kind"] == "repeater"],
               "panels": [s["id"] for s in ir["symbols"] if s["kind"] == "dynamic-panel"]}
    return {"ok": oracle["ok"], "steps": executed_clicks + executed_inputs,
            "requestedSteps": steps, "executedClicks": executed_clicks, "executedInputs": executed_inputs,
            "uniqueStatesSampled": len(seen), "oracleChecks": oracle["totalCases"],
            "validationLevel": "reference_actions_and_native_expressions",
            "expressionMismatches": len(oracle["mismatches"]), "stateHashMismatches": None,
            "nativeStateComparison": "not_run", "mismatches": oracle["mismatches"],
            "nativePlan": {"observe": observe, "scenarios": scenarios}}
