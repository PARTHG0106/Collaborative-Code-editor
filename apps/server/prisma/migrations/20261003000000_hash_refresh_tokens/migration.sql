-- Existing deployments already store token_hash. Upgrade installations created
-- by the initial migration without changing that deployed schema or sessions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'token'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'token_hash'
  ) THEN
    UPDATE "refresh_tokens"
    SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex');
    ALTER TABLE "refresh_tokens" RENAME COLUMN "token" TO "token_hash";
    ALTER TABLE "refresh_tokens" ALTER COLUMN "token_hash" DROP NOT NULL;
    DROP INDEX IF EXISTS "refresh_tokens_token_key";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "refresh_tokens_token_hash_idx" ON "refresh_tokens"("token_hash");
