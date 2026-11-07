CREATE TABLE chain_jobs (id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX chain_jobs_scope ON chain_jobs (scope, created_at);
--> statement-breakpoint
CREATE TABLE chain_challenges (id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, payload TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE operator_locks (scope TEXT PRIMARY KEY NOT NULL, owner TEXT, expires INTEGER NOT NULL DEFAULT 0);
