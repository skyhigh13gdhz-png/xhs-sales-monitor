const store = require('./store');

function svgChart(series, opts = {}) {
  const W = 680, H = 220, PL = 56, PR = 20, PT = 18, PB = 34;
  const iw = W - PL - PR, ih = H - PT - PB;
  if (series.length === 0) return `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="13" fill="var(--color-text-tertiary)">暂无数据</text>`;
  if (series.length === 1) {
    return `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="13" fill="var(--color-text-tertiary)">需要至少 2 次记录才能画趋势</text>`;
  }
  const xs = series.map((_, i) => i);
  const ys = series.map(p => p.v);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = (maxY - minY) * 0.15 || Math.max(1, maxY * 0.05);
  const lo = Math.max(0, minY - pad), hi = maxY + pad;
  const X = i => PL + (series.length === 1 ? iw/2 : (i / (series.length - 1)) * iw);
  const Y = v => PT + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const pts = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
  const ticks = [lo, (lo+hi)/2, hi];
  const gridY = ticks.map((t, i) => {
    const y = Y(t).toFixed(1);
    const lbl = Math.abs(t) >= 10000 ? (t/10000).toFixed(1)+'万' : Math.round(t);
    return `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
    <text x="${PL-8}" y="${y}" font-size="11" text-anchor="end" dominant-baseline="central" fill="var(--color-text-tertiary)">${lbl}</text>`;
  }).join('');
  const dots = series.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.5" fill="#1D9E75"/>`).join('');
  const xLabels = series.map((p, i) => {
    if (series.length > 7 && i % Math.ceil(series.length / 7) !== 0 && i !== series.length - 1) return '';
    const d = new Date(p.t);
    return `<text x="${X(i).toFixed(1)}" y="${H-PB+16}" font-size="11" text-anchor="middle" fill="var(--color-text-tertiary)">${d.getMonth()+1}/${d.getDate()}</text>`;
  }).join('');
  const area = `${PL},${(PT+ih).toFixed(1)} ${pts} ${(PL+iw).toFixed(1)},${(PT+ih).toFixed(1)}`;
  return `<polyline points="${area}" fill="#9FE1CB" fill-opacity="0.28" stroke="none"/>
  <polyline points="${pts}" fill="none" stroke="#0F6E56" stroke-width="1.5" stroke-linejoin="round"/>
  ${gridY}${dots}${xLabels}
  <text x="${PL}" y="${11}" font-size="11" fill="var(--color-text-secondary)">${opts.title || ''}</text>`;
}

function barChart(items) {
  if (!items.length) return `<text x="340" y="80" text-anchor="middle" font-size="13" fill="var(--color-text-tertiary)">暂无可比较的数据</text>`;
  const max = Math.max(...items.map(i => Math.abs(i.v)), 1);
  const rowH = 30, H = items.length * rowH + 16;
  const labelW = 150, barMax = 340, valW = 90;
  return items.map((it, i) => {
    const y = 8 + i * rowH;
    const w = (Math.abs(it.v) / max) * barMax;
    const color = it.v < 0 ? '#E24B4A' : '#1D9E75';
    return `<text x="0" y="${y+14}" font-size="12" dominant-baseline="central" fill="var(--color-text-primary)">${escapeXml(it.name.length > 11 ? it.name.slice(0,11)+'…' : it.name)}</text>
    <rect x="${labelW}" y="${y+4}" width="${Math.max(w,1)}" height="16" rx="3" fill="${color}" fill-opacity="0.85"/>
    <text x="${labelW+Math.max(w,1)+8}" y="${y+12}" font-size="12" dominant-baseline="central" fill="var(--color-text-secondary)">${it.v >= 0 ? '+' : ''}${it.v}${it.suffix || ''}</text>`;
  }).join('');
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' }[c]));
}

function render(db, days = 7) {
  const s = store.stats(db, days);
  const products = db.products.filter(p => !p.archived);
  if (!products.length) {
    return { html: '<p class="empty">还没有监控商品。用 <code>node xhs_monitor.js add "商品ID" "商品名" "https://..."</code> 添加。</p>', stat: null };
  }
  const rows = products.map(p => {
    const d = s[p.id] || {};
    const total = d.cumulative === null || d.cumulative === undefined ? '—' : d.cumulative.toLocaleString();
    const delta = d.delta === null || d.delta === undefined ? '—' : (d.delta > 0 ? '+' : '') + d.delta;
    const win = d.cumulativeInWindow === null || d.cumulativeInWindow === undefined ? '—' : (d.cumulativeInWindow > 0 ? '+' : '') + d.cumulativeInWindow;
    const flag = d.suspicious ? '<span class="warn">回退</span>' : '';
    const per = d.perHour === null || d.perHour === undefined ? '—' : d.perHour.toFixed(1);
    return `<tr>
      <td class="nm">${escapeXml(p.name)}<div class="sh">${escapeXml(p.shop || '')}</div></td>
      <td class="num">${total}</td>
      <td class="num ${d.delta > 0 ? 'up' : ''}">${delta}${flag}</td>
      <td class="num">${win}</td>
      <td class="num dim">${per}</td>
      <td class="dim">${d.samples || 0} 次${d.failedRuns ? ` / 失败 ${d.failedRuns}` : ''}</td>
    </tr>`;
  }).join('');

  const ranked = products.map(p => ({ name: p.name, v: (s[p.id] || {}).delta ?? 0 }))
    .filter(x => x.v !== 0).sort((a, b) => b.v - a.v).slice(0, 8);

  const anyProduct = products[0];
  const series = db.snapshots
    .filter(x => x.productId === anyProduct.id && x.ok && x.soldTotal !== null)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .slice(-30)
    .map(x => ({ t: x.ts, v: x.soldTotal }));

  const totalDelta = products.reduce((a, p) => a + ((s[p.id] || {}).delta || 0), 0);
  const winTotal = products.reduce((a, p) => a + ((s[p.id] || {}).cumulativeInWindow || 0), 0);

  const html = `
  <div class="kpis">
    <div class="kpi"><div class="kl">监控商品</div><div class="kv">${products.length}</div></div>
    <div class="kpi"><div class="kl">最近一次增量合计</div><div class="kv ${totalDelta > 0 ? 'pos' : ''}">${totalDelta > 0 ? '+' : ''}${totalDelta}</div></div>
    <div class="kpi"><div class="kl">近 ${days} 天增量合计</div><div class="kv ${winTotal > 0 ? 'pos' : ''}">${winTotal > 0 ? '+' : ''}${winTotal}</div></div>
    <div class="kpi"><div class="kl">生成时间</div><div class="kv sm">${new Date().toLocaleString('zh-CN', { hour12: false })}</div></div>
  </div>
  <div class="card">
    <div class="ch">商品明细</div>
    <table>
      <thead><tr><th>商品</th><th class="num">累计已售</th><th class="num">最近增量</th><th class="num">近${days}天</th><th class="num">件/小时</th><th>样本</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="grid2">
    <div class="card">
      <div class="ch">增量排行（最近一次）</div>
      <svg viewBox="0 0 680 ${Math.max(56, ranked.length * 30 + 16)}" role="img">${barChart(ranked)}</svg>
    </div>
    <div class="card">
      <div class="ch">累计销量走势 · ${escapeXml(anyProduct.name)}</div>
      <svg viewBox="0 0 680 220" role="img">${svgChart(series, { title: '' })}</svg>
      <div class="note">曲线为页面公开「已售」累计值，非真实订单量</div>
    </div>
  </div>`;
  return { html, stat: { products: products.length, totalDelta, winTotal } };
}

module.exports = { render };