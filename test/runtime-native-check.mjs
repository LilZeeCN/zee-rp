// Independent read-back of the written native model, containers and event scopes.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInteractiveRp } from '../scripts/proto.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const work=mkdtempSync(join(tmpdir(),'rp-runtime-native-'));
const spawn=childProcess.spawnSync;
let checks=0;
const check=(name,fn)=>{fn(); checks++; console.log('PASS '+name);};
const fixture=name=>JSON.parse(readFileSync(join(root,'examples/rp-language',name+'.json')));
const base=fixture('runtime-inventory');
const repeater=base.pages[0].root.children.find(n=>n.type==='repeater');
const empty=structuredClone(base); empty.datasets.items.rows=[];
const twin=structuredClone(base);const copy=structuredClone(repeater);copy.id='second';twin.pages[0].root.children.push(copy);twin.pages[0].canvas.h=1000;
const state=structuredClone(base);
state.pages[0].root={type:'dynamic-panel',id:'outer',w:950,h:750,states:[{id:'form',root:state.pages[0].root}]};
const programs=[['runtime',base],['empty',empty],['two-instances',twin],['state-data',state],['nested',fixture('nested-panels')]];
try {
  for(const [name,source] of programs){
    const spec=join(work,name+'.json'),bundle=join(work,name);writeFileSync(spec,JSON.stringify(source));
    const compiled=spawn('python3',[join(root,'scripts/proto.py'),'compile','--spec',spec,'--out-dir',bundle],{encoding:'utf8'});
    assert.equal(compiled.status,0,name+": "+compiled.stderr+compiled.stdout);
    childProcess.spawnSync=(...args)=>{throw Error('Forbidden subprocess '+args[0]);};syncBuiltinESMExports();
    let report;
    try{report=buildInteractiveRp(join(bundle,'compile-plan.json'),join(work,name+'.rp'),{cacheDir:join(work,'absent')});}
    finally{childProcess.spawnSync=spawn;syncBuiltinESMExports();}
    check(name+' cold native mapping and event coverage',()=>{
      assert.equal(report.backend,'native');assert(!existsSync(join(work,'absent')));
      for(const s of report.sourceMap)assert.equal(s.native.length,1,s.id);
      assert.equal(report.eventCoverage.declared,report.eventCoverage.materialized);
      assert.deepEqual(report.threeZeros,{danglingRefs:0,sentinelSlotsNonZero:0,problems:0});
    });
    const records=readRecords(readFileSync(report.outputRp)).filter(r=>['Axure:Page','Axure:PanelState'].includes(r.className));
    const contexts=records.map(r=>({r,g:parsePayload(r)}));
    const reps=contexts.flatMap(c=>[...c.g.objects.values()].filter(o=>o.className==='Axure:DiagramObject:Repeater').map(o=>({...c,o})));
    if(name==='nested'){
      check('nested records preserve deepest native input and events',()=>{
        assert.equal(contexts.length,5);
        assert(contexts.some(c=>c.r.className==='Axure:PanelState'&&[...c.g.objects.values()].some(o=>o.className==='Axure:DiagramObject:TextBox')));
      });continue;
    }
    check(name+' exact native columns, rows and row-template container',()=>{
      assert.equal(reps.length,name==='two-instances'?2:1);
      assert.equal(report.counts.repeaters,reps.length);
      for(const {g,o,r} of reps){
        if(name==='state-data')assert.equal(r.className,'Axure:PanelState');
        const data=g.objects.get(field(o.body,'Data').value);
        const columns=field(data.body,'columns').items.map(i=>g.objects.get(i.value));
        assert.deepEqual(columns.map(c=>field(c.body,'name').text),Object.keys(source.models.Item));
        const rows=field(data.body,'rows').items.map(i=>g.objects.get(i.value));
        assert.equal(rows.length,source.datasets.items.rows.length);
        rows.forEach((row,i)=>{
          const values=field(row.body,'elements').items.map(e=>g.objects.get(e.value));
          values.forEach((v,j)=>{
            assert.equal(field(v.body,'column-id').value,field(columns[j].body,'variable-id').value);
            assert.equal(field(v.body,'value').text,String(source.datasets.items.rows[i][Object.keys(source.models.Item)[j]]));
          });
        });
        assert(field(g.objects.get(field(o.body,'BaseDiagram').value).body,'diagram-objects').items.length>0);
        assert(report.sourceMap.filter(s=>s.id.includes('/item/')).every(s=>s.native[0].container.some(c=>c.includes('(行模板)'))));
        assert(field(o.body,'InteractionMap'));
      }
    });
    if(name==='two-instances')check('instances own distinct DataSet and row objects',()=>{
      assert.notEqual(field(reps[0].o.body,'Data').value,field(reps[1].o.body,'Data').value);
      assert.notEqual(field(reps[0].o.body,'BaseDiagram').value,field(reps[1].o.body,'BaseDiagram').value);
    });
  }
  console.log(JSON.stringify({ok:true,checks}));
} finally{childProcess.spawnSync=spawn;syncBuiltinESMExports();rmSync(work,{recursive:true,force:true});}
