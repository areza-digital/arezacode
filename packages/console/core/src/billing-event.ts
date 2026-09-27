import { and, Database, eq, sql } from "./drizzle"
import { BillingEventTable, BillingTable, PaymentTable } from "./schema/billing.sql"

export async function withBillingEvent<T>(
  input: { eventID: string; workspaceID: string; operation: string; invoiceID?: string },
  apply: (tx: Database.TxOrDb) => Promise<T>,
) {
  if (!input.eventID || input.eventID.length > 255 || !input.operation || input.operation.length > 255)
    throw new Error("Invalid billing event")
  return Database.transaction(async (tx) => {
    const billing = await tx
      .select({ id: BillingTable.id })
      .from(BillingTable)
      .where(eq(BillingTable.workspaceID, input.workspaceID))
      .for("update")
      .then((rows) => rows[0])
    if (!billing) throw new Error("Billing record not found")
    const claimed = await tx.insert(BillingEventTable).ignore().values({
      id: input.eventID,
      workspace_id: input.workspaceID,
      operation: input.operation,
    })
    if (claimed.rowsAffected === 0) return
    if (input.invoiceID) {
      const existing = await tx
        .select({ id: PaymentTable.id })
        .from(PaymentTable)
        .where(and(eq(PaymentTable.workspaceID, input.workspaceID), eq(PaymentTable.invoiceID, input.invoiceID)))
        .limit(1)
      if (existing.length) return
    }
    return apply(tx)
  })
}

export function refundedCredit(input: { credit: number; charged: number; refunded: number; previous: number }) {
  if (
    !Object.values(input).every((value) => Number.isSafeInteger(value) && value >= 0) ||
    input.charged === 0 ||
    input.refunded > input.charged ||
    input.previous > input.credit
  )
    throw new Error("Invalid refund amounts")
  const total = Number((BigInt(input.credit) * BigInt(input.refunded)) / BigInt(input.charged))
  return Math.max(input.previous, total)
}

export async function refundPayment(input: {
  eventID: string
  workspaceID: string
  paymentID: string
  chargeID: string
  charged: number
  refunded: number
  created: number
}) {
  return withBillingEvent({ ...input, operation: `refund:${input.chargeID}:${input.refunded}` }, async (tx) => {
    const payment = await tx
      .select({
        id: PaymentTable.id,
        amount: PaymentTable.amount,
        refundedAmount: PaymentTable.refundedAmount,
        enrichment: PaymentTable.enrichment,
      })
      .from(PaymentTable)
      .where(and(eq(PaymentTable.paymentID, input.paymentID), eq(PaymentTable.workspaceID, input.workspaceID)))
      .then((rows) => rows[0])
    if (!payment) throw new Error("Payment not found")
    const total = refundedCredit({
      charged: input.charged,
      refunded: input.refunded,
      credit: payment.amount,
      previous: payment.refundedAmount,
    })
    if (total === payment.refundedAmount) return
    await tx
      .update(PaymentTable)
      .set({ timeRefunded: new Date(input.created * 1000), refundedAmount: total })
      .where(and(eq(PaymentTable.id, payment.id), eq(PaymentTable.workspaceID, input.workspaceID)))
    if (payment.enrichment?.type) return
    await tx
      .update(BillingTable)
      .set({ balance: sql`${BillingTable.balance} - ${total - payment.refundedAmount}` })
      .where(eq(BillingTable.workspaceID, input.workspaceID))
  })
}
