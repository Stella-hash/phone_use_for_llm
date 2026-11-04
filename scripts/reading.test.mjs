import test from 'node:test';
import assert from 'node:assert/strict';
import { readingCursor } from '../dist/reading.js';
import { UiInspector } from '../dist/ui.js';

const xhs = 'com.xingin.xhs', moo = 'com.moomoo.trade.ca';
const para1 = 'The first long paragraph describes a quiet afternoon beside the river and a walk across the old stone bridge.';
const para2 = 'The second long paragraph describes the market stalls, the books for sale, and the people stopping to read.';
const para3 = 'The third long paragraph describes the journey home after the evening lights had appeared in the windows.';
const node = (pkg, id, text, y = 200, extra = {}) => ({type:'android.widget.TextView',
  ...(id ? {identifier:`${pkg}:id/${id}`} : {}), ...(text ? {text} : {}),
  rect:{x:0,y,width:1000,height:200}, ...extra});
const event = (id, pkg, elements) => ({id,outcome:'completed',tool:'android_drag',
  observation:{at:'2026-11-03T00:00:00Z',foregroundApp:{packageName:pkg},elements}});
const caption = (id, text=para1, y=500, title='A quiet day', author='Writer') => event(id,xhs,[
  node(xhs,'noteDetailRoot'), node(xhs,'noteTitleTV',title), node(xhs,'nickNameTV',author),
  node(xhs,'imageNoteTextView',text,y), node(xhs,'commentText',para3),
  node(xhs,'noteLikeTV','18'), node(xhs,'inputCommentTV','Say something'),
]);
const article = (id, texts, offset=0, title='A quiet day') => event(id,moo,[
  node(moo,'media_detail_content_container'), ...(title ? [node(moo,'title_text',title)] : []),
  node(moo,title?'author_name_text':'toolbar_user_name','Writer'),
  ...texts.map((text,i)=>node(moo,null,text,offset+i*220,{webView:1})),
  node(moo,null,null,0,{type:'android.webkit.WebView',webView:1}),
  node(moo,'comment_text_view',para3,2600),
]);

test('caption is delivered from its exact source once; comments and counts are excluded',()=>{
  const text = '第一段保留原来的标点、换行和空格。\n\t\n第二段讨论的是阅读位置，不能把评论区新出现的话当成作者正文，也不能替操作者决定要读哪一篇。';
  const first = caption(1,text), next = caption(2,text,100);
  const seeded = readingCursor(first);
  assert.equal(seeded.status,'seeded'); assert.deepEqual(seeded.new_text,[text]);
  assert.equal(seeded.same_post,null); assert.equal(seeded.needs_review,false);
  const delta = readingCursor(next, first);
  assert.deepEqual(delta.new_text,[]); assert.equal(delta.same_post,true);
  assert.equal(delta.scroll_result,'advanced'); assert.equal(delta.cursor_event_id,2);
  assert.equal(delta.overlap_anchor,text.slice(-120));
});

test('article overlap survives changing quote prefix and returns only new paragraphs',()=>{
  const first=article(1,['101.5',para1,para2],500);
  const next=article(2,['102.2',para1,para2,para3],0,null);
  const result=readingCursor(next,first);
  assert.equal(result.status,'advanced'); assert.deepEqual(result.new_text,[para3]);
  assert.equal(result.same_post,true); assert.equal(result.needs_review,false);
  assert.match(result.identity_basis,/derived/);
  assert.equal(result.source.scope,'article_webview');
  assert.equal(result.cursor_event_id,2);
});

test('ambiguity, missing overlap and conflicting post evidence preserve the prior cursor',()=>{
  const before=article(1,[para1,para1]);
  for (const after of [article(2,[para1,para3]),article(2,[para2,para3])]) {
    const result=readingCursor(after,before);
    assert.equal(result.needs_review,true); assert.equal(result.same_post,null);
    assert.equal(result.issue,'no_unique_overlap'); assert.deepEqual(result.new_text,[]);
    assert.equal(result.cursor_event_id,1);
  }
  const changed=readingCursor(caption(2,para1,100,'Another post'),caption(1));
  assert.equal(changed.same_post,false); assert.equal(changed.needs_review,true);
  assert.equal(changed.cursor_event_id,1);
});

test('backward views keep the forward cursor so a later forward view is not delivered twice',()=>{
  const before=article(1,[para1,para2,para3],0);
  const backward=article(2,[para1,para2],500);
  const result=readingCursor(backward,before);
  assert.equal(result.status,'backward'); assert.deepEqual(result.new_text,[]);
  assert.equal(result.cursor_event_id,1);
  const same=readingCursor(article(3,[para1,para2,para3],0),before);
  assert.deepEqual(same.new_text,[]);
});

test('private, missing, oversized and unscoped sources never fabricate text',()=>{
  const privateEvent=caption(1); privateEvent.callerClaim={private:true};
  privateEvent.observation.screenshot={filename:'private'};
  const missing=caption(2); missing.observation.elements=[];
  const old=article(3,[para1]); for(const e of old.observation.elements) delete e.webView;
  const huge=caption(4,'x'.repeat(16001));
  const duplicate=caption(5); duplicate.observation.elements.push(node(xhs,'imageNoteTextView',para1));
  for (const [source,reason] of [[privateEvent,'private_observation'],[missing,'body_unavailable'],
    [old,'webview_scope_unavailable'],[huge,'source_too_large'],[duplicate,'ambiguous_body']]) {
    const result=readingCursor(source);
    assert.equal(result.issue,reason); assert.deepEqual(result.new_text,[]);
    assert.equal(result.needs_review,true); assert.equal(result.evidence_available,false);
  }
  assert.throws(()=>readingCursor(null),/not found/);
  assert.throws(()=>readingCursor(caption(1),caption(1)),/earlier/);
});

test('repeated source content at distinct positions is retained, but same-node duplicate output is removed',()=>{
  const source=article(1,[para1,para1]);
  source.observation.elements.splice(4,0,structuredClone(source.observation.elements[3]));
  const result=readingCursor(source);
  assert.deepEqual(result.new_text,[para1,para1]);
});

test('nested WebView wrappers share an article scope; sibling WebViews remain ambiguous',()=>{
  const nested=article(1,[para1,para2]);
  nested.observation.elements.push(node(moo,null,null,0,{type:'android.webkit.WebView',webView:1}));
  assert.deepEqual(readingCursor(nested).new_text,[para1,para2]);
  nested.observation.elements.push(node(moo,null,null,0,{type:'android.webkit.WebView',webView:2}));
  assert.equal(readingCursor(nested).issue,'article_scope_unavailable');
});

test('WebView groups preserve XML ancestry and do not absorb native siblings or another WebView',()=>{
  const xml='<?xml version="1.0"?><hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][100,200]">'
    +'<node class="android.widget.TextView" text="native title" bounds="[0,0][100,20]"/>'
    +'<node class="android.webkit.WebView" bounds="[0,20][100,100]"><node class="android.webkit.WebView" bounds="[0,20][100,100]">'
    +'<node class="android.widget.TextView" text="article paragraph" bounds="[0,20][100,80]"/></node></node>'
    +'<node class="android.widget.TextView" text="native comments" bounds="[0,100][100,150]"/>'
    +'<node class="android.webkit.WebView" bounds="[0,150][100,200]"><node class="android.widget.TextView" text="second frame" bounds="[0,150][100,200]"/></node>'
    +'</node></hierarchy>';
  const elements=new UiInspector({adb:()=>Buffer.from(xml)}).getElements('test');
  assert.equal(elements.find(e=>e.text==='native title').webView,undefined);
  assert.equal(elements.find(e=>e.text==='native comments').webView,undefined);
  assert.equal(elements.find(e=>e.text==='article paragraph').webView,1);
  assert.equal(elements.find(e=>e.text==='second frame').webView,2);
  assert.deepEqual(elements.filter(e=>e.type==='android.webkit.WebView').map(e=>e.webView),[1,1,2]);
});

test('media position belongs to the current frame even when the text cursor stays backward',()=>{
  const before=caption(1,para1,100), after=caption(2,para1,900);
  before.observation.elements.push(node(xhs,'imageNumberTextView','1/7'));
  after.observation.elements.push(node(xhs,'imageNumberTextView','7/7'));
  const result=readingCursor(after,before);
  assert.equal(result.status,'backward'); assert.equal(result.scroll_result,'backward');
  assert.equal(result.cursor_event_id,1); assert.equal(result.evidence_frame,2);
  assert.equal(result.media_index,7); assert.equal(result.media_total,7);
  assert.equal(after.observation.elements[result.source.media_element_index].text,'7/7');
  assert.deepEqual(result.new_text,[]); assert.equal(result.needs_review,false);
});

test('missing, invalid or ambiguous media counters do not block good text or inherit an old counter',()=>{
  const previous=caption(1);
  previous.observation.elements.push(node(xhs,'imageNumberTextView','2/7'));
  for (const counters of [[],['0/7'],['8/7'],['3/0'],['Picture 3 of 7'],['3/7','4/7'],['3/7','3/7'],['9007199254740992/9007199254740992']]) {
    const current=caption(2);
    for(const text of counters)current.observation.elements.push(node(xhs,'imageNumberTextView',text));
    const result=readingCursor(current,previous);
    assert.equal(result.media_index,null); assert.equal(result.media_total,null);
    assert.equal(result.source.media_element_index,null);
    assert.equal(result.needs_review,false); assert.deepEqual(result.new_text,[]);
  }
  const privateEvent=caption(2);
  privateEvent.observation.elements.push(node(xhs,'imageNumberTextView','3/7'));
  privateEvent.callerClaim={private:true};
  assert.equal(readingCursor(privateEvent).media_index,null);
});

test('an observed media count remains available when this note has no caption text',()=>{
  const current=caption(1);
  current.observation.elements=current.observation.elements.filter(e=>!e.identifier.endsWith('/imageNoteTextView'));
  current.observation.elements.push(node(xhs,'imageNumberTextView',' 3 / 7 '));
  const result=readingCursor(current);
  assert.equal(result.media_index,3); assert.equal(result.media_total,7);
  assert.equal(result.issue,'body_unavailable'); assert.equal(result.cursor_event_id,null);
});
