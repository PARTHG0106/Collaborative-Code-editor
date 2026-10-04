-- Existing installations created these models with db push. Preserve those
-- tables while giving fresh installations the same execution schema.
DO $$ BEGIN
    CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "ExecutionTarget" AS ENUM ('BROWSER', 'LOCAL_AGENT', 'REMOTE', 'CPU_WORKER', 'GPU_WORKER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "execution_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT,
    "user_id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "target" "ExecutionTarget" NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "code" TEXT NOT NULL,
    "stdin" TEXT,
    "stdout" TEXT,
    "stderr" TEXT,
    "exit_code" INTEGER,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "execution_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "execution_agents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Machine',
    "last_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "runtimes" TEXT[],
    "platform" TEXT,
    "version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "execution_agents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notebook_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kernel_state" TEXT,
    "outputs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notebook_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "terminal_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target" "ExecutionTarget" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    CONSTRAINT "terminal_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "execution_workers" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "last_heartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active_jobs" INTEGER NOT NULL DEFAULT 0,
    "daily_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "execution_workers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "execution_sessions_workspace_id_idx" ON "execution_sessions"("workspace_id");
CREATE INDEX IF NOT EXISTS "execution_sessions_user_id_idx" ON "execution_sessions"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "execution_agents_user_id_key" ON "execution_agents"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "notebook_sessions_workspace_id_file_id_key" ON "notebook_sessions"("workspace_id", "file_id");
CREATE INDEX IF NOT EXISTS "terminal_sessions_workspace_id_idx" ON "terminal_sessions"("workspace_id");
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workers_url_key" ON "execution_workers"("url");
