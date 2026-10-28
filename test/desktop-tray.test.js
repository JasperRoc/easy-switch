import test from 'node:test';import assert from 'node:assert/strict';import tray from '../desktop/tray.cjs';
test('tray identities remain stable and offscreen items are detected without flagging an auto-hidden menu bar',()=>{
 assert.equal(tray.trayIdentity('/profile'),tray.trayIdentity('/profile'));assert.notEqual(tray.trayIdentity('/profile'),tray.trayIdentity('/other'));
 const displays=[{bounds:{x:0,y:0,width:2560,height:1080}}];
 assert.equal(tray.menuBarHidden({x:-8400,y:0,width:38},displays),true);assert.equal(tray.menuBarHidden({x:100,y:-30,width:38},displays),false);
});
