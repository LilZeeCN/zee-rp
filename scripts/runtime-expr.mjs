import { field } from './parse-payload.mjs';

// The frontend owns types and syntax; the backend owns native identities/scopes.
// No source expression string is accepted at this interface.
export function nativeRuntimeValue(ast, ctx, { targetRows = false } = {}) {
  const { obj, newGuid, str, list, ref, dict, bool, nullId, graph, findWidget, globalVariableInfo, pathTo } = ctx;
  if (ast.kind === 'viewport-width') {
    return obj(newGuid(), 'Axure:Expr:StringLiteral', {
      value: str('[[Window.width]]'), 'variable-identifiers': list([]), scope: dict([]),
      'repeater-scope': ref(nullId), TargetRepeaterScope: ref(nullId),
    });
  }
  if (ast.kind === 'aggregate-scan') {
    // A native rule visits every dataset row, including filtered/paginated rows.
    // Its local variables accumulate totals; the rule itself is ALWAYS false,
    // so the enclosing dataset action never deletes or changes a record.
    const locals = ast.aggregates.map((aggregate, index) => {
      const info = globalVariableInfo(aggregate.name);
      const variable = obj(newGuid(), 'Axure:Expr:GlobalVariableLiteral', {
        value: { tag: 17, value: info.pageGuidIndex }, 'is-dummy': bool(false), 'variable-name': str(aggregate.name),
      });
      const value = nativeRuntimeValue({ kind: 'binary', op: '+', valueType: 'number',
        left: { kind: 'variable', name: aggregate.name, valueType: 'number' }, right: aggregate.valAst }, ctx, { targetRows: true });
      const setter = obj(newGuid(), 'Axure:Expr:FCall', {
        'function-name': str('SetGlobalVariableValue'), args: list([ref(variable.id), ref(value.id)]),
      });
      // SetGlobalVariableValue returns undefined. Compare it first so Axure's
      // boolean short circuit never calls getBool(undefined).
      const falseResult = obj(newGuid(), 'Axure:Expr:BinaryExpr', {
        'left-expr': ref(setter.id),
        'right-expr': ref(nativeRuntimeValue({ kind: 'literal', value: true, valueType: 'boolean' }, ctx).id),
        operation: { tag: 5, value: 3 },
      });
      const conditional = aggregate.whereAst ? obj(newGuid(), 'Axure:Expr:BinaryExpr', {
        'left-expr': ref(nativeRuntimeValue(aggregate.whereAst, ctx, { targetRows: true }).id),
        'right-expr': ref(falseResult.id), operation: { tag: 5, value: 1 },
      }) : falseResult;
      return [str(`rp1_sum${index}`), ref(conditional.id)];
    });
    return obj(newGuid(), 'Axure:Expr:StringLiteral', {
      value: str('[[false]]'), 'variable-identifiers': list([]), scope: dict(locals),
      'repeater-scope': ref(nullId), TargetRepeaterScope: ref(nullId),
    });
  }
  if (ast.kind === 'selection-scan') {
    // Visits every repeater row at runtime; when whereAst matches the selected key,
    // writes the row's field values into global selection slots while returning false
    // so the host repeater action never mutates or deletes any row.
    const locals = (ast.assignments || []).map((assign, index) => {
      const info = globalVariableInfo(assign.variable);
      const variable = obj(newGuid(), 'Axure:Expr:GlobalVariableLiteral', {
        value: { tag: 17, value: info.pageGuidIndex }, 'is-dummy': bool(false), 'variable-name': str(assign.variable),
      });
      const value = nativeRuntimeValue(assign.valAst, ctx, { targetRows: true });
      const setter = obj(newGuid(), 'Axure:Expr:FCall', {
        'function-name': str('SetGlobalVariableValue'), args: list([ref(variable.id), ref(value.id)]),
      });
      const falseResult = obj(newGuid(), 'Axure:Expr:BinaryExpr', {
        'left-expr': ref(setter.id),
        'right-expr': ref(nativeRuntimeValue({ kind: 'literal', value: true, valueType: 'boolean' }, ctx).id),
        operation: { tag: 5, value: 3 },
      });
      const conditional = assign.whereAst ? obj(newGuid(), 'Axure:Expr:BinaryExpr', {
        'left-expr': ref(nativeRuntimeValue(assign.whereAst, ctx, { targetRows: true }).id),
        'right-expr': ref(falseResult.id), operation: { tag: 5, value: 1 },
      }) : falseResult;
      return [str(`rp1_sel${index}`), ref(conditional.id)];
    });
    return obj(newGuid(), 'Axure:Expr:StringLiteral', {
      value: str('[[false]]'), 'variable-identifiers': list([]), scope: dict(locals),
      'repeater-scope': ref(nullId), TargetRepeaterScope: ref(nullId),
    });
  }
  const scope = [], identifiers = [], reads = new Map();
  let dataId = null;
  const quote = value => {
    if (typeof value === 'string' && /[\[\]]/.test(value) && !/(\[\[|\]\])/.test(value)) {
      const key = `str:${value}`;
      if (reads.has(key)) return reads.get(key);
      const alias = `rps${reads.size}`;
      const lit = obj(newGuid(), 'Axure:Expr:StringLiteral', {
        value: str(value), 'variable-identifiers': list([]), scope: dict([]),
        'repeater-scope': ref(nullId), TargetRepeaterScope: ref(nullId),
      });
      scope.push([str(alias), ref(lit.id)]);
      reads.set(key, alias);
      return alias;
    }
    return JSON.stringify(value).replace(/[\[\]\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
  };
  const coerce = (expression, type) => type === 'number' ? `((${expression})*1)` : type === 'boolean' ? `((${expression}).toString().toLowerCase()=='true')` : expression;
  const render = node => {
    if (node.kind === 'literal') return quote(node.value);
    if (node.kind === 'binary') return `(${render(node.left)} ${node.op} ${render(node.right)})`;
    if (node.kind === 'call') {
      const args = node.args.map(render), a = args[0];
      switch (node.fn) {
        case 'text': return `((${a}).toString())`;
        case 'number': return `(((${a})*1)||0)`;
        case 'not': return `(!(${a}))`;
        case 'concat': return `((${a}).toString().concat(${args.slice(1).join(',')}))`;
        case 'lower': return `(${a}).toLowerCase()`;
        case 'upper': return `(${a}).toUpperCase()`;
        case 'length': return `(${a}).length`;
        case 'contains': return `((${a}).indexOf(${args[1]})>=0)`;
        case 'remove': return `(${a}).replace(${args[1]},"")`;
        default: throw new Error(`Unknown runtime function ${node.fn}`);
      }
    }
    if (node.kind === 'item') {
      const rep = findWidget(node.repeater);
      const data = graph.objects.get(field(rep.body,'Data')?.value);
      if (rep.sourceGraph || !data) throw new Error('Repeater expressions require their owning native record');
      if (dataId !== null && dataId !== data.id) throw new Error('Cannot mix Repeater row scopes');
      dataId = data.id;
      const column = (field(data.body,'columns')?.items ?? []).map(r=>graph.objects.get(r.value)).find(c=>field(c.body,'name')?.text===node.field);
      if (!column) throw new Error(`Unknown native row field ${node.field}`);
      identifiers.push({ id:field(column.body,'variable-id').value, name:`${targetRows?'TargetTargetItem':'Item'}.${node.field}`, target:targetRows });
      return coerce(`${targetRows?'TargetItem':'Item'}.${node.field}`,node.valueType);
    }
    if (node.kind !== 'variable' && node.kind !== 'widget') throw new Error(`Unknown runtime value ${node.kind}`);
    const key = `${node.kind}:${node.name}`;
    if (reads.has(key)) return coerce(reads.get(key),node.valueType);
    const alias = `rpv${reads.size}`;
    let read;
    if (node.kind === 'variable') {
      const info = globalVariableInfo(node.name);
      const variable = obj(newGuid(),'Axure:Expr:GlobalVariableLiteral', {
        value:{tag:17,value:info.pageGuidIndex}, 'is-dummy':bool(false), 'variable-name':str(node.name),
      });
      read = obj(newGuid(),'Axure:Expr:FCall',{'function-name':str('GetGlobalVariableValue'),args:list([ref(variable.id)])});
      identifiers.push({id:info.pageGuidIndex,name:alias,target:false});
    } else {
      const path = pathTo(findWidget(node.name).id);
      const literal = obj(newGuid(),'Axure:Expr:DiagramObjectPathLiteral',{value:ref(path.id)});
      read = obj(newGuid(),'Axure:Expr:FCall',{'function-name':str('GetWidgetText'),args:list([ref(literal.id)])});
    }
    scope.push([str(alias),ref(read.id)]); reads.set(key,alias);
    return coerce(alias,node.valueType);
  };
  const expression = render(ast);
  const value = obj(newGuid(),'Axure:Expr:StringLiteral',{
    value:str(`[[${expression}]]`), 'variable-identifiers':list([]), scope:dict(scope),
    'repeater-scope':ref(!targetRows && dataId!==null?dataId:nullId), TargetRepeaterScope:ref(targetRows && dataId!==null?dataId:nullId),
  });
  field(value.body,'variable-identifiers').items = identifiers.map(info=>ref(obj(newGuid(),'Axure:Expr:TextVariableIdentifier',{
    Id:{tag:17,value:info.id},Name:str(info.name),Expr:ref(value.id),TargetOverride:bool(info.target),
  }).id));
  return value;
}
