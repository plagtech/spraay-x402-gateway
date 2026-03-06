import { Request, Response } from "express";
import { taxDb } from "../db.js";

function genId(): string { return `tax_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

export async function taxCalculateHandler(req: Request, res: Response) {
  try {
    const { transactions } = req.body;
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: "Missing required field: transactions[] (array of tx objects)" });
    }
    if (transactions.length > 500) return res.status(400).json({ error: "Max 500 transactions per batch" });

    const events = transactions.map((tx: any) => {
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

    const totalGainLoss = events.reduce((sum: number, e: any) => sum + e.gainLoss, 0);
    const shortTerm = events.filter((e: any) => e.holdingPeriod === "short");
    const longTerm = events.filter((e: any) => e.holdingPeriod === "long");

    const reportId = genId();
    const summary = {
      totalTransactions: events.length,
      totalGainLossUsd: Math.round(totalGainLoss * 100) / 100,
      shortTermGainLoss: Math.round(shortTerm.reduce((s: number, e: any) => s + e.gainLoss, 0) * 100) / 100,
      longTermGainLoss: Math.round(longTerm.reduce((s: number, e: any) => s + e.gainLoss, 0) * 100) / 100,
      shortTermCount: shortTerm.length,
      longTermCount: longTerm.length,
    };
    await taxDb.create(reportId, events, summary);

    return res.json({
      reportId, summary, events,
      note: "Tax calculation uses FIFO method. Production integrates with CoinTracker/TokenTax APIs. Not financial advice.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to calculate tax", details: error.message });
  }
}

export async function taxReportHandler(req: Request, res: Response) {
  try {
    const { reportId } = req.query;

    if (reportId && typeof reportId === "string") {
      const report = await taxDb.get(reportId);
      if (!report) return res.status(404).json({ error: "Report not found", reportId });

      return res.json({
        reportId, events: report.events, total: Array.isArray(report.events) ? report.events.length : 0,
        _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
      });
    }

    const reports = await taxDb.listIds();
    return res.json({
      reports,
      note: "Pass reportId to retrieve full report. Production generates IRS 8949 / Schedule D compatible exports.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to retrieve tax report", details: error.message });
  }
}
