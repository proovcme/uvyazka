/** User presentation choices; independent from search, model data and the event log. */
export class ModelVisibility {
  private hidden=new Set<string>();
  visible(id:string){return !this.hidden.has(id);}
  set(ids:Iterable<string>,visible:boolean){for(const id of ids)if(visible)this.hidden.delete(id);else this.hidden.add(id);}
  isolate(ids:Iterable<string>,all:Iterable<string>){const keep=new Set(ids);this.hidden=new Set([...all].filter(id=>!keep.has(id)));}
  reset(){this.hidden.clear();}
  count(ids:Iterable<string>){let total=0,shown=0;for(const id of ids){total++;if(this.visible(id))shown++;}return {total,shown,checked:total>0&&shown===total,mixed:shown>0&&shown<total};}
}
