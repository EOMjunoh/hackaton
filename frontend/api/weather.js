// Vercel Serverless Function — 기상청 단기예보(VilageFcstInfoService_2.0/getVilageFcst)를
// 서버 쪽에서 안전하게 호출하는 프록시. 인증키는 여기(서버)에서만 쓰이고 브라우저로는
// 절대 내려가지 않습니다.
//
// 응답으로 오늘 기준 짧게는 3일치(base_time 발표 시각에 따라 다름) 실측 최고/최저기온,
// 강수확률(POP, %), 강수량 범주(PCP)를 돌려줍니다. PCP는 기상청이 "1~4mm", "30mm 이상"
// 같은 범주 텍스트로만 제공해 정확한 mm 값이 아니므로, 범주 구간의 중앙값(또는 "미만"은
// 절반, "이상"은 하한값)으로 추정한 pcpMm을 함께 내려줍니다 — 실측 범주에서 파생한
// 추정치이며 지어낸 값이 아닙니다.
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET만 허용됩니다.' });
    return;
  }

  const serviceKey = process.env.KMA_SERVICE_KEY;
  if (!serviceKey) {
    res.status(500).json({ error: 'KMA_SERVICE_KEY 환경변수가 설정되어 있지 않습니다.' });
    return;
  }

  const { nx, ny } = req.query || {};
  if (!/^\d+$/.test(String(nx)) || !/^\d+$/.test(String(ny))) {
    res.status(400).json({ error: 'nx, ny(격자 좌표, 정수)가 필요합니다.' });
    return;
  }

  const { baseDate, baseTime } = getBaseDateTime();

  try {
    const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst` +
      `?serviceKey=${serviceKey}&numOfRows=1000&pageNo=1&dataType=JSON` +
      `&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;

    const upstream = await fetch(url);
    const data = await upstream.json();

    const header = data?.response?.header;
    if (!header || header.resultCode !== '00') {
      res.status(502).json({ error: `기상청 API 오류: ${header?.resultMsg || '알 수 없는 응답'}` });
      return;
    }

    // 이상치 방어: 파싱 오류나 API 응답 이상으로 물리적으로 불가능한 값(대한민국 기상
    // 관측사상 극값을 넉넉히 벗어난 기온, 0~100을 벗어난 확률)이 섞여 있으면 버린다.
    const inRange = (v, lo, hi) => !Number.isNaN(v) && v >= lo && v <= hi;

    const items = data.response.body?.items?.item || [];
    const byDate = {};
    for (const it of items) {
      const d = byDate[it.fcstDate] || (byDate[it.fcstDate] = { mx: null, mn: null, tmpSamples: [], popSamples: [], pcpSamples: [] });
      if (it.category === 'TMX') { const v = parseFloat(it.fcstValue); if (inRange(v, -45, 45)) d.mx = v; }
      else if (it.category === 'TMN') { const v = parseFloat(it.fcstValue); if (inRange(v, -45, 45)) d.mn = v; }
      else if (it.category === 'TMP') { const v = parseFloat(it.fcstValue); if (inRange(v, -45, 45)) d.tmpSamples.push(v); }
      else if (it.category === 'POP') { const v = parseFloat(it.fcstValue); if (inRange(v, 0, 100)) d.popSamples.push(v); }
      else if (it.category === 'PCP') { d.pcpSamples.push(parsePcpMm(it.fcstValue)); }
    }

    const days = Object.keys(byDate).sort().map((date) => {
      const d = byDate[date];
      const mx = d.mx ?? (d.tmpSamples.length ? Math.max(...d.tmpSamples) : null);
      const mn = d.mn ?? (d.tmpSamples.length ? Math.min(...d.tmpSamples) : null);
      const pop = d.popSamples.length ? Math.round(d.popSamples.reduce((a, b) => a + b, 0) / d.popSamples.length) : null;
      const pcpMm = d.pcpSamples.length ? Math.round(d.pcpSamples.reduce((a, b) => a + b, 0) * 10) / 10 : 0;
      return { date, mx, mn, pop, pcpMm };
    }).filter((d) => d.mx !== null && d.mn !== null);

    res.status(200).json({ baseDate, baseTime, days });
  } catch (e) {
    res.status(500).json({ error: e.message || '알 수 없는 오류' });
  }
};

// 단기예보는 02/05/08/11/14/17/20/23시(KST)에 발표되고, 발표 후 약 10분 뒤 조회 가능
function getBaseDateTime() {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const now = new Date(Date.now() + KST_OFFSET_MS);
  const slots = [2, 5, 8, 11, 14, 17, 20, 23];
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();

  let idx = -1;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (h > slots[i] || (h === slots[i] && m >= 10)) { idx = i; break; }
  }

  const date = new Date(now);
  if (idx === -1) {
    date.setUTCDate(date.getUTCDate() - 1);
    idx = slots.length - 1;
  }

  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return { baseDate: `${y}${mo}${d}`, baseTime: String(slots[idx]).padStart(2, '0') + '00' };
}

// 기상청 PCP(강수량) 범주 텍스트 → mm 추정치. 예: "강수없음"→0, "1mm 미만"→0.5,
// "1~4mm"→2.5(구간 중앙값), "30mm 이상"→30(하한값, 보수적 추정).
function parsePcpMm(text) {
  if (!text || text.includes('없음')) return 0;
  const nums = (text.match(/\d+(\.\d+)?/g) || []).map(Number);
  if (!nums.length) return 0;
  if (text.includes('미만')) return nums[0] / 2;
  if (text.includes('이상')) return nums[0];
  if (nums.length >= 2) return (nums[0] + nums[1]) / 2;
  return nums[0];
}
