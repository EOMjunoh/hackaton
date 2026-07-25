# FarmFit AI v3 — 배포 가이드

## 파일 구조
```
farmfit_v3/
├── frontend/
│   ├── index.html      ← UI 마크업 + CSS
│   └── app.js          ← Supabase 인증 + 분석 로직 + 챗봇
├── vercel.json         ← Vercel 배포 설정
├── supabase_schema.sql ← DB 테이블 + RLS 설정
└── README.md
```

---

## 1. Supabase 설정

### 1.1 SQL 실행
Supabase 대시보드 → **SQL Editor** → `supabase_schema.sql` 내용 붙여넣고 실행.

### 1.2 이메일 인증 설정 (개발 중엔 끄기 권장)
대시보드 → **Authentication** → **Email** → **Confirm email** 토글 OFF  
→ 회원가입 즉시 로그인됨 (테스트 편함)

운영 환경에서는 ON으로 켜고 이메일 템플릿 설정.

---

## 2. Vercel 배포

### 2.1 Vercel CLI 방식
```bash
npm i -g vercel
cd farmfit_v3/frontend   # index.html + app.js 있는 폴더
vercel --prod
```

> 최초 배포 시 `vercel.json`도 같은 폴더에 있어야 합니다.  
> `frontend/` 폴더만 배포하려면 아래처럼:
```bash
cd farmfit_v3
vercel --prod --root ./frontend
```

### 2.2 GitHub 연동 방식 (추천)
1. GitHub 레포 생성 후 `farmfit_v3/` 전체 푸시
2. Vercel 대시보드 → **New Project** → GitHub 레포 연결
3. **Root Directory**: `frontend` 로 설정
4. **Framework Preset**: Other (Static Site)
5. Deploy 클릭

### 2.3 배포 후 Supabase CORS 설정
Supabase 대시보드 → **Authentication** → **URL Configuration**  
→ **Redirect URLs** 에 Vercel 도메인 추가:
```
https://your-app.vercel.app
https://your-app.vercel.app/**
```

---

## 3. 로컬 실행 (배포 없이 테스트)
```bash
# frontend/ 폴더에서 index.html, app.js 같이 있어야 함
open frontend/index.html
```

---

## 3.5 챗봇용 Google Gemini API 키 설정 (필수, 무료)
챗봇은 `frontend/api/chat.js` 서버리스 함수를 통해 Google Gemini API(무료 티어)를 호출합니다.
API 키는 절대 프론트엔드 코드에 넣지 말고, Vercel 환경변수로만 등록하세요.

1. https://aistudio.google.com/apikey 에서 무료 API 키 발급 (Google 계정만 있으면 됨)
2. Vercel에 환경변수 등록:
```bash
vercel env add GEMINI_API_KEY
```
(또는 Vercel 대시보드 → 프로젝트 → Settings → Environment Variables)

기본 모델은 `gemini-2.0-flash`이며, 다른 모델을 쓰고 싶으면 `GEMINI_MODEL` 환경변수로 바꿀 수 있습니다.
키가 없으면 챗봇은 자동으로 `fallbackAns()` 규칙 기반 답변으로 대체됩니다(로컬 정적 서버로 열 때도 마찬가지).

---

## 4. Supabase 연결 정보 (app.js에 이미 포함)
```js
const SUPABASE_URL = 'https://ahklaovymayuqfalwggg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wXVlSyyz209dANBxjr7gUw_lMKhw1CZ';
```

---

## 5. 주요 기능
- **Supabase Auth**: 회원가입 → 이메일 인증 → 로그인 → 세션 복원
- **닉네임**: 가입 시 `user_metadata.nickname` 저장, 상단 표시, 변경 가능
- **지역 2단계**: 시/도 → 시군구 선택 (전국 9개 시도, 154개 시군구 커버)
- **작물 세분화**: 작물 → 품종(5개) → 재배방식(노지/시설)
- **ML 예측**: 품종·방식별 수확량 보정 + 4주 적합도 예측
- **분석 이력**: Supabase `analyses` 테이블에 로그인 사용자 이력 자동 저장
- **챗봇**: 분석 결과 컨텍스트 인식 대화

---

## 6. 실데이터 아키텍처 — 시뮬레이션 데이터 없음

이 앱은 어떤 지역/작물 조합에 대해서도 기상·토양 값을 임의로 만들어내지 않습니다.
사용하는 실제 데이터 출처는 다음과 같습니다.

| 구분 | 데이터 | 제공처 | 연동 방식 |
|---|---|---|---|
| 기상 | 기상청 단기예보 조회서비스(`VilageFcstInfoService_2.0`) | 기상청 (data.go.kr 15084084) | `frontend/api/weather.js` 서버 프록시 → 실측 최고/최저기온, 강수확률(POP), 강수량 범주(PCP) |
| 토양 | 토양검정 화학성 상세정보(`SoilEnviron/SoilExam`) | 농촌진흥청 국립농업과학원 | `frontend/api/soil.js` 서버 프록시 → 실측 pH·EC·유기물·유효인산 |
| 격자 좌표 | 기상청 공식 격자-위경도 변환 공식(dfs_xy_conv, 람베르트 정각원추도법) | 기상청 공개 알고리즘 | `frontend/data.js`의 `COORDS`(시청/군청 실측 위경도, 위키백과 출처) → `dfsXyConv()`로 계산한 파생값. 상수는 서울 공식 예제(37.5794, 126.9910 → nx60,ny127)로 검증함 |
| 법정동코드 | 행정표준코드(STDG_CD) | code.go.kr / data.go.kr 실응답으로 리 단위까지 확인된 지역만 | `frontend/data.js`의 `BJD` — 미검증 지역은 코드를 채워 넣지 않고 `null` |

**데이터가 없을 때의 동작**
- 기상 데이터를 가져올 수 없는 지역(격자 매핑 실패, API 오류 등)은 분석을 진행하지 않고 토스트로 안내합니다.
- 토양 실측 데이터가 없는 지역(현재 `BJD`에 없는 대부분의 지역)은 적합도 점수를 **온도·GDD·일교차·강수 항목만으로 재정규화**해 계산하고, 결과 화면과 챗봇 모두에 "토양 데이터 없음"을 명시합니다. 토양산도/염분 값을 평균치나 지역 유형으로 추정해 채워 넣지 않습니다.
- 강수량은 기상청이 "1~4mm", "30mm 이상" 같은 범주 텍스트로만 제공해, 범주 구간의 중앙값(또는 상/하한)으로 추정한 mm 값을 씁니다 — 실측 범주에서 파생한 값이며 별도로 지어낸 수치가 아닙니다.

**작물 재배 임계값(`CROPS[].th`)**: 지역별로 매번 새로 만드는 데이터가 아니라 작물마다 고정된 재배 기준(최적/한계 온도·pH·EC·강수 구간)입니다. 실측 환경값을 이 기준과 비교해 점수를 계산하는 상수로, 표준 재배 매뉴얼을 참고해 정한 값입니다.

**커버리지 확장하기**: 토양 실측 커버 지역을 넓히려면 해당 시군구의 법정동코드(리 단위)를 code.go.kr에서 확인해 `frontend/data.js`의 `BJD`에 추가하세요 — 검증되지 않은 코드는 추가하지 마세요.
