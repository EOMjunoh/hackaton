// ══════════════════════════════════════════════════════
// FarmFit v3 — scoring.js
// 스코어링 엔진 (FAO 3구간 비선형) + 4주 예측
// 순수 함수만 포함 — DOM/Supabase 의존성 없음 (Node 유닛테스트 가능)
// ══════════════════════════════════════════════════════
(function (root) {
  const _data = (typeof module !== 'undefined' && module.exports) ? require('./data.js') : root;
  const CROPS = _data.CROPS;

  function sVar(v,th){
    if(v>=th.opt_min&&v<=th.opt_max) return 100;
    if(v<th.opt_min){
      if(v>=th.lim_min) return Math.max(60,100-40*(th.opt_min-v)/(th.opt_min-th.lim_min));
      return Math.max(0,60-60*(th.lim_min-v)/(th.opt_min-th.lim_min));
    }
    if(v<=th.lim_max) return Math.max(60,100-40*(v-th.opt_max)/(th.lim_max-th.opt_max));
    return Math.max(0,60-60*(v-th.lim_max)/th.lim_max);
  }
  function sEC(ec,th){
    if(ec<=th.opt_max) return 100;
    if(ec<=th.lim_max) return Math.max(60,100-40*(ec-th.opt_max)/(th.lim_max-th.opt_max));
    return Math.max(0,60-60*(ec-th.lim_max)/th.lim_max);
  }
  function gdd(avg,tbase,days,req){ return Math.min(100,Math.max(0,avg-tbase)*days/req*100); }
  function dts(mx,mn,th){ return Math.max(0,100-(Math.max(0,mx-th.opt_max)+Math.max(0,th.opt_min-mn))*8); }
  function frostRisk(fc,lim){
    const fd=fc.filter(d=>d.mn<=lim);
    let mx=1,cur=1;
    for(let i=1;i<fc.length;i++){if(fc[i].mn<=lim&&fc[i-1].mn<=lim){cur++;mx=Math.max(mx,cur)}else cur=1;}
    return Math.min(100,fd.length/7*100*(mx>=3?1.3:1));
  }
  // 토양 실측값(ph/ec)이 없는 지역에서는 그 두 항목을 점수 계산에서 아예 빼고,
  // 남은 항목(온도·GDD·일교차·강수)의 가중치만으로 다시 정규화합니다 — 없는 데이터를
  // 평균치 등으로 채워 넣지 않고, 실제로 가진 항목만으로 계산한다는 원칙입니다.
  function calcScore(env,cropId,variety,method){
    const c=CROPS[cropId],th=c.th,w=th.w;
    const avg=(env.mx+env.mn)/2;
    const ts=sVar(avg,th.temp),gs=gdd(avg,th.temp.tbase,180,th.gdd);
    const ds=dts(env.mx,env.mn,th.temp),rs=sVar(env.rain,th.rain);
    const fr=frostRisk(env.fc||[],th.frost);
    const hasSoil=env.ph!=null&&env.ec!=null;
    const ps=hasSoil?sVar(env.ph,th.ph):null;
    const es=hasSoil?sEC(env.ec,th.ec):null;

    let ws;
    if(hasSoil){
      ws=w.temp*ts+w.gdd*gs+w.dts*ds+w.ph*ps+w.ec*es+w.rain*rs;
    } else {
      const baseW=w.temp+w.gdd+w.dts+w.rain;
      ws=(w.temp*ts+w.gdd*gs+w.dts*ds+w.rain*rs)/baseW;
    }
    // 방식 보정: 시설은 기후 위험 완화
    const methodMod=method==='시설'?4:0;
    const pen=fr>50?0.92:1;
    const total=Math.round((ws+methodMod)*pen*10)/10;
    return{total:Math.min(100,Math.max(0,total)),ts:Math.round(ts),gs:Math.round(gs),ds:Math.round(ds),ps:ps==null?null:Math.round(ps),es:es==null?null:Math.round(es),rs:Math.round(rs),fr:Math.round(fr),hasSoil};
  }

  // 4주 예측 — 규칙 기반 추세 모델 (학습된 ML 모델 아님)
  // 신뢰구간은 고정 상수가 아니라 해당 지역 7일 예보의 변동성(표준편차),
  // pH 개선 가정 여부, 예측 주차(멀수록 불확실)를 반영해 매번 다르게 계산됩니다.
  function mlPredict(baseScore,env,cropId,variety,method){
    const th=CROPS[cropId].th;
    const hasSoil=env.ph!=null;
    const phGap=hasSoil?Math.max(0,th.ph.opt_min-env.ph):0;
    const frostDecay=[1,0.8,0.5,0.2,0];
    const phImprove=phGap>0?[0,0.1,0.3,0.5,0.7]:[0,0,0,0,0];

    const fcMins=(env.fc||[]).map(d=>d.mn);
    const fcAvg=fcMins.reduce((a,b)=>a+b,0)/(fcMins.length||1);
    const variance=fcMins.reduce((a,b)=>a+(b-fcAvg)*(b-fcAvg),0)/(fcMins.length||1);
    const volatility=Math.sqrt(variance); // 예보 변동성(°C) — 클수록 불확실

    const pred=[],lo=[],hi=[];
    [0,1,2,3,4].forEach((w,i)=>{
      const phBoost=hasSoil?(sVar(env.ph+phImprove[i],th.ph)-sVar(env.ph,th.ph))*th.w.ph*1.5:0;
      const frostD=(env.fc||[]).filter(d=>d.mn<=th.frost).length;
      const ns=Math.min(100,Math.max(20,baseScore+phBoost+(i>0?frostD*3*frostDecay[i-1]:0)));
      pred.push(Math.round(ns));
      // 폭 = 기본 3% + 예보 변동성 + (pH 개선 가정이 실현 안 될 위험) + 주차가 멀수록 확대
      const spread=0.03+volatility*0.012+(phGap>0?0.02:0)+i*0.01;
      lo.push(Math.max(0,Math.round(ns*(1-spread))));
      hi.push(Math.min(100,Math.round(ns*(1+spread*0.7))));
    });
    const by=CROPS[cropId].th.baseYield[method]||CROPS[cropId].th.baseYield['노지'];
    const predictedYield=Math.round(by*(pred[4]/100)/10)*10;
    const yieldDelta=Math.round((predictedYield-by)/by*100);
    return{pred,lo,hi,predictedYield,yieldDelta,volatility:Math.round(volatility*10)/10};
  }

  // 위험 감지 — mode(before=심기 전 진단/manage=지금 관리)에 따라
  // "심으면 안전한가"와 "이미 심은 작물이 지금 괜찮은가"로 문구·행동을 다르게 안내
  function detectRisks(env,cropId,mode){
    const th=CROPS[cropId].th,risks=[],M=mode==='manage';
    const fd=env.fc.filter(d=>d.mn<=th.frost);
    if(fd.length>=3) risks.push({lv:'d',title:'야간 저온 3일 연속',sub:`최저 ${Math.min(...fd.map(d=>d.mn))}°C — ${M?'보온 조치 필요':'뿌리 활착 실패 위험'}`,act:M?'부직포/멀칭 즉시':'정식 2주 미루기'});
    else if(fd.length>0) risks.push({lv:'w',title:'야간 저온 주의',sub:`${fd.length}일 저온 예보`,act:M?'오늘 밤 기온 모니터링':'정식 전 기상 재확인'});
    if(env.ph==null){
      risks.push({lv:'s',title:'토양 실측 데이터 없음',sub:'이 지역은 농촌진흥청 토양검정 자료가 아직 확인되지 않았어요',act:'농업기술센터에 토양 검정 의뢰'});
    } else {
      if(env.ph<th.ph.lim_min) risks.push({lv:'d',title:'토양 산도 위험',sub:M?`pH ${env.ph} — 이미 심은 작물이 영양을 흡수하지 못하고 있을 수 있음`:`pH ${env.ph} — 이 상태로 정식하면 뿌리 활착 실패 위험`,act:M?'농업기술센터 방문 — 응급 석회 처방':'정식 전 석회 시용 필수'});
      else if(env.ph<th.ph.opt_min) risks.push({lv:'w',title:'토양 산도 개선 필요',sub:`pH ${env.ph}`,act:M?'추가 웃거름으로 보완':'정식 2~3주 전 석회 소량 시용'});
      if(env.ec>th.ec.lim_max) risks.push({lv:'d',title:'토양 염분 과다',sub:`EC ${env.ec} dS/m`,act:M?'즉시 관수량 늘려 희석':'정식 전 담수 처리로 희석'});
      else if(env.ec>th.ec.opt_max) risks.push({lv:'w',title:'토양 염분 주의',sub:`EC ${env.ec} dS/m`,act:M?'관수 스케줄 점검':'정식 1주 전 관수로 낮춰두기'});
    }
    if(risks.length===0) risks.push({lv:'s',title:'위험 없음',sub:M?'현재 재배 조건 양호':'현재 조건에서 정식해도 안전','act':M?'현재 관리 유지':'예정대로 진행'});
    return risks;
  }

  function genChecks(env,cropId,mode){
    const th=CROPS[cropId].th,checks=[],M=mode==='manage';
    const fd=env.fc.filter(d=>d.mn<=th.frost).length;
    if(fd>=3) checks.push({t:M?'오늘 밤 부직포/멀칭 덮기':'정식일 2주 뒤로 변경',w:'오늘'});
    if(env.ph!=null&&env.ph<th.ph.opt_min) checks.push({t:M?'추가 웃거름/석회로 산도 보완':'정식 전 석회 시용 (200~300kg/10a)',w:M?'이번 주 안':'정식 2주 전'});
    if(env.ec!=null&&env.ec>th.ec.opt_max) checks.push({t:M?'즉시 관수량 늘려 염분 희석':'정식 전 관수로 염분 희석',w:M?'지금부터':'정식 1주 전'});
    if(env.om!=null&&env.om<25) checks.push({t:M?'다음 작기 대비 퇴비 주문 2톤/10a':'정식 전 완숙 퇴비 2톤/10a 살포',w:'이번 주'});
    if(env.ph==null) checks.push({t:'농업기술센터에 토양검정 신청하기',w:'이번 주'});
    checks.push({t:M?'7일 뒤 기상 예보 재확인':'정식 전날 기상 최종 재확인',w:'7일 후'});
    return checks.slice(0,4);
  }

  function gradeInfo(s){
    if(s>=85) return{label:'매우 적합 🟢',color:'#15803d'};
    if(s>=70) return{label:'적합 🟢',color:'#1a6e00'};
    if(s>=55) return{label:'보통 🟡',color:'#c47a00'};
    if(s>=40) return{label:'주의 🟠',color:'#b45309'};
    return{label:'부적합 🔴',color:'#b91c1c'};
  }

  function featImport(scores,cropId){
    const w=CROPS[cropId].th.w;
    const items=[
      {label:'온도',val:Math.round(w.temp*scores.ts),color:'#2a78d6'},
      {label:'일교차',val:Math.round(w.dts*scores.ds),color:'#eb6834'},
      {label:'강수량',val:Math.round(w.rain*scores.rs),color:'#1baf7a'},
    ];
    if(scores.hasSoil){
      items.push({label:'토양산도',val:Math.round(w.ph*scores.ps),color:'#e34948'});
      items.push({label:'토양염분',val:Math.round(w.ec*scores.es),color:'#888780'});
    }
    const total=items.reduce((a,i)=>a+i.val,0)||1;
    items.forEach(i=>i.pct=Math.round(i.val/total*100));
    return items.sort((a,b)=>b.pct-a.pct);
  }

  const api = { sVar, sEC, gdd, dts, frostRisk, calcScore, mlPredict, detectRisks, genChecks, gradeInfo, featImport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);

})(typeof window !== 'undefined' ? window : globalThis);
