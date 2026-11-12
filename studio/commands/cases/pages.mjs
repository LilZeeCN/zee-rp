// 页面命令 case(addPage/duplicatePage/renamePage/reorderPages/deletePage)。
// 从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import { cmdError } from '../helpers.mjs';

function addPage({ doc, cmd, cmdIdx, affectedIds }) {
      let pageId = cmd.pageId || cmd.id;
      if (!pageId) {
        let n = (doc.pages?.length || 0) + 1;
        while ((doc.pages || []).some(p => p.id === `page_${n}`)) n++;
        pageId = `page_${n}`;
      } else if (cmd.autoUniqueId && (doc.pages || []).some(p => p.id === pageId)) {
        const base = pageId;
        let n = 2;
        while ((doc.pages || []).some(p => p.id === `${base}_${n}`)) n++;
        pageId = `${base}_${n}`;
      } else if ((doc.pages || []).some(p => p.id === pageId)) {
        throw cmdError('E_DUPLICATE_PAGE', `页面 ID "${pageId}" 已存在`, { commandIndex: cmdIdx, field: 'pageId' });
      }
      const lastBoard = doc.pages?.at(-1)?.canvas;
      const domain = cmd.domain || cmd.pageDomain || (cmd.shell === 'web-page' ? 'web' : cmd.shell === 'phone-shell' ? 'mobile' : doc.domain) || 'mobile';
      const isWeb = domain !== 'mobile';
      const w = Number(cmd.w || (isWeb ? 1280 : 402));
      const h = Number(cmd.h || (isWeb ? 800 : 874));
      const x = Number.isFinite(cmd.x) ? cmd.x : (lastBoard ? lastBoard.x + lastBoard.w + 120 : 80);
      const y = Number.isFinite(cmd.y) ? cmd.y : (lastBoard ? lastBoard.y : 80);
      const pageName = cmd.name || cmd.title || pageId;
      const resolvedDevice = cmd.device !== undefined ? cmd.device : (isWeb ? null : (doc.device || 'iphone16-pro'));
      let defaultRoot;
      if (cmd.shell === 'phone-shell') {
        defaultRoot = {
          type: 'phone-shell',
          id: `${pageId}_shell`,
          layout: 'stack',
          padding: 0,
          device: resolvedDevice || 'iphone16-pro',
          children: [
            {
              type: 'box',
              id: `${pageId}_screen`,
              name: pageName,
              layout: cmd.layout || 'stack',
              padding: cmd.padding !== undefined ? cmd.padding : [60, 0, 0, 0],
              gap: cmd.gap ?? 12,
              w,
              h,
              fill: '$bg',
              children: [],
            },
          ],
        };
      } else if (cmd.shell === 'web-page') {
        defaultRoot = {
          type: 'box',
          id: `${pageId}_root`,
          name: pageName,
          layout: cmd.layout || 'column',
          w,
          h,
          padding: cmd.padding !== undefined ? cmd.padding : 24,
          gap: cmd.gap ?? 16,
          fill: '$bg',
          children: [],
        };
      } else {
        defaultRoot = {
          type: 'box',
          id: `${pageId}_root`,
          name: pageName,
          layout: cmd.layout || 'stack',
          w,
          h,
          padding: cmd.padding !== undefined ? cmd.padding : 0,
          gap: cmd.gap ?? 12,
          fill: '$bg',
          children: [],
        };
      }
      doc.pages.push({
        id: pageId,
        name: pageName,
        device: cmd.device !== undefined ? cmd.device : (isWeb ? null : doc.device),
        domain,
        canvas: { x, y, w, h },
        root: cmd.root ? structuredClone(cmd.root) : defaultRoot,
        interactions: [],
        explorations: [],
      });
      affectedIds.push(pageId);
}

function duplicatePage({ doc, cmd, cmdIdx, affectedIds }) {
      const srcPage = (doc.pages || []).find(p => p.id === cmd.pageId);
      if (!srcPage) {
        throw cmdError('E_PAGE_NOT_FOUND', `未找到源页面 "${cmd.pageId}"`, { commandIndex: cmdIdx, field: 'pageId' });
      }
      const baseId = cmd.newPageId || `${srcPage.id}_copy`;
      let newPageId = baseId;
      let n = 2;
      while ((doc.pages || []).some(p => p.id === newPageId)) {
        newPageId = `${baseId}_${n++}`;
      }
      const clonePage = structuredClone(srcPage);
      clonePage.id = newPageId;
      clonePage.name = cmd.newName || `${srcPage.name} (${n > 2 ? `副本 ${n - 1}` : '副本'})`;
      const lastBoard = doc.pages.at(-1)?.canvas || srcPage.canvas;
      clonePage.canvas.x = lastBoard.x + lastBoard.w + 120;
      doc.pages.push(clonePage);
      affectedIds.push(newPageId);
}

function renamePage({ doc, cmd, cmdIdx, affectedIds }) {
      const pg = (doc.pages || []).find(p => p.id === cmd.pageId);
      if (!pg) throw cmdError('E_PAGE_NOT_FOUND', `未找到页面 "${cmd.pageId}"`, { commandIndex: cmdIdx, field: 'pageId' });
      pg.name = cmd.name;
      affectedIds.push(pg.id);
}

function reorderPages({ doc, cmd, cmdIdx, affectedIds }) {
      if (!Array.isArray(cmd.pageIds)) {
        throw cmdError('E_INVALID_VALUE', `reorderPages 需要 pageIds 数组`, { commandIndex: cmdIdx, field: 'pageIds' });
      }
      const map = new Map((doc.pages || []).map(p => [p.id, p]));
      for (const id of cmd.pageIds) if(!map.has(id)) throw cmdError('E_PAGE_NOT_FOUND',`页面不存在：${id}`,{commandIndex:cmdIdx,field:'pageIds'});
      const nextPages = [];
      for (const id of cmd.pageIds) {
        if (map.has(id)) {
          nextPages.push(map.get(id));
          map.delete(id);
        }
      }
      for (const rem of map.values()) nextPages.push(rem);
      doc.pages = nextPages;
      affectedIds.push(...cmd.pageIds);
}

function deletePage({ doc, cmd, cmdIdx, affectedIds }) {
      if ((doc.pages || []).length <= 1) {
        throw cmdError('E_CANNOT_DELETE_LAST_PAGE', `文档至少需保留一个页面`, { commandIndex: cmdIdx, field: 'pageId' });
      }
      const idx = (doc.pages || []).findIndex(p => p.id === cmd.pageId);
      if (idx < 0) throw cmdError('E_PAGE_NOT_FOUND', `未找到页面 "${cmd.pageId}"`, { commandIndex: cmdIdx, field: 'pageId' });
      if (!cmd.force && !cmd.cascade) {
        const pageLinks = [];
        function scanNodeForPageLink(n, pgId) {
          if (!n || typeof n !== 'object') return;
          if (n.on && typeof n.on === 'object') {
            for (const [, evSpec] of Object.entries(n.on)) {
              const acts = Array.isArray(evSpec) ? evSpec : evSpec?.cases ? evSpec.cases.flatMap(c => c.actions || []) : [evSpec];
              for (const act of acts) {
                if (act && (act.page === cmd.pageId || act.navigate === cmd.pageId || act.target === cmd.pageId)) {
                  pageLinks.push(`${pgId}/${n.id}`);
                }
              }
            }
          }
          for (const ch of n.children || []) scanNodeForPageLink(ch, pgId);
          for (const st of n.states || []) if (st.root) scanNodeForPageLink(st.root, pgId);
        }
        for (const p of doc.pages || []) {
          if (p.id !== cmd.pageId) scanNodeForPageLink(p.root, p.id);
        }
        if (pageLinks.length > 0) {
          throw cmdError(
            'E_DANGLING_REF',
            `无法删除页面 "${cmd.pageId}"：被 ${pageLinks.length} 处跨页交互引用 (${pageLinks.slice(0, 4).join(', ')})；请先解除引用或传入 force: true`,
            { commandIndex: cmdIdx, field: 'pageId', danglingReferences: pageLinks }
          );
        }
      }
      doc.pages.splice(idx, 1);
      affectedIds.push(cmd.pageId);
}

export const handlers = { addPage, duplicatePage, renamePage, reorderPages, deletePage };
