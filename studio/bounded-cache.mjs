// Cache correctness comes from the existing semantic keys; eviction only limits
// retained results. Keep one oversized value so a large active page can be reused.
export class BoundedCache extends Map {
 constructor({maxEntries,maxWeight,weight}){super();this.maxEntries=maxEntries;this.maxWeight=maxWeight;this.weigh=weight;this.weights=new Map();this.totalWeight=0;}
 get(key){if(!super.has(key))return undefined;const value=super.get(key);super.delete(key);super.set(key,value);return value;}
 set(key,value){if(super.has(key))this.delete(key);const weight=this.weigh(key,value);super.set(key,value);this.weights.set(key,weight);this.totalWeight+=weight;while(this.size>1&&(this.size>this.maxEntries||this.totalWeight>this.maxWeight))this.delete(super.keys().next().value);return this;}
 delete(key){if(!super.has(key))return false;this.totalWeight-=this.weights.get(key)||0;this.weights.delete(key);return super.delete(key);}
 clear(){super.clear();this.weights.clear();this.totalWeight=0;}
}
export const textWeight=(key,value)=>(String(key).length+JSON.stringify(value).length)*2;
