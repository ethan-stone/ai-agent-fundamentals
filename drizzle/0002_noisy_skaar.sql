CREATE TABLE `strands_historical_snapshots` (
	`storage_key` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `strands_latest_snapshots` (
	`storage_key` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `strands_snapshot_manifests` (
	`storage_key` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`manifest_json` text NOT NULL,
	`updated_at` text NOT NULL
);
