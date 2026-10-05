import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
url,run=sys.argv[1:3]
root=(Path(__file__).resolve().parents[4] / '.ui-runs/u114')/run
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
    try:
        page=browser.new_page(viewport={'width':2500,'height':1000})
        page.goto(url);page.wait_for_function('window.ready===true')
        result=page.evaluate('''async run => {
          await load(run);reset();let index=0;const out=[];
          const first=loaded.chunks[0].at,last=loaded.chunks.at(-1).at;
          for(let at=first;at<=last+200;at+=200){
            while(index<loaded.chunks.length&&loaded.chunks[index].at<=at){
              const chunk=loaded.chunks[index++];await write(loaded.raw.slice(chunk.offset,chunk.offset+chunk.length));
            }
            const lines=[];
            for(let y=0;y<term.rows;y++){
              const line=term.buffer.active.getLine(term.buffer.active.viewportY+y),text=line?.translateToString(true)||'';
              if(!/思考|▸|▪|◊|●|○|MOTION_FINISHED/.test(text))continue;
              const cells=[];
              for(let x=0;x<term.cols;x++){
                const c=line.getCell(x),ch=c?.getChars()||'';
                if(['●','◊','○','▪','▸','思','考'].includes(ch))cells.push({x,ch,fg:c.getFgColor(),mode:c.getFgColorMode()});
              }
              lines.push({y,text,cells});
            }
            out.push({at,bytes:index===0?0:loaded.chunks[index-1].offset+loaded.chunks[index-1].length,lines});
          }
          return out;
        }''',run)
        (root/'u114-motion-samples.json').write_text(json.dumps({'sampleMs':200,'source':'actual ANSI raw.bin replayed through xterm','samples':result},ensure_ascii=False,indent=2))
        print(run,len(result))
    finally:browser.close()
