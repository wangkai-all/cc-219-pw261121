'use strict';

/* 全局状态：最近一次服务端快照 + 本地 UI 状态 */
let DATA = null;
let LAST_IMPACT = null;
const expanded = new Set(); // 展开的物料供需对应关系

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KIND_LABEL = { onhand: '现货', po: '采购', prod: '生产' };
const STATUS = {
  'on-time': { label: '✓ 准时', cls: 'ok' },
  late: { label: '⏱ 延迟', cls: 'late' },
  partial: { label: '◐ 部分满足', cls: 'partial' },
  unmet: { label: '✕ 缺料', cls: 'unmet' },
};

function currentRun() {
  return DATA.view === 'scenario' ? DATA.runScenario : DATA.runBase;
}

function materialOf(id) {
  return DATA.materials.find((m) => m.id === id) || { id, name: id, unit: '', lotSize: 1 };
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function refresh() {
  DATA = await api('/api/state');
  render();
}

function applyResult(body) {
  DATA = body;
  if (Array.isArray(body.impact)) LAST_IMPACT = body.impact;
  render();
}

// ---------- 渲染 ----------

function render() {
  $('#strategy').value = DATA.settings.strategy;
  $('#includeUnconfirmed').checked = DATA.settings.includeUnconfirmed;
  renderKpis();
  renderGrid();
  renderOrders();
  renderSupplies();
  renderImpact();
  renderScenarioCompare();
  renderHistory();
}

function renderKpis() {
  const s = currentRun().summary;
  const rate = s.total ? Math.round((s.onTime / s.total) * 100) : 0;
  const kpis = [
    { num: `${rate}%`, lbl: `订单准交率（${s.onTime}/${s.total}）` },
    { num: s.late, lbl: '延迟订单' },
    { num: s.partial + s.unmet, lbl: '部分满足 / 缺料' },
    { num: s.substituteOrders, lbl: '使用替代料的订单' },
    { num: s.scenarioOrders, lbl: '依赖情景供给的订单' },
    { num: currentRun().orders.reduce((t, o) => t + (o.tail || 0), 0), lbl: '订单尾差（不足最小单位）' },
  ];
  $('#kpis').innerHTML = kpis.map((k) => `<div class="kpi"><div class="num">${k.num}</div><div class="lbl">${esc(k.lbl)}</div></div>`).join('');
}

function renderGrid() {
  const run = currentRun();
  const host = $('#grid');
  host.innerHTML = DATA.materials.map((m) => {
    const rows = run.grid[m.id] || [];
    const maxAtp = Math.max(1, ...rows.map((r) => r.atp));
    const open = expanded.has(m.id);
    const head = `
      <div class="material-head" data-mat="${m.id}" role="button" tabindex="0" aria-expanded="${open}">
        <span class="name">${esc(m.name)}</span>
        <span class="meta">${m.id} · 单位 ${esc(m.unit)} · 最小单位 ${m.lotSize}</span>
        <span class="caret">${open ? '▾ 收起' : '▸ 供需对应'}</span>
      </div>`;
    const table = `
      <table>
        <thead><tr><th>日期</th><th>确认供给</th><th>情景供给</th><th>需求</th><th>累计供需差</th><th>可承诺余量 ATP</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${r.date}</td>
              <td class="${r.supply ? 'cell-sup' : 'cell-muted'}">${r.supply || '—'}</td>
              <td class="${r.supplyScenario ? 'cell-scen' : 'cell-muted'}">${r.supplyScenario || '—'}</td>
              <td class="${r.demand ? 'cell-dem' : 'cell-muted'}">${r.demand || '—'}</td>
              <td class="${r.projected < 0 ? 'cell-neg' : ''}">${r.projected}</td>
              <td><span class="atp-bar" style="width:${Math.round((r.atp / maxAtp) * 80)}px"></span>${r.atp}${r.atpScenario ? ` <span class="cell-scen">+${r.atpScenario} 情景</span>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    const trace = open ? renderTrace(m) : '';
    return `<div class="material-block">${head}<div class="material-body">${table}</div>${trace}</div>`;
  }).join('');

  host.querySelectorAll('.material-head').forEach((el) => {
    const toggle = () => {
      const id = el.dataset.mat;
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      renderGrid();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

/** 供需对应关系：该物料每张订单 ← 供给来源明细 */
function renderTrace(m) {
  const run = currentRun();
  const orders = run.orders.filter((o) => o.material === m.id);
  const items = orders.map((o) => {
    const src = o.allocations.length
      ? o.allocations.map((a) => {
          const sup = DATA.supplies.find((s) => s.id === a.supplyId);
          const via = a.via === 'substitute'
            ? `替代 ${esc(a.material)} ×${a.subQty}（比例 ${a.ratio}）`
            : a.via === 'scenario' ? '情景供给' : KIND_LABEL[a.kind] || a.kind;
          return `${esc(a.supplyId)} ${esc(sup?.ref || '')} @${a.date} · ${a.qty}${esc(m.unit)} · ${via}`;
        }).join('<br>')
      : '<span class="cell-neg">无可用供给</span>';
    const unmet = o.unmet ? ` <span class="cell-neg">缺口 ${o.unmet}</span>` : '';
    return `<li><b>${esc(o.orderNo)}</b>（${esc(o.customer)}，需 ${o.qty}，交期 ${o.dueDate}）←<br>${src}${unmet}</li>`;
  }).join('');
  const tails = run.tails.filter((t) => t.material === m.id);
  const tailHtml = tails.length
    ? `<h4>尾差（不足最小单位 ${m.lotSize}，无法再承诺）</h4><ul>${tails.map((t) => `<li>${esc(t.supplyId)} 剩余 ${t.qty} ${esc(m.unit)}</li>`).join('')}</ul>`
    : '';
  return `<div class="trace"><h4>供需对应关系</h4><ul>${items}</ul>${tailHtml}</div>`;
}

function renderOrders() {
  const run = currentRun();
  const rows = [...run.orders].sort((a, b) => (a.orderNo < b.orderNo ? -1 : 1)).map((o) => {
    const m = materialOf(o.material);
    const st = STATUS[o.status];
    const tags = [
      o.locked ? '<span class="chip tag">已有占用</span>' : '',
      o.usesScenario ? '<span class="chip scen">含情景供给</span>' : '',
      o.usesSubstitute ? '<span class="chip tag">含替代料</span>' : '',
      o.tail ? `<span class="chip tag">尾差 ${o.tail}</span>` : '',
    ].filter(Boolean).join(' ');
    return `<tr>
      <td>${esc(o.orderNo)}</td>
      <td>${esc(o.customer)}</td>
      <td>${esc(m.name)}</td>
      <td>${o.qty}</td>
      <td>${o.allocated}</td>
      <td class="${o.unmet ? 'cell-neg' : 'cell-muted'}">${o.unmet || '—'}</td>
      <td>${o.dueDate}</td>
      <td class="${o.late ? 'cell-neg' : ''}">${o.promisedDate || '—'}</td>
      <td><span class="chip ${st.cls}">${st.label}</span></td>
      <td>${tags}</td>
    </tr>`;
  }).join('');
  $('#orders').innerHTML = `
    <table>
      <thead><tr><th>订单</th><th>客户</th><th>物料</th><th>需求</th><th>已承诺</th><th>缺口</th><th>交期</th><th>承诺日期</th><th>状态</th><th>标记</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderSupplies() {
  const run = currentRun();
  // 每个供给的剩余可承诺量 = 供给总量 − 本次运行中已被分配的量
  const used = {};
  for (const a of run.allocations) used[a.supplyId] = (used[a.supplyId] || 0) + (a.via === 'substitute' ? a.subQty : a.qty);
  const rows = DATA.supplies.map((s) => {
    const m = materialOf(s.material);
    const remain = s.cancelled ? 0 : s.qty - (used[s.id] || 0);
    const scen = s.confirmed ? '' : '<span class="chip scen">情景·未确认</span>';
    const cancelled = s.cancelled ? '<span class="chip unmet">已取消</span>' : '';
    const actions = s.cancelled
      ? `<button class="btn small" data-restore="${s.id}">恢复</button>`
      : `<button class="btn small danger" data-cancel="${s.id}">取消</button>
         <input type="date" class="delay-date" data-delay-for="${s.id}" value="${s.date}">
         <button class="btn small" data-delay="${s.id}">延迟</button>`;
    return `<tr>
      <td>${esc(s.id)}</td>
      <td>${esc(s.ref)}</td>
      <td>${KIND_LABEL[s.kind]}</td>
      <td>${esc(m.name)}</td>
      <td>${s.qty}</td>
      <td class="${remain ? '' : 'cell-muted'}">${remain}</td>
      <td>${s.date}</td>
      <td>${scen}${cancelled}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
  $('#supplies').innerHTML = `
    <table>
      <thead><tr><th>编号</th><th>来源</th><th>类型</th><th>物料</th><th>数量</th><th>剩余可承诺</th><th>到货日</th><th>标记</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  $('#supplies').querySelectorAll('[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => mutateSupply(`/api/supplies/${b.dataset.cancel}/cancel`, { cancel: true })));
  $('#supplies').querySelectorAll('[data-restore]').forEach((b) =>
    b.addEventListener('click', () => mutateSupply(`/api/supplies/${b.dataset.restore}/cancel`, { cancel: false })));
  $('#supplies').querySelectorAll('[data-delay]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.delay;
      const date = $(`[data-delay-for="${id}"]`).value;
      if (date) mutateSupply(`/api/supplies/${id}/delay`, { date });
    }));
}

async function mutateSupply(path, body) {
  try {
    applyResult(await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  } catch (e) {
    alert(e.message);
  }
}

function renderImpact() {
  const host = $('#impact');
  if (!LAST_IMPACT) {
    host.innerHTML = '<div class="empty">尚无调整。取消或延迟一笔供给、或新增订单后，这里列出受影响订单及调整前后的承诺交期。</div>';
    return;
  }
  if (!LAST_IMPACT.length) {
    host.innerHTML = '<div class="empty">本次调整未影响任何订单的承诺。</div>';
    return;
  }
  host.innerHTML = `
    <table>
      <thead><tr><th>订单</th><th>物料</th><th>承诺日期（前 → 后）</th><th>已承诺量（前 → 后）</th><th>状态（前 → 后）</th></tr></thead>
      <tbody>
        ${LAST_IMPACT.map((i) => {
          const m = materialOf(i.material);
          if (i.change === 'new') {
            return `<tr><td>${esc(i.orderNo)}</td><td>${esc(m.name)}</td><td>— → ${i.after.promisedDate || '无法满足'}</td><td>— → ${i.after.allocated}</td><td>— → ${STATUS[i.after.status].label}</td></tr>`;
          }
          const d = i.before.promisedDate || '—';
          const a = i.after.promisedDate || '—';
          const cls = a > d ? 'worse' : a < d ? 'better' : '';
          return `<tr>
            <td>${esc(i.orderNo)}</td><td>${esc(m.name)}</td>
            <td><span class="diff"><span class="before">${d}</span><span class="after ${cls}">${a}</span></span></td>
            <td>${i.before.allocated} → ${i.after.allocated}</td>
            <td>${STATUS[i.before.status].label} → ${STATUS[i.after.status].label}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function renderScenarioCompare() {
  const base = Object.fromEntries(DATA.runBase.orders.map((o) => [o.id, o]));
  const rows = DATA.runScenario.orders.map((s) => {
    const b = base[s.id];
    const m = materialOf(s.material);
    const changed = b.promisedDate !== s.promisedDate || b.allocated !== s.allocated;
    const delta = changed
      ? (s.promisedDate && (!b.promisedDate || s.promisedDate < b.promisedDate) ? '<span class="after better">提前</span>' : '<span class="after worse">变化</span>')
      : '<span class="cell-muted">相同</span>';
    return `<tr class="${changed ? '' : ''}">
      <td>${esc(s.orderNo)}</td><td>${esc(m.name)}</td><td>${s.dueDate}</td>
      <td>${b.promisedDate || '—'}${b.unmet ? ` <span class="cell-neg">缺${b.unmet}</span>` : ''}</td>
      <td>${s.promisedDate || '—'}${s.unmet ? ` <span class="cell-neg">缺${s.unmet}</span>` : ''}</td>
      <td>${delta}</td>
    </tr>`;
  }).join('');
  $('#scenarioCompare').innerHTML = `
    <table>
      <thead><tr><th>订单</th><th>物料</th><th>交期</th><th>确定可交付承诺</th><th>纳入情景后承诺</th><th>差异</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderHistory() {
  const host = $('#history');
  if (!DATA.history.length) {
    host.innerHTML = '<div class="empty">暂无调整记录。</div>';
    return;
  }
  host.innerHTML = DATA.history.map((h) => `
    <div class="history-item">
      <span class="ts">${new Date(h.ts).toLocaleString('zh-CN')}</span>${esc(h.detail)}
      ${h.impacted.length ? `<span class="cell-neg"> · 影响 ${h.impacted.length} 单：${h.impacted.map((i) => esc(i.orderNo)).join('、')}</span>` : ' · 无订单受影响'}
    </div>`).join('');
}

// ---------- 事件 ----------

$('#strategy').addEventListener('change', async (e) => {
  applyResult(await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: e.target.value }) }));
});

$('#includeUnconfirmed').addEventListener('change', async (e) => {
  applyResult(await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeUnconfirmed: e.target.checked }) }));
});

$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('重置为初始虚构数据？所有调整将丢失。')) return;
  LAST_IMPACT = null;
  applyResult(await api('/api/reset', { method: 'POST' }));
});

$('#addOrder').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    applyResult(await api('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: f.get('customer'), material: f.get('material'),
        qty: Number(f.get('qty')), dueDate: f.get('dueDate'), priority: Number(f.get('priority')),
      }),
    }));
    e.target.reset();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 启动 ----------

(async function init() {
  await refresh();
  $('#orderMaterial').innerHTML = DATA.materials.map((m) => `<option value="${m.id}">${esc(m.name)}（${m.id}）</option>`).join('');
})();
