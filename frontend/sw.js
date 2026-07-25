// FarmFit 서비스 워커 — 앱 셸(정적 파일)만, "오프라인일 때만" 캐시를 대신 보여준다.
// /api/* (기상청 단기예보·초단기실황, 농촌진흥청 토양검정, Gemini 챗봇)는 절대 캐시하지
// 않는다 — 실측 데이터를 캐시해서 오래된 값을 최신인 것처럼 보여주면, 이 앱 전체의
// 핵심 원칙("실제 데이터가 없으면 지어내지 않고 그대로 노출")과 정면으로 어긋나기 때문.
//
// 네트워크 우선(network-first) 전략을 쓴다 — stale-while-revalidate였을 때는 배포
// 직후에도 "일단 캐시된 옛날 app.js/scoring.js를 먼저 보여주고 다음 로드에서야 갱신"돼서,
// 방금 고친 챗봇 코드가 실제로는 반영 안 된 채로 실행되는 문제가 있었다. 온라인이면 항상
// 최신 코드를 받고, 네트워크가 끊겼을 때만 캐시로 대체한다.
const CACHE_NAME = 'farmfit-shell-v2';
const SHELL_ASSETS = [
  '/', '/index.html', '/app.js', '/data.js', '/scoring.js', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 응답은 캐시하지 않고 항상 네트워크로 — 실측 데이터의 신선함이 생명이다.
  if (url.pathname.startsWith('/api/')) return;
  // GET + 같은 출처 요청만 다룬다 (CDN 등 교차 출처 스크립트는 브라우저 기본 캐시에 맡김)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // 앱 셸: network-first — 온라인이면 항상 최신 파일을 받고, 캐시에는 "오프라인 대비용"으로만
  // 최신 응답을 저장해둔다. 네트워크 요청이 실패할 때만 캐시로 대체한다.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
