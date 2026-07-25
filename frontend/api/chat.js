// Vercel Serverless Function — Google Gemini API를 서버 쪽에서 안전하게 호출하는 프록시.
// API 키는 여기(서버)에서만 사용되고 브라우저로는 절대 내려가지 않습니다.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 허용됩니다.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.' });
    return;
  }

  const { system, messages, enableTools, toolResult } = req.body || {};
  if (!system || !Array.isArray(messages)) {
    res.status(400).json({ error: 'system과 messages가 필요합니다.' });
    return;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // 도구 실행 결과를 받은 후속 턴: 모델의 functionCall + 클라이언트가 실행한
  // functionResponse를 대화에 이어붙여 최종 자연어 답변을 받는다.
  if (toolResult && toolResult.name) {
    contents.push({ role: 'model', parts: [{ functionCall: { name: toolResult.name, args: toolResult.args || {} } }] });
    contents.push({ role: 'function', parts: [{ functionResponse: { name: toolResult.name, response: toolResult.result || {} } }] });
  }

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    // maxOutputTokens 400은 한국어 기준으로 조금만 길어져도 답변이 중간에 잘렸다 —
    // 질문 성격에 따라 유연하게 답하도록 여유를 늘림. temperature도 살짝 올려 매번
    // 판박이 같은 문장 대신 자연스러운 표현이 나오게 함(단, 근거 데이터는 그대로 고정).
    generationConfig: { maxOutputTokens: 900, temperature: 0.6 },
  };

  // 에이전트형 챗봇: 모델이 필요하면 재계산 도구를 직접 호출하게 한다.
  if (enableTools) {
    body.tools = [{
      functionDeclarations: [
        {
          name: 'recalc_region',
          description: '같은 작물·품종·재배방식에서 다른 시군구 지역으로 적합도 점수를 재계산합니다.',
          parameters: {
            type: 'OBJECT',
            properties: { sigun: { type: 'STRING', description: '재계산할 시군구명 (예: 전주시, 춘천시)' } },
            required: ['sigun'],
          },
        },
      ],
    }];
  }

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: data.error?.message || 'Gemini API 오류' });
      return;
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const fnPart = parts.find((p) => p.functionCall);
    if (fnPart) {
      res.status(200).json({ functionCall: { name: fnPart.functionCall.name, args: fnPart.functionCall.args || {} } });
      return;
    }

    const text = parts.map((p) => p.text || '').join('');
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message || '알 수 없는 오류' });
  }
};
