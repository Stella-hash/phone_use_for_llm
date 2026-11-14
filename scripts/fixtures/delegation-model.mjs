// Explicit --import synthetic sink. Production modules never import this file.
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init,...rest)=>{
  if(String(url)!=='https://api.openai.com/v1/responses')return realFetch(url,init,...rest);
  const body=JSON.parse(init.body),input=JSON.parse(body.input[0].content[0].text);
  if(body.model!=='synthetic-clean-model'||body.store!==false||init.redirect!=='error')throw Error('Unexpected synthetic model request');
  const source=input.sources.find(s=>s.spans.length);
  if(!source)throw Error('Synthetic model requires retained source text');
  const answer={intentVersion:input.intentVersion,eventId:input.frame.eventId,action:'yield',targetIndex:null,value:null,
    reason:'Synthetic bounded read',localNotes:'',finding:{summary:'Synthetic finding with an exact source',question:'',uncertainty:'',
      references:[{readEventId:source.eventId,spanIds:[0]}],visualEventIds:[]}};
  return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',name:'next_step',arguments:JSON.stringify(answer)}],usage:{total_tokens:42}}));
};
