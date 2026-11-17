CREATE TABLE IF NOT EXISTS public.cue_global_usage_daily (
  day date PRIMARY KEY,
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  local_calls bigint NOT NULL DEFAULT 0 CHECK (local_calls >= 0),
  external_calls bigint NOT NULL DEFAULT 0 CHECK (external_calls >= 0),
  dots3_requests bigint NOT NULL DEFAULT 0 CHECK (dots3_requests >= 0),
  dots3_calls bigint NOT NULL DEFAULT 0 CHECK (dots3_calls >= 0),
  executions bigint NOT NULL DEFAULT 0 CHECK (executions >= 0),
  successes bigint NOT NULL DEFAULT 0 CHECK (successes >= 0),
  failures bigint NOT NULL DEFAULT 0 CHECK (failures >= 0),
  clarifications bigint NOT NULL DEFAULT 0 CHECK (clarifications >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.cue_global_usage_daily FROM PUBLIC, anon, authenticated;
