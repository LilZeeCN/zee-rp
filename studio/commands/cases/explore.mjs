// 探索命令 case(generateExplorations/selectExploration/recordDesignDecision)。
// 从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import { recordDesignDecision } from '../../design-decisions.mjs';
import {
  generateGeneralExplorations,
  validateExplorationsUsability,
  applySelectedExplorationToPage,
} from '../../explorations.mjs';
import { cmdError } from '../helpers.mjs';

function generateExplorations({ doc, cmd, cmdIdx, affectedIds }) {
      const targetPageId = cmd.pageId || cmd.targetPageId || 'home';
      const basePage = (doc.pages || []).find(p => p.id === targetPageId);
      if (!basePage) throw cmdError('E_PAGE_NOT_FOUND', `未找到页面 "${targetPageId}"`, { commandIndex: cmdIdx });

      const designBrief = cmd.designBrief || cmd.brief || {
        domain: cmd.domain || doc.domainPreset || doc.meta?.domain || 'birding',
        targetTask: cmd.targetTask,
        targetAudience: cmd.targetAudience,
        styleTone: cmd.styleTone,
        mustKeepModuleIds: cmd.mustKeepModuleIds,
        candidateDirections: cmd.candidateDirections || cmd.directions,
      };
      const generated = generateGeneralExplorations(basePage, doc, designBrief);
      const explorations = Array.isArray(generated) ? generated : generated.explorations;

      // Remove any old exploration pages for this basePage and add the new ones
      doc.pages = doc.pages.filter(p => !p.explorationOf || p.explorationOf !== basePage.id);
      let cursorX = Math.max(...doc.pages.map(p => (p.canvas?.x || 0) + (p.canvas?.w || 402))) + 120;
      for (const exp of explorations) {
        exp.canvas.x = cursorX;
        exp.canvas.y = basePage.canvas?.y || 80;
        cursorX += exp.canvas.w + 100;
        doc.pages.push(exp);
        affectedIds.push(exp.id);
      }

      const usability = validateExplorationsUsability(doc, explorations);
      if (!usability.allUsable || !usability.allPairsStructurallyDistinct) {
        throw cmdError('E_EXPLORATION_USABILITY_FAILED', `视觉探索方案基础可用性或结构差异校验未通过`, {
          commandIndex: cmdIdx,
          usabilityResults: usability,
        });
      }

      basePage.explorations = explorations.map(e => {
        const sf = e.explorationMeta.structuralFeatures || {};
        return {
          id: e.id,
          explorationId: e.id,
          name: e.name,
          title: e.name,
          direction: e.explorationMeta.direction,
          rationale: e.explorationMeta.rationale,
          designBriefSummary: e.explorationMeta.designBriefSummary,
          axes: e.explorationMeta.axes,
          structuralFeatures: sf,
        };
      });
      basePage.explorationStructuralDiffs = usability.pairChecks;
      doc.explorations = structuredClone(basePage.explorations);
}

function selectExploration({ doc, cmd, cmdIdx, affectedIds }) {
      const targetPageId = cmd.pageId || cmd.targetPageId || 'home';
      const expPageId = cmd.explorationPageId || cmd.explorationId || cmd.id;
      const basePage = (doc.pages || []).find(p => p.id === targetPageId);
      let expPage = (doc.pages || []).find(p => p.id === expPageId);
      if (!expPage && basePage && expPageId) {
        const expList = (doc.pages || []).filter(p => p.explorationOf === basePage.id);
        const lower = String(expPageId).toLowerCase();
        if (lower.endsWith('_exp_a') || lower === 'a' || lower === '0') expPage = expList[0];
        else if (lower.endsWith('_exp_b') || lower === 'b' || lower === '1') expPage = expList[1];
        else if (lower.endsWith('_exp_c') || lower === 'c' || lower === '2') expPage = expList[2];
      }
      if (!basePage || !expPage) {
        throw cmdError('E_PAGE_NOT_FOUND', `未找到主页面 "${targetPageId}" 或方案页面 "${expPageId}"`, { commandIndex: cmdIdx });
      }
      const adoptResult = applySelectedExplorationToPage(basePage, expPage, doc, {
        mode: cmd.mode || (cmd.regionRole || cmd.regionNodeId ? 'region' : 'full-page'),
        regionRole: cmd.regionRole || null,
        regionNodeId: cmd.regionNodeId || null,
      });
      affectedIds.push(basePage.id);
      if (adoptResult.replacedNodeId) {
        affectedIds.push(`${basePage.id}/${adoptResult.replacedNodeId}`);
      }
}

function recordDesignDecisionCase({ doc, cmd, affectedIds }) {
      affectedIds.push(...recordDesignDecision(doc, cmd));
}

export const handlers = {
  generateExplorations,
  selectExploration,
  recordDesignDecision: recordDesignDecisionCase,
};
