import test from 'node:test';import assert from 'node:assert/strict';import tray from '../desktop/tray.cjs';
import { EventEmitter } from 'node:events';
test('macOS and Windows tray clicks reopen settings while right clicks open the current provider menu', () => {
 for (const platform of ['darwin', 'win32']) {
  const icon = new EventEmitter(), menus = []; let opened = 0, menu = { version: 1 };
  icon.popUpContextMenu = value => menus.push(value);
  tray.bindTrayActions(icon, () => opened++, () => menu, platform);
  icon.emit('click'); assert.equal(opened, 1);
  icon.emit('right-click'); assert.equal(opened, 1); assert.equal(menus[0], menu);
  menu = { version: 2 }; icon.emit('right-click'); assert.equal(menus[1], menu);
  icon.emit('double-click'); assert.equal(opened, platform === 'win32' ? 2 : 1);
 }
});
test('tray identities remain stable and offscreen items are detected without flagging an auto-hidden menu bar',()=>{
 assert.equal(tray.trayIdentity('/profile'),tray.trayIdentity('/profile'));assert.notEqual(tray.trayIdentity('/profile'),tray.trayIdentity('/other'));
 const displays=[{bounds:{x:0,y:0,width:2560,height:1080}}];
 assert.equal(tray.menuBarHidden({x:-8400,y:0,width:38},displays),true);assert.equal(tray.menuBarHidden({x:100,y:-30,width:38},displays),false);
});
