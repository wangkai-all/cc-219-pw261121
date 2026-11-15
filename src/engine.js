'use strict';

/**
 * 订单交付能力（ATP）分配引擎 —— 纯函数，无副作用。
 *
 * 输入：{ materials, supplies, demands, substitutions }
 * 输出：{ orders, allocations, grid, tails, summary }
 *
 * 规则：
 * - 未确认供给（confirmed=false）仅在 includeUnconfirmed 时参与，且始终单独标记，不混入确定可承诺量。
 * - 供给池按物料独立，消耗即扣减，同一份库存不会承诺给两个订单。
 * - 已有占用（locked）订单最先分配；其余按策略排序（dueDate / priority / fifo）。
 * - 物料替代受比例（1 单位替代料 = ratio 单位原物料）与生效期（按订单交期判断）限制。
 * - 所有分配数量按物料最小数量单位（lotSize）向下取整，尾差单独记录。
 */

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function floorToLot(qty, lot) {
  if (!lot || lot <= 1) return Math.floor(qty);
  return Math.floor(qty / lot) * lot;
}

function ceilToLot(qty, lot) {
  if (!lot || lot <= 1) return Math.ceil(qty);
  return Math.ceil(qty / lot) * lot;
}

const STRATEGIES = {
  dueDate: (a, b) => cmp(a.dueDate, b.dueDate) || cmp(a.priority, b.priority) || cmp(a.seq, b.seq),
  priority: (a, b) => cmp(a.priority, b.priority) || cmp(a.dueDate, b.dueDate) || cmp(a.seq, b.seq),
  fifo: (a, b) => cmp(a.seq, b.seq),
};

function runAllocation(state, opts = {}) {
  const includeUnconfirmed = !!opts.includeUnconfirmed;
  const strategy = STRATEGIES[opts.strategy] ? opts.strategy : 'dueDate';
  const materials = Object.fromEntries(state.materials.map((m) => [m.id, m]));

  // 1) 构建供给池（取消的不参与；未确认供给按开关参与）
  const pools = {};
  for (const s of state.supplies) {
    if (s.cancelled) continue;
    if (!s.confirmed && !includeUnconfirmed) continue;
    (pools[s.material] = pools[s.material] || []).push({ ...s, available: s.qty });
  }
  for (const m of Object.keys(pools)) {
    pools[m].sort((a, b) => cmp(a.date, b.date) || cmp(a.id, b.id));
  }

  // 2) 需求排序：已有占用永远优先，其余按策略
  const ordered = [...state.demands].sort(
    (a, b) => (a.locked === b.locked ? 0 : a.locked ? -1 : 1) || STRATEGIES[strategy](a, b)
  );

  // 3) 逐单分配
  const orders = [];
  const allocations = [];
  for (const d of ordered) {
    const lot = (materials[d.material] || {}).lotSize || 1;
    let remaining = d.qty;
    const mine = [];

    // 3a) 本物料供给，按可用日期先后消耗
    for (const s of pools[d.material] || []) {
      if (remaining <= 0) break;
      const take = floorToLot(Math.min(remaining, s.available), lot);
      if (take <= 0) continue;
      s.available -= take;
      remaining -= take;
      mine.push({
        supplyId: s.id, material: d.material, qty: take, date: s.date, kind: s.kind,
        scenario: !s.confirmed, via: s.confirmed ? 'direct' : 'scenario',
      });
    }

    // 3b) 替代料：比例 + 生效期（按订单交期落在生效窗口内判断）
    if (remaining > 0) {
      const rules = (state.substitutions || []).filter(
        (r) => r.from === d.material && r.fromDate <= d.dueDate && d.dueDate <= r.toDate
      );
      for (const rule of rules) {
        if (remaining <= 0) break;
        const subLot = (materials[rule.to] || {}).lotSize || 1;
        for (const s of pools[rule.to] || []) {
          if (remaining <= 0) break;
          // 可覆盖的原物料数量（按原物料最小单位取整）
          const cover = floorToLot(Math.min(remaining, s.available * rule.ratio), lot);
          if (cover <= 0) continue;
          // 实际消耗的替代料数量（按替代料最小单位向上取整）
          const consumed = ceilToLot(cover / rule.ratio, subLot);
          if (consumed <= 0 || consumed > s.available) continue;
          s.available -= consumed;
          remaining -= cover;
          mine.push({
            supplyId: s.id, material: rule.to, qty: cover, subQty: consumed, ratio: rule.ratio,
            date: s.date, kind: s.kind, scenario: !s.confirmed, via: 'substitute',
          });
        }
      }
    }

    const allocated = d.qty - remaining;
    const promisedDate = mine.length
      ? mine.reduce((mx, a) => (a.date > mx ? a.date : mx), mine[0].date)
      : null;
    const status =
      allocated <= 0 ? 'unmet' : remaining > 0 ? 'partial' : promisedDate <= d.dueDate ? 'on-time' : 'late';

    orders.push({
      ...d,
      allocated,
      unmet: remaining,
      tail: remaining > 0 && remaining < lot ? remaining : 0, // 不足一个最小单位的尾差
      promisedDate,
      status,
      late: promisedDate ? promisedDate > d.dueDate : false,
      usesScenario: mine.some((a) => a.scenario),
      usesSubstitute: mine.some((a) => a.via === 'substitute'),
      allocations: mine,
    });
    for (const a of mine) allocations.push({ ...a, demandId: d.id, orderNo: d.orderNo });
  }

  // 4) 供需对照网格：按物料 × 日期
  const grid = {};
  for (const m of state.materials) {
    const dates = new Set();
    for (const s of state.supplies) {
      if (s.material === m.id && !s.cancelled) dates.add(s.date);
    }
    for (const d of state.demands) {
      if (d.material === m.id) dates.add(d.dueDate);
    }
    const pool = pools[m.id] || [];
    let cumSup = 0;
    let cumSupScenario = 0;
    let cumDem = 0;
    const rows = [...dates].sort().map((date) => {
      const sup = state.supplies
        .filter((s) => s.material === m.id && !s.cancelled && s.confirmed && s.date === date)
        .reduce((t, s) => t + s.qty, 0);
      const supScenario = state.supplies
        .filter((s) => s.material === m.id && !s.cancelled && !s.confirmed && s.date === date)
        .reduce((t, s) => t + s.qty, 0);
      const dem = state.demands
        .filter((d) => d.material === m.id && d.dueDate === date)
        .reduce((t, d) => t + d.qty, 0);
      cumSup += sup;
      cumSupScenario += supScenario;
      cumDem += dem;
      // 累计可承诺 = 该日期及之前到货、且尚未被任何订单占用的确认供给
      const atp = pool
        .filter((s) => s.confirmed && s.date <= date)
        .reduce((t, s) => t + s.available, 0);
      const atpScenario = pool
        .filter((s) => !s.confirmed && s.date <= date)
        .reduce((t, s) => t + s.available, 0);
      return { date, supply: sup, supplyScenario: supScenario, demand: dem, cumSup, cumDem, projected: cumSup - cumDem, atp, atpScenario };
    });
    grid[m.id] = rows;
  }

  // 5) 尾差：供给池中不足一个最小单位、无法再承诺的剩余
  const tails = [];
  for (const m of state.materials) {
    const lot = m.lotSize || 1;
    for (const s of pools[m.id] || []) {
      if (s.available > 0 && s.available < lot) {
        tails.push({ material: m.id, supplyId: s.id, qty: s.available, lotSize: lot, scenario: !s.confirmed });
      }
    }
  }

  const summary = {
    total: orders.length,
    onTime: orders.filter((o) => o.status === 'on-time').length,
    late: orders.filter((o) => o.status === 'late').length,
    partial: orders.filter((o) => o.status === 'partial').length,
    unmet: orders.filter((o) => o.status === 'unmet').length,
    scenarioOrders: orders.filter((o) => o.usesScenario).length,
    substituteOrders: orders.filter((o) => o.usesSubstitute).length,
  };

  return { orders, allocations, grid, tails, summary, strategy, includeUnconfirmed };
}

/** 对比两次分配结果，返回受影响订单（含调整前后交期）。 */
function diffRuns(before, after) {
  const bMap = Object.fromEntries(before.orders.map((o) => [o.id, o]));
  const impacted = [];
  const pick = (o) => ({
    promisedDate: o.promisedDate, allocated: o.allocated, unmet: o.unmet,
    status: o.status, usesScenario: o.usesScenario, usesSubstitute: o.usesSubstitute,
  });
  for (const o of after.orders) {
    const b = bMap[o.id];
    if (!b) {
      impacted.push({ id: o.id, orderNo: o.orderNo, material: o.material, change: 'new', before: null, after: pick(o) });
      continue;
    }
    if (
      b.promisedDate !== o.promisedDate || b.allocated !== o.allocated ||
      b.unmet !== o.unmet || b.status !== o.status
    ) {
      impacted.push({ id: o.id, orderNo: o.orderNo, material: o.material, change: 'modified', before: pick(b), after: pick(o) });
    }
  }
  return impacted;
}

module.exports = { runAllocation, diffRuns, floorToLot, ceilToLot, STRATEGIES };
