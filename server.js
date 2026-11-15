'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runAllocation, diffRuns } = require('./src/engine');
const { seed } = require('./src/seed');

const PORT = process.env.PORT || 3210;
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
const PUBLIC = path.join(__dirname, 'public');

// ---------- 状态 ----------
let state = load() || seed();

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('持久化失败（不影响本次运行）:', err.message);
  }
}

function runs() {
  return {
    base: runAllocation(state, { strategy: state.settings.strategy, includeUnconfirmed: false }),
    scenario: runAllocation(state, { strategy: state.settings.strategy, includeUnconfirmed: true }),
  };
}

function snapshot() {
  const { base, scenario } = runs();
  return {
    materials: state.materials,
    supplies: state.supplies,
    demands: state.demands,
    substitutions: state.substitutions,
    settings: state.settings,
    history: state.history.slice(-20).reverse(),
    runBase: base,
    runScenario: scenario,
    view: state.settings.includeUnconfirmed ? 'scenario' : 'base',
  };
}

/** 执行一次变更：先算前快照，变更后算差异，写入历史。 */
function mutate(action, detail, fn) {
  const before = state.settings.includeUnconfirmed
    ? runAllocation(state, { strategy: state.settings.strategy, includeUnconfirmed: true })
    : runAllocation(state, { strategy: state.settings.strategy, includeUnconfirmed: false });
  fn();
  const after = state.settings.includeUnconfirmed
    ? runAllocation(state, { strategy: state.settings.strategy, includeUnconfirmed: true })
    : runAllocation(state, { strategy: state.settings.strategy, includeUnconfirmed: false });
  const impacted = diffRuns(before, after);
  state.history.push({
    ts: new Date().toISOString(),
    action,
    detail,
    impacted,
  });
  if (state.history.length > 50) state.history = state.history.slice(-50);
  persist();
  return { ...snapshot(), impact: impacted };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // ----- API -----
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, snapshot());
    }

    if (p === '/api/orders' && req.method === 'POST') {
      const b = await readBody(req);
      const mat = state.materials.find((m) => m.id === b.material);
      const qty = Number(b.qty);
      if (!mat || !Number.isFinite(qty) || qty <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate || '')) {
        return sendJson(res, 400, { error: '参数无效：需要物料、正数数量、YYYY-MM-DD 交期' });
      }
      const seq = state.nextSeq++;
      const id = `D-N${seq}`;
      const orderNo = `SO-N${String(seq).padStart(4, '0')}`;
      const result = mutate('add-order', `新增分析订单 ${orderNo}（${mat.name} × ${qty}，交期 ${b.dueDate}）`, () => {
        state.demands.push({
          id, orderNo, customer: String(b.customer || '分析订单').slice(0, 40),
          material: mat.id, qty, dueDate: b.dueDate,
          priority: Math.min(5, Math.max(1, Number(b.priority) || 3)),
          locked: false, seq,
        });
      });
      return sendJson(res, 200, result);
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const result = mutate('settings', '切换分配策略/情景开关', () => {
        if (['dueDate', 'priority', 'fifo'].includes(b.strategy)) state.settings.strategy = b.strategy;
        if (typeof b.includeUnconfirmed === 'boolean') state.settings.includeUnconfirmed = b.includeUnconfirmed;
      });
      return sendJson(res, 200, result);
    }

    const cancelMatch = p.match(/^\/api\/supplies\/([\w-]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const sup = state.supplies.find((s) => s.id === cancelMatch[1]);
      if (!sup) return sendJson(res, 404, { error: '供给不存在' });
      const b = await readBody(req);
      const cancel = b.cancel !== false;
      const result = mutate(
        cancel ? 'cancel-supply' : 'restore-supply',
        `${cancel ? '取消' : '恢复'}供给 ${sup.id}（${sup.ref}，${sup.material} × ${sup.qty}）`,
        () => { sup.cancelled = cancel; }
      );
      return sendJson(res, 200, result);
    }

    const delayMatch = p.match(/^\/api\/supplies\/([\w-]+)\/delay$/);
    if (delayMatch && req.method === 'POST') {
      const sup = state.supplies.find((s) => s.id === delayMatch[1]);
      if (!sup) return sendJson(res, 404, { error: '供给不存在' });
      const b = await readBody(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return sendJson(res, 400, { error: '需要 YYYY-MM-DD 日期' });
      const oldDate = sup.date;
      const result = mutate('delay-supply', `延迟供给 ${sup.id}（${sup.ref}）：${oldDate} → ${b.date}`, () => {
        sup.date = b.date;
      });
      return sendJson(res, 200, result);
    }

    if (p === '/api/reset' && req.method === 'POST') {
      state = seed();
      persist();
      return sendJson(res, 200, { ...snapshot(), impact: [] });
    }

    // ----- 静态文件 -----
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`订单交付能力（ATP）供需对照工具已启动: http://localhost:${PORT}`);
});
