import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
url,run=sys.argv[1:3]
root=(Path(__file__).resolve().parents[4] / '.ui-runs/u114')/run
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
    try:
        page=browser.new_page(viewport={'width':2500,'height':1000},device_scale_factor=1)
        page.goto(url);page.wait_for_function('window.ready===true')
        out=root/'browser';out.mkdir(exist_ok=True)
        for frame in sorted((root/'frames').glob('*.json')):
            data=page.evaluate('async ([run,frame])=>await window.renderFrame(run,frame)',[run,frame.name])
            page.locator('#terminal').screenshot(path=str(out/(frame.stem+'.png')))
            text=page.evaluate('window.terminalText()')
            (out/(frame.stem+'.json')).write_text(json.dumps({'frame':frame.name,'bytes':data['bytes'],'browserText':text},ensure_ascii=False,indent=2))
            print(frame.name)
    finally:browser.close()
