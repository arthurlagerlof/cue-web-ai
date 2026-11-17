ALTER TABLE public.cue_request_statistics
  ADD COLUMN IF NOT EXISTS selected_mode text
    CHECK (selected_mode IN ('web_ai', 'automatic', 'dots3_always')),
  ADD COLUMN IF NOT EXISTS request_text text;

ALTER TABLE public.cue_request_statistics
  DROP COLUMN IF EXISTS dots3_baseline;

DROP TABLE IF EXISTS public.cue_global_usage_daily;
