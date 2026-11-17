CREATE TABLE IF NOT EXISTS public.cue_request_statistics (
  request_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK (completed_at >= started_at),
  execution_mode text NOT NULL CHECK (execution_mode IN ('local', 'external', 'hybrid')),
  local_models text[] NOT NULL DEFAULT '{}',
  local_processing boolean NOT NULL DEFAULT false,
  external_models jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(external_models) = 'array'),
  external_calls integer NOT NULL CHECK (external_calls >= 0),
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  token_usage_calls integer NOT NULL CHECK (token_usage_calls >= 0 AND token_usage_calls <= external_calls),
  local_inference_ms bigint NOT NULL CHECK (local_inference_ms >= 0),
  external_ai_ms bigint NOT NULL CHECK (external_ai_ms >= 0),
  tool_execution_ms bigint NOT NULL CHECK (tool_execution_ms >= 0),
  response_ms bigint NOT NULL CHECK (response_ms >= 0),
  tool_calls integer NOT NULL CHECK (tool_calls >= 0),
  tool_failures integer NOT NULL CHECK (tool_failures >= 0 AND tool_failures <= tool_calls),
  clarifications integer NOT NULL CHECK (clarifications >= 0),
  multi_step boolean NOT NULL,
  completion_status text NOT NULL CHECK (completion_status IN ('completed', 'clarification', 'awaiting_confirmation', 'failed', 'cancelled')),
  dots3_baseline boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS cue_request_statistics_completed_at_idx
  ON public.cue_request_statistics (completed_at);
CREATE INDEX IF NOT EXISTS cue_request_statistics_execution_mode_idx
  ON public.cue_request_statistics (execution_mode, completed_at);

REVOKE ALL ON public.cue_request_statistics FROM PUBLIC, anon, authenticated;
