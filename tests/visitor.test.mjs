import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { classifyLanding, unobscuredHeadline } from '../scripts/visitor-check.mjs';
import { validVisitor, visitorObservation, visitorView } from '../public/visitor-model.mjs';

const root='https://yomumi.moe/', destination=root+'coming-soon/';
const ok={url:destination,redirects:[root,destination],status:200,mime:'text/html; charset=utf-8',pageTitle:'Yomumi - Coming Soon | Every Story Begins with a Dream',headingVisible:true,headingText:'Yomumi: Coming Soon'};
test('the public browser must reach and render the official landing from the root',()=>{
  assert.equal(classifyLanding(ok),'coming_soon');
  assert.equal(classifyLanding({...ok, url:root, redirects:[root]}),'coming_soon');
  for (const bad of [{url:'https://example.org/'},{redirects:[destination]}, {redirects:[root,'https://example.org/',destination]}, {headingVisible:false},{mime:'application/json'},{headingText:'Sign in'},{pageTitle:'Other page'}]) {
    assert.equal(classifyLanding({...ok,...bad}),'unexpected_page');
  }
  assert.equal(classifyLanding({...ok,status:403}),'challenge');
  assert.equal(classifyLanding({...ok,status:200,challenge:true}),'challenge');
  assert.equal(classifyLanding({...ok,status:503}),'unavailable');
});
test('external results cannot be substituted between networks or kept green after expiry',()=>{
  const now=Date.UTC(2026,10,21,1);
  const value=visitorObservation('github_hosted','coming_soon',new Date(now).toISOString());
  assert.equal(visitorView(value,'github_hosted',now).state,'operational');
  assert.equal(visitorView(value,'cloudflare_public_http',now).state,'unknown');
  assert.equal(visitorView(value,'github_hosted',now+46*60_000).label,'Observation expired');
  assert.equal(validVisitor({...value,status:'unknown'},'github_hosted',now),false);
  assert.equal(validVisitor({...value,token:'extra'},'github_hosted',now),false);
  assert.equal(validVisitor({...value,checkedAt:'2026-02-31T00:00:00.000Z'},'github_hosted',now),false);
  assert.equal(validVisitor({...value,checkedAt:new Date(now+60_001).toISOString()},'github_hosted',now),false);
});
test('the browser waits until the visible word is on screen and unobstructed',()=>{
  function frame({hit=true,visible=true,left=12,wordText='Coming Soon'}={}) {
    const word={textContent:wordText,checkVisibility:()=>visible,getBoundingClientRect:()=>({left,top:10,width:120,height:50})};
    const heading={innerText:'Yomumi: Coming Soon',querySelector:()=>word,contains:target=>target===word};
    const document={querySelector:()=>heading,elementFromPoint:()=>hit?word:{id:'loading-overlay'}};
    return vm.runInNewContext('('+unobscuredHeadline.toString()+')()', {document, innerWidth:640, innerHeight:480});
  }
  assert.equal(frame(),'Yomumi: Coming Soon');
  for(const state of [{hit:false},{visible:false},{left:1000},{wordText:''}]) assert.equal(frame(state),false);
});
