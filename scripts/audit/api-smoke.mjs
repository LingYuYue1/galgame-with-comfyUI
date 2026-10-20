import fs from 'node:fs';
import http from 'node:http';

const BASE = process.env.LINSHE_API || 'http://127.0.0.1:3099';
const dir = 'agent-core/src/routes';

// 先读挂载声明表（自定义挂载点 + 顺序都在那儿）
const autoSrc = fs.readFileSync(`${dir}/_autoMount.js`, 'utf8');
const declared = {};
for (const m of autoSrc.matchAll(/\{\s*file:\s*'([^']+)',\s*base:\s*'([^']+)'/g)) declared[m[1]] = m[2];

const targets = [];
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('_'))) {
  const s = fs.readFileSync(`${dir}/${f}`, 'utf8');
  const explicit = (s.match(/export const mount\s*=\s*['"]([^'"]+)/) || [])[1];
  const base = declared[f] || explicit || '/api/' + f.replace(/\.js$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  for (const m of s.matchAll(/router\.get\(\s*['"]([^'"]+)['"]/g)) {
    const g = m[1];
    if (g.includes(':')) continue;
    targets.push({ f, url: base.replace(/\/$/, '') + (g === '/' ? '' : g) });
  }
}

const get = (url) => new Promise((resolve) => {
  const req = http.get(BASE + url, { timeout: 8000 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 240) }));
  });
  req.on('error', (e) => resolve({ status: 0, body: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: 'timeout(SSE 正常)' }); });
});

const bad = [];
for (const t of targets) {
  const r = await get(t.url);
  if (r.status === 200 || r.status === -1) continue;           // 200 正常；-1 是 SSE 长连接
  if (r.status === 400 && /required|缺少|参数/.test(r.body)) continue;  // 必填参数由脚本触发，非缺陷
  bad.push({ ...t, ...r });
}

console.log(`探测 ${targets.length} 个无参 GET，值得看的异常：${bad.length}`);
for (const b of bad) console.log(`  [${b.status}] ${b.url}  ← ${b.f}\n        ${b.body.replace(/\s+/g, ' ').slice(0, 150)}`);
