import { beforeEach, expect, mock, test } from "bun:test"
import { Database } from "bun:sqlite"

const database = new Database(":memory:")
const statements: string[] = []
let tail = Promise.resolve()
mock.module("@opencode-ai/console-resource", () => ({ Resource: { Database: {} } }))
mock.module("@planetscale/database", () => ({
  Client: class {
    async execute(query: string, params: (string | number | null)[] = [], options?: { as: string }) {
      statements.push(query)
      const statement = database.query(
        query
          .replace(/ for update$/i, "")
          .replace(/^insert ignore /i, "insert or ignore ")
          .replace(/\bdefault\b/gi, "CURRENT_TIMESTAMP"),
      )
      if (/^select /i.test(query)) {
        const rows = (statement.all(...params) as Record<string, unknown>[]).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              key === "enrichment" && typeof value === "string" ? JSON.parse(value) : value,
            ]),
          ),
        )
        return { rows: options?.as === "array" ? rows.map(Object.values) : rows }
      }
      const result = statement.run(...params)
      return { rows: [], rowsAffected: result.changes, insertId: String(result.lastInsertRowid) }
    }
    async transaction<T>(callback: (tx: this) => Promise<T>) {
      const previous = tail
      const release = Promise.withResolvers<void>()
      tail = release.promise
      await previous
      database.exec("BEGIN")
      try {
        const result = await callback(this)
        database.exec("COMMIT")
        return result
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      } finally {
        release.resolve()
      }
    }
  },
}))

const { withBillingEvent, refundPayment, refundedCredit } = await import("../src/billing-event")
const { BillingTable } = await import("../src/schema/billing.sql")
const { eq, sql } = await import("drizzle-orm")

beforeEach(() => {
  statements.length = 0
  database.exec(`
    DROP TABLE IF EXISTS billing_event;
    DROP TABLE IF EXISTS billing;
    DROP TABLE IF EXISTS payment;
    CREATE TABLE billing (id TEXT, workspace_id TEXT PRIMARY KEY, balance INTEGER);
    CREATE TABLE billing_event (id TEXT PRIMARY KEY, workspace_id TEXT, operation TEXT, time_created TEXT,
      UNIQUE(workspace_id, operation));
    CREATE TABLE payment (id TEXT, workspace_id TEXT, invoice_id TEXT, payment_id TEXT, amount INTEGER,
      refunded_amount INTEGER DEFAULT 0, time_refunded TEXT, enrichment TEXT);
    INSERT INTO billing VALUES ('bill', 'wrk', 1000);
    INSERT INTO payment (id, workspace_id, invoice_id, payment_id, amount) VALUES ('pay', 'wrk', 'inv-old', 'pi', 1000);
  `)
})

function balance() {
  return database.query<{ balance: number }, []>("SELECT balance FROM billing").get()!.balance
}

test("overlapping retries and distinct events for one payment mutate the balance once", async () => {
  const apply = (eventID: string) =>
    withBillingEvent({ eventID, workspaceID: "wrk", operation: "payment:inv" }, async (tx) => {
      await tx
        .update(BillingTable)
        .set({ balance: sql`${BillingTable.balance} + 100` })
        .where(eq(BillingTable.workspaceID, "wrk"))
    })
  await Promise.all([apply("evt1"), apply("evt1"), apply("evt2")])
  expect(balance()).toBe(1100)
  expect(database.query("SELECT * FROM billing_event").all()).toHaveLength(1)
  expect(statements.filter((query) => query.endsWith("for update"))).toHaveLength(3)
})

test("failed mutations roll back their durable claim and can be retried", async () => {
  const input = { eventID: "evt", workspaceID: "wrk", operation: "payment:inv" }
  await expect(
    withBillingEvent(input, async (tx) => {
      await tx.update(BillingTable).set({ balance: 0 }).where(eq(BillingTable.workspaceID, "wrk"))
      throw new Error("injected failure")
    }),
  ).rejects.toThrow("injected failure")
  expect(balance()).toBe(1000)
  expect(database.query("SELECT * FROM billing_event").all()).toHaveLength(0)
  await withBillingEvent(input, async (tx) => {
    await tx.update(BillingTable).set({ balance: 1200 }).where(eq(BillingTable.workspaceID, "wrk"))
  })
  expect(balance()).toBe(1200)
})

test("pre-migration payments cannot be credited again by a new event", async () => {
  await withBillingEvent(
    { eventID: "evt", workspaceID: "wrk", operation: "payment:inv-old", invoiceID: "inv-old" },
    async () => {
      throw new Error("existing payment must not be applied")
    },
  )
  expect(balance()).toBe(1000)
})

test("partial, duplicate, and out-of-order refunds deduct only the cumulative credit delta", async () => {
  const refund = (eventID: string, refunded: number) =>
    refundPayment({
      eventID,
      workspaceID: "wrk",
      paymentID: "pi",
      chargeID: "ch",
      charged: 1100,
      refunded,
      created: 1,
    })
  await Promise.all([refund("evt1", 550), refund("evt1", 550), refund("evt2", 550)])
  expect(balance()).toBe(500)
  await refund("evt3", 1100)
  await refund("evt4", 275)
  expect(balance()).toBe(0)
  expect(database.query("SELECT refunded_amount FROM payment").get()).toEqual({ refunded_amount: 1000 })
})

test("subscription refunds do not debit prepaid credit", async () => {
  database.query("UPDATE payment SET enrichment = ?").run(JSON.stringify({ type: "lite" }))
  await refundPayment({
    eventID: "evt",
    workspaceID: "wrk",
    paymentID: "pi",
    chargeID: "ch",
    charged: 1000,
    refunded: 1000,
    created: 1,
  })
  expect(balance()).toBe(1000)
})

test("refund before payment is retryable and missing tenants never acquire claims", async () => {
  await expect(
    refundPayment({
      eventID: "evt",
      workspaceID: "wrk",
      paymentID: "missing",
      chargeID: "ch",
      charged: 1000,
      refunded: 1000,
      created: 1,
    }),
  ).rejects.toThrow("Payment not found")
  await expect(
    withBillingEvent({ eventID: "evt2", workspaceID: "missing", operation: "payment:inv" }, async () => {}),
  ).rejects.toThrow("Billing record not found")
  expect(database.query("SELECT * FROM billing_event").all()).toHaveLength(0)
})

test("refund allocation preserves integer precision and rejects invalid amounts", () => {
  expect(refundedCredit({ credit: 1001, charged: 3, refunded: 1, previous: 0 })).toBe(333)
  expect(refundedCredit({ credit: 1001, charged: 3, refunded: 3, previous: 333 })).toBe(1001)
  expect(() => refundedCredit({ credit: 1000, charged: 0, refunded: 1, previous: 0 })).toThrow("Invalid refund amounts")
})

test("migration preserves already-applied historical refund deductions", async () => {
  using migrated = new Database(":memory:")
  migrated.exec("CREATE TABLE payment (amount INTEGER, time_refunded TEXT)")
  migrated.exec("INSERT INTO payment VALUES (1000, '2026-01-01'), (2000, NULL)")
  const migration = await Bun.file(
    new URL("../migrations/20260926201515_billing-event/migration.sql", import.meta.url),
  ).text()
  migrated.exec(
    migration.replace(/UNIQUE INDEX/g, "UNIQUE").replace(/DEFAULT \(now\(\)\)/g, "DEFAULT CURRENT_TIMESTAMP"),
  )
  expect(migrated.query("SELECT refunded_amount FROM payment ORDER BY amount").all()).toEqual([
    { refunded_amount: 1000 },
    { refunded_amount: 0 },
  ])
})
