// routes/xrp-batch.ts — Spraay XRP Ledger Batch Payments (Chain #15)
// Uses xrpl.js to construct unsigned Payment transactions
// Since the XRPL Batch amendment (XLS-56) is NOT live on mainnet (disabled in rippled 3.1.1),
// we build individual Payment transactions with sequential sequence numbers.
// The caller signs each tx with their wallet (Xaman, GemWallet, Crossmark, etc.) and submits.

import { Request, Response } from 'express';
import * as xrpl from 'xrpl';

// --- Config ---
const XRP_MAINNET_WSS = 'wss://xrplcluster.com';
const SPRAAY_FEE_ADDRESS = process.env.SPRAAY_XRP_FEE_ADDRESS || 'rpyynY82uCCgjjyPbxE6iYu6EzNZu6Hg1w';
const SPRAAY_FEE_PERCENT = 0.003; // 0.3%
const MAX_RECIPIENTS = 100;
const MIN_XRP_AMOUNT = 0.000001; // 1 drop

// --- Helpers ---
function validateXRPAddress(address: string): boolean {
  return xrpl.isValidClassicAddress(address) || xrpl.isValidXAddress(address);
}

function buildMemos(memo?: string): any[] | undefined {
  if (!memo) return undefined;
  return [
    {
      Memo: {
        MemoType: Buffer.from('text/plain', 'utf8').toString('hex').toUpperCase(),
        MemoData: Buffer.from(memo, 'utf8').toString('hex').toUpperCase(),
      },
    },
  ];
}

// --- POST /api/v1/xrp/batch ---
export async function xrpBatchHandler(req: Request, res: Response) {
  const startTime = Date.now();

  try {
    const { sender, recipients, memo } = req.body;

    if (!sender || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing required fields: sender, recipients[]' });
    }
    if (!validateXRPAddress(sender)) {
      return res.status(400).json({ success: false, error: `Invalid sender address: ${sender}` });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({ success: false, error: `Maximum ${MAX_RECIPIENTS} recipients per batch` });
    }

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      if (!r.address || !r.amount) {
        return res.status(400).json({ success: false, error: `Recipient ${i}: missing address or amount` });
      }
      if (!validateXRPAddress(r.address)) {
        return res.status(400).json({ success: false, error: `Recipient ${i}: invalid address ${r.address}` });
      }
      const amt = parseFloat(r.amount);
      if (isNaN(amt) || amt < MIN_XRP_AMOUNT) {
        return res.status(400).json({ success: false, error: `Recipient ${i}: invalid amount ${r.amount}` });
      }
      if (r.tag !== undefined && (!Number.isInteger(r.tag) || r.tag < 0 || r.tag > 4294967295)) {
        return res.status(400).json({ success: false, error: `Recipient ${i}: invalid destination tag ${r.tag}` });
      }
    }

    const client = new xrpl.Client(XRP_MAINNET_WSS);
    await client.connect();

    try {
      const accountInfo = await client.request({
        command: 'account_info',
        account: sender,
        ledger_index: 'validated',
      });

      const accountData = accountInfo.result.account_data;
      const currentSequence = (accountData as any).Sequence as number;
      const balanceDrops = BigInt((accountData as any).Balance as string);

      const ledgerResponse = await client.request({ command: 'ledger', ledger_index: 'validated' });
      const currentLedger = ledgerResponse.result.ledger_index;
      const lastLedgerSequence = currentLedger + 60;

      const serverInfo = await client.request({ command: 'server_info' });
      const baseFeeDrops = (serverInfo.result.info as any).validated_ledger?.base_fee_xrp
        ? Math.ceil(parseFloat((serverInfo.result.info as any).validated_ledger.base_fee_xrp) * 1_000_000)
        : 12;

      let totalPaymentDrops = BigInt(0);
      for (const r of recipients) {
        totalPaymentDrops += BigInt(xrpl.xrpToDrops(r.amount));
      }

      const spraayFeeDrops = (totalPaymentDrops * BigInt(3)) / BigInt(1000);
      const totalTxCount = recipients.length + 1;
      const totalNetworkFeesDrops = BigInt(baseFeeDrops) * BigInt(totalTxCount);
      const reserveDrops = BigInt(1_000_000); // 1 XRP base reserve (lowered Dec 2024)
      const totalRequired = totalPaymentDrops + spraayFeeDrops + totalNetworkFeesDrops + reserveDrops;

      if (balanceDrops < totalRequired) {
        await client.disconnect();
        return res.status(400).json({
          success: false,
          error: 'Insufficient XRP balance',
          details: {
            balance: xrpl.dropsToXrp(balanceDrops.toString()),
            totalPayments: xrpl.dropsToXrp(totalPaymentDrops.toString()),
            spraayFee: xrpl.dropsToXrp(spraayFeeDrops.toString()),
            networkFees: xrpl.dropsToXrp(totalNetworkFeesDrops.toString()),
            reserveHeld: xrpl.dropsToXrp(reserveDrops.toString()),
          },
        });
      }

      const transactions: any[] = [];
      let seq = currentSequence;

      for (const r of recipients) {
        const tx: any = {
          TransactionType: 'Payment',
          Account: sender,
          Destination: r.address,
          Amount: xrpl.xrpToDrops(r.amount),
          Sequence: seq,
          Fee: baseFeeDrops.toString(),
          LastLedgerSequence: lastLedgerSequence,
        };
        if (r.tag !== undefined) tx.DestinationTag = r.tag;
        const memoText = r.memo || memo;
        const memos = buildMemos(memoText);
        if (memos) tx.Memos = memos;
        transactions.push(tx);
        seq++;
      }

      const feeTx: any = {
        TransactionType: 'Payment',
        Account: sender,
        Destination: SPRAAY_FEE_ADDRESS,
        Amount: spraayFeeDrops.toString(),
        Sequence: seq,
        Fee: baseFeeDrops.toString(),
        LastLedgerSequence: lastLedgerSequence,
        Memos: buildMemos('Spraay batch payment fee'),
      };
      transactions.push(feeTx);

      await client.disconnect();
      const elapsed = Date.now() - startTime;

      return res.status(200).json({
        success: true,
        chain: 'xrp',
        chainId: 15,
        network: 'mainnet',
        sender,
        recipientCount: recipients.length,
        transactions,
        summary: {
          totalPayments: xrpl.dropsToXrp(totalPaymentDrops.toString()),
          spraayFee: xrpl.dropsToXrp(spraayFeeDrops.toString()),
          spraayFeePercent: '0.3%',
          networkFees: xrpl.dropsToXrp(totalNetworkFeesDrops.toString()),
          totalCost: xrpl.dropsToXrp((totalPaymentDrops + spraayFeeDrops + totalNetworkFeesDrops).toString()),
          baseFeePerTx: xrpl.dropsToXrp(baseFeeDrops.toString()),
          transactionCount: totalTxCount,
          lastLedgerSequence,
        },
        instructions: {
          step1: 'Sign each transaction in order using your XRP wallet (Xaman, GemWallet, Crossmark)',
          step2: 'Submit each signed transaction to the XRP Ledger in sequence order',
          step3: 'Wait for each transaction to be validated before submitting the next',
          note: 'Transactions use sequential sequence numbers — submit in order or they will fail',
          batchNote: 'Native XRPL Batch (XLS-56) is not yet enabled on mainnet. When BatchV1_1 activates, Spraay will upgrade to atomic batch transactions.',
        },
        meta: { processingTimeMs: elapsed, timestamp: new Date().toISOString(), version: 'v3.5.0' },
      });
    } catch (err: any) {
      await client.disconnect();
      throw err;
    }
  } catch (err: any) {
    console.error('[XRP Batch] Error:', err.message);
    if (err.message?.includes('actNotFound')) {
      return res.status(400).json({ success: false, error: 'Sender account not found on XRP Ledger. Account may not be activated (requires 1 XRP minimum).' });
    }
    return res.status(500).json({ success: false, error: 'Failed to build XRP batch transactions', details: err.message });
  }
}

// --- POST /api/v1/xrp/estimate ---
export async function xrpEstimateHandler(req: Request, res: Response) {
  try {
    const { sender, recipients } = req.body;

    if (!sender || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing required fields: sender, recipients[]' });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({ success: false, error: `Maximum ${MAX_RECIPIENTS} recipients per batch` });
    }

    let totalPaymentDrops = BigInt(0);
    for (const r of recipients) {
      if (!r.amount || isNaN(parseFloat(r.amount))) continue;
      totalPaymentDrops += BigInt(xrpl.xrpToDrops(r.amount));
    }

    const spraayFeeDrops = (totalPaymentDrops * BigInt(3)) / BigInt(1000);
    const totalTxCount = recipients.length + 1;
    const estimatedBaseFee = BigInt(12);
    const totalNetworkFeesDrops = estimatedBaseFee * BigInt(totalTxCount);

    let balance: string | null = null;
    let sufficient: boolean | null = null;

    if (validateXRPAddress(sender)) {
      try {
        const client = new xrpl.Client(XRP_MAINNET_WSS);
        await client.connect();
        const accountInfo = await client.request({
          command: 'account_info',
          account: sender,
          ledger_index: 'validated',
        });
        const balanceDrops = BigInt((accountInfo.result.account_data as any).Balance as string);
        balance = String(xrpl.dropsToXrp(balanceDrops.toString()));
        const reserveDrops = BigInt(1_000_000);
        sufficient = balanceDrops >= (totalPaymentDrops + spraayFeeDrops + totalNetworkFeesDrops + reserveDrops);
        await client.disconnect();
      } catch {
        // Account might not exist
      }
    }

    return res.status(200).json({
      success: true,
      chain: 'xrp',
      chainId: 15,
      estimate: {
        recipientCount: recipients.length,
        totalPayments: xrpl.dropsToXrp(totalPaymentDrops.toString()),
        spraayFee: xrpl.dropsToXrp(spraayFeeDrops.toString()),
        spraayFeePercent: '0.3%',
        networkFees: xrpl.dropsToXrp(totalNetworkFeesDrops.toString()),
        totalCost: xrpl.dropsToXrp((totalPaymentDrops + spraayFeeDrops + totalNetworkFeesDrops).toString()),
        transactionCount: totalTxCount,
        estimatedTimeSeconds: totalTxCount * 4,
      },
      sender: { address: sender, balance, sufficient },
      meta: { timestamp: new Date().toISOString(), version: 'v3.5.0' },
    });
  } catch (err: any) {
    console.error('[XRP Estimate] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to estimate XRP batch', details: err.message });
  }
}

// --- GET /api/v1/xrp/info ---
export function xrpInfoHandler(_req: Request, res: Response) {
  return res.status(200).json({
    success: true,
    chain: 'xrp',
    chainId: 15,
    name: 'XRP Ledger',
    network: 'mainnet',
    nativeAsset: 'XRP',
    decimals: 6,
    explorer: 'https://livenet.xrpl.org',
    rpc: XRP_MAINNET_WSS,
    spraay: {
      feePercent: '0.3%',
      feeAddress: SPRAAY_FEE_ADDRESS,
      maxRecipients: MAX_RECIPIENTS,
      minAmount: MIN_XRP_AMOUNT,
      batchMethod: 'sequential-payments',
      batchNote: 'Native XRPL Batch (XLS-56/BatchV1_1) not yet enabled on mainnet. Spraay will upgrade to atomic batch when available.',
    },
    walletSupport: ['Xaman (XUMM)', 'GemWallet', 'Crossmark', 'Ledger (via Xaman)'],
    features: { destinationTags: true, memos: true, nativeBatch: false, atomicBatch: false },
    meta: { timestamp: new Date().toISOString(), version: 'v3.5.0' },
  });
}
