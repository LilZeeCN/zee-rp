import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolveBlankTemplate} from '../scripts/blank-template.mjs';
import {createBlankPage} from '../scripts/create-blank-page.mjs';
import {addInteractions,resolvePageRecord} from '../scripts/ix-actions.mjs';
import {parsePayload,field} from '../scripts/parse-payload.mjs';
import {validateSemantics} from './check-semantics.mjs';

const guidTable=g=>g.roots.find(n=>n.tag===0x1e).values;
const identity=g=>guidTable(g)[g.roots.find(n=>n.tag===0x12).value-1];
export function runPageLinkChecks(){
 const results=[];
 const check=(name,fn)=>{try{fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,detail:error.message});}};
 const original=createBlankPage(readFileSync(resolveBlankTemplate()),'Destination').file;
 check('page link stores the actual package GUID and page type',()=>{
  const output=addInteractions(original,{page:'Page 1'},[{event:'OnLoad',actions:[{type:'link',page:'Destination'}]}]).file;
  const g=parsePayload(resolvePageRecord(output,'Page 1'));
  const target=[...g.objects.values()].find(o=>o.className==='Axure:InteractionTarget'),pair=field(target.body,'target-page-id');
  assert.equal(guidTable(g)[pair.values[1]-1],identity(parsePayload(resolvePageRecord(original,'Destination'))));
  assert.equal(resolvePageRecord(output,'Page 1').strings[pair.values[0]-1],'Axure:Page');
  assert.equal(validateSemantics(output).valid,true);
 });
 check('a referenced destination GUID does not change source or destination lookup',()=>{
  let output=addInteractions(original,{page:'Page 1'},[{actions:[{type:'link',page:'Destination'}]}]).file;
  for(const p of ['Page 1','Destination'])assert.equal(identity(parsePayload(resolvePageRecord(output,p))),identity(parsePayload(resolvePageRecord(original,p))));
  output=addInteractions(output,{page:'Destination'},[{event:'OnLoad',actions:[{type:'link',page:'Page 1',window:'new'}]}]).file;
  for(const p of ['Page 1','Destination'])assert.equal(identity(parsePayload(resolvePageRecord(output,p))),identity(parsePayload(resolvePageRecord(original,p))));
 });
 check('missing, ambiguous and invalid link inputs reject',()=>{
  const before=Buffer.from(original);
  for(const spec of [{type:'link'},{type:'link',page:'Missing'},{type:'link',page:'Destination',url:'https://example.com'},{type:'link',url:'https://example.com',window:'typo'}])assert.throws(()=>addInteractions(original,{page:'Page 1'},[{actions:[spec]}]));
  assert.deepEqual(original,before);
 });
 return results;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const results=runPageLinkChecks();for(const r of results)console.log((r.passed?'PASS ':'FAIL ')+r.name+(r.detail?' '+r.detail:''));process.exitCode=results.some(r=>!r.passed)?1:0;}
