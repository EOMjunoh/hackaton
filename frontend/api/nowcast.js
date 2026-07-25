// Vercel Serverless Function — 기상청 초단기실황(UltraSrtNcst/getUltraSrtNcst)을
// 서버 쪽에서 안전하게 호출하는 프록시. weather.js(단기예보, 미래 예측)와 달리 이건
// "지금 이 순간" 실제로 관측된 값입니다 — 기온(T1H)과 최근 1시간 강수량(RN1)은 범주
// 텍스트가 아니라 실측 숫자 그대로 옵니다.
//
// '지금 관리' 플로우가 '심기 전 진단'과 똑같이 미래 예보만 보고 있다는 지적을 반영해,
// "지금 실제로 어떤 상태인지"를 별도로 보여주기 위해 추가했습니다.
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
    const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst` +
      `?serviceKey=${serviceKey}&numOfRows=10&pageNo=1&dataType=JSON` +
      `&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;

    const upstream = await fetch(url);
    const data = await upstream.json();

    const header = data?.response?.header;
    if (!header || header.resultCode !== '00') {
      res.status(502).json({ error: `기상청 API 오류: ${header?.resultMsg || '알 수 없는 응답'}` });
      return;
    }

    const items = data.response.body?.items?.item || [];
    let temp = null, rain1h = null, ptyCode = null;
    for (const it of items) {
      const v = parseFloat(it.obsrValue);
      if (it.category === 'T1H' && !Number.isNaN(v)) temp = v;
      else if (it.category === 'RN1' && !Number.isNaN(v)) rain1h = v; // mm, "강수없음"이면 API가 0으로 줌
      else if (it.category === 'PTY') ptyCode = it.obsrValue;
    }
    if (temp === null) {
      res.status(200).json({ available: false });
      return;
    }

    res.status(200).json({
      available: true,
      baseDate, baseTime, temp, rain1h,
      ptyLabel: ptyLabelOf(ptyCode),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || '알 수 없는 오류' });
  }
};

function ptyLabelOf(code) {
  switch (String(code)) {
    case '0': return '맑음/흐림(강수 없음)';
    case '1': return '비';
    case '2': return '비/눈';
    case '3': return '눈';
    case '5': return '빗방울';
    case '6': return '빗방울/눈날림';
    case '7': return '눈날림';
    default: return null;
  }
}

// 초단기실황은 매시 정시 관측, 40분 이후 조회 가능
function getBaseDateTime() {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const now = new Date(Date.now() + KST_OFFSET_MS);
  const date = new Date(now);
  let hour = date.getUTCHours();
  if (date.getUTCMinutes() < 40) {
    date.setUTCHours(hour - 1);
    hour = date.getUTCHours();
  }
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return { baseDate: `${y}${mo}${d}`, baseTime: String(hour).padStart(2, '0') + '00' };
}
