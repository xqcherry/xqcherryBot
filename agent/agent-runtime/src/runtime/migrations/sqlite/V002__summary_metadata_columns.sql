ALTER TABLE conversation_summaries ADD COLUMN version INTEGER;
ALTER TABLE conversation_summaries ADD COLUMN status TEXT;
ALTER TABLE conversation_summaries ADD COLUMN provider TEXT;
ALTER TABLE conversation_summaries ADD COLUMN model TEXT;
ALTER TABLE conversation_summaries ADD COLUMN prompt_version TEXT;
ALTER TABLE conversation_summaries ADD COLUMN from_message_id TEXT;
ALTER TABLE conversation_summaries ADD COLUMN to_message_id TEXT;
ALTER TABLE conversation_summaries ADD COLUMN input_token_estimate INTEGER;
ALTER TABLE conversation_summaries ADD COLUMN output_token_estimate INTEGER;
ALTER TABLE conversation_summaries ADD COLUMN compression_ratio REAL;

CREATE INDEX IF NOT EXISTS idx_conversation_summaries_status
  ON conversation_summaries (status);

CREATE INDEX IF NOT EXISTS idx_conversation_summaries_range
  ON conversation_summaries (session_id, from_message_id, to_message_id);
