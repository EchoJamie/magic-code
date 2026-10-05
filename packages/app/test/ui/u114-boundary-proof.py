from pathlib import Path
import json,sys
base=(Path(__file__).resolve().parents[4] / '.ui-runs/u114')
result=[]
for name in sys.argv[1:]:
 r=base/name
 frames=[json.loads(p.read_text()) for p in sorted((r/'frames').glob('*.json'))]
 samples=json.loads((r/'u114-motion-samples.json').read_text())['samples']
 first,last=frames[1:3]
 assert last['at']-first['at']>=1400
 assert first['lines']==last['lines'] and first['styles']==last['styles'],'停止/失联后真实字格和样式必须静止'
 one={'run':name,'pass':True,'staticFrom':first['at'],'staticTo':last['at'],'sameActualCellsAndStyles':True}
 if name.endswith('no-color'):
  live=[s for s in samples if s['at']<frames[3]['at'] and any('exec(sleep 10' in l['text'] for l in s['lines'])]
  assert len(live)>20,'无色实际工具进行位不能为空'
  cells=[c for s in live for l in s['lines'] for c in l['cells']]
  assert cells and all(c['mode']==0 for c in cells),'无色主屏动效位不发颜色'
  a,b=frames[3:5]
  assert b['at']-a['at']>=1400 and a['lines']==b['lines'] and a['styles']==b['styles'],'全文已有静态语义色不能重放动画'
  one.update(noColorLiveSamples=len(live),noColorMainScreenForegroundModeZero=True,historySameCellsAndStyles=True,historyFrom=a['at'],historyTo=b['at'],historyKeepsExistingStaticSemanticColors=True)
 result.append(one)
(base/'u114-motion-boundary-proof.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
