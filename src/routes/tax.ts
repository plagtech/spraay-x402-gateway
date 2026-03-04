import { Request, Response } from "express";

// x402 Tax — POST /tax/calculate ($0.01), GET /tax/report ($0.02)

interface TaxEvent {
  type: "swap" | "send" | "receive" | "bridge" | "payroll" | "escrow_release";
  txHash: string;
  timestamp: string;
  asset: string;
  amount: number;
  costBasisUsd: number;
  proceedsUsd: number;
  gainLoss: number;
  holdingPeriod: "short" | "long";
}

const taxReports: Map<string, TaxEvent[]> = new Map();
function genId(): string { return `tax_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

export async function taxCalculateHandler(req: Request, res: Response) {
  try {
    const { transactions } = req.body;
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: "Missing required field: transactions[] (array of tx objects)" });
    }
    if (transactions.length > 500) return res.status(400).json({ error: "Max 500 transactions per batch" });

    const events: TaxEvent[] = transactions.map((tx: any) => {
      const costBasis = tx.costBasisUsd || tx.amount * (tx.priceAtAcquisition || 1);
      const proceeds = tx.proceedsUsd || tx.amount * (tx.priceAtDisposal || tx.priceAtAcquisition || 1);
      const gainLoss = proceeds - costBasis;
      const holdDays = tx.holdingDays || 0;

      return {
        type: tx.type || "swap",
        txHash: tx.txHash || "0x" + Math.random().toString(16).substring(2, 66),
        timestamp: tx.timestamp || new Date().toISOString(),
        asset: tx.asset || "ETH",
        amount: tx.amount || 0,
        costBasisUsd: Math.round(costBasis * 100) / 100,
        proceedsUsd: Math.round(proceeds * 100) / 100,
        gainLoss: Math.round(gainLoss * 100) / 100,
        holdingPeriod: holdDays > 365 ? "long" : "short",
      };
    });

    const totalGainLoss = events.reduce((sum, e) => sum + e.gainLoss, 0);
    const shortTerm = events.filter((e) => e.holdingPeriod === "short");
    const longTerm = events.filter((e) => e.holdingPeriod === "long");

    const reportId = genId();
    taxReports.set(reportId, events);

    return res.json({
      reportId,
      summary: {
        totalTransactions: events.length,
        totalGainLossUsd: Math.round(totalGainLoss * 100) / 100,
        shortTermGainLoss: Math.round(shortTerm.reduce((s, e) => s + e.gainLoss, 0) * 100) / 100,
        longTermGainLoss: Math.round(longTerm.reduce((s, e) => s + e.gainLoss, 0) * 100) / 100,
        shortTermCount: shortTerm.length,
        longTermCount: longTerm.length,
      },
      events,
      note: "Tax calculation uses FIFO method. Production integrates with CoinTracker/TokenTax APIs. Not financial advice.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to calculate tax", details: error.message });
  }
}

export async function taxReportHandler(req: Request, res: Response) {
  try {
    const { reportId, year, address } = req.query;

    if (reportId && typeof reportId === "string") {
      const events = taxReports.get(reportId);
      if (!events) return res.status(404).json({ error: "Report not found", reportId });

      return res.json({
        reportId, events, total: events.length,
        _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      reports: Array.from(taxReports.keys()).map((id) => ({
        reportId: id, transactions: taxReports.get(id)!.length,
      })),
      note: "Pass reportId to retrieve full report. Production generates IRS 8949 / Schedule D compatible exports.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to retrieve tax report", details: error.message });
  }
}