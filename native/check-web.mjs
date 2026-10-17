// Run after scripts/build-rusterize.sh. Uses the actual compiled WASM and host.
import { chromium } from '../node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = '<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOB test</title><style>body{margin:16px;background:#11151e;color:white;font:16px sans-serif}canvas{display:block;width:100%;height:560px;border-radius:20px}button{margin-top:12px}</style><canvas id="map"></canvas><button id="after">После карты</button></html>';
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname;
  if (name === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture); return; }
  const local = name.startsWith('/rusterize/') ? '/public' + name : name;
  if (local.includes('..')) { response.writeHead(400).end(); return; }
  try {
    const bytes = await readFile(path.join(root, local));
    response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless:true, args:['--no-sandbox'] });
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:850},deviceScaleFactor:2,isMobile:mobile,hasTouch:mobile});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(async () => {
      const {createDreamMap} = await import('/src/rusterize.js');
      const image = document.createElement('canvas');image.width=image.height=32;
      image.getContext('2d').fillStyle='#e02e52';image.getContext('2d').fillRect(0,0,32,32);
      window.graph = {nodes:[{id:'forest',name:'Тихий лес',x:300,y:300,count:12,lucidCount:4,image:image.toDataURL()},{id:'city',name:'Город у моря',x:700,y:410,count:7,lucidCount:1}],edges:[{source:'forest',target:'city',count:3}],characters:[{id:'friend',name:'Саша',locations:['forest','city']}]};
      window.opened=[];window.moves=[];
      window.map=await createDreamMap(document.querySelector('canvas'),{...window.graph,onOpen:id=>opened.push(id),onMove:(id,position)=>moves.push({id,...position}),onError:error=>{throw error;}});
    });
    await page.waitForFunction(() => map.frameCount > 2);
    assert.equal(await page.title(), 'MOB test');
    assert.equal(await page.locator('canvas').getAttribute('data-engine'), 'rusterize-wasm');
    let position = await page.evaluate(()=>map.position('forest'));
    const box = await page.locator('canvas').boundingBox();
    const pixel = await page.evaluate(p=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(Math.round(p.screenX*2),Math.round(p.screenY*2),1,1).data),position);
    assert.deepEqual(pixel,[224,46,82,255],'Rust Image command renders the local illustration');
    await page.mouse.click(box.x+position.screenX,box.y+position.screenY);
    assert.deepEqual(await page.evaluate(()=>opened),['forest']);
    await page.mouse.move(box.x+position.screenX,box.y+position.screenY);
    await page.mouse.down();await page.mouse.move(box.x+position.screenX+48,box.y+position.screenY+24,{steps:8});await page.mouse.up();
    const moved = await page.evaluate(()=>moves.at(-1));
    assert.equal(moved.id,'forest');assert.ok(moved.x>300 && moved.y>300);
    assert.equal(await page.evaluate(()=>opened.length),1,'A drag must not open a location');
    await page.evaluate(()=>map.focus('city'));
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>opened.at(-1)),'city');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'after','Canvas does not trap keyboard focus');
    await page.evaluate(()=>{map.zoom(1.25);map.reset();});
    const before = await page.evaluate(()=>map.frameCount);
    await page.waitForTimeout(160);
    assert.ok(await page.evaluate(()=>map.frameCount)>before,'Characters animate through Rust Frame events');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForTimeout(100);
    const quiet = await page.evaluate(()=>map.frameCount);
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(()=>map.frameCount),quiet,'Reduced motion stays idle');
    await page.evaluate(()=>map.update({...graph,characters:[]}));
    await page.waitForTimeout(80);
    const idle = await page.evaluate(()=>map.frameCount);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>map.frameCount),idle,'A static graph does not run a permanent RAF loop');
    await page.setViewportSize(mobile?{width:360,height:800}:{width:1024,height:768});
    await page.waitForTimeout(80);
    assert.equal(await page.locator('canvas').evaluate(c=>c.width), mobile?656:1984);
    await mkdir('/tmp/mob-map-check',{recursive:true});
    await page.screenshot({path:`/tmp/mob-map-check/${mobile?'mobile':'desktop'}.png`});
    await page.evaluate(()=>{map.destroy();map.destroy();});
    assert.equal(await page.locator('canvas').getAttribute('data-engine'),null);
    assert.deepEqual(errors,[]);
    console.log(`PASS ${mobile?'mobile':'desktop'}: real WASM drawing/image, click, drag, keyboard, zoom, animation, reduced motion, idle, resize/DPI, destroy`);
    await page.close();
  }
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
