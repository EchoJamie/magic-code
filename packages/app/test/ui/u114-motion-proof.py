from pathlib import Path
import json,re,sys
base=(Path(__file__).resolve().parents[4] / '.ui-runs/u114')
result=[]
for name in sys.argv[1:]:
 r=base/name;data=json.loads((r/'u114-motion-samples.json').read_text())['samples'];reduced='reduced' in name
 def points(test,ch):
  return [(s['at'],c['fg'],c['x'],l['y'],l['text']) for s in data for l in s['lines'] if test(l['text']) for c in l['cells'] if c['ch']==ch]
 thinking=points(lambda t:t.startswith('（思考 '),'思')
 tool=points(lambda t:'▸ ● exec(sleep 5;' in t,'●')
 plan=points(lambda t:'▪ 执行受控工具' in t,'▪')
 working=points(lambda t:t.startswith(' ● 工作中'),'●')
 waiting=points(lambda t:t.startswith(' ◊ 等你定夺'),'◊')
 idle=points(lambda t:t.startswith(' ○ 空闲') and '验证思考' in t,'○')
 phases={}
 for key,values in [('thinking',thinking),('tool',tool),('plan',plan),('working',working),('waiting',waiting),('idle',idle)]:
  assert values,key+'不能空集'
  phases[key]={'samples':len(values),'firstAt':values[0][0],'lastAt':values[-1][0],'colors':len(set(v[1] for v in values))}
 assert tool[-1][0]-tool[0][0]>=4000
 assert len(set(v[2] for v in tool))==1
 if reduced:
  for key,vals in [('thinking',thinking),('tool',tool),('plan',plan),('working',working),('waiting',waiting)]:assert len(set(v[1] for v in vals))==1,key+'减动效必须静止'
  assert len(set(v[4] for v in thinking))>5,'减动效思考真实耗时仍更新'
  assert len(set(v[4] for v in tool))==1,'工具身份与布局稳定'
 else:
  for key,vals in [('thinking',thinking),('tool',tool),('working',working)]: assert len(set(v[1] for v in vals))>5,key+'实际ANSI必须多次变化'
  currentplan=[v for v in plan if tool[0][0]<=v[0]<=tool[-1][0]]
  assert len(set(v[1] for v in currentplan))>5,'计划步骤必须实际变化'
  # 窗口内两次以上由暗转亮再变暗；只读取实际色值，不自行生成产品颜色。
  colors=[sum(((v[1]>>16)&255,(v[1]>>8)&255,v[1]&255)) for v in tool]
  extrema=[i for i in range(1,len(colors)-1) if colors[i]>colors[i-1] and colors[i]>=colors[i+1]]
  assert len(extrema)>=2,('真实工具两轮峰值不足',colors)
  phases['tool']['peakTimes']=[tool[i][0] for i in extrema]
  assert len(set(v[1] for v in waiting))>1,'等待只提示一次必须发生实际颜色变化'
 staticWait=[v for v in waiting if v[0]>=waiting[0][0]+600]
 assert len(staticWait)>=2 and len(set(v[1] for v in staticWait))==1,'等待600ms后必须静止'
 assert idle[-1][0]-idle[0][0]>=1000
 assert len(set(v[1] for v in idle))==1
 staticPlan=[v for v in plan if v[0]>=idle[0][0]]
 assert len(set(v[1] for v in staticPlan))==1,'收束后计划不再呼吸'
 result.append({'run':name,'reduced':reduced,'pass':True,'sampleIntervalMs':200,'phases':phases,'waitingAfter600msStatic':True,'completionAfter1000msStatic':True})
print(json.dumps(result,ensure_ascii=False,indent=2))
(base/'u114-motion-proof.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
