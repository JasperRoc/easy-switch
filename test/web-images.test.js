import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseWebImageRequest, WebImages } from '../desktop/web-images.js';

const request = (body = { prompt: 'draw a bird' }) => ({ raw: Buffer.from(JSON.stringify(body)), contentType: 'application/json', route: '/v1/images/generations', signal: new AbortController().signal });
test('web images retain the image prompt, parse inline and multipart reference bytes, and reject unsupported controls', async () => {
 const image='data:image/png;base64,aW1hZ2U=';
 const parsed=await parseWebImageRequest({...request({prompt:'draw a bird',images:[{image_url:image}],background:'transparent'}),route:'/v1/images/edits'});
 assert.match(parsed.prompt,/draw a bird/);assert.match(parsed.prompt,/transparent/);assert.equal(parsed.files[0].bytes.toString(),'image');
 const form=new FormData();form.set('prompt','edit this');form.append('image',new Blob(['reference'],{type:'image/png'}),'ref.png');
 const encoded=new Response(form);
 const multipart=await parseWebImageRequest({raw:Buffer.from(await encoded.arrayBuffer()),contentType:encoded.headers.get('content-type'),route:'/v1/images/edits'});
 assert.equal(multipart.files[0].bytes.toString(),'reference');
 for(const body of [{prompt:''},{prompt:'x',n:2},{prompt:'x',mask:'value'},{prompt:'x',images:[{image_url:'https://private.example/secret'}]},{prompt:'x',images:[{file_id:'private'}]}])await assert.rejects(parseWebImageRequest(request(body)),error=>error.status===400);
 await assert.rejects(parseWebImageRequest({...request(),route:'/v1/images/edits'}),/reference/);
});

function fixture(t, { mode='image' }={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-web-image-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let windows=[],sessions=[],submitted=false,clock=0;const commands=[];
 class Window extends EventEmitter {
  constructor(options){super();this.options=options;this.visible=options.show;this.destroyed=false;windows.push(this);
   this.webContents=new EventEmitter();Object.assign(this.webContents,{setWindowOpenHandler(){},setBackgroundThrottling(){},getURL:()=>this.url,stop(){},debugger:{attach(){},detach(){},async sendCommand(method,params){commands.push({method,params});return method==='DOM.getDocument'?{root:{nodeId:1}}:{nodeId:2};}},
   executeJavaScriptInIsolatedWorld:async(_id,[{code}])=>{
    if(code.includes('function inspectImagePage'))return{composer:true,login:mode==='login',verification:false,busy:false,images:submitted&&mode==='image'?[{url:'https://chatgpt.com/backend-api/files/file/download',width:1024,height:1024}]:[]};
    if(code.includes('function focusImageComposer'))return true;
    if(code.includes('function submitImageComposer')){submitted=true;return true;}
    if(code.includes('function readGeneratedImage'))return Buffer.from('fixture-image').toString('base64');
    throw Error('Unexpected page operation');
   }});
  }
  async loadURL(url){this.url=url;this.webContents.emit('did-finish-load');}
  show(){this.visible=true;}focus(){}isVisible(){return this.visible;}isDestroyed(){return this.destroyed;}
  destroy(){this.destroyed=true;this.webContents.emit('destroyed');this.emit('closed');}
 }
 const browser={async setProxy(settings){this.proxy=settings;},setPermissionRequestHandler(){},setPermissionCheckHandler(){},flushStorageData(){},cookies:{async flushStore(){}},async clearStorageData(){this.cleared=true;},async clearCache(){}};
 const adapter=new WebImages({root,BrowserWindow:Window,session:{fromPartition(partition){sessions.push(partition);return browser;}},nativeImage:{createFromBuffer:()=>({isEmpty:()=>false})},enabled:()=>true,network:()=>({httpsProxy:'http://127.0.0.1:7890'}),now:()=>clock+=1000});
 t.after(()=>adapter.close());return{adapter,root,windows,sessions,browser,commands};
}
test('browser image output uses its own session and returns native image JSON without any Codex login',async t=>{
 const {adapter,root,sessions,browser,commands}=fixture(t);
 const response=await adapter.handle(request());
 assert.equal(response.status,200);assert.equal((await response.json()).data[0].b64_json,Buffer.from('fixture-image').toString('base64'));
 assert.equal(response.headers.get('x-switch-image-route'),'chatgpt-web');
 assert.deepEqual(sessions,['persist:easy-switch-web-images']);assert.match(browser.proxy.proxyRules,/7890/);
 assert.equal(fs.existsSync(path.join(root,'auth.json')),false);assert.equal(fs.existsSync(path.join(root,'config.toml')),false);
 assert.match(commands.find(command=>command.method==='Input.insertText').params.text,/draw a bird/);
 assert.equal(adapter.pending,false);assert.equal(adapter.window,null,'a hidden completed web page is destroyed');
});
test('a required official sign-in opens only the isolated image window and never submits generation',async t=>{
 const {adapter,windows,commands}=fixture(t,{mode:'login'});const response=await adapter.handle(request());
 assert.equal(response.status,401);assert.equal(windows[0].visible,true);assert.equal(adapter.snapshot().phase,'signin');assert.equal(commands.length,0);
 await adapter.disconnect();assert.equal(adapter.snapshot().phase,'disconnected');
});
test('a concurrent web image job is rejected without replacing the running job and disabled routing returns control',async t=>{
 const {adapter}=fixture(t);adapter.pending=true;
 assert.equal((await adapter.handle(request())).status,409);
 await assert.rejects(adapter.disconnect(),/current image/);adapter.pending=false;
 adapter.enabled=()=>false;assert.equal(await adapter.handle(request()),null);
});

test('request cancellation destroys the isolated page and removes temporary reference uploads',async t=>{
 const {adapter,root}=fixture(t);const abort=new AbortController();
 const pending=adapter.handle({...request({prompt:'edit',images:[{image_url:'data:image/png;base64,aW1hZ2U='}]}),signal:abort.signal});
 await new Promise(resolve=>setImmediate(resolve));abort.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(adapter.pending,false);assert.equal(adapter.window,null);
 const uploads=path.join(root,'web-images','uploads');assert.ok(!fs.existsSync(uploads)||fs.readdirSync(uploads).length===0);
});

test('web sign-in, image data and file URLs never appear in the public snapshot',async t=>{
 const {adapter}=fixture(t);await adapter.connect();const snapshot=adapter.snapshot();
 assert.deepEqual(Object.keys(snapshot),['enabled','phase']);assert.doesNotMatch(JSON.stringify(snapshot),/cookie|token|chatgpt\.com|fixture-image/);
});

test('clearing a saved web login after an app restart clears the isolated profile before it is opened',async t=>{
 const {adapter,browser,sessions,root}=fixture(t);assert.equal(adapter.browser,null);
 await adapter.disconnect();assert.equal(browser.cleared,true);assert.deepEqual(sessions,['persist:easy-switch-web-images']);assert.equal(adapter.window,null);
});

test('native client retries reuse the same turn image result instead of submitting a second webpage request',async t=>{
 const {adapter}=fixture(t);let calls=0;
 adapter.generate=async()=>{calls++;return{data:[{b64_json:'fixture'}]};};
 const first={...request(),turnId:'turn-fixture'};
 assert.equal((await adapter.handle(first)).status,200);assert.equal((await adapter.handle(first)).status,200);assert.equal(calls,1);
 adapter.generate=async()=>{calls++;throw Object.assign(new Error('quota exhausted'),{status:429});};
 const second={...request(),turnId:'turn-quota'};assert.equal((await adapter.handle(second)).status,429);assert.equal((await adapter.handle(second)).status,429);assert.equal(calls,2);
 await adapter.disconnect();assert.equal(adapter.results.size,0);
});
