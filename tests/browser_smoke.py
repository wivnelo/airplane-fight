"""Isolated Chromium regression checks. Requires Python playwright + Chromium.
Run: python3 tests/browser_smoke.py (starts/stops its own API and temporary DB).
BROWSER_EXECUTABLE can select a Chromium binary. No production data is touched.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
checks = []
def check(name, condition):
    assert condition, name
    checks.append(name)

with tempfile.TemporaryDirectory(prefix='airplane-browser-') as data_dir:
    server = subprocess.Popen(['node', 'backend/server.js'], cwd=ROOT,
        env={**os.environ, 'DATA_DIR': data_dir, 'PORT': '0', 'HOST': '127.0.0.1'},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = server.stdout.readline().strip()
        base = 'http://127.0.0.1:' + line.rsplit(' ', 1)[1]
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('BROWSER_EXECUTABLE') or shutil.which('chromium'),
                headless=True, args=['--no-sandbox'])
            try:
                page = browser.new_page(viewport={'width': 1280, 'height': 1000})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base)
                page.click('#start-btn')
                page.wait_for_timeout(150)
                check('start retains manual shooting', page.evaluate('state.isRunning && !state.isPaused && !state.isShooting'))
                box = page.locator('#game-area').bounding_box()
                page.mouse.move(box['x'] + 80, box['y'] + 150)
                check('mouse horizontal movement', page.evaluate('state.playerX < 100'))
                page.mouse.down(); page.wait_for_timeout(250)
                check('mouse press shoots', page.evaluate('state.isShooting && state.bullets.length > 0'))
                page.mouse.up()
                check('mouse release stops', page.evaluate('!state.isShooting'))
                page.keyboard.down('Space'); page.wait_for_timeout(250)
                check('space shoots', page.evaluate('state.isShooting'))
                page.keyboard.up('Space')
                check('space release stops', page.evaluate('!state.isShooting'))
                page.click('#leaderboard-btn')
                check('leaderboard pauses without ending', page.evaluate('state.isRunning && state.isPaused'))
                frozen = page.evaluate('({time:state.gameTime,score:state.score,y:state.enemies.map(e=>e.y)})')
                page.wait_for_timeout(400)
                check('hidden board freezes simulation', frozen == page.evaluate('({time:state.gameTime,score:state.score,y:state.enemies.map(e=>e.y)})'))
                page.keyboard.press('Escape')
                check('return requires deliberate resume', page.locator('#start-btn').inner_text() == '继续游戏')
                page.click('#start-btn');page.wait_for_timeout(100)
                check('resume keeps current score', page.evaluate('state.isRunning && !state.isPaused') and page.evaluate('state.score') >= frozen['score'])
                # Existing-function fixture for shield timing; no rule changes.
                remaining = page.evaluate('() => {applyPowerUp(POWER_UP_TYPES[3],state.gameTime);window.dispatchEvent(new Event("blur"));return state.shieldExpiresAt-state.gameTime;}')
                page.wait_for_timeout(300)
                check('blur clears inputs and freezes shield', page.evaluate('state.isPaused && !state.isShooting') and remaining == page.evaluate('state.shieldExpiresAt-state.gameTime'))
                page.click('#start-btn')
                page.set_viewport_size({'width':600,'height':1000})
                box=page.locator('#game-area').bounding_box();page.mouse.move(box['x']+box['width']-2,box['y']+150)
                page.set_viewport_size({'width':320,'height':568});page.wait_for_timeout(100)
                check('resize clamps plane inside bounds', page.evaluate('state.playerX>=0 && state.playerX+PLAYER_WIDTH<=state.bounds.width'))
                # End/restart fixture checks transition and no extra RAF after collision.
                page.evaluate('state.hasShield=false;spawnSingleEnemy();const e=state.enemies.at(-1);e.x=state.playerX;e.y=state.bounds.height-70;e.speed=0;e.element.style.left=e.x+"px";e.element.style.top=e.y+"px"')
                page.wait_for_function('!state.isRunning')
                check('collision ends once with no RAF left', page.evaluate('state.animationFrame === null'))
                page.click('#start-btn')
                check('restart clears entities and score',page.evaluate('state.isRunning && state.score===0 && state.enemies.length===0 && state.bullets.length===0'))
                deadline=time.time()+20
                while page.evaluate('state.isRunning') and time.time()<deadline:
                    target=page.evaluate('state.enemies.length ? state.enemies[0].element.getBoundingClientRect().toJSON() : null')
                    if target:
                        page.mouse.move(target['x']+target['width']/2, min(450,target['y']+30))
                    page.wait_for_timeout(100)
                check('natural enemy collision ends a real run',page.evaluate('!state.isRunning'))
                page.click('#start-btn')
                check('restart after natural death',page.evaluate('state.isRunning && state.score===0'))
                page.wait_for_timeout(100)
                page.evaluate('cancelAnimationFrame(state.animationFrame);update(state.lastTime+1000)')
                check('long frame pauses instead of jumping collisions',page.evaluate('state.isPaused && state.animationFrame===null'))
                page.click('#start-btn')
                page.evaluate('spawnSingleEnemy();const targetEnemy=state.enemies.at(-1);targetEnemy.x=state.playerX+3;targetEnemy.y=state.bounds.height-130;targetEnemy.speed=0;targetEnemy.element.style.left=targetEnemy.x+"px";targetEnemy.element.style.top=targetEnemy.y+"px"')
                page.keyboard.down('Space')
                page.wait_for_function('state.score>=1',timeout=3000)
                page.keyboard.up('Space')
                page.evaluate('endGame("受控结算检查")')
                page.wait_for_function('document.getElementById("sync-status").textContent.includes("成绩已同步")',timeout=5000)
                check('browser score reaches real isolated API',page.evaluate('scoreClient.pending.length===0') and page.evaluate('async () => (await (await fetch("/api/leaderboard")).json()).entries.some(e=>e.score>=1)'))
                check('desktop has no JS errors',not errors)
                page.close()
                # Real CDP touch input, not synthesized DOM touch events.
                ctx=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
                mobile=ctx.new_page();mobile.goto(base);mobile.tap('#start-btn')
                g=mobile.locator('#game-area').bounding_box();cdp=ctx.new_cdp_session(mobile)
                def touch(kind,x=0,y=0):
                    cdp.send('Input.dispatchTouchEvent', {'type':kind,'touchPoints':[] if kind=='touchEnd' else [{'x':x,'y':y}]})
                touch('touchStart',g['x']+90,g['y']+230);mobile.wait_for_timeout(250)
                check('touch hold shoots',mobile.evaluate('state.isShooting && state.bullets.length>0'))
                x=mobile.evaluate('state.playerX');scroll=mobile.evaluate('scrollY')
                for i in range(1,5):
                    touch('touchMove',g['x']+90+i*15,g['y']+230-i*20);mobile.wait_for_timeout(40)
                check('touch drag moves without page scroll',mobile.evaluate('state.playerX')>x and mobile.evaluate('scrollY')==scroll)
                touch('touchEnd');check('touch release stops',mobile.evaluate('!state.isShooting'))
                touch('touchStart',g['x']+100,g['y']+200)
                pointer_id=mobile.evaluate('state.pointerId')
                check('second touch activates input',pointer_id is not None and mobile.evaluate('state.isShooting'))
                mobile.dispatch_event('#game-area','pointercancel',{'pointerId':pointer_id})
                check('active pointer cancel stops shooting',mobile.evaluate('!state.isShooting && state.pointerId===null'))
                touch('touchEnd')
                ctx.close()
                for width,height in [(320,568),(390,844),(844,390)]:
                    ctx=browser.new_context(viewport={'width':width,'height':height},is_mobile=True,has_touch=True)
                    m=ctx.new_page();m.goto(base)
                    g=m.locator('#game-area').bounding_box();start=m.locator('#start-btn').bounding_box()
                    check(f'layout {width}x{height}: game and start visible',g['width']>100 and g['y']>=0 and g['y']+g['height']<=height and start['y']+start['height']<=height)
                    ctx.close()
                off=browser.new_page();off.route('**/api/**',lambda route:route.abort());off.goto(base);off.click('#start-btn');off.wait_for_timeout(200)
                check('offline still playable with visible warning',off.evaluate('state.isRunning') and '不会上榜' in off.locator('#sync-status').inner_text())
                off.close()
            finally:
                browser.close()
    finally:
        server.terminate()
        try:server.wait(timeout=5)
        except subprocess.TimeoutExpired:server.kill();server.wait()
print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
