// 矢量路径命令 case(editPath/booleanPathOp)。从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import {
  normalizeVectorNodeSpec,
  bakeVectorTransform,
  parseSvgPathD,
  parseSvgMarkup,
  subpathsToSvgD,
  booleanVectorPaths,
  computeVectorBounds,
} from '../../vector-paths.mjs';
import { cmdError, resolveTargetOrSubnode } from '../helpers.mjs';

function editPath({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const isSub = targetInfo.isInstanceSubnode;
      const inst = isSub ? targetInfo.instanceEntry.node : null;
      const entry = isSub ? targetInfo.instanceEntry : targetInfo.entry;
      const targetNode = isSub
        ? (() => {
            const comp = doc.components?.[inst.component];
            const findSub = n => {
              if (!n) return null;
              if (n.id === targetInfo.subNodeId) return n;
              for (const ch of n.children || []) {
                const found = findSub(ch);
                if (found) return found;
              }
              return null;
            };
            const baseSub = findSub(comp?.root);
            if (!baseSub) throw cmdError('E_NODE_NOT_FOUND', `未找到实例子节点 "${cmd.nodeId}"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
            return { ...structuredClone(baseSub), ...(inst.overrides?.[targetInfo.subNodeId] || {}) };
          })()
        : entry.node;

      if ((isSub && inst.locked) || (!isSub && targetNode.locked)) {
        throw cmdError('E_NODE_LOCKED', `节点 "${cmd.nodeId}" 已锁定，无法编辑路径`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      if (targetNode.type !== 'path') {
        throw cmdError('E_INVALID_NODE_TYPE', `editPath 仅适用于 path 矢量节点，当前节点 "${cmd.nodeId}" 类型为 "${targetNode.type}"`, {
          commandIndex: cmdIdx,
          nodeId: cmd.nodeId,
          field: 'nodeId',
        });
      }

      let spec;
      try {
        spec = normalizeVectorNodeSpec(targetNode);
      } catch (err) {
        throw cmdError(err.code || 'E_INVALID_VECTOR', err.message, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }

      let subpaths = structuredClone(spec.subpaths || []);
      let fillRule = cmd.fillRule || spec.fillRule || 'nonzero';
      let strokeLinecap = cmd.strokeLinecap || spec.strokeLinecap || 'round';
      let strokeLinejoin = cmd.strokeLinejoin || spec.strokeLinejoin || 'round';
      let strokeDasharray = cmd.strokeDasharray !== undefined ? cmd.strokeDasharray : spec.strokeDasharray;
      let transform = cmd.transform !== undefined ? cmd.transform : spec.transform;

      const op = cmd.operation || (
        cmd.svg ? 'import-svg' :
        cmd.d || cmd.subpaths || cmd.points ? 'set-subpaths' :
        cmd.bakeTransform ? 'bake-transform' :
        cmd.dx !== undefined || cmd.dy !== undefined ? 'move-point' :
        cmd.pointIndex !== undefined && (cmd.x !== undefined || cmd.y !== undefined || cmd.point) ? 'set-point' :
        'set-subpaths'
      );

      if (op === 'import-svg' || typeof cmd.svg === 'string') {
        const parsedSvg = parseSvgMarkup(cmd.svg || cmd.d || '');
        subpaths = parsedSvg.subpaths;
        if (parsedSvg.fillRule && !cmd.fillRule) fillRule = parsedSvg.fillRule;
        if (parsedSvg.strokeLinecap && !cmd.strokeLinecap) strokeLinecap = parsedSvg.strokeLinecap;
        if (parsedSvg.strokeLinejoin && !cmd.strokeLinejoin) strokeLinejoin = parsedSvg.strokeLinejoin;
        if (parsedSvg.strokeDasharray && cmd.strokeDasharray === undefined) strokeDasharray = parsedSvg.strokeDasharray;
        if (!isSub) {
          if (parsedSvg.extractedFill && !targetNode.fill) targetNode.fill = parsedSvg.extractedFill;
          if (parsedSvg.extractedStroke && !targetNode.stroke) targetNode.stroke = parsedSvg.extractedStroke;
          if (parsedSvg.extractedStrokeWidth !== null && targetNode.strokeWidth === undefined) {
            targetNode.strokeWidth = parsedSvg.extractedStrokeWidth;
          }
        }
      } else if (op === 'set-subpaths') {
        if (typeof cmd.d === 'string') {
          subpaths = parseSvgPathD(cmd.d);
        } else if (Array.isArray(cmd.subpaths)) {
          subpaths = normalizeVectorNodeSpec({ points: { subpaths: cmd.subpaths, fillRule } }).subpaths;
        } else if (cmd.points !== undefined) {
          const nextSpec = normalizeVectorNodeSpec({ points: cmd.points, w: targetNode.w, h: targetNode.h, smooth: cmd.smooth ?? targetNode.smooth });
          subpaths = nextSpec.subpaths;
          if (nextSpec.fillRule && !cmd.fillRule) fillRule = nextSpec.fillRule;
        }
      } else if (op === 'set-point' || op === 'move-point') {
        const sIdx = cmd.subpathIndex ?? 0;
        const pIdx = cmd.pointIndex ?? 0;
        const sp = subpaths[sIdx];
        if (!sp || !sp.points?.[pIdx]) {
          throw cmdError('E_VECTOR_POINT_RANGE', `控制点索引越界: subpathIndex=${sIdx}, pointIndex=${pIdx}`, {
            commandIndex: cmdIdx,
            nodeId: cmd.nodeId,
          });
        }
        const pt = sp.points[pIdx];
        const handle = cmd.handle || 'anchor';
        if (cmd.point && typeof cmd.point === 'object') {
          sp.points[pIdx] = normalizeVectorNodeSpec({ points: { subpaths: [{ closed: sp.closed, points: [cmd.point] }] } }).subpaths[0].points[0];
        } else if (handle === 'anchor') {
          const nx = op === 'move-point' ? pt.x + Number(cmd.dx || 0) : Number(cmd.x ?? pt.x);
          const ny = op === 'move-point' ? pt.y + Number(cmd.dy || 0) : Number(cmd.y ?? pt.y);
          const deltaX = nx - pt.x;
          const deltaY = ny - pt.y;
          pt.x = Math.round(nx * 1000) / 1000;
          pt.y = Math.round(ny * 1000) / 1000;
          if (pt.in) {
            pt.in.x = Math.round((pt.in.x + deltaX) * 1000) / 1000;
            pt.in.y = Math.round((pt.in.y + deltaY) * 1000) / 1000;
          }
          if (pt.out) {
            pt.out.x = Math.round((pt.out.x + deltaX) * 1000) / 1000;
            pt.out.y = Math.round((pt.out.y + deltaY) * 1000) / 1000;
          }
        } else {
          const curHandle = pt[handle] || { x: pt.x, y: pt.y };
          const nx = op === 'move-point' ? curHandle.x + Number(cmd.dx || 0) : Number(cmd.x ?? curHandle.x);
          const ny = op === 'move-point' ? curHandle.y + Number(cmd.dy || 0) : Number(cmd.y ?? curHandle.y);
          pt[handle] = {
            x: Math.round(nx * 1000) / 1000,
            y: Math.round(ny * 1000) / 1000,
          };
          if (handle === 'q' && pIdx > 0) {
            const prev = sp.points[pIdx - 1];
            prev.out = {
              x: Math.round((prev.x + (2 / 3) * (nx - prev.x)) * 1000) / 1000,
              y: Math.round((prev.y + (2 / 3) * (ny - prev.y)) * 1000) / 1000,
            };
            pt.in = {
              x: Math.round((pt.x + (2 / 3) * (nx - pt.x)) * 1000) / 1000,
              y: Math.round((pt.y + (2 / 3) * (ny - pt.y)) * 1000) / 1000,
            };
          }
        }
      } else if (op === 'insert-point') {
        const sIdx = cmd.subpathIndex ?? 0;
        const sp = subpaths[sIdx];
        if (!sp || !Array.isArray(sp.points)) {
          throw cmdError('E_VECTOR_POINT_RANGE', `子路径索引越界: subpathIndex=${sIdx}`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        const newPt = cmd.point
          ? normalizeVectorNodeSpec({ points: { subpaths: [{ closed: false, points: [cmd.point] }] } }).subpaths[0].points[0]
          : { x: Number(cmd.x || 0), y: Number(cmd.y || 0) };
        const pIdx = cmd.pointIndex !== undefined ? Math.max(0, Math.min(sp.points.length, cmd.pointIndex)) : sp.points.length;
        sp.points.splice(pIdx, 0, newPt);
      } else if (op === 'delete-point') {
        const sIdx = cmd.subpathIndex ?? 0;
        const pIdx = cmd.pointIndex ?? 0;
        const sp = subpaths[sIdx];
        if (!sp || !sp.points?.[pIdx]) {
          throw cmdError('E_VECTOR_POINT_RANGE', `控制点索引越界: subpathIndex=${sIdx}, pointIndex=${pIdx}`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        if (sp.points.length <= 2) {
          throw cmdError('E_VECTOR_DEGENERATE', `子路径至少需要保留 2 个控制点`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        sp.points.splice(pIdx, 1);
      }

      if (cmd.closed !== undefined && subpaths[cmd.subpathIndex ?? 0]) {
        subpaths[cmd.subpathIndex ?? 0].closed = Boolean(cmd.closed);
      }
      if (cmd.bakeTransform && transform) {
        subpaths = bakeVectorTransform(subpaths, transform, {
          x: (Number(targetNode.w) || 100) / 2,
          y: (Number(targetNode.h) || 100) / 2,
        });
        transform = null;
      }

      const nextPointsObj = {
        subpaths,
        fillRule,
        ...(transform ? { transform } : {}),
        ...(strokeLinecap ? { strokeLinecap } : {}),
        ...(strokeLinejoin ? { strokeLinejoin } : {}),
        ...(strokeDasharray ? { strokeDasharray } : {}),
      };
      const nextSvgD = subpathsToSvgD(subpaths);

      if (isSub) {
        inst.overrides = inst.overrides || {};
        inst.overrides[targetInfo.subNodeId] = {
          ...(inst.overrides[targetInfo.subNodeId] || {}),
          points: nextPointsObj,
          content: nextSvgD,
          ...(cmd.smooth !== undefined ? { smooth: Boolean(cmd.smooth) } : {}),
        };
        affectedIds.push(entry.scopedId);
      } else {
        targetNode.points = nextPointsObj;
        targetNode.content = nextSvgD;
        if (op === 'import-svg' && subpaths.length > 0) {
          // 导入 SVG 会用解析出的子路径整体替换内容；盒尺寸必须跟随新内容，
          // 否则路径按旧盒子裁切/显示。与 booleanPathOp 一样按局部坐标取整。
          const bounds = computeVectorBounds(subpaths);
          targetNode.w = Math.max(1, Math.ceil(bounds.maxX || bounds.width || 1));
          targetNode.h = Math.max(1, Math.ceil(bounds.maxY || bounds.height || 1));
        }
        if (cmd.smooth !== undefined) targetNode.smooth = Boolean(cmd.smooth);
        affectedIds.push(entry.scopedId);
      }
}

function booleanPathOp({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const op = cmd.op || cmd.operation;
      const pairIds = Array.isArray(cmd.nodeIds) && cmd.nodeIds.length === 2
        ? cmd.nodeIds
        : [cmd.targetId, cmd.clipId].filter(Boolean);
      if (!op || pairIds.length !== 2) {
        throw cmdError('E_VECTOR_BOOLEAN_ARGS', `booleanPathOp 需要 op (union/subtract/intersect/exclude) 与两个目标路径节点 (nodeIds 或 targetId+clipId)`, {
          commandIndex: cmdIdx,
        });
      }
      const infoA = resolveTargetOrSubnode(doc, index, pairIds[0], pageScope, cmdIdx);
      const infoB = resolveTargetOrSubnode(doc, index, pairIds[1], pageScope, cmdIdx);
      if (infoA.isInstanceSubnode || infoB.isInstanceSubnode) {
        throw cmdError('E_VECTOR_BOOLEAN_SCOPE', `booleanPathOp 需要直接作用于两个可编辑 path 源节点`, { commandIndex: cmdIdx });
      }
      const nodeA = infoA.entry.node;
      const nodeB = infoB.entry.node;
      if (nodeA.locked || nodeB.locked) {
        throw cmdError('E_NODE_LOCKED', `参与布尔运算的节点已锁定`, { commandIndex: cmdIdx, nodeId: nodeA.locked ? nodeA.id : nodeB.id });
      }
      if (nodeA.type !== 'path' || nodeB.type !== 'path') {
        throw cmdError('E_INVALID_NODE_TYPE', `booleanPathOp 要求两个节点均为 path 类型`, {
          commandIndex: cmdIdx,
          nodeId: nodeA.type !== 'path' ? nodeA.id : nodeB.id,
        });
      }

      const specA = normalizeVectorNodeSpec(nodeA);
      const specB = normalizeVectorNodeSpec(nodeB);
      const oxA = Number(nodeA.x || 0);
      const oyA = Number(nodeA.y || 0);
      const oxB = Number(nodeB.x || 0);
      const oyB = Number(nodeB.y || 0);
      const sameOrigin = oxA === oxB && oyA === oyB;

      const worldSubpathsA = sameOrigin ? specA.subpaths : bakeVectorTransform(specA.subpaths, [1, 0, 0, 1, oxA, oyA]);
      const worldSubpathsB = sameOrigin ? specB.subpaths : bakeVectorTransform(specB.subpaths, [1, 0, 0, 1, oxB, oyB]);

      let boolResult;
      try {
        boolResult = booleanVectorPaths(
          op,
          { points: { subpaths: worldSubpathsA, fillRule: specA.fillRule } },
          { points: { subpaths: worldSubpathsB, fillRule: specB.fillRule } },
          { allowSelfIntersection: Boolean(cmd.allowSelfIntersection) }
        );
      } catch (err) {
        throw cmdError(err.code || 'E_VECTOR_BOOLEAN_FAILED', err.message, {
          commandIndex: cmdIdx,
          nodeId: nodeA.id,
          extra: { intersections: err.intersections, subpathIndex: err.subpathIndex },
        });
      }

      let finalSubpaths = boolResult.subpaths;
      let nextX = oxA;
      let nextY = oyA;
      let nextW = Math.max(8, Number(nodeA.w || 100), Math.ceil(boolResult.bounds.maxX || 0));
      let nextH = Math.max(8, Number(nodeA.h || 100), Math.ceil(boolResult.bounds.maxY || 0));

      if (!sameOrigin && finalSubpaths.length > 0) {
        nextX = Math.round(boolResult.bounds.minX);
        nextY = Math.round(boolResult.bounds.minY);
        finalSubpaths = bakeVectorTransform(finalSubpaths, [1, 0, 0, 1, -nextX, -nextY]);
        const localBounds = computeVectorBounds(finalSubpaths);
        nextW = Math.max(8, Math.ceil(localBounds.maxX || localBounds.width || 24));
        nextH = Math.max(8, Math.ceil(localBounds.maxY || localBounds.height || 24));
      }

      const finalSvgD = subpathsToSvgD(finalSubpaths);
      const finalPointsObj = {
        subpaths: finalSubpaths,
        fillRule: boolResult.fillRule,
        strokeLinecap: specA.strokeLinecap,
        strokeLinejoin: specA.strokeLinejoin,
        ...(specA.strokeDasharray ? { strokeDasharray: specA.strokeDasharray } : {}),
      };

      if (cmd.resultId && cmd.resultId !== nodeA.id) {
        const parent = infoA.entry.parent;
        if (!parent || !Array.isArray(parent.children)) {
          throw cmdError('E_INVALID_PARENT', `无法在根节点同级创建布尔运算结果节点`, { commandIndex: cmdIdx });
        }
        const created = {
          ...structuredClone(nodeA),
          id: cmd.resultId,
          name: cmd.name || `${nodeA.name || nodeA.id}_${op}`,
          type: 'path',
          x: nextX,
          y: nextY,
          w: nextW,
          h: nextH,
          points: finalPointsObj,
          content: finalSvgD,
        };
        const posA = parent.children.indexOf(nodeA);
        parent.children.splice(posA >= 0 ? posA + 1 : parent.children.length, 0, created);
        if (cmd.keepSources === false) {
          for (const src of [nodeA, nodeB]) {
            const p = infoA.entry.parent?.children?.includes(src) ? infoA.entry.parent : infoB.entry.parent;
            const idx = p?.children?.indexOf(src) ?? -1;
            if (idx >= 0) p.children.splice(idx, 1);
          }
        }
        affectedIds.push(`${infoA.entry.scope}/${created.id}`);
      } else {
        nodeA.x = nextX;
        nodeA.y = nextY;
        nodeA.w = nextW;
        nodeA.h = nextH;
        nodeA.points = finalPointsObj;
        nodeA.content = finalSvgD;
        if (cmd.name) nodeA.name = cmd.name;
        if (cmd.keepSources === false && infoB.entry.parent && Array.isArray(infoB.entry.parent.children)) {
          const posB = infoB.entry.parent.children.indexOf(nodeB);
          if (posB >= 0) infoB.entry.parent.children.splice(posB, 1);
          affectedIds.push(infoB.entry.scopedId);
        }
        affectedIds.push(infoA.entry.scopedId);
      }
}

export const handlers = { editPath, booleanPathOp };
