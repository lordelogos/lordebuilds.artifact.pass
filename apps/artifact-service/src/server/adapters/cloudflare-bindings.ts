import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

export interface ArtifactServiceBindings {
  readonly ASSETS?: Fetcher;
}

export const createD1Database = (database: D1Database): DrizzleD1Database =>
  drizzle(database);
