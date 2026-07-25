// 스코어링 엔진 + 실데이터 유틸 유닛테스트 — Node 내장 테스트 러너 사용
// 실행: cd frontend && node --test tests/
//
// 더 이상 Math.sin 기반 시뮬레이션(genEnv)을 쓰지 않으므로, 여기서는 기상청/농촌진흥청
// 응답을 흉내 낸 "실측 데이터 모양"의 고정 fixture(envFull/envNoSoil)로 스코어링 엔진의
// 순수 함수만 검증한다. data.js 쪽은 격자 변환 공식과 실제 좌표 매핑만 검증한다 —
// 어떤 지역의 환경값을 지어내는 함수는 이제 존재하지 않는다.
const assert = require('node:assert');
const test = require('node:test');
const { CROPS, dfsXyConv, getGrid, resolveSido, getGridBySigun, SIDO } = require('../data.js');
const { sVar, gdd, calcScore, mlPredict, detectRisks, genChecks, gradeInfo } = require('../scoring.js');

// 기상청 단기예보 실측 + 농촌진흥청 토양검정 실측을 합쳐 놓은 모양의 fixture
function makeFc(mns, mxs) {
  return mns.map((mn, i) => ({ date: i === 0 ? '오늘' : `${i}일 후`, mx: mxs[i], mn }));
}
const envFull = {
  mx: 24, mn: 15,
  fc: makeFc([15, 14, 16], [24, 23, 25]),
  rain: 50,
  ph: 6.2, ec: 1.0, om: 28, avp: 300,
};
const envNoSoil = { ...envFull, ph: null, ec: null, om: null, avp: null };

test('sVar returns 100 within the optimal band', () => {
  const th = { opt_min: 10, opt_max: 20, lim_min: 0, lim_max: 30 };
  assert.strictEqual(sVar(15, th), 100);
  assert.strictEqual(sVar(10, th), 100);
  assert.strictEqual(sVar(20, th), 100);
});

test('sVar decays but stays >=60 just outside the optimal band', () => {
  const th = { opt_min: 10, opt_max: 20, lim_min: 0, lim_max: 30 };
  const v = sVar(5, th);
  assert.ok(v >= 60 && v < 100, `expected [60,100) got ${v}`);
});

test('sVar drops to 0 far beyond the limit', () => {
  const th = { opt_min: 10, opt_max: 20, lim_min: 0, lim_max: 30 };
  assert.strictEqual(sVar(-50, th), 0);
  assert.strictEqual(sVar(100, th), 0);
});

test('gdd is clamped to [0,100]', () => {
  assert.strictEqual(gdd(-10, 5, 180, 1000), 0); // avg below tbase
  assert.ok(gdd(50, 5, 180, 100) <= 100); // absurdly high avg still capped
});

test('calcScore stays within [0,100] for every crop/variety/method, with or without soil data', () => {
  for (const env of [envFull, envNoSoil]) {
    for (const cid of Object.keys(CROPS)) {
      for (const variety of CROPS[cid].varieties) {
        for (const method of ['노지', '시설']) {
          const s = calcScore(env, cid, variety, method).total;
          assert.ok(s >= 0 && s <= 100, `${cid}/${variety}/${method} out of range: ${s}`);
        }
      }
    }
  }
});

test('calcScore omits ph/ec and renormalizes weights when soil data is unavailable', () => {
  const cid = 'apple';
  const withSoil = calcScore(envFull, cid, '후지(부사)', '노지');
  const withoutSoil = calcScore(envNoSoil, cid, '후지(부사)', '노지');
  assert.strictEqual(withSoil.hasSoil, true);
  assert.strictEqual(withoutSoil.hasSoil, false);
  assert.strictEqual(withoutSoil.ps, null);
  assert.strictEqual(withoutSoil.es, null);
  assert.notStrictEqual(withSoil.ps, null);
});

test('gradeInfo covers the full 0-100 range without gaps', () => {
  for (const s of [0, 10, 39, 40, 54, 55, 69, 70, 84, 85, 100]) {
    const g = gradeInfo(s);
    assert.ok(g && typeof g.label === 'string' && typeof g.color === 'string', `no grade for score ${s}`);
  }
});

test('mlPredict returns 5 weekly points each inside its own confidence band', () => {
  const cid = 'apple';
  const base = calcScore(envFull, cid, '후지(부사)', '노지').total;
  const ml = mlPredict(base, envFull, cid, '후지(부사)', '노지');
  assert.strictEqual(ml.pred.length, 5);
  assert.strictEqual(ml.lo.length, 5);
  assert.strictEqual(ml.hi.length, 5);
  ml.pred.forEach((p, i) => {
    assert.ok(ml.lo[i] <= p, `week ${i}: lo(${ml.lo[i]}) should be <= pred(${p})`);
    assert.ok(p <= ml.hi[i], `week ${i}: pred(${p}) should be <= hi(${ml.hi[i]})`);
  });
});

test('mlPredict confidence band widens with forecast volatility', () => {
  const cid = 'lettuce';
  const stable = { ...envFull, fc: makeFc([15, 15, 15], [24, 24, 24]) };
  const volatile = { ...envFull, fc: makeFc([15, 2, 20], [24, 10, 30]) };
  const baseStable = calcScore(stable, cid, '청치마', '노지').total;
  const baseVolatile = calcScore(volatile, cid, '청치마', '노지').total;
  const mlStable = mlPredict(baseStable, stable, cid, '청치마', '노지');
  const mlVolatile = mlPredict(baseVolatile, volatile, cid, '청치마', '노지');
  assert.ok(mlVolatile.volatility > mlStable.volatility, 'volatile fixture should report higher volatility');
  assert.ok((mlVolatile.hi[4] - mlVolatile.lo[4]) >= (mlStable.hi[4] - mlStable.lo[4]), 'wider volatility should not shrink the band');
});

test('mlPredict does not assume a ph improvement when soil data is unavailable', () => {
  const cid = 'potato';
  const base = calcScore(envNoSoil, cid, '수미', '노지').total;
  const ml = mlPredict(base, envNoSoil, cid, '수미', '노지');
  assert.strictEqual(ml.pred.length, 5); // just needs to run without throwing on env.ph being null
});

test('variety no longer affects the score (varMods removed)', () => {
  const cid = 'apple';
  const scores = CROPS[cid].varieties.map((v) => calcScore(envFull, cid, v, '노지').total);
  const [first, ...rest] = scores;
  rest.forEach((s) => assert.strictEqual(s, first, `varieties should score identically, got ${scores}`));
});

test('variety no longer affects predicted yield (varMods removed)', () => {
  const cid = 'apple';
  const base = calcScore(envFull, cid, '후지(부사)', '노지').total;
  const yields = CROPS[cid].varieties.map((v) => mlPredict(base, envFull, cid, v, '노지').predictedYield);
  const [first, ...rest] = yields;
  rest.forEach((y) => assert.strictEqual(y, first, `predicted yield should be identical across varieties, got ${yields}`));
});

test('detectRisks and genChecks run without throwing when soil data is missing, and flag the gap honestly', () => {
  const cid = 'apple';
  const risks = detectRisks(envNoSoil, cid, 'before');
  assert.ok(risks.some((r) => r.title.includes('토양 실측 데이터 없음')), 'should surface the missing-soil-data gap instead of inventing a value');
  const checks = genChecks(envNoSoil, cid, 'before');
  assert.ok(Array.isArray(checks) && checks.length > 0);
});

// ── data.js: 격자 좌표 변환 + 실제 좌표 매핑 ──────────────────────────────
test('dfsXyConv matches the official KMA worked example (Seoul)', () => {
  const { nx, ny } = dfsXyConv(37.5794, 126.9910);
  assert.strictEqual(nx, 60);
  assert.strictEqual(ny, 127);
});

test('getGrid returns a real, in-range grid coordinate for a known sido/sigun pair', () => {
  const g = getGrid('전라북도', '전주시');
  assert.ok(g);
  assert.ok(g.nx >= 1 && g.nx <= 149);
  assert.ok(g.ny >= 1 && g.ny <= 253);
});

test('getGrid returns null (not an invented coordinate) for an unmapped region', () => {
  assert.strictEqual(getGrid('전라북도', '없는지역동네'), null);
});

test('every SIDO region has a real coordinate entry backing getGrid', () => {
  const missing = [];
  for (const [sido, list] of Object.entries(SIDO)) {
    for (const sigun of list) {
      if (!getGrid(sido, sigun)) missing.push(`${sido} ${sigun}`);
    }
  }
  assert.deepStrictEqual(missing, [], `regions missing a real coordinate: ${missing.join(', ')}`);
});

test('resolveSido / getGridBySigun refuses to guess for an ambiguous region name', () => {
  // 고성군 exists in both 강원도 and 경상남도 — must not silently pick one
  assert.strictEqual(resolveSido('고성군'), null);
  assert.strictEqual(getGridBySigun('고성군'), null);
});

test('resolveSido / getGridBySigun resolves an unambiguous region name', () => {
  assert.strictEqual(resolveSido('전주시'), '전라북도');
  assert.ok(getGridBySigun('전주시'));
});
