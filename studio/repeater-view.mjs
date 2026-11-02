// A repeater's `dataset` field may hold inline row objects (an array) instead of a
// dataset name string. Treat the array as inline rows and key the dataset by the
// repeater node id, so names never collapse into "[object Object]" strings.
export function repeaterDatasetName(node){
  if(!node)return '';
  if(typeof node.dataset==='string'&&node.dataset)return node.dataset;
  if(typeof node.source==='string'&&node.source)return node.source;
  return node.id||'';
}

export function repeaterInlineRows(node){
  return Array.isArray(node?.dataset)?node.dataset:[];
}

export function repeaterRows(node,doc){
  const inline=repeaterInlineRows(node);
  if(inline.length)return inline;
  const name=repeaterDatasetName(node);
  const dataset=name&&doc?.datasets?.[name];
  return Array.isArray(dataset)?dataset:(dataset?.rows||node?.rows||[]);
}

export function applyRepeaterView(rows,{filter=null,sort=null,pageSize=null,page=null,pageIndex=null}={}){
  let result=Array.isArray(rows)?rows:[];
  if(typeof filter==='string'&&filter.trim()!==''){
    const q=filter.trim().toLowerCase();
    result=result.filter(row=>Object.entries(row||{}).some(([k,v])=>!k.startsWith('_')&&String(v??'').toLowerCase().includes(q)));
  }else if(filter?.field){
    result=result.filter(row=>{
      const value=String(row?.[filter.field]??'');
      if(Array.isArray(filter.in))return filter.in.map(String).includes(value);
      if(filter.equals!==undefined)return value===String(filter.equals);
      if(filter.value!==undefined&&String(filter.value)!==''&&String(filter.value)!=='all'){
        const target=String(filter.value).toLowerCase(),cell=value.toLowerCase();
        return (filter.operator==='eq'||filter.operator==='==')?cell===target:cell.includes(target);
      }
      return true;
    });
  }
  if(sort?.field){
    const direction=(sort.direction??sort.order)==='desc'?-1:1;
    result=[...result].sort((a,b)=>{
      const left=a?.[sort.field],right=b?.[sort.field];
      const nl=Number(left),nr=Number(right);
      if(!Number.isNaN(nl)&&!Number.isNaN(nr)&&left!==''&&right!==''&&left!==null&&right!==null&&typeof left!=='boolean'&&typeof right!=='boolean'){
        return (nl-nr)*direction;
      }
      return String(left??'').localeCompare(String(right??''),'zh-CN')*direction;
    });
  }
  if(Number.isInteger(pageSize)&&pageSize>0){
    const totalPages=Math.max(1,Math.ceil(result.length/pageSize));
    const rawPage=Number.isInteger(pageIndex)&&pageIndex>=0
      ? pageIndex+1
      : (Number.isFinite(Number(page))&&Number(page)>=1?Math.floor(Number(page)):1);
    const activePage=Math.min(Math.max(1,rawPage),totalPages);
    const start=(activePage-1)*pageSize;
    result=result.slice(start,start+pageSize);
  }
  return result;
}

// Bind the existing RP/1 item field forms before measuring, so long values
// participate in wrapping. This intentionally does not evaluate arbitrary JS.
export function bindRepeaterTemplate(template,row){
 const result=structuredClone(template);
 const value=path=>{let current=row;for(const key of path.split('.')){if(!current||!Object.prototype.hasOwnProperty.call(current,key))return '';current=current[key];}return current==null?'':String(current);};
 const bind=text=>{
  if(typeof text!=='string')return text;
  const direct=text.match(/^=item\.([A-Za-z_][\w.]*)$/);
  return direct?value(direct[1]):text
   .replace(/\$\{item\.([A-Za-z_][\w.]*)\}/g,(_,path)=>value(path))
   .replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g,(_,path)=>value(path));
 };
 const visit=node=>{if(!node||typeof node!=='object')return;for(const field of ['text','value','placeholder'])if(field in node)node[field]=bind(node[field]);for(const span of node.spans||[])span.text=bind(span.text);for(const child of node.children||[])visit(child);for(const state of node.states||[])visit(state.root);if(node.template)visit(node.template);};
 visit(result);return result;
}
