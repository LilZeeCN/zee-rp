import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords } from './rp-records.mjs';

export function parsePayload(record) {
  const buf=record.raw.subarray(record.payloadStart), nodes=[], objects=new Map();
  let p=0;
  const u32=()=>{const n=buf.readUInt32LE(p);p+=4;return n;};
  const val=()=>{
    const start=p,tag=u32(), n={start,tag};nodes.push(n);
    switch(tag){
      case 1: n.entries=Array.from({length:u32()},()=>[val(),val()]);break;
      case 2: n.items=Array.from({length:u32()},()=>val());break;
      // 0x14 与 0x11/0x12/0x16 同类：单 u32 的值/引用（Axure:Page 里 start/end-diagram-object 用它，
      // 见 research-rp/round4/rp-read-tag14-repro.mjs 的字节证据）。
      case 3: case 0xf: case 0x12: case 5: case 8: case 0x11: case 0x14: case 0x16: n.value=u32();break;
      case 4:{const size=u32();n.value=buf.subarray(p,p+size).toString('base64');p+=size;break;}
      case 6:n.rawNumber=buf.subarray(p,p+8).toString('hex');n.value=buf.readDoubleLE(p);p+=8;break;
      case 9:n.id=u32();n.classIndex=u32();n.className=record.strings[n.classIndex-1];n.body=val();objects.set(n.id,n);break;
      case 0x10: case 0x13:n.values=[u32(),u32()];break;
      case 0x19:n.value=!!buf[p++];break;
      // 26/28 是无载荷尾部标记。注意 0x1e(30) 是 GUID 列表、有载荷，不能和它们合并。
      case 26: case 28:break;
      case 0x1a: case 0x1c:break;
      case 0x1d:n.value=buf.subarray(p,p+8).toString('hex');p+=8;break;
      case 0x1e:{const count=u32();n.values=Array.from({length:count},()=>{const b=buf.subarray(p,p+16);p+=16;return b.toString('hex')});break;}
      default:throw new Error(`Unknown tag 0x${tag.toString(16)} at ${start}; last nodes ${JSON.stringify(nodes.slice(-6))}`);
    }
    n.end=p;if(tag===8)n.text=record.strings[n.value-1];return n;
  };
  const roots=[];try{while(p<buf.length)roots.push(val());}catch(e){throw new Error(e.message+'; context '+JSON.stringify(nodes.slice(-5)));}return {roots,nodes,objects,bytes:buf.length};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const rs=readRecords(readFileSync(process.argv[2]));
 for(const r of rs.filter(r=>r.strings))try{const p=parsePayload(r);console.log(r.className,p.bytes,'OK',p.nodes.length,'nodes',p.objects.size,'objects');}catch(e){console.error(r.className,e.message)}
}

// Encode the parsed grammar without scanning byte patterns. Preserve NaN payload bits.
export function encodePayload(roots) {
  const chunks=[];
  const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);chunks.push(b);};
  const write=n=>{
    u32(n.tag);
    switch(n.tag){
      case 1:u32(n.entries.length);for(const [k,v]of n.entries){write(k);write(v);}break;
      case 2:u32(n.items.length);n.items.forEach(write);break;
      case 3:case 5:case 8:case 0xf:case 0x11:case 0x12:case 0x14:case 0x16:u32(n.value);break;
      case 4:{const b=Buffer.from(n.value,'base64');u32(b.length);chunks.push(b);break;}
      case 6:{const b=Buffer.alloc(8);if(Number.isNaN(n.value)&&n.rawNumber)Buffer.from(n.rawNumber,'hex').copy(b);else b.writeDoubleLE(n.value);chunks.push(b);break;}
      case 9:u32(n.id);u32(n.classIndex);write(n.body);break;
      case 0x10:case 0x13:n.values.forEach(u32);break;
      case 0x19:chunks.push(Buffer.from([n.value?1:0]));break;
      // 26/28 是无载荷标记；0x1e(30) 是 GUID 列表、必须读数据。
      case 26:case 28:break;
      case 0x1a:case 0x1c:break;
      case 0x1d:chunks.push(Buffer.from(n.value,'hex'));break;
      case 0x1e:{const gs=n.values??n.value;u32(gs.length);gs.forEach(v=>chunks.push(Buffer.from(v,'hex')));break;}
      default:throw new Error(`Cannot encode tag ${n.tag}`);
    }
  };
  roots.forEach(write);return Buffer.concat(chunks);
}
export function field(map,name){return map.entries?.find(([k])=>k.text===name)?.[1];}
export function walkNodes(roots,visit){
  for(const n of roots){visit(n);if(n.entries)for(const pair of n.entries)walkNodes(pair,visit);if(n.items)walkNodes(n.items,visit);if(n.body)walkNodes([n.body],visit);}
}
