"""Phone-preview readiness on Chromium, not Safari or real-device certification.
Uses real isolated HTTP/SQLite, CDP network shaping, and labelled response-loss/audio fixtures.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
checks = []
evidence = {}

def check(name, value):
    assert value, name
    checks.append(name)

async def run(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('BROWSER_EXECUTABLE') or shutil.which('chromium'),
            headless=True, args=['--no-sandbox'])
        evidence['browser'] = browser.version
        try:
            for width,height,scale in [(320,568,2),(390,664,3),(393,852,3),(844,390,3),(1024,768,2)]:
                ctx = await browser.new_context(viewport={'width':width,'height':height},device_scale_factor=scale,is_mobile=True,has_touch=True)
                page = await ctx.new_page()
                errors=[]
                page.on('pageerror', lambda e: errors.append(str(e)))
                await page.goto(base)
                check(f'{width}x{height}@{scale}: layout and mobile instructions', await page.evaluate('''() => {
                    const start=document.getElementById('start-btn').getBoundingClientRect();
                    return document.documentElement.scrollWidth<=innerWidth && start.bottom<=innerHeight &&
                        getComputedStyle(document.querySelector('.desktop-control')).display==='none' &&
                        getComputedStyle(document.querySelector('.touch-control')).display!=='none';
                }'''))
                await page.tap('#start-btn')
                cdp=await ctx.new_cdp_session(page)
                g=await page.locator('#game-area').bounding_box()
                x=g['x']+g['width']*.35; y=g['y']+g['height']*.6
                await cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
                await page.wait_for_function('state.isShooting && state.bullets.length>0')
                start_scroll=await page.evaluate('scrollY')
                await cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+30,'y':y-40}]})
                await cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
                check(f'{width}x{height}: real CDP touch fires, drags, releases without scroll', await page.evaluate('!state.isShooting') and await page.evaluate('scrollY')==start_scroll)
                await page.tap('#pause-btn')
                await page.set_viewport_size({'width':height,'height':width})
                check(f'{width}x{height}: resize keeps paused plane in bounds', await page.evaluate('state.isPaused && state.playerX>=0 && state.playerX+PLAYER_WIDTH<=state.bounds.width'))
                await page.tap('#start-btn')
                check(f'{width}x{height}: resumes with cleared input and no JS errors',await page.evaluate('state.isRunning && !state.isPaused && !state.isShooting') and not errors)
                await ctx.close()

            ctx=await browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,locale='en-US')
            page=await ctx.new_page()
            cdp=await ctx.new_cdp_session(page)
            await cdp.send('Network.enable')
            slow={'offline':False,'latency':750,'downloadThroughput':128*1024,'uploadThroughput':32*1024,'connectionType':'cellular3g'}
            fast={'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1}
            await cdp.send('Network.emulateNetworkConditions',slow)
            await page.goto(base,wait_until='networkidle')
            await page.tap('#start-btn');await page.tap('#pause-btn')
            await page.evaluate('state.run.ready')
            check('750ms latency / 128KiB down / 32KiB up: real run credentials received',await page.evaluate('Boolean(state.run.credentials)'))
            await page.evaluate('state.score=1;endGame("受控弱网结算")')
            await page.wait_for_function('syncStatus.textContent.includes("成绩已同步")',timeout=10000)
            check('slow network: real API accepted score',await page.evaluate('scoreClient.pending.length===0'))
            evidence['network_profile']={'latency_ms':750,'download_KiB_s':128,'upload_KiB_s':32}
            await cdp.send('Network.emulateNetworkConditions',fast)
            await page.tap('#start-btn');await page.tap('#pause-btn');await page.evaluate('state.run.ready')
            await cdp.send('Network.emulateNetworkConditions',{**fast,'offline':True})
            await page.evaluate('state.score=2;endGame("受控断网结算")')
            await page.wait_for_function('syncStatus.textContent.includes("未同步")')
            check('connection loss persists completed run for retry',await page.evaluate('scoreClient.pending.length===1 && JSON.parse(localStorage.getItem(scoreClient.storageKey)).length===1'))
            await page.tap('#start-btn');await page.tap('#pause-btn');await page.evaluate('state.run.ready')
            check('new offline run still starts',await page.evaluate('state.isRunning && !state.run.credentials'))
            await page.evaluate('state.score=3;endGame("受控离线新局")')
            await page.wait_for_function('syncStatus.textContent.includes("未同步")')
            check('offline new run does not discard earlier pending run',await page.evaluate('scoreClient.pending.length===1 && scoreClient.pending[0].score===2'))
            await cdp.send('Network.emulateNetworkConditions',fast)
            await page.wait_for_function('scoreClient.pending.length===0 && syncStatus.textContent.includes("成绩已同步")',timeout=10000)
            check('online event automatically retries actual queued score',await page.evaluate('async()=> (await(await fetch("/api/leaderboard")).json()).entries.some(e=>e.score===2)'))

            # Commit to the real backend, then drop its first response. Reload must retry the identical payload.
            sent=[]
            async def lose_first_response(route):
                if route.request.method!='POST':
                    await route.continue_();return
                sent.append(route.request.post_data)
                if len(sent)==1:
                    response=await route.fetch(headers=await route.request.all_headers())
                    check('response-loss fixture committed original score',response.status==201)
                    await route.abort()
                else: await route.continue_()
            await page.route('**/api/leaderboard',lose_first_response)
            await page.tap('#start-btn');await page.tap('#pause-btn');await page.evaluate('state.run.ready')
            await page.evaluate('state.score=3;endGame("受控响应丢失")')
            await page.wait_for_function('scoreClient.pending.length===1 && !scoreClient.flushing')
            check('lost acknowledgement remains visibly unsynced', '未同步' in await page.locator('#sync-status').inner_text())
            await page.reload()
            await page.wait_for_function('scoreClient.pending.length===0 && syncStatus.textContent.includes("成绩已同步")')
            check('reload resends identical payload and accepts idempotent result',len(sent)==2 and sent[0]==sent[1])
            await page.unroute('**/api/leaderboard',lose_first_response)
            check('real leaderboard retains highest score after retries',await page.evaluate('async()=> (await(await fetch("/api/leaderboard")).json()).entries.some(e=>e.score===3)'))

            # Slow run creation must hit the production 4-second timeout, not a shortened test timeout.
            held=[]
            await page.route('**/api/runs',lambda route: held.append(route))
            await page.tap('#start-btn');await page.tap('#pause-btn')
            await page.wait_for_function('syncStatus.textContent.includes("不会上榜")',timeout=6500)
            check('4-second credential timeout keeps run playable with explicit warning',await page.evaluate('state.isRunning && !state.run.credentials'))
            for route in held:
                try: await route.abort()
                except Exception: pass  # Browser has already aborted the request on timeout.
            await page.unroute('**/api/runs')
            await ctx.close()

            ctx=await browser.new_context()
            page=await ctx.new_page();await page.goto(base);await page.click('#start-btn')
            await page.wait_for_function('state.audioContext && state.audioContext.state==="running"')
            check('user start unlocks real Web Audio context',True)
            await page.click('#pause-btn')
            await page.evaluate('state.audioContext.suspend()')
            await page.click('#start-btn')
            await page.wait_for_function('state.audioContext.state==="running"')
            check('continue gesture resumes suspended audio context',True)
            await page.click('#sound-btn')
            check('mute button state and label',await page.locator('#sound-btn').get_attribute('aria-pressed')=='false' and await page.locator('#sound-btn').get_attribute('aria-label')=='开启音效')
            # Render the real synthesis function into an OfflineAudioContext, not to speakers.
            synthesis='''async enabled=>{
                const previous=state.audioContext, previousEnabled=state.soundEnabled;
                const context=new OfflineAudioContext(1,24000,48000);
                state.audioContext=context;state.soundEnabled=enabled;playHitSound();
                const audio=await context.startRendering(), samples=audio.getChannelData(0);
                state.audioContext=previous;state.soundEnabled=previousEnabled;
                let peak=0,energy=0,tail=0;
                for(let i=0;i<samples.length;i++){peak=Math.max(peak,Math.abs(samples[i]));energy+=samples[i]**2;if(i>16000)tail=Math.max(tail,Math.abs(samples[i]));}
                return {peak,rms:Math.sqrt(energy/samples.length),tail,sampleRate:audio.sampleRate};
            }'''
            muted=await page.evaluate(synthesis,False)
            check('muted hit synthesizes silence',muted['peak']==0)
            await page.click('#sound-btn')
            active=await page.evaluate(synthesis,True)
            evidence['audio_signal']=active
            check('hit synthesizes finite non-clipping signal with silent tail',0<active['peak']<1 and active['rms']>0 and active['tail']==0)
            await ctx.close()
        finally: await browser.close()

with tempfile.TemporaryDirectory(prefix='airplane-playtest-check-') as data_dir:
    server=subprocess.Popen(['node','backend/server.js'],cwd=ROOT,
        env={**os.environ,'DATA_DIR':data_dir,'PORT':'0','HOST':'127.0.0.1'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        base='http://127.0.0.1:'+server.stdout.readline().strip().rsplit(' ',1)[1]
        asyncio.run(run(base))
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
print(json.dumps({'passed':len(checks),'evidence':evidence,'checks':checks},ensure_ascii=False,indent=2))
