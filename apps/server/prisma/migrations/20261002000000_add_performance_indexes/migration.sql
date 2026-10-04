-- Performance indexes for hot foreign-key / lookup columns.
--
-- Postgres does not auto-index foreign keys. These columns are filtered or
-- joined on the hottest paths (dashboard workspace list, chat history, version
-- list, refresh-token revocation, recursive folder cascade) and previously
-- forced sequential scans. All additive; safe to apply with `migrate deploy`.
-- IF NOT EXISTS guards against an index created out-of-band on the live DB.

-- Dashboard: workspaceMember.findMany({ where: { userId } })
CREATE INDEX IF NOT EXISTS "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- Chat history: findMany({ where: { workspaceId }, orderBy: { createdAt: desc } })
CREATE INDEX IF NOT EXISTS "chat_messages_workspace_id_created_at_idx" ON "chat_messages"("workspace_id", "created_at");

-- Version list / count: queries by fileId ordered by createdAt
CREATE INDEX IF NOT EXISTS "file_versions_file_id_created_at_idx" ON "file_versions"("file_id", "created_at");

-- Refresh-token revocation (deleteMany by userId) and expiry sweeps
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- Self-referential folder tree: ON DELETE CASCADE and parent lookups
CREATE INDEX IF NOT EXISTS "file_system_items_parent_id_idx" ON "file_system_items"("parent_id");
