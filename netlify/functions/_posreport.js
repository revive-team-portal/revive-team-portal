// Cafe POS report: builds the till query, parses the agent's TSV, and renders an
// HTML email body. Shared by the interactive report (scoreboard-data) and the
// monthly auto-email.
const DEPTNAMES = { 1: 'Salads', 2: 'Meals', 3: 'Other', 4: 'Sweets', 5: 'Drinks', 6: 'Shop', 7: 'Surcharges', 8: 'Cards / flyers', 99: 'Vouchers' };

function reportSql(start, endNext) {
  const W = "t.Receipt_Date_Time >= '" + start + "' AND t.Receipt_Date_Time < '" + endNext + "'";
  return "SELECT 'dept' AS section, CAST(p.Product_Group AS varchar(10)) AS code, CAST(NULL AS varchar(64)) AS label, CAST(SUM(i.Sales) AS decimal(18,2)) AS amount, CAST(SUM(i.Qty) AS int) AS qty, CAST(NULL AS int) AS txns" +
    " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number LEFT JOIN ProductTable p ON p.Inventory_Code=i.InventoryCode WHERE " + W + " GROUP BY p.Product_Group" +
    " UNION ALL SELECT 'cover', NULL, NULL, NULL, CAST(SUM(CASE WHEN p.Product_Group IN (1,2) THEN i.Qty ELSE 0 END) AS int), NULL" +
    " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number LEFT JOIN ProductTable p ON p.Inventory_Code=i.InventoryCode WHERE " + W +
    " UNION ALL SELECT 'txn', NULL, NULL, NULL, NULL, CAST(COUNT(DISTINCT t.Transaction_Number) AS int)" +
    " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number WHERE " + W +
    " UNION ALL SELECT 'tradedays', NULL, NULL, NULL, NULL, CAST((SELECT COUNT(*) FROM (SELECT CAST(t.Receipt_Date_Time AS date) AS dd FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number WHERE " + W + " GROUP BY CAST(t.Receipt_Date_Time AS date) HAVING SUM(i.Sales) > 0) z) AS int)" +
    " UNION ALL SELECT 'media', CAST(m.MediaType AS varchar(10)), CAST(MAX(md.MediaDescription) AS varchar(64)), CAST(SUM(m.MediaAmount) AS decimal(18,2)), NULL, CAST(COUNT(DISTINCT m.Transaction_Number) AS int)" +
    " FROM EJMediaTable m JOIN EJTable t ON t.Transaction_Number=m.Transaction_Number LEFT JOIN MediaDescriptionTable md ON md.MediaNumber=m.MediaType WHERE " + W + " AND m.MediaType < 100 GROUP BY m.MediaType HAVING SUM(m.MediaAmount) <> 0" +
    " ORDER BY 1, 4 DESC;";
}
function parseReport(tsv) {
  const lines = String(tsv || '').replace(/\r/g, '').trim().split('\n'); const cols = lines[0].split('\t'); const ix = c => cols.indexOf(c);
  const depts = [], media = []; let covers = 0, txns = 0, tradeDays = 0;
  for (const ln of lines.slice(1)) { const r = ln.split('\t'); const sec = r[ix('section')];
    if (sec === 'dept') { const g = Number(r[ix('code')]); depts.push({ label: DEPTNAMES[g] || ('Group ' + g), amount: Number(r[ix('amount')] || 0), qty: Number(r[ix('qty')] || 0) }); }
    else if (sec === 'cover') covers = Number(r[ix('qty')] || 0);
    else if (sec === 'txn') txns = Number(r[ix('txns')] || 0);
    else if (sec === 'tradedays') tradeDays = Number(r[ix('txns')] || 0);
    else if (sec === 'media') media.push({ label: r[ix('label')] || ('Media ' + r[ix('code')]), amount: Number(r[ix('amount')] || 0), txns: Number(r[ix('txns')] || 0) });
  }
  depts.sort((a, b) => b.amount - a.amount); media.sort((a, b) => b.amount - a.amount);
  return { depts, deptTotal: depts.reduce((s, d) => s + d.amount, 0), deptQty: depts.reduce((s, d) => s + d.qty, 0), covers, txns, tradeDays, media, mediaTotal: media.reduce((s, d) => s + d.amount, 0) };
}
const money = n => '$' + (Number(n) || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = n => (Number(n) || 0).toLocaleString('en-NZ');
function emailHtml(label, d) {
  const th = 'style="text-align:right;padding:6px 10px;border-bottom:2px solid #243029;font-size:12px"';
  const thl = 'style="text-align:left;padding:6px 10px;border-bottom:2px solid #243029;font-size:12px"';
  const td = 'style="text-align:right;padding:5px 10px;border-bottom:1px solid #eee"';
  const tdl = 'style="text-align:left;padding:5px 10px;border-bottom:1px solid #eee"';
  const tot = 'style="text-align:right;padding:6px 10px;border-top:2px solid #243029;font-weight:700"';
  const totl = 'style="text-align:left;padding:6px 10px;border-top:2px solid #243029;font-weight:700"';
  let h = '<div style="font-family:Arial,Helvetica,sans-serif;color:#243029;max-width:640px">';
  h += '<h2 style="margin:0 0 2px">Cafe POS report</h2>';
  h += '<div style="color:#6b7b72;font-size:13px;margin-bottom:14px">' + label + ' · all figures GST-inclusive</div>';
  h += '<table style="border-collapse:collapse;width:100%;margin-bottom:22px"><thead><tr><th ' + thl + '>Department</th><th ' + th + '>Qty</th><th ' + th + '>Sales</th></tr></thead><tbody>';
  d.depts.forEach(x => { h += '<tr><td ' + tdl + '>' + x.label + '</td><td ' + td + '>' + num(x.qty) + '</td><td ' + td + '>' + money(x.amount) + '</td></tr>'; });
  h += '<tr><td ' + totl + '>Total sales</td><td ' + tot + '>' + num(d.deptQty) + '</td><td ' + tot + '>' + money(d.deptTotal) + '</td></tr>';
  h += '<tr><td ' + tdl + '>Covers (salads + meals)</td><td ' + td + '>' + num(d.covers) + '</td><td ' + td + '></td></tr>';
  h += '<tr><td ' + tdl + '>Transactions</td><td ' + td + '>' + num(d.txns) + '</td><td ' + td + '></td></tr>';
  h += '<tr><td ' + tdl + '>Trading days</td><td ' + td + '>' + num(d.tradeDays) + '</td><td ' + td + '></td></tr>';
  h += '</tbody></table>';
  h += '<h3 style="margin:0 0 6px">By media type</h3>';
  h += '<table style="border-collapse:collapse;width:100%"><thead><tr><th ' + thl + '>Media</th><th ' + th + '>Count</th><th ' + th + '>Amount</th></tr></thead><tbody>';
  d.media.forEach(x => { h += '<tr><td ' + tdl + '>' + x.label + '</td><td ' + td + '>' + num(x.txns) + '</td><td ' + td + '>' + money(x.amount) + '</td></tr>'; });
  h += '<tr><td ' + totl + '>Total</td><td ' + tot + '></td><td ' + tot + '>' + money(d.mediaTotal) + '</td></tr>';
  h += '</tbody></table></div>';
  return h;
}
module.exports = { reportSql, parseReport, emailHtml };
