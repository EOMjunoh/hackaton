// Vercel Serverless Function — 농촌진흥청 국립농업과학원 "토양검정 화학성 상세정보"
// (SoilEnviron/SoilExam/getSoilExamList) API를 서버에서 안전하게 호출하는 프록시.
// data.go.kr 계정의 서비스키(KMA_SERVICE_KEY)를 그대로 재사용합니다 — data.go.kr은
// API별로 개별 "활용신청"이 필요하지만, 승인되면 계정당 발급된 키 하나로 공용 사용합니다.
// 이 API가 동작하려면 data.go.kr에서 "농촌진흥청 국립농업과학원_토양검정 화학성 상세정보"
// (서비스 상품 ID 15073569)에 대해 별도로 활용신청이 승인돼 있어야 합니다.
//
// 법정동(BJD_Code) 안에는 여러 필지의 검정 기록이 있을 수 있어, 최근 기록들의 평균을
// 그 지역의 대표 토양값으로 사용합니다. 응답은 XML만 제공돼(JSON 옵션 없음) 여기서
// 간단히 정규식으로 파싱합니다.
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

  const { bjd } = req.query || {};
  if (!/^\d{10}$/.test(String(bjd))) {
    res.status(400).json({ error: 'bjd(법정동코드, 10자리)가 필요합니다.' });
    return;
  }

  try {
    const url = `https://apis.data.go.kr/1390802/SoilEnviron/SoilExam/V2/getSoilExamList` +
      `?serviceKey=${serviceKey}&Page_Size=20&Page_No=1&STDG_CD=${bjd}`;
    const upstream = await fetch(url);
    const xml = await upstream.text();

    const resultCode = extractTag(xml, 'Result_Code');
    if (resultCode !== '200') {
      res.status(502).json({ error: `토양 API 오류(${resultCode || '?'}): ${extractTag(xml, 'Result_Msg') || xml.slice(0, 200)}` });
      return;
    }

    // 이상치 방어: NaN뿐 아니라 화학적으로 불가능한 값(파싱 오류·공공데이터 입력 오류로
    // 간혹 섞여 들어옴)도 평균에서 제외한다. 범위는 임의 추정이 아니라 물리·화학적 정의
    // 그 자체다 — pH는 정의상 0~14, EC·유기물·유효인산은 국내 농경지에서 절대 나올 수
    // 없는 극단값(음수, 수만 단위)만 걸러내는 넉넉한 상한이라 정상적인 실측값을 실수로
    // 버리지 않는다.
    const PLAUSIBLE = { ph: [0, 14], ec: [0, 20], om: [0, 100], avp: [0, 5000] };
    const isPlausible = (i) => Object.entries(PLAUSIBLE).every(([k, [lo, hi]]) =>
      !Number.isNaN(i[k]) && i[k] >= lo && i[k] <= hi);
    const items = parseItems(xml).filter(isPlausible);
    if (!items.length) {
      res.status(200).json({ items: 0 });
      return;
    }

    const avg = (key) => Math.round((items.reduce((a, i) => a + i[key], 0) / items.length) * 100) / 100;
    const latestYear = items.reduce((a, i) => Math.max(a, parseInt(i.anyYear, 10) || 0), 0);

    res.status(200).json({
      ph: avg('ph'), ec: avg('ec'), om: avg('om'), avp: avg('avp'),
      sampleCount: items.length, latestYear,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || '알 수 없는 오류' });
  }
};

function extractTag(str, tag) {
  const m = str.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

function parseItems(xml) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return blocks.map((b) => ({
    anyYear: extractTag(b, 'Any_Year'),
    ph: parseFloat(extractTag(b, 'ACID')),
    ec: parseFloat(extractTag(b, 'ELCD')),
    om: parseFloat(extractTag(b, 'OM')),
    avp: parseFloat(extractTag(b, 'VLDPHA')),
  }));
}
