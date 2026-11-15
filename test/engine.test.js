'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAllocation, diffRuns } = require('../src/engine');
const { seed } = require('../src/seed');

const base = (over = {}) => runAllocation(seed(), { strategy: 'dueDate', ...over });

test('同一份库存不会被承诺给多个订单（供给不超分）', () => {
  const run = base();
  const used = {};
  for (const a of run.allocations) used[a.supplyId] = (used[a.supplyId] || 0) + a.qty;
  for (const s of seed().supplies) {
    assert.ok((used[s.id] || 0) <= s.qty, `${s.id} 超分: ${used[s.id]} > ${s.qty}`);
  }
});

test('未确认供给不混入确定可交付量，仅情景模式可见', () => {
  const b = base();
  assert.ok(!b.allocations.some((a) => a.supplyId === 'SUP-U1' || a.supplyId === 'SUP-U2'));
  const s = base({ includeUnconfirmed: true });
  assert.ok(s.allocations.some((a) => a.supplyId === 'SUP-U1'));
  // 基准模式下 SO-2002 只能等 12-10 尾批；情景模式下 12-01 即可承诺
  const so2002Base = b.orders.find((o) => o.orderNo === 'SO-2002');
  const so2002Scen = s.orders.find((o) => o.orderNo === 'SO-2002');
  assert.equal(so2002Base.promisedDate, '2026-12-10');
  assert.equal(so2002Base.status, 'late');
  assert.equal(so2002Scen.promisedDate, '2026-12-01');
  assert.equal(so2002Scen.status, 'on-time');
  assert.ok(so2002Scen.usesScenario);
});

test('已有占用订单优先分配且足额承诺', () => {
  const run = base();
  for (const no of ['SO-1001', 'SO-1002', 'SO-1003', 'SO-1004']) {
    const o = run.orders.find((x) => x.orderNo === no);
    assert.equal(o.unmet, 0, `${no} 未足额`);
    assert.equal(o.status, 'on-time');
  }
});

test('插单按优先级策略先于低优先级单获得共享物料', () => {
  const run = base({ strategy: 'priority' });
  const rush = run.orders.find((o) => o.orderNo === 'SO-2006');
  assert.equal(rush.unmet, 0);
  assert.equal(rush.status, 'on-time');
  // 共享物料 MAT-A 的现货 SUP-01 被已有占用与插单先用掉
  const sup01 = run.allocations.filter((a) => a.supplyId === 'SUP-01');
  const holders = sup01.map((a) => a.orderNo).sort();
  assert.deepEqual(holders, ['SO-1001', 'SO-2006']);
});

test('物料替代受比例限制：缺口 60 组 → 消耗 80 组兼容料（比例 0.95，最小单位 20）', () => {
  const run = base();
  const so2003 = run.orders.find((o) => o.orderNo === 'SO-2003');
  assert.equal(so2003.unmet, 0);
  assert.ok(so2003.usesSubstitute);
  const sub = so2003.allocations.find((a) => a.via === 'substitute');
  assert.equal(sub.material, 'MAT-C');
  assert.equal(sub.qty, 60); // 覆盖原物料 60 组
  assert.equal(sub.subQty, 80); // 消耗替代料 80 组（60/0.95 向上取整到 20 的倍数）
});

test('替代受生效期限制：交期在窗口外则不启用替代', () => {
  const state = seed();
  state.demands.find((d) => d.orderNo === 'SO-2003').dueDate = '2027-01-15'; // 窗口外
  const run = runAllocation(state, { strategy: 'dueDate' });
  const so2003 = run.orders.find((o) => o.orderNo === 'SO-2003');
  assert.ok(!so2003.usesSubstitute);
  assert.ok(so2003.unmet > 0);
});

test('按最小数量单位处理尾差：355 片需求按 30 取整，尾差 25', () => {
  const run = base();
  const so2005 = run.orders.find((o) => o.orderNo === 'SO-2005');
  assert.equal(so2005.allocated % 30, 0);
  assert.equal(so2005.allocated, 330);
  assert.equal(so2005.unmet, 25);
  assert.equal(so2005.tail, 25);
  // 所有分配数量均为对应物料最小单位的整数倍
  const lots = Object.fromEntries(seed().materials.map((m) => [m.id, m.lotSize]));
  for (const o of run.orders) {
    for (const a of o.allocations) {
      const lot = lots[o.material];
      assert.equal(a.qty % lot, 0, `${o.orderNo} 分配 ${a.qty} 不是 ${lot} 的倍数`);
    }
  }
});

test('取消供给后重新分配并报告受影响订单（含前后交期）', () => {
  const before = base();
  const state = seed();
  state.supplies.find((s) => s.id === 'SUP-02').cancelled = true; // 取消 MAT-A 主采购
  const after = runAllocation(state, { strategy: 'dueDate' });
  const impacted = diffRuns(before, after);
  assert.ok(impacted.length > 0);
  const so2001 = impacted.find((i) => i.orderNo === 'SO-2001');
  assert.ok(so2001, 'SO-2001 应受影响');
  assert.equal(so2001.before.promisedDate, '2026-11-25');
  assert.ok(so2001.after.promisedDate > so2001.before.promisedDate || so2001.after.unmet > 0);
});

test('延迟供给后重新分配，晚到订单交期顺延', () => {
  const before = base();
  const state = seed();
  state.supplies.find((s) => s.id === 'SUP-08').date = '2026-12-20'; // MAT-B 采购延迟
  const after = runAllocation(state, { strategy: 'dueDate' });
  const impacted = diffRuns(before, after);
  const so2003 = impacted.find((i) => i.orderNo === 'SO-2003');
  assert.ok(so2003, 'SO-2003 应受影响');
  assert.ok(so2003.after.promisedDate > so2003.before.promisedDate);
});

test('ATP 网格：累计可承诺不为负，且等于未被占用的确认供给', () => {
  const run = base();
  for (const [mat, rows] of Object.entries(run.grid)) {
    for (const r of rows) {
      assert.ok(r.atp >= 0, `${mat} @${r.date} ATP 为负`);
      assert.ok(r.atpScenario === 0, '基准模式不应出现情景 ATP');
    }
  }
  // MAT-A 全部确认供给被占满到 12-10，最后一批剩 300
  const gridA = run.grid['MAT-A'];
  assert.equal(gridA[gridA.length - 1].atp, 300);
});

test('部分到货：PO-8802 拆为两批，分别参与承诺', () => {
  const run = base();
  const so2002 = run.orders.find((o) => o.orderNo === 'SO-2002');
  const srcIds = so2002.allocations.map((a) => a.supplyId);
  assert.ok(srcIds.includes('SUP-03'), '应使用首批到货');
  assert.ok(srcIds.includes('SUP-04'), '应使用尾批到货');
});
