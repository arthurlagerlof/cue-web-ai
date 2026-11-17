ALTER TABLE public.cue_global_usage_daily
  ADD COLUMN IF NOT EXISTS dots3_requests bigint NOT NULL DEFAULT 0 CHECK (dots3_requests >= 0),
  ADD COLUMN IF NOT EXISTS dots3_calls bigint NOT NULL DEFAULT 0 CHECK (dots3_calls >= 0);
