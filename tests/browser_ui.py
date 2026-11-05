"""Pixel UI regression: isolated API, Chromium emulation and explicit response fixtures.
Run: python3 tests/browser_ui.py. Screenshots are internal review only, not test artifacts.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)

def fits_overlay(page):
    return page.evaluate('''() => {
      const content = document.querySelector('.overlay-content');
      const outer = document.querySelector('.overlay').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.overlay-actions button')];
      return content.scrollHeight <= content.clientHeight + 1 && buttons.every(button => {
        const r = button.getBoundingClientRect();
        return r.top >= outer.top && r.bottom <= outer.bottom && r.left >= outer.left && r.right <= outer.right && r.height >= 44;
      });
    }''')

with tempfile.TemporaryDirectory(prefix='airplane-ui-') as data_dir:
    server = subprocess.Popen(['node', 'backend/server.js'], cwd=ROOT,
        env={**os.environ, 'DATA_DIR': data_dir, 'PORT': '0', 'HOST': '127.0.0.1'},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        base = 'http://127.0.0.1:' + server.stdout.readline().strip().rsplit(' ', 1)[1]
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('BROWSER_EXECUTABLE') or shutil.which('chromium'),
                headless=True, args=['--no-sandbox'])
            try:
                for width, height in [(1280,900),(390,844),(320,568),(844,390)]:
                    ctx = browser.new_context(viewport={'width':width,'height':height}, is_mobile=width<900, has_touch=width<900)
                    page = ctx.new_page()
                    errors = []
                    page.on('pageerror', lambda e: errors.append(str(e)))
                    page.goto(base)
                    page.wait_for_function('leaderboardList.getAttribute("aria-busy")==="false"')
                    check(f'{width}: menu fits, both actions >=44px', fits_overlay(page))
                    check(f'{width}: menu art loaded', page.locator('.hero-plane').evaluate('(e)=>e.complete && e.naturalWidth>0'))
                    page.click('#overlay-leaderboard-btn')
                    check(f'{width}: menu leaderboard and keyboard focus', page.locator('#back-btn').evaluate('(e)=>document.activeElement===e') and page.locator('#leaderboard-panel').is_visible())
                    page.click('#back-btn')
                    check(f'{width}: menu return retains screen', page.get_attribute('body','data-screen')=='menu')
                    page.click('#start-btn')
                    check(f'{width}: battle HUD fits shell', page.evaluate('''() => {
                      const shell=document.querySelector('.game-shell').getBoundingClientRect();
                      return [...document.querySelectorAll('.hud button')].every(e=>{const r=e.getBoundingClientRect();return r.left>=shell.left && r.right<=shell.right && r.height>=44});
                    }'''))
                    # Exact geometry is intentional: the new SVG art cannot alter collisions.
                    check(f'{width}: unchanged player/bullet/enemy collision boxes', page.evaluate('''() => {
                      spawnSingleEnemy();spawnBulletAt(10,10);
                      const box=e=>[e.offsetWidth,e.offsetHeight];
                      return JSON.stringify([box(player),box(state.enemies[0].element),box(state.bullets[0].element)])==='[[46,48],[40,42],[4,14]]';
                    }'''))
                    page.click('#pause-btn')
                    check(f'{width}: explicit pause fits and clears input', fits_overlay(page) and page.evaluate('state.isPaused && !state.isShooting && state.animationFrame===null'))
                    page.click('#start-btn')
                    # Controlled presentation fixture; use real score client but mocked submission response.
                    page.route('**/api/leaderboard', lambda r: r.fulfill(status=200,json={'entries':[]}) if r.request.method=='GET' else r.fulfill(status=201,json={}))
                    page.evaluate('state.score=128;scoreEl.textContent="128";endGame("被撞到了，下次再试！")')
                    page.wait_for_function('syncStatus.textContent.includes("成绩已同步")')
                    check(f'{width}: report fits and local record is separate from sync', fits_overlay(page) and page.locator('#result-score').inner_text()=='128' and page.locator('#record-label').inner_text()=='本机新纪录')
                    page.click('#overlay-leaderboard-btn')
                    check(f'{width}: report leaderboard preserves best', page.locator('#leaderboard-best').inner_text()=='128')
                    page.keyboard.press('Escape')
                    check(f'{width}: leaderboard returns to report', page.get_attribute('body','data-screen')=='report')
                    page.reload()
                    check(f'{width}: browser best persists after reload', page.locator('#best-score').inner_text()=='128')
                    check(f'{width}: no horizontal overflow or JS errors', page.evaluate('document.documentElement.scrollWidth<=innerWidth') and not errors)
                    ctx.close()

                page=browser.new_page(viewport={'width':390,'height':844})
                mode={'value':'empty'}
                def board_response(route):
                    if route.request.method!='GET':
                        route.fulfill(status=503,json={'error':'test unavailable'})
                    elif mode['value']=='error':
                        route.fulfill(status=503,json={'error':'test unavailable'})
                    else:
                        rows=[] if mode['value']=='empty' else [{'displayName':'飞行员 · '+('长名字' * 12),'score':128}]*12
                        route.fulfill(status=200,json={'entries':rows})
                page.route('**/api/leaderboard', board_response)
                page.goto(base)
                page.click('#overlay-leaderboard-btn')
                page.wait_for_function('leaderboardList.getAttribute("aria-busy")==="false"')
                check('empty leaderboard state', '暂无飞行记录' in page.locator('#leaderboard-list').inner_text())
                mode['value']='error'
                page.evaluate('fetchLeaderboard()')
                check('error state has retry and no false empty claim', page.locator('#leaderboard-retry-btn').is_visible() and '暂时不可用' in page.locator('#leaderboard-list').inner_text())
                mode['value']='rows'
                page.click('#leaderboard-retry-btn')
                page.wait_for_function('leaderboardList.getAttribute("aria-busy")==="false"')
                check('leaderboard retry loads top ten and handles long names', page.locator('.leaderboard-list li').count()==10 and page.evaluate('document.querySelector(".leaderboard-card").scrollWidth<=document.querySelector(".leaderboard-card").clientWidth'))
                mode['value']='error'
                page.evaluate('fetchLeaderboard()')
                check('failed refresh retains rows with explicit stale warning', page.locator('.leaderboard-list li').count()==10 and '上次取得' in page.locator('#leaderboard-status').inner_text())
                page.click('#back-btn');page.click('#start-btn')
                page.evaluate('applyPowerUp(POWER_UP_TYPES[1],state.gameTime);applyPowerUp(POWER_UP_TYPES[3],state.gameTime)')
                check('simultaneous firepower and shield labels', page.locator('#power-status').inner_text()=='3 排火力 · 护盾生效')
                page.evaluate('updateActivePowerUp(state.gameTime+20000)')
                check('expired powerups clear HUD', page.locator('#power-status').is_hidden())
                page.evaluate('state.score=1;endGame("受控同步失败检查")')
                page.wait_for_function('syncStatus.textContent.includes("未同步")')
                check('submission failure shows reachable retry without blocking replay', page.locator('#retry-btn').is_visible() and page.locator('#start-btn').is_enabled())
                page.unroute('**/api/leaderboard')
                page.route('**/api/leaderboard', lambda r:r.fulfill(status=201,json={}))
                page.click('#retry-btn')
                page.wait_for_function('syncStatus.textContent.includes("成绩已同步")')
                check('submission retry updates state and hides retry', page.locator('#retry-btn').is_hidden())
                page.unroute('**/api/leaderboard')
                page.route('**/api/leaderboard', lambda r:r.fulfill(status=422,json={'error':'test rejected'}))
                page.click('#start-btn');page.evaluate('state.score=1;endGame("受控校验失败检查")')
                page.wait_for_function('syncStatus.textContent.includes("未通过校验")')
                check('rejected score clearly not ranked and not queued', '未上榜' in page.locator('#sync-status').inner_text() and page.locator('#retry-btn').is_hidden())
                page.close()

                page=browser.new_page(viewport={'width':320,'height':568},reduced_motion='reduce')
                page.route('**/api/**',lambda r:r.abort())
                page.goto(base);page.click('#start-btn')
                page.wait_for_function('syncStatus.textContent.includes("不会上榜")')
                check('offline warning keeps game playable', page.evaluate('state.isRunning'))
                page.evaluate('spawnExplosion(50,50);applyPowerUp(POWER_UP_TYPES[3],state.gameTime)')
                check('reduced motion disables decorative animations', page.evaluate('getComputedStyle(document.querySelector(".explosion")).animationName==="none" && getComputedStyle(player,"::after").animationName==="none"'))
                page.wait_for_timeout(500)
                check('reduced motion effects are still removed', page.locator('.explosion').count()==0)
                page.evaluate('state.score=1;endGame("受控离线结算")')
                page.wait_for_function('syncStatus.textContent.includes("未同步")')
                check('offline report never claims successful sync', page.get_attribute('body','data-screen')=='report' and '未同步' in page.locator('#sync-status').inner_text())
                page.close()

                page=browser.new_page(viewport={'width':390,'height':844},has_touch=True)
                pending_requests=[]
                page.route('**/api/leaderboard',lambda r:pending_requests.append(r))
                page.goto(base)
                page.click('#overlay-leaderboard-btn')
                page.wait_for_function('leaderboardList.getAttribute("aria-busy")==="true"')
                check('loading state is explicit without showing a false empty list', '加载中' in page.locator('#leaderboard-status').inner_text() and '正在获取' in page.locator('#leaderboard-list').inner_text())
                pending_requests.pop().fulfill(status=200,json={'entries':[]})
                page.wait_for_function('leaderboardList.getAttribute("aria-busy")==="false"')
                page.click('#back-btn');page.click('#start-btn')
                page.evaluate('state.score=1;endGame("受控等待提交检查")')
                page.wait_for_function('scoreClient.flushing')
                check('pending submission remains visible while replay is available', '提交本局' in page.locator('#sync-status').inner_text() and page.locator('#start-btn').is_enabled())
                # Pump browser events until the intercepted POST arrives.
                page.wait_for_timeout(50)
                pending_requests.pop().fulfill(status=201,json={})
                page.wait_for_function('syncStatus.textContent.includes("成绩已同步")')
                check('all integrated SVGs are served locally', all(page.request.get(base+'/assets/'+name+'.svg').status==200 for name in ['player','enemy','bullet','ocean','power-2','power-3','power-4','shield','explosion-1','explosion-2','explosion-3']))
                page.close()

                # Blocked localStorage must not break the menu or a new run.
                ctx=browser.new_context()
                ctx.add_init_script('Object.defineProperty(window,"localStorage",{get(){throw new Error("test storage blocked")}})')
                page=ctx.new_page();page.goto(base);page.click('#start-btn')
                page.evaluate('endGame("受控零分结算")')
                check('blocked storage and zero score remain playable', page.get_attribute('body','data-screen')=='report' and '0 分' in page.locator('#sync-status').inner_text())
                page.click('#start-btn')
                check('restart clears obsolete zero-score message', page.locator('#sync-status').inner_text()=='')
                ctx.close()
            finally:
                browser.close()
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
