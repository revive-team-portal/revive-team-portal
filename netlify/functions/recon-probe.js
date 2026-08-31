// TEMPORARY extraction endpoint for the Shopify -> bank payment reconciliation.
// Guarded by a SHA-256 hash of a one-time key held only by the operator; the key
// itself is never stored in this public repo. DELETE THIS FILE once extraction is done.
const crypto = require('crypto');
const { gql, STORE, API_VER } = require('./_shopify');
const R = require('./_recon');

const KEY_HASH = '7f10988a658d5af94698b56ab5dd927e728633f18336fa9fe3bc12707246f85a';

function ok(obj) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const hdr = (event.headers || {})['x-recon-key'] || '';
  if (!hdr || crypto.createHash('sha256').update(hdr).digest('hex') !== KEY_HASH) {
    return { statusCode: 403, body: 'nope' };
  }
  const qp = (event.queryStringParameters) || {};
  const action = qp.action || 'scopes';
  const after = qp.after || null;
  const first = Math.min(Number(qp.first || 100), 250);

  try {
    if (action === 'scopes') {
      const d = await gql('{ currentAppInstallation{ accessScopes{ handle } app{ title } } }');
      return ok({
        store: STORE, api_version: API_VER,
        app: d.currentAppInstallation.app && d.currentAppInstallation.app.title,
        scopes: (d.currentAppInstallation.accessScopes || []).map(x => x.handle).sort(),
      });
    }

    if (action === 'account') {
      const d = await gql(`{
        shopifyPaymentsAccount {
          id defaultCurrency chargeStatementDescriptors { default }
          payoutSchedule { interval monthlyAnchor weeklyAnchor }
          bankAccounts(first: 10) { nodes { id accountNumberLastDigits bankName country currency status createdAt } }
        }
      }`);
      return ok(d);
    }

    if (action === 'payouts') {
      const d = await gql(`query($first:Int!,$after:String,$q:String){
        shopifyPaymentsAccount { payouts(first:$first, after:$after, query:$q, sortKey: ISSUED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id issuedAt status
            net { amount currencyCode }
            summary {
              adjustmentsFee { amount } adjustmentsGross { amount }
              chargesFee { amount } chargesGross { amount }
              refundsFee { amount } refundsFeeGross { amount }
              reservedFundsFee { amount } reservedFundsGross { amount }
              retriedPayoutsFee { amount } retriedPayoutsGross { amount }
            }
          }
        } }
      }`, { first, after, q: qp.q || null });
      return ok(d);
    }

    if (action === 'balance') {
      // Balance transactions link each charge/refund to the payout that carried it.
      const d = await gql(`query($first:Int!,$after:String,$q:String){
        shopifyPaymentsAccount { balanceTransactions(first:$first, after:$after, query:$q, sortKey: PROCESSED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id type test processedAt
            amount { amount currencyCode }
            fee { amount currencyCode }
            net { amount currencyCode }
            sourceId sourceType sourceOrderTransactionId
            associatedPayout { id status }
            associatedOrder { id name processedAt }
          }
        } }
      }`, { first, after, q: qp.q || null });
      return ok(d);
    }

    if (action === 'orders') {
      const d = await gql(`query($first:Int!,$after:String,$q:String){
        orders(first:$first, after:$after, query:$q, sortKey: PROCESSED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id name createdAt processedAt cancelledAt test
            displayFinancialStatus
            currentTotalPriceSet { shopMoney { amount } }
            totalPriceSet { shopMoney { amount } }
            totalRefundedSet { shopMoney { amount } }
            totalTaxSet { shopMoney { amount } }
            totalDiscountsSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            subtotalPriceSet { shopMoney { amount } }
            paymentGatewayNames
            channelInformation { channelDefinition { channelName subChannelName } }
            transactions {
              id kind status gateway formattedGateway processedAt createdAt
              paymentId accountNumber errorCode
              amountSet { shopMoney { amount currencyCode } }
              fees { amount { amount currencyCode } type flatFee { amount } rate rateName }
              parentTransaction { id }
            }
          }
        }
      }`, { first, after, q: qp.q || null });
      return ok(d);
    }


    if (action === 'dbtest') {
      const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
      const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
      const out = { has_key: !!APPS_KEY };
      const res = await fetch(APPS_URL + '/rest/v1/run?select=id&limit=1', {
        headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Accept-Profile': 'recon' },
      });
      out.read_status = res.status;
      out.read_body = (await res.text()).slice(0, 300);
      const w = await fetch(APPS_URL + '/rest/v1/run', {
        method: 'POST',
        headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
                   'Accept-Profile': 'recon', 'Content-Profile': 'recon', Prefer: 'return=minimal' },
        body: JSON.stringify({ kind: 'dbtest', note: 'probe write' }),
      });
      out.write_status = w.status;
      out.write_body = (await w.text()).slice(0, 300);
      return ok(out);
    }

    if (action === 'urltest') {
      const u = (event.queryStringParameters || {}).u || '';
      const r = await fetch(u);
      const t = await r.text();
      return ok({ status: r.status, bytes: t.length, head: t.slice(0, 400) });
    }


    if (action === 'verify') {
      const from = qp.from || '2026-04-01', to = qp.to || '2026-08-31';
      const cutoff = qp.cutoff === 'nz' ? 'nz' : 'utc';
      const lag = { card: Number(qp.lag_card || 2), afterpay: Number(qp.lag_afterpay || 2) };
      const txns = await R.reconDb('txn?select=txn_id,txn_processed_at,nz_date,kind,status,gateway,amount,fee,is_test' +
        '&nz_date=gte.' + from + '&nz_date=lte.' + to + '&limit=100000');
      const batches = R.buildBatches(txns, { cutoff, lag });
      const bank = await R.reconDb('bank?select=id,bank_date,amount,reference,provider&limit=20000') || [];
      const m = R.matchBatches(batches, bank);
      const sum = (a, f) => Math.round(a.reduce((s, x) => s + Number(f(x)), 0) * 100) / 100;
      const byRail = {};
      for (const b of batches) {
        const r = byRail[b.rail] || (byRail[b.rail] = { batches: 0, gross: 0, refunds: 0, fees: 0, net: 0 });
        r.batches++; r.gross += b.gross; r.refunds += b.refunds; r.fees += b.fees; r.net += b.expected_net;
      }
      for (const k of Object.keys(byRail)) for (const f of ['gross','refunds','fees','net'])
        byRail[k][f] = Math.round(byRail[k][f] * 100) / 100;
      return ok({
        period: { from, to }, cutoff, lag,
        txns_loaded: txns.length, batch_count: batches.length,
        by_rail: byRail,
        totals: { gross: sum(batches, b => b.gross), fees: sum(batches, b => b.fees), expected_net: sum(batches, b => b.expected_net) },
        cutoff_impact: R.cutoffImpact(txns),
        first_batches: batches.slice(0, 4),
        last_batches: batches.slice(-3),
        bank_rows: bank.length,
        unmatched_bank: m.unmatchedBank.length,
        sample_matched: m.rows.slice(0, 2),
      });
    }

    return { statusCode: 400, body: 'unknown action' };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e).slice(0, 800) }) };
  }
};
