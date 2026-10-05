-- Preserve existing password accounts while allowing Google-only identities.
-- Deployment preflight verifies compatible db-push schemas before replaying
-- these additive statements, so preserve any Google users already present.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_subject" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_subject_key" ON "users"("google_subject");

-- Hash both the browser cookie and Google's nonce; atomically delete on use.
CREATE TABLE IF NOT EXISTS "google_auth_challenges" (
    "token_hash" TEXT NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "google_auth_challenges_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX IF NOT EXISTS "google_auth_challenges_expires_at_idx" ON "google_auth_challenges"("expires_at");
