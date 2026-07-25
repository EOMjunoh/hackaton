-- FarmFit AI — Supabase 테이블 설정
-- Supabase 대시보드 > SQL Editor 에서 실행하세요

-- 1. 분석 이력 테이블
CREATE TABLE IF NOT EXISTS analyses (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  region      TEXT NOT NULL,
  crop_id     TEXT NOT NULL,
  variety     TEXT,
  method      TEXT,
  f_score     NUMERIC(5,2),
  flow_mode   TEXT DEFAULT 'before',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. RLS (Row Level Security) — 본인 데이터만 읽기/쓰기
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "본인 데이터만 조회"
  ON analyses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "본인 데이터만 삽입"
  ON analyses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 3. Supabase Auth 설정 안내
-- Dashboard > Authentication > Email > "Confirm email" 설정
-- 개발/테스트 시: "Confirm email" 비활성화하면 이메일 인증 없이 즉시 로그인 가능
