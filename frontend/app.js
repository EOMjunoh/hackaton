// ══════════════════════════════════════════════════════
// FarmFit v3 — app.js
// Supabase Auth + 멀티페이지 + 지역 2단계 + 품종/방식 세분화
// ══════════════════════════════════════════════════════

// ── Supabase 초기화 ──────────────────────────────────
const SUPABASE_URL = 'https://ahklaovymayuqfalwggg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wXVlSyyz209dANBxjr7gUw_lMKhw1CZ';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ══════════════════════════════════════════════════════
// 정적 데이터 + 스코어링 엔진
// → frontend/data.js, frontend/scoring.js 로 분리됨 (index.html에서
//   app.js보다 먼저 로드). SIDO/CROPS/fetchKmaShortTerm/fetchRealSoil/calcScore/
//   gradeInfo 등은 여기서 전역으로 그대로 사용 가능.
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// 전역 상태
// ══════════════════════════════════════════════════════
let currentUser = null;
let authMode = 'login';
let flowMode = 'before'; // before | manage | compare
let selSido = null, selSigun = null;
let selCropId = null, selVariety = null, selMethod = null;
let cSido = null, cSigun = null, cCropIds = [];
let doneMap = {}, analysisCtx = null, chatHist = [], currentChecks = [];
let fcChart = null;
let histChart = null;
let pmenuOpen = false;

// ══════════════════════════════════════════════════════
// 유틸
// ══════════════════════════════════════════════════════
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function goPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
  document.getElementById(id).classList.add('on');
  window.scrollTo(0,0);
  document.getElementById('fab').className = 'fab' + (id==='pResult'?' show':'');
}
function showToast(msg, ms=2800){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), ms);
}
function setProgress(p,e,m){
  document.getElementById('pFill').style.width=p+'%';
  document.getElementById('pPct').textContent=p+'%';
  if(e) document.getElementById('lEmoji').textContent=e;
  if(m) document.getElementById('lMsg').textContent=m;
}
async function runLoading(steps){
  goPage('pLoading');
  for(const s of steps){ await sleep(460); setProgress(s.p,s.e,s.m); }
  await sleep(300); setProgress(100); await sleep(200);
}

// ══════════════════════════════════════════════════════
// Supabase 인증
// ══════════════════════════════════════════════════════
function switchAuth(mode){
  authMode=mode;
  document.getElementById('tabLogin').classList.toggle('on',mode==='login');
  document.getElementById('tabSignup').classList.toggle('on',mode==='signup');
  document.getElementById('fnickname').style.display=mode==='signup'?'block':'none';
  document.getElementById('authBtnTxt').textContent=mode==='signup'?'회원가입 완료':'로그인';
  document.getElementById('authErr').style.display='none';
}

function setAuthLoading(on){
  document.getElementById('authBtn').disabled=on;
  document.getElementById('authBtnSpin').style.display=on?'inline-block':'none';
}

async function doAuth(){
  const email=document.getElementById('iemail').value.trim();
  const pw=document.getElementById('ipw').value;
  const nick=document.getElementById('inick').value.trim();
  const errEl=document.getElementById('authErr');
  errEl.style.display='none';

  if(!email || !pw){ showErr('이메일과 비밀번호를 입력해주세요.'); return; }
  if(pw.length<6){ showErr('비밀번호는 6자 이상이어야 합니다.'); return; }
  setAuthLoading(true);

  try{
    if(authMode==='signup'){
      if(!nick){ showErr('닉네임을 입력해주세요.'); setAuthLoading(false); return; }
      const { data, error } = await sb.auth.signUp({
        email, password: pw,
        options: { data: { nickname: nick } }
      });
      if(error) throw error;
      if(data.user && !data.session){
        showToast('📧 이메일을 확인해 인증 후 로그인해주세요!', 4000);
        switchAuth('login');
      } else if(data.session){
        onAuthSuccess(data.user);
      }
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
      if(error) throw error;
      onAuthSuccess(data.user);
    }
  } catch(e){
    const msg=e.message||'오류가 발생했습니다.';
    showErr(
      msg.includes('Invalid login')?'이메일 또는 비밀번호가 맞지 않습니다.':
      msg.includes('Email not confirmed')?'이메일 인증 후 로그인해주세요.':
      msg.includes('already registered')?'이미 가입된 이메일입니다.':msg
    );
  }
  setAuthLoading(false);
}

function showErr(msg){
  const e=document.getElementById('authErr');
  e.textContent=msg; e.style.display='block';
}

function onAuthSuccess(user){
  currentUser=user;
  const nick=user.user_metadata?.nickname || user.email.split('@')[0];
  const hour=new Date().getHours();
  const greet=hour<12?'좋은 아침이에요':hour<18?'안녕하세요':'좋은 저녁이에요';
  document.getElementById('homeUser').textContent='🌱 '+nick;
  document.getElementById('hgreet').textContent=`${greet}, ${nick}님 👋`;
  goPage('pHome');
  showToast('✅ 로그인 되었습니다!');
  renderHomeStats();
}

// 홈 화면 하단 요약 카드 — Supabase에 쌓인 내 실제 분석 이력(analyses 테이블)만 집계한다.
// 꾸밈용 문구를 채워 넣는 대신, 이미 있는 실제 사용자 데이터로 빈 공간을 채운다.
async function renderHomeStats(){
  const card=document.getElementById('homeStatsCard');
  const body=document.getElementById('homeStatsBody');
  if(!currentUser){ card.style.display='none'; return; }
  const { data, error } = await sb.from('analyses')
    .select('crop_id,region,f_score,created_at')
    .eq('user_id',currentUser.id)
    .order('created_at',{ascending:false})
    .limit(50);
  card.style.display='block';
  if(error||!data||!data.length){
    body.innerHTML='<div style="text-align:center;color:var(--mute);font-size:13px;padding:6px 0">아직 분석 기록이 없어요. 첫 분석을 시작해보세요!</div>';
    return;
  }
  const avg=Math.round(data.reduce((a,r)=>a+Number(r.f_score),0)/data.length);
  const last=data[0];
  const lastCrop=CROPS[last.crop_id]?CROPS[last.crop_id].name:last.crop_id;
  const g=gradeInfo(avg);
  body.innerHTML=`
    <div style="display:flex">
      <div style="flex:1;text-align:center">
        <div style="font-size:20px;font-weight:900;color:var(--teal-d)">${data.length}</div>
        <div style="font-size:11px;color:var(--mute);margin-top:2px">누적 분석</div>
      </div>
      <div style="flex:1;text-align:center;border-left:1px solid var(--line);border-right:1px solid var(--line)">
        <div style="font-size:20px;font-weight:900;color:${g.color}">${avg}</div>
        <div style="font-size:11px;color:var(--mute);margin-top:2px">평균 적합도</div>
      </div>
      <div style="flex:1;text-align:center">
        <div style="font-size:14px;font-weight:800;color:var(--ink)">${lastCrop}</div>
        <div style="font-size:11px;color:var(--mute);margin-top:2px">${last.region} · 최근</div>
      </div>
    </div>`;
}

function toggleProfile(){
  pmenuOpen=!pmenuOpen;
  document.getElementById('pmenu').classList.toggle('on',pmenuOpen);
  if(pmenuOpen) document.addEventListener('click',closePmenuOnClick,{once:true});
}
function closePmenuOnClick(e){
  if(!e.target.closest('#pmenu')&&!e.target.closest('#homeUser')){
    document.getElementById('pmenu').classList.remove('on'); pmenuOpen=false;
  }
}
async function editNickname(){
  document.getElementById('pmenu').classList.remove('on'); pmenuOpen=false;
  const newNick=prompt('새 닉네임을 입력하세요:');
  if(!newNick||!newNick.trim()) return;
  const { error } = await sb.auth.updateUser({ data:{ nickname: newNick.trim() } });
  if(!error){
    document.getElementById('homeUser').textContent='🌱 '+newNick.trim();
    document.getElementById('hgreet').textContent=`안녕하세요, ${newNick.trim()}님 👋`;
    showToast('✅ 닉네임이 변경되었습니다!');
  } else { showToast('닉네임 변경 실패: '+error.message); }
}
async function doLogout(){
  await sb.auth.signOut();
  currentUser=null;
  document.getElementById('homeStatsCard').style.display='none';
  goPage('pAuth');
  showToast('로그아웃 되었습니다.');
  document.getElementById('pmenu').classList.remove('on'); pmenuOpen=false;
}

// 세션 복원
(async()=>{
  const { data:{ session } } = await sb.auth.getSession();
  if(session?.user) onAuthSuccess(session.user);
})();

// ══════════════════════════════════════════════════════
// 지역 선택 (시/도 → 시군구 2단계)
// ══════════════════════════════════════════════════════
function buildSidoUI(prefix, getSido, setSido, getSigun, setSigun, onComplete){
  const sidoList=document.getElementById(prefix+'SidoList');
  const sigunWrap=document.getElementById(prefix+'SigunWrap');
  const sigunTitle=document.getElementById(prefix+'SigunTitle');
  const sigunGrid=document.getElementById(prefix+'SigunGrid');

  // 시/도 버튼
  sidoList.innerHTML=Object.keys(SIDO).map(s=>
    `<button class="sido-btn${getSido()===s?' on':''}" data-s="${s}">${s.replace('특별','').replace('광역','').replace('도','').replace('시','')}</button>`
  ).join('');
  sidoList.querySelectorAll('.sido-btn').forEach(b=>b.onclick=()=>{
    setSido(b.dataset.s); setSigun(null);
    sidoList.querySelectorAll('.sido-btn').forEach(x=>x.classList.toggle('on',x.dataset.s===b.dataset.s));
    renderSigunGrid(b.dataset.s);
    onComplete();
  });

  function renderSigunGrid(sido){
    sigunWrap.style.display='block';
    const sName=sido.replace('특별시','').replace('광역시','').replace('특별자치시','').replace('특별자치도','').replace('도','').replace('시','');
    sigunTitle.textContent=sName+' 내 시군구를 선택하세요';
    const list=SIDO[sido]||[];
    sigunGrid.innerHTML=list.map(g=>
      `<button class="sigun-btn${getSigun()===g?' on':''}" data-g="${g}">${g}</button>`
    ).join('');
    sigunGrid.querySelectorAll('.sigun-btn').forEach(b=>b.onclick=()=>{
      setSigun(b.dataset.g);
      sigunGrid.querySelectorAll('.sigun-btn').forEach(x=>x.classList.toggle('on',x.dataset.g===b.dataset.g));
      onComplete();
    });
  }

  // 이미 선택된 시도가 있으면 시군구도 렌더
  if(getSido()) renderSigunGrid(getSido());
}

// ══════════════════════════════════════════════════════
// 작물/품종/방식 UI
// ══════════════════════════════════════════════════════
function buildCropUI(multi=false){
  // 작물 가로 스크롤
  const row=document.getElementById('cropRow');
  row.innerHTML=Object.entries(CROPS).map(([id,c])=>{
    const on=multi?cCropIds.includes(id):selCropId===id;
    return `<button class="crop-btn${on?' on':''}" data-id="${id}"><span class="ce">${c.emoji}</span><span class="cn">${c.name}</span></button>`;
  }).join('');
  row.querySelectorAll('.crop-btn').forEach(b=>b.onclick=()=>{
    if(multi){
      const idx=cCropIds.indexOf(b.dataset.id);
      if(idx>=0)cCropIds.splice(idx,1);else cCropIds.push(b.dataset.id);
      buildCropUI(true); updateCompareCta(); return;
    }
    selCropId=b.dataset.id; selVariety=null; selMethod=null;
    buildCropUI(false); buildVarietyUI(); buildMethodUI(); updateInputCta();
  });

  if(!multi){
    buildVarietyUI(); buildMethodUI();
  }
}

function buildVarietyUI(){
  const wrap=document.getElementById('varietyWrap');
  const grid=document.getElementById('varietyGrid');
  if(!selCropId){wrap.style.display='none';return;}
  wrap.style.display='block';
  const crop=CROPS[selCropId];
  const vars=crop.varieties;
  // 조사로 확인된 작물(배·감자·사과)만 품종별 수확시기(GDD) 차이가 점수에 반영됨 —
  // 나머지(오이·상추)는 신뢰할 자료를 못 찾아 품종이 점수에 영향을 주지 않음.
  document.getElementById('varietyNote').textContent = crop.varietyGddMult
    ? '(수확시기 차이가 점수에 반영돼요)' : '(기록용 — 적합도 점수에는 영향 없음)';
  grid.innerHTML=vars.map(v=>
    `<button class="variety-btn${selVariety===v?' on':''}" data-v="${v}">${v}</button>`
  ).join('');
  grid.querySelectorAll('.variety-btn').forEach(b=>b.onclick=()=>{
    selVariety=b.dataset.v;
    grid.querySelectorAll('.variety-btn').forEach(x=>x.classList.toggle('on',x.dataset.v===b.dataset.v));
    buildMethodUI(); updateInputCta();
  });
}

function buildMethodUI(){
  const wrap=document.getElementById('methodWrap');
  const mrow=document.getElementById('methodRow');
  if(!selCropId||!selVariety){wrap.style.display='none';return;}
  wrap.style.display='block';
  mrow.innerHTML=METHODS.map(m=>
    `<button class="method-btn${selMethod===m.id?' on':''}" data-m="${m.id}"><span class="mico">${m.emoji}</span><span class="mlb">${m.label} (${m.desc})</span></button>`
  ).join('');
  mrow.querySelectorAll('.method-btn').forEach(b=>b.onclick=()=>{
    selMethod=b.dataset.m;
    mrow.querySelectorAll('.method-btn').forEach(x=>x.classList.toggle('on',x.dataset.m===b.dataset.m));
    updateInputCta();
  });
}

function updateInputCta(){
  const btn=document.getElementById('inputCta');
  const c=CROPS[selCropId];
  if(selSigun&&selCropId&&selVariety&&selMethod){
    btn.disabled=false;
    btn.textContent=`${selSigun} × ${c.name}(${selVariety}) ${selMethod} 분석 →`;
  } else if(selSigun&&selCropId&&selVariety){
    btn.disabled=true; btn.textContent='재배방식을 선택해주세요';
  } else if(selSigun&&selCropId){
    btn.disabled=true; btn.textContent='품종을 선택해주세요';
  } else if(selSigun){
    btn.disabled=true; btn.textContent='작물을 선택해주세요';
  } else {
    btn.disabled=true; btn.textContent='위 내용을 선택해주세요';
  }
}

function updateCompareCta(){
  const btn=document.getElementById('compareCta');
  // 작물 비교 — 위에서 cCropRow 렌더
  const row=document.getElementById('cCropRow');
  row.innerHTML=Object.entries(CROPS).map(([id,c])=>{
    const on=cCropIds.includes(id);
    return `<button class="crop-btn${on?' on':''}" data-id="${id}"><span class="ce">${c.emoji}</span><span class="cn">${c.name}</span></button>`;
  }).join('');
  row.querySelectorAll('.crop-btn').forEach(b=>b.onclick=()=>{
    const idx=cCropIds.indexOf(b.dataset.id);
    if(idx>=0)cCropIds.splice(idx,1);else cCropIds.push(b.dataset.id);
    updateCompareCta();
  });
  if(cSigun&&cCropIds.length>=2){
    btn.disabled=false;
    btn.textContent=`${cSigun} × ${cCropIds.length}개 작물 비교 →`;
  } else if(cCropIds.length===1){
    btn.disabled=true; btn.textContent='작물을 1개 더 선택하세요';
  } else {
    btn.disabled=true; btn.textContent='작물을 2개 이상 선택하세요';
  }
}

// ══════════════════════════════════════════════════════
// 플로우 시작
// ══════════════════════════════════════════════════════
function startFlow(mode){
  flowMode=mode;
  if(mode==='compare'){
    cSido=null; cSigun=null; cCropIds=[];
    buildSidoUI('c',()=>cSido,v=>{cSido=v},()=>cSigun,v=>{cSigun=v},updateCompareCta);
    updateCompareCta();
    goPage('pCompare'); return;
  }
  // before | manage
  selSido=null; selSigun=null; selCropId=null; selVariety=null; selMethod=null;
  document.getElementById('inputTitle').textContent=mode==='before'?'심기 전 진단':'지금 관리';
  buildSidoUI('',()=>selSido,v=>{selSido=v},()=>selSigun,v=>{selSigun=v},updateInputCta);
  buildCropUI(false);
  updateInputCta();
  goPage('pInput');
}

// ══════════════════════════════════════════════════════
// (스코어링 엔진 sVar/calcScore/mlPredict/detectRisks/genChecks/
//  gradeInfo/featImport은 scoring.js, 실측 데이터 조회는 data.js 참고)
// ══════════════════════════════════════════════════════
// 실제 기상청/농촌진흥청 응답만으로 env 객체를 구성한다 — 시뮬레이션 폴백 없음.
// 기상 데이터가 없으면 null을 돌려주고, 호출부가 분석을 중단하고 정직하게 안내해야 한다.
// 토양 데이터가 없으면 ph/ec/om/avp를 null로 두고, calcScore가 그 항목을 제외한 채
// 나머지 가중치로 재정규화해 계산한다(scoring.js 참고) — 채워 넣지 않는다.
function buildEnvFromReal(kma, soil){
  const first = kma.byOffset[kma.offsets[0]];
  const fc = kma.offsets.map(i=>{
    const d=kma.byOffset[i];
    return { date: i===0?'오늘':`${i}일 후`, mx:d.mx, mn:d.mn, pop:d.pop, pcpMm:d.pcpMm };
  });
  const rainDays = fc.filter(d=>d.pcpMm!=null);
  const avgDailyMm = rainDays.length ? rainDays.reduce((a,d)=>a+d.pcpMm,0)/rainDays.length : 0;
  return {
    mx:first.mx, mn:first.mn, fc,
    rain: Math.round(avgDailyMm*7*10)/10, // 실측 예보 범주 기반 추정치를 7일 환산값으로 스코어링 기준에 맞춤
    ph: soil?soil.ph:null, ec: soil?soil.ec:null, om: soil?soil.om:null, avp: soil?soil.avp:null,
  };
}
function weatherNoteOf(kma){ return `🌤 기상: 기상청 단기예보 실측 (오늘~${Math.max(...kma.offsets)}일 후, 강수는 예보 범주 기반 추정)`; }
function soilNoteOf(soil){ return soil ? `🧪 토양: 농촌진흥청 실측 (${soil.latestYear}년, 표본 ${soil.sampleCount}건 평균)` : '🧪 토양: 이 지역은 아직 실측 데이터가 없어 토양산도/염분은 점수에 반영되지 않았습니다'; }

// ══════════════════════════════════════════════════════
// 분석 실행
// ══════════════════════════════════════════════════════
async function runAnalysis(){
  if(!selSigun||!selCropId||!selVariety||!selMethod) return;
  doneMap={};
  await runLoading([
    {p:15,e:'🌤',m:'지역 기상 조건 분석 중...'},
    {p:35,e:'🌱',m:'토양 실측 데이터 조회 중...'},
    {p:55,e:'📐',m:`GDD·DTS·pHD 파생변수 계산 중...`},
    {p:72,e:'🤖',m:`${CROPS[selCropId].name}(${selVariety}) 적합도 예측 계산 중...`},
    {p:90,e:'📊',m:'인사이트 생성 중...'},
  ]);

  const isManageMode=flowMode==='manage';
  const [kma,soil,nowcast]=await Promise.all([
    fetchKmaShortTerm(selSido,selSigun),
    fetchRealSoil(selSigun),
    isManageMode?fetchKmaNowcast(selSido,selSigun):Promise.resolve(null),
  ]);
  if(!kma){
    goPage('pHome');
    showToast(`⚠️ ${selSigun}은(는) 기상청 실측 데이터를 가져올 수 없어 지금은 분석할 수 없습니다`, 4200);
    return;
  }
  const env=buildEnvFromReal(kma,soil);
  // '지금 관리'는 미래 예보뿐 아니라 지금 이 순간의 실황(초단기실황)까지 함께 보여준다 —
  // '심기 전 진단'과 달리 "지금 상태"를 실측으로 확인한다는 게 실질적인 차이.
  const nowNote=nowcast?`⏱ 지금 실황: ${nowcast.temp}°C${nowcast.rain1h>0?`, 최근 1시간 강수 ${nowcast.rain1h}mm`:''}${nowcast.ptyLabel?` (${nowcast.ptyLabel})`:''}`:null;
  const dataNote=`${nowNote?nowNote+' · ':''}${weatherNoteOf(kma)} · ${soilNoteOf(soil)}`;
  const score=calcScore(env,selCropId,selVariety,selMethod);
  const ml=mlPredict(score.total,env,selCropId,selVariety,selMethod);
  const risks=detectRisks(env,selCropId,flowMode);
  const checks=genChecks(env,selCropId,flowMode);
  currentChecks=checks;
  const features=featImport(score,selCropId);
  const crop=CROPS[selCropId];
  const g=gradeInfo(score.total);
  const dc=risks.filter(r=>r.lv==='d').length;
  const dp=ml.yieldDelta;

  document.getElementById('rTitle').textContent=flowMode==='before'?'심기 전 진단 결과':'지금 관리 결과';
  const verdict=buildVerdict(env,score,selCropId,crop.name,selVariety,selSigun,flowMode);

  // 분석 이력 Supabase 저장 (있으면)
  if(currentUser){
    sb.from('analyses').insert({
      user_id:currentUser.id, region:selSigun, crop_id:selCropId,
      variety:selVariety, method:selMethod, f_score:score.total,
      flow_mode:flowMode, created_at:new Date().toISOString()
    }).then(({error})=>{ if(error){ console.warn('이력 저장 실패:',error.message); showToast('⚠️ 분석 이력 저장에 실패했습니다', 3200); } else { renderHomeStats(); } });
  }

  // 결과 렌더
  const rc=document.getElementById('rContent');
  const isManage=flowMode==='manage';
  const kpiLabel1=isManage?'현재 생육 적합도':'정식 적합도';
  const kpiLabel2=isManage?`예상 수확량 (관리 지속 시)`:`예상 수확량 (${selMethod} 정식 시)`;
  const nowCard=(isManage&&nowNote)?`<div class="card" style="background:var(--green-p);box-shadow:none"><div style="padding:12px 15px;font-size:13px;font-weight:700;color:var(--green-d)">${nowNote}</div></div>`:'';
  const kpiCards=`
    ${nowCard}
    <div class="kpis">
      <div class="kpi"><div class="klb">${kpiLabel1} (${selMethod})</div><div class="kval" style="color:${g.color}">${score.total}</div><div class="ksub" style="color:${g.color}">${g.label}</div></div>
      <div class="kpi"><div class="klb">${kpiLabel2}</div><div class="kval" style="font-size:19px">${ml.predictedYield.toLocaleString()}<span style="font-size:11px"> kg</span></div><div class="ksub" style="color:${dp>=0?'#15803d':'#b91c1c'}">${dp>0?'+':''}${dp}% vs 표준</div></div>
    </div>
    <div class="card"><div class="card-h"><span class="card-t">${crop.emoji} ${crop.name} ${selVariety} · ${selMethod} · ${selSigun}</span></div><div class="verdict">${verdict}</div><div style="padding:0 15px 12px;font-size:11px;color:var(--mute)">${dataNote}</div></div>`;
  const forecastCard=`
    <div class="card"><div class="card-h"><span class="card-t">적합도 예측 · 4주</span><span class="badge bml">규칙 기반 예측</span></div>
      <div style="padding:12px 12px 8px">
        <div class="leg"><span><span class="lsq" style="background:#2a78d6"></span>예측</span><span><span class="lsq" style="background:#e34948"></span>위험선(60)</span><span><span class="lsq" style="background:#bcd4f0"></span>신뢰구간</span></div>
        <div class="chart-wrap" style="height:170px"><canvas id="fcChart" role="img" aria-label="4주 예측 차트"></canvas></div>
      </div>
    </div>
    <div class="card"><div class="card-h"><span class="card-t">점수 기여 요인</span><span class="badge bml">기여도 분석</span></div><div id="segBox"></div></div>`;
  const riskAndChecks=`
    <div class="card"><div class="card-h"><span class="card-t">위험 신호</span>${dc>0?`<span class="badge bred">${dc}건 긴급</span>`:''}</div><div id="riskBox"></div></div>
    <div class="card"><div class="card-h"><span class="card-t">${isManage?'지금 할 일':'정식 전 할 일'}</span><span style="font-size:11px;color:var(--mute)" id="chkCnt"></span></div><div id="chkBox"></div></div>`;
  const aiCard=`
    <div class="card"><div class="card-h"><span class="card-t">AI 맞춤 리포트</span><span id="aiSpin" class="spin" style="display:none"></span></div><div class="aireport" id="aiBody" style="color:var(--mute)">분석 결과를 AI가 자연어로 설명합니다. 챗봇에서 물어보세요!</div></div>`;
  // 지금 관리: 당장의 위험/할 일이 먼저 보이도록, 심기 전 진단: 적합도 예측이 먼저 보이도록 순서를 바꾼다
  rc.innerHTML = isManage
    ? kpiCards + riskAndChecks + forecastCard + aiCard
    : kpiCards + forecastCard + riskAndChecks + aiCard;

  // 차트
  if(fcChart){fcChart.destroy();fcChart=null;}
  fcChart=new Chart(document.getElementById('fcChart'),{type:'line',data:{labels:['지금','1주','2주','3주','4주'],datasets:[
    {data:ml.hi,borderColor:'transparent',backgroundColor:'rgba(42,120,214,.1)',fill:'+1',pointRadius:0,tension:.4},
    {data:ml.lo,borderColor:'transparent',fill:false,pointRadius:0,tension:.4},
    {data:ml.pred,borderColor:'#2a78d6',borderWidth:2.5,pointBackgroundColor:'#2a78d6',pointRadius:5,tension:.4},
    {data:[60,60,60,60,60],borderColor:'#e34948',borderWidth:1.5,borderDash:[5,3],pointRadius:0},
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:x=>x.dataset.label?null:Math.round(x.parsed.y)+'점'}}},scales:{x:{grid:{display:false},ticks:{font:{size:11}}},y:{min:30,max:100,ticks:{font:{size:11},stepSize:20,callback:v=>v+'점'},grid:{color:'rgba(0,0,0,.04)'}}}}});

  // 기여 요인
  document.getElementById('segBox').innerHTML=features.map(f=>`<div class="seg"><div class="slb">${f.label}</div><div class="sbg"><div class="sfill" style="width:${f.pct}%;background:${f.color}"></div></div><div class="sv">${f.pct}%</div></div>`).join('');

  // 위험
  document.getElementById('riskBox').innerHTML=risks.map(r=>{
    const ic=r.lv==='d'?'rid':r.lv==='w'?'riw':'ris',tc=r.lv==='d'?'rd':r.lv==='w'?'rw':'rs',ico=r.lv==='d'?'🚨':r.lv==='w'?'⚠️':'✅';
    return `<div class="riskrow"><div class="rico ${ic}">${ico}</div><div><div class="rmain ${tc}">${r.title}</div><div class="rsub">${r.sub}</div><div class="ract">→ ${r.act}</div></div></div>`;
  }).join('');

  renderChecks();
  goPage('pResult');

  // 챗봇 컨텍스트
  analysisCtx={cropId:selCropId,region:selSigun,crop:crop.name,variety:selVariety,method:selMethod,score:score.total,grade:g.label,mlPred4w:ml.pred[4],yield:ml.predictedYield,yieldDelta:dp,avg:((env.mx+env.mn)/2).toFixed(1),tmin:env.mn,tmax:env.mx,ph:env.ph,ec:env.ec,om:env.om,rain:env.rain,hasSoil:score.hasSoil,hasVarietyEffect:!!crop.varietyGddMult,nowcast:nowcast,frostDays:env.fc.filter(d=>d.mn<=CROPS[selCropId].th.frost).length,thPh:`${CROPS[selCropId].th.ph.opt_min}~${CROPS[selCropId].th.ph.opt_max}`,risks:risks.map(r=>`[${r.lv}]${r.title}:${r.sub}`).join(' / '),dataSource:dataNote};
  chatHist=[];
  document.getElementById('cCtx').textContent=`${selSigun} · ${crop.name}(${selVariety}) ${selMethod} 결과를 알고 있어요`;
  resetChat();
}

function buildVerdict(env,score,cropId,cropName,variety,sigun,mode){
  const th=CROPS[cropId].th,fd=env.fc.filter(d=>d.mn<=th.frost).length,phLow=env.ph!=null&&env.ph<th.ph.opt_min;
  if(mode==='manage'){
    if(score.total>=70) return `<span class="hi">${cropName}(${variety}) 현재 관리 상태가 양호합니다.</span> ${fd>0?`다만 <span class="lo">야간 저온 ${fd}일</span> 예보에 대비하세요.`:'큰 위험 없이 잘 자라고 있어요.'}`;
    return `${cropName}(${variety}) 재배 중 <span class="lo">주의가 필요한 신호</span>가 감지됐어요. ${phLow?'토양 산도부터 손보세요.':'아래 위험 항목을 확인하세요.'}`;
  }
  if(score.total>=80) return `<span class="hi">${sigun}은 ${cropName}(${variety}) 재배에 매우 적합합니다.</span> 지금이 정식 적기예요.`;
  if(score.total>=65) return `${cropName}(${variety}) 심기에 <span class="hi">좋은 환경</span>입니다. ${fd>0?`<span class="lo">야간 저온 ${fd}일</span>에 주의하세요.`:phLow?'토양 산도만 개선하면 됩니다.':''}`;
  if(phLow&&fd>=3) return `<span class="lo">토양 산도(pH ${env.ph})</span>가 낮고 <span class="lo">야간 저온 ${fd}일</span>이 겹쳐 지금 심으면 실패 위험이 높습니다.`;
  if(phLow) return `토양 산도(<span class="lo">pH ${env.ph}</span>)가 낮아 ${cropName}이 영양을 흡수하지 못해요. 석회 시용 후 <span class="hi">적합 구간</span>에 들어갑니다.`;
  return `현재 적합도 <span class="lo">${score.total}점</span>으로 일부 개선이 필요합니다.`;
}

function renderChecks(){
  document.getElementById('chkCnt').textContent=`${Object.values(doneMap).filter(Boolean).length} / ${currentChecks.length} 완료`;
  document.getElementById('chkBox').innerHTML=currentChecks.map((c,i)=>`<div class="chkrow" onclick="tog(${i})"><div class="chkbox${doneMap[i]?' on':''}">${doneMap[i]?'✓':''}</div><div><div class="chtxt" style="${doneMap[i]?'text-decoration:line-through;color:var(--mute)':''}">${c.t}</div><div class="chwhen">${c.w}</div></div></div>`).join('');
}
function tog(i){doneMap[i]=!doneMap[i];renderChecks();}

// ══════════════════════════════════════════════════════
// 비교 분석
// ══════════════════════════════════════════════════════
async function runCompare(){
  if(!cSigun||cCropIds.length<2) return;
  await runLoading([
    {p:20,e:'🌤',m:'기상 조건 분석 중...'},
    {p:45,e:'🌱',m:'토양 실측 데이터 조회 중...'},
    {p:70,e:'📐',m:`${cCropIds.length}개 작물 분석 중...`},
    {p:90,e:'📊',m:'순위 산출 중...'},
  ]);
  const [kma,soil]=await Promise.all([fetchKmaShortTerm(cSido,cSigun),fetchRealSoil(cSigun)]);
  if(!kma){
    goPage('pHome');
    showToast(`⚠️ ${cSigun}은(는) 기상청 실측 데이터를 가져올 수 없어 비교할 수 없습니다`, 4200);
    return;
  }
  const env=buildEnvFromReal(kma,soil);
  const dataNote=`${weatherNoteOf(kma)} · ${soilNoteOf(soil)}`;
  const results=cCropIds.map(cid=>{
    const c=CROPS[cid];
    // 대표 품종 + 노지로 비교 (날씨·토양은 지역 값으로 동일, 작물별 임계값만 다름)
    const variety=c.varieties[0];
    const score=calcScore(env,cid,variety,'노지');
    return{cropId:cid,crop:c,variety,score:score.total,env};
  }).sort((a,b)=>b.score-a.score);

  const best=results[0];
  const content=document.getElementById('cmpContent');
  content.innerHTML=`
    <div class="card"><div class="card-h"><span class="card-t">📍 ${cSigun} 작물 적합도 순위</span></div>
      ${results.map((r,i)=>{const g=gradeInfo(r.score);return`<div class="rankrow${i===0?' top':''}"><div class="rnum">${i+1}</div><span style="font-size:24px">${r.crop.emoji}</span><div class="rnbody"><div class="rnname">${r.crop.name}</div><div class="rnvar">대표품종: ${r.variety}</div><div class="rbar"><div class="rbarfill" style="width:${r.score}%;background:${g.color}"></div></div></div><div class="rsc" style="color:${g.color}">${r.score}</div></div>`;}).join('')}
      <div style="padding:0 15px 12px;font-size:11px;color:var(--mute)">${dataNote}</div>
    </div>
    <div class="card"><div class="card-h"><span class="card-t">💡 추천 요약</span></div>
      <div class="verdict">${cSigun}에서는 <span class="hi">${best.crop.name}(${best.variety})</span>이(가) <span class="hi">${best.score}점</span>으로 가장 잘 맞습니다. ${results[results.length-1].score<55?`반면 <span class="lo">${results[results.length-1].crop.name}</span>은 이 지역에 적합하지 않습니다.`:'선택하신 작물 모두 시도해볼 만합니다.'}</div>
    </div>
  `;
  goPage('pCmpResult');
}

// ══════════════════════════════════════════════════════
// 분석 이력
// ══════════════════════════════════════════════════════
async function goHistory(){
  goPage('pHistory');
  const box=document.getElementById('histBox');
  const chartWrap=document.getElementById('histChartWrap');
  chartWrap.style.display='none';
  if(!currentUser){
    box.innerHTML='<div style="padding:24px;text-align:center;color:var(--mute);font-size:13px">로그인 후 이용할 수 있어요.</div>';
    return;
  }
  box.innerHTML='<div style="padding:24px;text-align:center;color:var(--mute);font-size:13px">불러오는 중...</div>';
  const { data, error } = await sb.from('analyses')
    .select('*').eq('user_id',currentUser.id)
    .order('created_at',{ascending:false}).limit(50);

  if(error){
    box.innerHTML=`<div style="padding:24px;text-align:center;color:var(--red);font-size:13px">기록을 불러오지 못했습니다: ${error.message}</div>`;
    return;
  }
  if(!data||data.length===0){
    box.innerHTML='<div style="padding:24px;text-align:center;color:var(--mute);font-size:13px">아직 분석 기록이 없어요. 분석을 실행하면 여기에 쌓입니다.</div>';
    return;
  }

  box.innerHTML=data.map(r=>{
    const c=CROPS[r.crop_id];
    const g=gradeInfo(r.f_score);
    const d=new Date(r.created_at);
    const dstr=`${d.getMonth()+1}/${d.getDate()}`;
    const modeLabel=r.flow_mode==='manage'?'지금 관리':r.flow_mode==='compare'?'작물 비교':'심기 전 진단';
    return `<div class="riskrow"><div class="rico ris" style="font-size:20px">${c?c.emoji:'🌾'}</div><div style="flex:1"><div class="rmain" style="color:var(--ink)">${r.region} · ${c?c.name:r.crop_id}${r.variety?`(${r.variety})`:''} ${r.method||''}</div><div class="rsub">${dstr} · ${modeLabel}</div></div><div class="rsc" style="color:${g.color};font-size:18px;font-weight:900">${r.f_score}</div></div>`;
  }).join('');

  chartWrap.style.display='block';
  const chrono=[...data].reverse();
  if(histChart){histChart.destroy();histChart=null;}
  histChart=new Chart(document.getElementById('histChart'),{type:'line',data:{
    labels:chrono.map(r=>{const d=new Date(r.created_at);return `${d.getMonth()+1}/${d.getDate()}`;}),
    datasets:[{data:chrono.map(r=>r.f_score),borderColor:'#1D9E75',backgroundColor:'rgba(29,158,117,.12)',fill:true,pointRadius:3,pointBackgroundColor:'#1D9E75',tension:.35}],
  },options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:x=>Math.round(x.parsed.y)+'점'}}},scales:{y:{min:0,max:100,ticks:{stepSize:20,font:{size:11}},grid:{color:'rgba(0,0,0,.04)'}},x:{grid:{display:false},ticks:{font:{size:11}}}}}});
}

// ══════════════════════════════════════════════════════
// 챗봇
// ══════════════════════════════════════════════════════
const CHIPS=['점수가 왜 이렇게 나왔나요?','지금 당장 뭘 해야 하나요?','이 품종 선택이 맞나요?'];
function resetChat(){
  chatHist=[];const c=analysisCtx;
  document.getElementById('cMsgs').innerHTML=`<div class="cmsg cb">안녕하세요! ${c.region} · ${c.crop}(${c.variety}) ${c.method} 분석(${c.score}점)을 함께 보고 있어요. 무엇이든 물어보세요!</div>`;
  document.getElementById('cChips').innerHTML=CHIPS.map(q=>`<button class="cchip" onclick="sendChat('${q}')">${q}</button>`).join('');
}
function openChat(){document.getElementById('overlay').classList.add('on');document.getElementById('csheet').classList.add('on');document.getElementById('fab').classList.remove('show');}
function closeChat(){document.getElementById('overlay').classList.remove('on');document.getElementById('csheet').classList.remove('on');if(document.getElementById('pResult').classList.contains('on'))document.getElementById('fab').classList.add('show');}

async function sendChat(text){
  if(!text||!text.trim()||!analysisCtx)return;
  const msgs=document.getElementById('cMsgs');
  document.getElementById('cIn').value='';
  document.getElementById('cChips').style.display='none';
  const um=document.createElement('div');um.className='cmsg cu';um.textContent=text;msgs.appendChild(um);msgs.scrollTop=msgs.scrollHeight;
  const typing=document.createElement('div');typing.className='ctyping';typing.innerHTML='<span></span><span></span><span></span>';msgs.appendChild(typing);msgs.scrollTop=msgs.scrollHeight;
  const ans=await fetchChatAns(text);
  typing.remove();
  if(ans.fallback){
    const tag=document.createElement('div');
    tag.style.cssText='font-size:10px;color:var(--mute);align-self:flex-start;margin:-2px 0 0 4px';
    tag.textContent='⚡ 기본 응답 (AI 연결 실패 — 미리 준비된 답변입니다)';
    msgs.appendChild(tag);
  }
  const bm=document.createElement('div');bm.className='cmsg cb';bm.textContent=ans.text;msgs.appendChild(bm);msgs.scrollTop=msgs.scrollHeight;
  msgs.scrollTop=msgs.scrollHeight;
  chatHist.push({role:'user',content:text});chatHist.push({role:'assistant',content:ans.text});
}

// 챗봇이 직접 호출할 수 있는 도구 — 클라이언트에서 실제 스코어링 엔진으로 재계산
// (recalc_variety는 두지 않음 — 사용자가 이미 자기 품종을 알고 선택했으므로 "다른
// 품종이면?" 재계산 수요가 없고, 지역 재계산만 실제로 쓰인다)
const TOOLS_CLIENT={
  async recalc_region(args){
    const cid=analysisCtx.cropId;
    const kma=await fetchKmaShortTerm(null,args.sigun); // sido 모르면 동명 지역 없는 한 자동 해석
    if(!kma) return{error:`${args.sigun}은(는) 기상청 실측 데이터를 가져올 수 없어 재계산할 수 없습니다. 지역명을 다시 확인해주세요(예: 동명 시군구가 있으면 시/도까지 알려주세요).`};
    const soil=await fetchRealSoil(args.sigun);
    const env=buildEnvFromReal(kma,soil);
    const sc=calcScore(env,cid,analysisCtx.variety,analysisCtx.method);
    return{region:args.sigun,score:sc.total,grade:gradeInfo(sc.total).label,avgTemp:((env.mx+env.mn)/2).toFixed(1),ph:env.ph==null?'실측 데이터 없음':env.ph,weatherSource:'기상청 실측'};
  },
};

async function callChatApi(payload){
  const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await res.json();
  if(!res.ok) throw new Error(data.error||'chat api failed');
  return data;
}

async function fetchChatAns(msg){
  const c=analysisCtx;
  const soilLine=c.hasSoil?`산도:pH${c.ph}(적정${c.thPh}) 염분:EC${c.ec} 유기물:${c.om}`:'토양: 이 지역은 농촌진흥청 실측 데이터가 없어 적합도 점수에 반영되지 않았음';
  const nowLine=c.nowcast?` 지금 실황:${c.nowcast.temp}°C${c.nowcast.rain1h>0?`,최근1시간강수${c.nowcast.rain1h}mm`:''}`:'';
  const sys=`당신은 귀농인을 돕는 농업 전문가입니다. 아래 분석 데이터에만 근거해서 답하세요.
지역:${c.region} 작물:${c.crop} 품종:${c.variety} 재배방식:${c.method}
적합도:${c.score}점(${c.grade}) ML4주후:${c.mlPred4w}점 수확량:${c.yield}kg(${c.yieldDelta>0?'+':''}${c.yieldDelta}%)
기온(예보 평균):${c.avg}°C${nowLine} ${soilLine} 야간저온:${c.frostDays}일
위험:${c.risks}

답변 스타일:
- 쉬운 말, 행동 중심으로 답하되 문장 수를 억지로 맞추지 마세요. 단순한 질문(예/아니오,
  숫자 확인)은 1~2문장으로 짧게, "왜 이 점수가 나왔는지" "지금 뭘 해야 하는지"처럼
  설명이 필요한 질문은 필요한 만큼 충분히(항목을 나눠 설명해도 됨) 답하세요.
- 이 데이터로 답할 수 없는 질문(예: 병충해 진단, 농약 처방)은 모른다고 인정하고
  농업기술센터·전문가 상담을 안내하세요. 지어내서 답하지 마세요.
- 사용자가 인사만 하거나 잡담을 걸면 자연스럽게 받아주고, 이 분석에 대해 뭘 도와줄 수
  있는지 짧게 안내하세요.

${c.hasVarietyEffect
  ? `이 작물은 품종별 수확 시기(조생/중생/만생) 차이가 실제로 확인돼 점수에 반영돼 있습니다 — "품종이 점수에 영향을 주냐"는 질문에는 그렇다고 답하고, 정확한 수치 근거(예: pH나 EC 같은 구체적 수치)가 없는 부분은 추측하지 마세요.`
  : `이 작물은 품종별 재배 적합도 차이를 뒷받침할 신뢰할 만한 자료를 찾지 못해 품종은 기록용일 뿐 점수에 반영하지 않습니다 — "이 품종이 더 낫냐"는 질문에는 추측하지 말고 그렇게 정확히 답하세요.`}
사용자가 "다른 지역이면?"처럼 실제 재계산이 필요한 질문을 하면 추측하지 말고
recalc_region 도구를 호출해 실제 점수를 받아온 뒤 답하세요.`;

  const baseMessages=[...chatHist,{role:'user',content:msg}];
  try{
    const first=await callChatApi({system:sys,messages:baseMessages,enableTools:true});
    if(first.functionCall){
      const {name,args}=first.functionCall;
      const fn=TOOLS_CLIENT[name];
      const result=fn?await fn(args):{error:'알 수 없는 도구입니다.'};
      const second=await callChatApi({system:sys,messages:baseMessages,toolResult:{name,args,result}});
      if(!second.text) throw new Error('empty tool followup');
      return{text:second.text,fallback:false};
    }
    if(!first.text) throw new Error('empty response');
    return{text:first.text,fallback:false};
  }catch(e){ return{text:fallbackAns(msg),fallback:true}; }
}

function fallbackAns(msg){
  const c=analysisCtx;
  if(msg.includes('점수')||msg.includes('산도')||msg.includes('pH')){
    if(!c.hasSoil) return `${c.crop}(${c.variety}) 적합도 ${c.score}점은 이 지역의 농촌진흥청 토양 실측 데이터가 아직 없어 기온·강수 조건만으로 계산됐어요. 정확한 산도(pH) 진단은 농업기술센터에 토양검정을 의뢰해보세요.`;
    if(c.ph<6.0) return `${c.crop}(${c.variety}) 적합도 ${c.score}점의 주요 원인은 토양 산도(pH ${c.ph})입니다. 적정(pH ${c.thPh})보다 산성이라 뿌리가 영양을 흡수하기 어렵습니다. 석회 200~300kg/10a를 정식 2~3주 전에 뿌리면 개선됩니다.`;
    const varietyNote=c.hasVarietyEffect?`품종(${c.variety})도 수확 시기 차이 때문에 점수에 일부 반영됐어요.`:`품종(${c.variety})은 기록용일 뿐 점수에는 반영되지 않고요.`;
    return `현재 ${c.score}점은 기온·토양산도·염분·강수를 종합한 결과예요. ${varietyNote} ${c.method} 재배방식도 점수·수확량에 영향을 줍니다.`;
  }
  if(msg.includes('품종')) return c.hasVarietyEffect
    ? `품종(${c.variety})은 수확 시기(조생/중생/만생)에 따라 필요한 누적 온도가 달라서 적합도 점수에 일부 반영돼요. 다만 정확한 항목별 수치까지는 알려드리기 어려워요.`
    : `품종(${c.variety})은 현재 기록 목적으로만 남겨두고 있어서 적합도 점수에는 영향을 주지 않아요. 대신 ${c.method} 재배 시 ${c.frostDays>0?'야간 저온 관리':'일조량 확보'}에 신경 쓰시면 됩니다.`;
  if(msg.includes('심')||msg.includes('정식')||msg.includes('언제')){
    if(c.frostDays>=3) return `앞으로 ${c.frostDays}일 야간 저온이 예보돼 정식을 2주 미루는 게 좋아요. ${c.method==='시설'?'하우스라면 내부 온도를 유지하면 진행 가능합니다.':''}ML 예측상 ${c.mlPred4w}점으로 오르면 그때가 적기입니다.`;
    return `현재 기온 조건은 정식에 무리가 없어요. 토양 준비를 마쳤다면 이번 주 진행해도 좋습니다.`;
  }
  if(msg.includes('수확')) return `ML 예측 기준 ${c.yield.toLocaleString()}kg/10a(표준 대비 ${c.yieldDelta>0?'+':''}${c.yieldDelta}%)입니다. ${c.method} 재배방식${c.hasVarietyEffect?'과 품종의 수확시기 차이':''}를 고려한 값입니다.`;
  if(msg.includes('날씨')||msg.includes('기온')||msg.includes('온도')||msg.includes('비')||msg.includes('강수')){
    const nowPart=c.nowcast?` 지금 실황은 ${c.nowcast.temp}°C${c.nowcast.rain1h>0?`, 최근 1시간 강수 ${c.nowcast.rain1h}mm`:''}예요.`:'';
    return `기상청 단기예보 기준 평균 기온은 ${c.avg}°C(최저 ${c.tmin}°C~최고 ${c.tmax}°C)이고, 야간 저온이 ${c.frostDays}일 예보돼 있어요.${nowPart}`;
  }
  if(msg.includes('위험')||msg.includes('걱정')||msg.includes('괜찮')){
    return `현재 감지된 신호는 — ${c.risks} — 이렇습니다. 급한 항목(🚨)이 있으면 오늘 안에 조치하시고, 애매하면 농업기술센터에 확인해보세요.`;
  }
  if(/^(안녕|하이|헬로|ㅎㅇ)/.test(msg.trim())) return `안녕하세요! ${c.region} · ${c.crop}(${c.variety}) ${c.method} 분석 결과 보고 계세요. 점수 이유, 지금 할 일, 다른 지역과 비교 등 뭐든 물어보세요.`;
  return `${c.region} · ${c.crop}(${c.variety}) ${c.method} 분석 기준으로 답할 수 있어요 — 점수, 토양, 날씨, 위험 신호, 수확량, 정식 시기 중 궁금한 걸 구체적으로 물어봐 주시면 더 정확히 안내할게요.`;
}
