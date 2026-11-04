// Synthetic protocol payloads. Values are intentionally adversarial test markers.
export function chromeFixture() {
  const strings=[], index=value=>{let at=strings.indexOf(value);if(at<0){at=strings.length;strings.push(value);}return at;};
  const nodes={parentIndex:[],nodeType:[],nodeName:[],nodeValue:[],backendNodeId:[],attributes:[],inputValue:{index:[],value:[]},inputChecked:{index:[]},isClickable:{index:[]}};
  const layout={nodeIndex:[],styles:[],bounds:[],text:[]};
  const add=(parent,tag,{text='',attrs={},bounds=[0,10,100,20],input,hidden=false}={})=>{
    const i=nodes.parentIndex.length;
    nodes.parentIndex.push(parent);nodes.nodeType.push(tag==='#document'?9:tag==='#text'?3:1);nodes.nodeName.push(index(tag));nodes.nodeValue.push(index(text));nodes.backendNodeId.push(i+100);
    nodes.attributes.push(Object.entries(attrs).flatMap(([k,v])=>[index(k),index(v)]));
    if(input!==undefined){nodes.inputValue.index.push(i);nodes.inputValue.value.push(index(input));}
    layout.nodeIndex.push(i);layout.styles.push([index(hidden?'hidden':'visible'),index('1'),index('none')]);layout.bounds.push(bounds);layout.text.push(index(text));return i;
  };
  const root=add(-1,'#document'),html=add(root,'HTML'),body=add(html,'BODY');
  const p=add(body,'P');add(p,'#text',{text:'Visible Chinese 中文'});
  const button=add(body,'BUTTON',{attrs:{id:'advance'}});nodes.isClickable.index.push(button);add(button,'#text',{text:'Continue'});
  const blank=add(body,'INPUT',{input:''});
  const password=add(body,'INPUT',{attrs:{id:'password',type:'password',value:'FAKE_PRIVATE_VALUE'},input:'FAKE_PRIVATE_VALUE'});
  add(password,'#text',{text:'FAKE_PRIVATE_VALUE'});
  add(body,'#text',{text:'HIDDEN_MARKER',hidden:true});
  add(body,'#text',{text:'OFFSCREEN_MARKER',bounds:[0,3000,100,20]});
  const check=add(body,'INPUT',{attrs:{id:'enabled',type:'checkbox'},input:'on'});nodes.inputChecked.index.push(check);
  const canvas=add(body,'CANVAS',{attrs:{id:'picture'}});
  add(body,'IFRAME',{attrs:{id:'frame'}});
  const doc={documentURL:index('https://fixture.example/page'),title:index('Fixture'),frameId:index('main'),nodes,layout};
  const ax={nodes:[
    {backendDOMNodeId:button+100,ignored:false,role:{value:'button'},name:{value:'Continue'},properties:[{name:'disabled',value:{value:false}},{name:'pressed',value:{type:'tristate',value:'mixed'}}]},
    {backendDOMNodeId:blank+100,ignored:false,role:{value:'textbox'},name:{value:''},value:{value:''}},
    {backendDOMNodeId:password+100,ignored:false,role:{value:'textbox'},name:{value:'FAKE_PRIVATE_VALUE'},value:{value:'FAKE_PRIVATE_VALUE'}},
    {backendDOMNodeId:check+100,ignored:false,role:{value:'checkbox'},name:{value:'Enabled'},properties:[{name:'checked',value:{type:'tristate',value:'true'}}]},
    {backendDOMNodeId:canvas+100,ignored:false,role:{value:'image'},name:{value:'Drawing'}},
  ]};
  return {snapshot:{strings,documents:[doc,{frameId:index('child'),documentURL:index('https://other.example/'),secret:'CHILD_MARKER'}]},ax,
    metrics:{visualViewport:{pageX:0,pageY:0,clientWidth:400,clientHeight:800,scale:1},cssVisualViewport:{pageX:0,pageY:0,clientWidth:400,clientHeight:800,scale:1}}};
}

export function fixtureRpc(method,params={}) {
  const data=chromeFixture();
  if(method==='Runtime.evaluate')return {result:{value:{url:'https://fixture.example/page',visible:true,focused:true}}};
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'document-1',url:'https://fixture.example/page'}}};
  if(method==='DOMSnapshot.captureSnapshot')return data.snapshot;
  if(method==='Accessibility.getFullAXTree')return data.ax;
  if(method==='Page.getLayoutMetrics')return data.metrics;
  throw new Error('Unexpected CDP method '+method);
}
