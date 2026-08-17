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
  readonly LOCAL_TEST_CONTROL_TOKEN?: string;
  readonly PDF_PROVENANCE_PUBLIC_KEYS?: string;
  readonly PDF_PROVENANCE_RENDERERS?: string;
  readonly PDF_PROVENANCE_KEY_ID?: string;
}

export const createD1Database = (database: D1Database): DrizzleD1Database =>
  drizzle(database);
