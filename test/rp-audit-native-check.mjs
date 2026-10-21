import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readRecords} from '../scripts/rp-records.mjs';
import {parsePayload,field} from '../scripts/parse-payload.mjs';
import {readRp} from '../scripts/rp-read.mjs';
const here=dirname(fileURLToPath(import.meta.url)),tmp=mkdtempSync(join(tmpdir(),'rp1-gaps-'));
try{
 const r=spawnSync('node',[join(here,'../scripts/proto.mjs'),'generate','--spec',join(here,'fixtures/rp1-master-adaptive.json'),'--out-dir',join(tmp,'bundle'),'--out-rp',join(tmp,'probe.rp')],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 const recs=readRecords(readFileSync(join(tmp,'probe.rp'))),pages=recs.filter(r=>r.className==='Axure:Page');
 let refs=0,adaptiveWidths=[];
 for(const r of pages){const g=parsePayload(r);for(const o of g.objects.values()){
  if(o.className==='Axure:DiagramObject:ReferenceDiagramObject')refs++;
  const name=field(field(o.body??{},'name-block')??{},'text')?.text;
  if(name?.startsWith('txt-p1_title-')){
   for(const a of field(o.body,'AdaptiveStyles')?.items??[]){if(a.tag!==3)continue;const st=g.objects.get(a.value);
    for(const prop of field(st?.body??{},'PropList')?.items??[]){if(field(prop,'DOAName')?.value===3221225577)adaptiveWidths.push(field(field(prop,'Value'),'Width')?.value);}
   }
  }
 }}
 assert.equal(refs,3,'Each of three pages must contain a real native master instance');
 const summary=readRp(readFileSync(join(tmp,'probe.rp')), {includeMasterWidgets:true});
 assert.equal(recs.filter(r=>r.className==='Axure:Master').length,1);
 assert.equal(summary.containedWidgets.filter(w=>w.container[0].startsWith('母版:')&&w.interactions.some(ix=>ix.event==='OnClick')).length,3);
 assert.ok(adaptiveWidths.includes(342)&&adaptiveWidths.includes(1000),`Missing adaptive size overrides: ${adaptiveWidths}`);
 console.log(JSON.stringify({ok:true,masterReferences:refs,adaptiveWidths}));
}finally{rmSync(tmp,{recursive:true});}
