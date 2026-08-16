import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

export interface ArtifactServiceBindings {
  readonly ASSETS?: Fetcher;
  readonly ARTIFACT_DB: D1Database;
  readonly ARTIFACTS: R2Bucket;
  readonly ACCESS_AUD?: string;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ALLOWED_EXPIRY_SECONDS?: string;
  readonly MAX_ARTIFACT_BYTES?: string;
  readonly MAX_EXPIRY_SECONDS?: string;
}

export const createD1Database = (database: D1Database): DrizzleD1Database =>
  drizzle(database);
