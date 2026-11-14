import test from 'node:test';
import assert from 'node:assert/strict';
import {navigation} from '../dist/delegation-navigation.js';

const target = {type:'android.widget.TextView',identifier:'org.example:id/article',text:'Article',rect:{x:10,y:30,width:200,height:300}};
const propose = (action, before, after, browser=true) => navigation({action,targetIndex:0,value:action==='scroll'?'up':null}, {elements:[before]}, [after], browser);

for (const action of ['tap','scroll']) {
  test(`${action} binds both observations to the same WebView group, while native navigation remains usable`,()=>{
    for (const [before,after] of [[1,undefined],[undefined,1],[1,2],[undefined,undefined],[null,null],[0,0],['1','1']]) {
      assert.throws(()=>propose(action,{...target,webView:before},{...target,webView:after}),/DELEGATION_WEB_TARGET/);
    }
    assert.equal(propose(action,{...target,webView:1},{...target,webView:1}).name,action==='tap'?'android_tap_element':'android_swipe');
    assert.equal(propose(action,target,target,false).name,action==='tap'?'android_tap_element':'android_swipe');
    assert.throws(()=>propose(action,{...target,webView:1},target,false),/DELEGATION_WEB_TARGET_CHANGED/);
    assert.throws(()=>propose(action,target,{...target,editable:true},false),/DELEGATION_TARGET_INVALID/);
  });
}
test('browser scrolling requires a target; native vertical scrolling still supports the existing default',()=>{
  const d={action:'scroll',targetIndex:null,value:'up'};
  assert.throws(()=>navigation(d,{elements:[target]},[target],true),/WEB_TARGET_REQUIRED/);
  assert.equal(navigation(d,{elements:[target]},[target],false).name,'android_swipe');
});
test('search transmits the unique observed native resource identifier or refuses before input',()=>{
  const d={action:'search',targetIndex:null,value:'synthetic query'};
  const field={...target,type:'android.widget.EditText',identifier:'org.example:id/search',label:'Search',editable:true,focused:true};
  assert.deepEqual(navigation(d,{elements:[]},[field],false),{name:'android_set_text',args:{text:d.value,resourceId:field.identifier}});
  for (const fresh of [[],[{...field,identifier:undefined}],[{...field,identifier:''}],[{...field,identifier:' '}],
    [field,{...field,focused:false}],[field,{...field,identifier:'org.example:id/note',label:'Note'}],
    [{...field,webView:1}],[{...field,password:true}],[{...field,focused:false}]]) {
    assert.throws(()=>navigation(d,{elements:[]},fresh,false),/DELEGATION_(SEARCH_FIELD_UNAVAILABLE|PASSWORD_BOUNDARY)/);
  }
  assert.throws(()=>navigation(d,{elements:[]},[field],true),/SEARCH_FIELD_UNAVAILABLE/);
});
