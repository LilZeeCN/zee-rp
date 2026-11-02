import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{launchChrome}from'../studio/cdp.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('new tabs receive their viewport before the first page script and navigation observes the new loader',async t=>{
 const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<script>window.firstViewport=[innerWidth,innerHeight,devicePixelRatio];window.pageMarker='+JSON.stringify(req.url)+';</script><p>Controlled page</p>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await launchChrome({width:912,height:700,dpr:1.25});t.after(async()=>{await browser.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));});const url=`http://127.0.0.1:${server.address().port}`;
 for(let i=0;i<3;i++){const page=await browser.openPage(url+'/first-'+i);assert.deepEqual(await page.evaluate('window.firstViewport'),[912,700,1.25]);await page.navigate(url+'/next-'+i);assert.equal(await page.evaluate('window.pageMarker'),'/next-'+i);await page.close();}
});

test('failed browser startup releases its own profile before returning an error',t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-startup-failure-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const source=`import {launchChrome} from ${JSON.stringify(new URL('../studio/cdp.mjs',import.meta.url).href)};try{await launchChrome();process.exitCode=1;}catch(error){console.log(JSON.stringify({failed:true,message:error.message}));}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,TMPDIR:dir,CHROME_BIN:process.execPath},encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert(JSON.parse(result.stdout).failed);assert.deepEqual(readdirSync(dir),[]);
});
