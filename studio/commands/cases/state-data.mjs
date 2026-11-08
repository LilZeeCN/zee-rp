// 数据与状态命令 case(setToken/setTokens/setVariable/datasetOp/setPanelActiveState/setFont/repeaterSetFilter/repeaterSetSort)。
// 从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import { assertKnownNodeEffects } from '../../node-capabilities.mjs';
import { validateComponentInstanceAgainstContract } from '../../component-contracts.mjs';
import { cmdError, validatePropertiesObject, resolveTargetOrSubnode, defineRecordEntry } from '../helpers.mjs';

function setToken({ doc, cmd, cmdIdx, affectedIds }) {
      const cat = cmd.category || 'color';
      const name = String(cmd.name || '').replace(/^\$/, '');
      if (!name) {
        throw cmdError('E_INVALID_TOKEN', `setToken 需要提供有效的令牌名称 name`, { commandIndex: cmdIdx, field: 'name' });
      }
      if (cat === 'color' || cat === 'colors') {
        if (typeof cmd.value !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(cmd.value)) {
          throw cmdError('E_INVALID_COLOR', `颜色令牌 "${name}" 的值 "${cmd.value}" 必须是 #RRGGBB 或 #RRGGBBAA`, { commandIndex: cmdIdx, field: 'value' });
        }
        doc.palette = doc.palette || {};
        defineRecordEntry(doc.palette ||= {}, name, cmd.value);
        doc.tokens = doc.tokens || {};
        doc.tokens.colors = doc.tokens.colors || {};
        defineRecordEntry(doc.tokens.colors, name, cmd.value);
      } else {
        doc.tokens = doc.tokens || {};
        defineRecordEntry(doc.tokens, name, cmd.value);
      }
      affectedIds.push(`token:${cat}:${name}`);
}

function setTokens({ doc, cmd, cmdIdx, affectedIds }) {
      const tokensObj = cmd.tokens || cmd.values || (cmd.colors ? { colors: cmd.colors } : {});
      doc.palette = doc.palette || {};
      doc.tokens = doc.tokens || { colors: {} };
      doc.tokens.colors = doc.tokens.colors || {};
      const applyColor = (rawName, val) => {
        const name = String(rawName || '').replace(/^\$/, '');
        if (!name || typeof val !== 'string') return;
        if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(val)) {
          throw cmdError('E_INVALID_COLOR', `颜色令牌 "${name}" 的值 "${val}" 必须是 #RRGGBB 或 #RRGGBBAA`, { commandIndex: cmdIdx, field: name });
        }
        defineRecordEntry(doc.palette, name, val);
        defineRecordEntry(doc.tokens.colors, name, val);
        affectedIds.push(`token:color:${name}`);
      };
      if (tokensObj.colors && typeof tokensObj.colors === 'object') {
        for (const [k, v] of Object.entries(tokensObj.colors)) applyColor(k, v);
      }
      for (const [k, v] of Object.entries(tokensObj)) {
        if (k === 'colors') continue;
        if (typeof v === 'string' && v.startsWith('#')) {
          applyColor(k, v);
        } else {
          defineRecordEntry(doc.tokens, k, v);
          affectedIds.push(`token:general:${k}`);
        }
      }
}

function setVariable({ doc, cmd, cmdIdx, affectedIds }) {
      doc.variables = doc.variables || {};
      const name = String(cmd.name || cmd.variable || '').trim();
      if (!name) {
        throw cmdError('E_INVALID_VARIABLE', `setVariable 需要提供变量名称 name`, { commandIndex: cmdIdx, field: 'name' });
      }
      defineRecordEntry(doc.variables ||= {}, name, cmd.value);
      affectedIds.push(`variable:${name}`);
}

function datasetOp({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const op = cmd.op || cmd.operation || 'add';
      if(op==='filter') throw cmdError('E_DATASET_FILTER_UNSUPPORTED','datasetOp.filter没有运行态消费；筛选repeater请用repeaterSetFilter，运行中筛选请用dataset-filter交互',{commandIndex:cmdIdx,field:'op'});
      if(op==='sort' && !cmd.sort?.field && !cmd.field) throw cmdError('E_SORT_FIELD','排序需要field或sort.field',{commandIndex:cmdIdx,field:'sort'});
      let rows,writeRows;
      const bindDataset=name=>{
        doc.datasets=doc.datasets||{};defineRecordEntry(doc.datasets,name,doc.datasets[name]||{columns:[],rows:[]});
        const dataset=doc.datasets[name];
        rows=Array.isArray(dataset)?dataset:Array.isArray(dataset.rows)?dataset.rows:[];
        writeRows=value=>{if(Array.isArray(dataset))defineRecordEntry(doc.datasets,name,value);else dataset.rows=value;};
        affectedIds.push(`dataset:${name}`);
      };
      if(cmd.dataset)bindDataset(cmd.dataset);
      else{
        const target=resolveTargetOrSubnode(doc,index,cmd.nodeId||cmd.targetId,pageScope,cmdIdx);
        const {node,scopedId}=target.entry||target.instanceEntry;
        if(node.type!=='repeater')throw cmdError('E_REPEATER_REQUIRED','按节点修改数据需要repeater；其他数据集请明确dataset',{commandIndex:cmdIdx,nodeId:cmd.nodeId||cmd.targetId});
        const datasetName=node.dataset||node.source;
        if(datasetName&&doc.datasets?.[datasetName])bindDataset(datasetName);
        else{rows=Array.isArray(node.rows)?node.rows:[];writeRows=value=>{node.rows=value;};}
        affectedIds.push(scopedId);
      }
      let next=structuredClone(rows);
      if(op==='add')next.push(structuredClone(cmd.row||cmd.item||{}));
      else if(op==='replace-all')next=structuredClone(cmd.rows||[]);
      else if(op==='update'){
        const key=cmd.matchKey||'id';
        for(const row of next)if(cmd.matchValue===undefined||String(row[key])===String(cmd.matchValue)){const patch=structuredClone(cmd.patch||cmd.row||{});for(const [pk,pv] of Object.entries(patch))defineRecordEntry(row,pk,pv);}
      }else if(op==='delete'){
        const key=cmd.matchKey||'id';next=next.filter(row=>String(row[key])!==String(cmd.matchValue));
      }else if(op==='sort'){
        const field=cmd.sort?.field||cmd.field,dir=(cmd.sort?.direction||cmd.direction)==='desc'?-1:1;
        next.sort((a,b)=>a[field]>b[field]?dir:a[field]<b[field]?-dir:0);
      }
      writeRows(next);
}

function setPanelActiveState({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, scopedId } = entry;
      if (node.type !== 'dynamic-panel' || !Array.isArray(node.states)) {
        throw cmdError('E_NOT_DYNAMIC_PANEL', `节点 "${node.id}" 不是动态面板`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const nextStateId = cmd.stateId || cmd.state || cmd.activeState;
      if (!nextStateId || !node.states.some(s => s.id === nextStateId)) {
        throw cmdError('E_UNKNOWN_PANEL_STATE', `动态面板 "${node.id}" 不存在状态 "${nextStateId}"`, {
          commandIndex: cmdIdx,
          nodeId: cmd.nodeId,
          field: 'stateId',
        });
      }
      node.activeState = nextStateId;
      affectedIds.push(scopedId);
}

function setFont({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      doc.fonts = doc.fonts || { defaultFamily: 'PingFang SC', headingFamily: 'PingFang SC', catalog: [] };
      if (cmd.defaultFamily) doc.fonts.defaultFamily = cmd.defaultFamily;
      if (cmd.headingFamily) doc.fonts.headingFamily = cmd.headingFamily;
      if (cmd.addFont && typeof cmd.addFont === 'object') {
        doc.fonts.catalog = doc.fonts.catalog || [];
        const existingIdx = doc.fonts.catalog.findIndex(f => f.family === cmd.addFont.family);
        if (existingIdx >= 0) doc.fonts.catalog[existingIdx] = structuredClone(cmd.addFont);
        else doc.fonts.catalog.push(structuredClone(cmd.addFont));
      }
      if (cmd.nodeId) {
        const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
        const fontProps = {};
        for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'italic', 'underline', 'align', 'color']) {
          if (cmd[k] !== undefined) fontProps[k] = cmd[k];
        }
        if (Object.keys(fontProps).length > 0) {
          validatePropertiesObject(fontProps, cmd.nodeId, cmdIdx);
        }
        if (targetInfo.isInstanceSubnode) {
          const inst = targetInfo.instanceEntry.node;
          if (inst.locked) {
            throw cmdError('E_NODE_LOCKED', `实例 "${inst.id}" 已锁定，无法修改字体`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
          }
          inst.overrides = inst.overrides || {};
          inst.overrides[targetInfo.subNodeId] = {
            ...(inst.overrides[targetInfo.subNodeId] || {}),
            ...fontProps,
          };
          validateComponentInstanceAgainstContract(inst, doc, { strict: true });
          affectedIds.push(targetInfo.instanceEntry.scopedId);
        } else {
          if (targetInfo.entry.node.locked) {
            throw cmdError('E_NODE_LOCKED', `节点 "${targetInfo.entry.node.id}" 已锁定，无法修改字体`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
          }
          assertKnownNodeEffects(targetInfo.entry.node,fontProps,{commandIndex:cmdIdx,nodeId:targetInfo.entry.scopedId});
          Object.assign(targetInfo.entry.node, fontProps);
          affectedIds.push(targetInfo.entry.scopedId);
        }
      } else {
        affectedIds.push('fonts');
      }
}

function repeaterSetFilterOrSort({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const target = resolveTargetOrSubnode(doc, index, cmd.nodeId || cmd.repeaterId || cmd.id, pageScope, cmdIdx);
      const node = target.entry.node;
      if (!node || node.type !== 'repeater') {
        throw cmdError('E_REPEATER_REQUIRED', `repeaterSetFilter 需要指向一个 repeater 节点，收到 ${node?.type || 'null'}`, {
          commandIndex: cmdIdx, field: 'nodeId',
        });
      }
      if (cmd.type === 'repeaterSetFilter') {
        if (cmd.clear === true || cmd.filter === null) {
          delete node.filter;
        } else {
          const filter = typeof cmd.filter === 'object' && cmd.filter ? cmd.filter : { field: cmd.field, equals: cmd.value, in: cmd.values };
          if (!filter.field || typeof filter.field !== 'string') {
            throw cmdError('E_FILTER_SHAPE', '过滤器需要 field（字段名）；可选 equals / in 之一', {
              commandIndex: cmdIdx, field: 'filter',
              expected: { field: 'status', equals: '已支付' },
            });
          }
          const hasEquals = filter.equals !== undefined;
          const hasIn = Array.isArray(filter.in);
          if (!hasEquals && !hasIn) {
            throw cmdError('E_FILTER_SHAPE', '过滤器需要 equals 或 in 中的至少一个', { commandIndex: cmdIdx, field: 'filter' });
          }
          node.filter = hasIn
            ? { field: filter.field, in: filter.in.map(String) }
            : { field: filter.field, equals: String(filter.equals) };
        }
      } else {
        if (cmd.clear === true || cmd.sort === null) {
          delete node.sort;
        } else {
          const sort = typeof cmd.sort === 'object' && cmd.sort ? cmd.sort : { field: cmd.field, direction: cmd.direction };
          if (!sort.field) throw cmdError('E_FILTER_SHAPE', '排序需要 field（字段名）', { commandIndex: cmdIdx, field: 'sort' });
          node.sort = { field: String(sort.field), direction: sort.direction === 'desc' ? 'desc' : 'asc' };
        }
      }
      affectedIds.push(`${pageScope}/${node.id}`);
}

export const handlers = {
  setToken,
  'set-tokens': setTokens,
  setTokens,
  'set-variable': setVariable,
  setVariable,
  'dataset-op': datasetOp,
  datasetOp,
  setPanelActiveState,
  setFont,
  repeaterSetFilter: repeaterSetFilterOrSort,
  repeaterSetSort: repeaterSetFilterOrSort,
};
