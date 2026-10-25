import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import { claimDelivery, finishDelivery, type DeliveryDatabase } from "../src/delivery-store";

const migration = readFileSync(new URL("../migrations/0001-deliveries.sql", import.meta.url), "utf8");
const job = {
  id: "a".repeat(64),
  channelId: "C0CC13XRWJG",
  messageTs: "1730000000.000100",
  threadTs: "1730000000.000100",
  shareUrl: `https://artifactpass.com/a/${"A".repeat(43)}`,
};

const database = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const db: DeliveryDatabase = {
    prepare: (sql) => ({
      bind: (...values) => ({
        run: async () => {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      }),
    }),
  };
  return { sqlite, db };
};

describe("durable delivery claims", () => {
  test("a duplicate Queue delivery cannot claim an active or completed job", async () => {
    const { sqlite, db } = database();
    const claim = await claimDelivery(db, job, 1_730_000_000_000);
    expect(claim).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await claimDelivery(db, job, 1_730_000_000_001)).toBeNull();
    expect(await finishDelivery(db, job.id, claim ?? "", "succeeded", 1_730_000_000_002)).toBe(true);
    expect(await claimDelivery(db, job, 1_730_100_000_000)).toBeNull();
    expect(sqlite.prepare("SELECT status FROM deliveries WHERE id = ?").get(job.id)).toMatchObject({ status: "succeeded" });
    sqlite.close();
  });

  test("a timed-out claim can be recovered without storing a share token", async () => {
    const { sqlite, db } = database();
    const firstClaim = await claimDelivery(db, job, 1_730_000_000_000);
    expect(firstClaim).not.toBeNull();
    const secondClaim = await claimDelivery(db, job, 1_730_003_600_001);
    expect(secondClaim).not.toBeNull();
    expect(secondClaim).not.toBe(firstClaim);
    expect(await finishDelivery(db, job.id, firstClaim ?? "", "succeeded", 1_730_003_600_002)).toBe(false);
    const row = sqlite.prepare("SELECT * FROM deliveries WHERE id = ?").get(job.id);
    expect(row).toMatchObject({ attempts: 2, status: "transferring" });
    expect(JSON.stringify(row)).not.toContain(job.shareUrl);
    sqlite.close();
  });
});
