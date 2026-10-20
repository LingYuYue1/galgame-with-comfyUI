import fs from 'node:fs';

const dir = 'agent-core/src/routes';
const autoSrc = fs.readFileSync(`${dir}/_autoMount.js`, 'utf8');
const declared = {};
for (const m of autoSrc.matchAll(/\{\s*file:\s*'([^']+)',\s*base:\s*'([^']+)'/g)) declared[m[1]] = m[2];

/** 后端真实路由表：method + 正则化的路径 */
const routes = [];
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('_'))) {
  const s = fs.readFileSync(`${dir}/${f}`, 'utf8');
  const explicit = (s.match(/export const mount\s*=\s*['"]([^'"]+)/) || [])[1];
  const base = declared[f] || explicit || '/api/' + f.replace(/\.js$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  for (const m of s.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) {
    const full = (base.replace(/\/$/, '') + (m[2] === '/' ? '' : m[2])).replace(/\/+/g, '/');
    const re = new RegExp('^' + full.replace(/:[A-Za-z0-9_]+/g, '[^/]+').replace(/\//g, '\\/') + '$');
    routes.push({ method: m[1].toUpperCase(), full, re, file: f });
  }
}

/** 前端 api/index.js 里的调用 */
const apiSrc = fs.readFileSync('web-ui/src/api/index.js', 'utf8');
const calls = [];
// request('/x') 或 request(`/x/${y}`) ，可能带 { method: 'POST' }
for (const m of apiSrc.matchAll(/request\(\s*(?:`([^`]+)`|'([^']+)')\s*(?:,\s*\{([^}]*)\})?/g)) {
  const raw = (m[1] || m[2] || '').split('?')[0];
  if (!raw.startsWith('/')) continue;
  const opts = m[3] || '';
  const method = (opts.match(/method:\s*'([A-Z]+)'/) || [, 'GET'])[1];
  const norm = '/api' + raw.replace(/\$\{[^}]+\}/g, 'X');
  const re = new RegExp('^' + norm.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === 'X' ? '.*' : '\\' + c)).replace(/\\\.\*/g, '[^/]+') + '$');
  calls.push({ method, path: raw, norm });
}

const missing = [];
for (const c of calls) {
  const hit = routes.some((r) => {
    if (r.method !== c.method && !(c.method === 'GET' && r.method === 'GET')) return false;
    // 用统一模板比对：把前后端的参数位都换成 #
    const a = c.norm.replace(/[^/]+/g, (seg) => (/^([A-Z]+|\$\{.*\})$/.test(seg) ? '#' : seg));
    const b = r.full.replace(/\/:([A-Za-z0-9_]+)/g, '/#');
    return a === b;
  });
  if (!hit) missing.push(c);
}

console.log(`前端 api 调用 ${calls.length} 条；后端路由 ${routes.length} 条`);
console.log(`对不上后端的：${missing.length}`);
const seen = new Set();
for (const m of missing) {
  const key = m.method + ' ' + m.path;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${m.method} ${m.path}   → 归一到 ${m.norm}`);
}
