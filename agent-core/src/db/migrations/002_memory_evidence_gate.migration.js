// 迁移（一次性）: 记忆证据闸门 —— 为 memory_fragments 增加「逐字证据」三列。
//
// ── 这个迁移解决什么问题 ────────────────────────────────────────
// T1（千千结逆向移植，2026-10-07）：邻舍的记忆提取链路只要求模型写
// `reasoning:"只写支撑判断的对话依据"` —— 这是**自由文本**，写入前**不做任何复算**。
// 结果是"模型编造记忆"无法被拦截：它说"用户喜欢咖啡"，但对话里从没提过咖啡，也会照存。
//
// 千千结的做法是在写入前把每条证据的逐字引文拿回原文**数出现次数**（`occurrence`），
// 对不上就拒收 —— 这是唯一能根治幻觉的机制。
//
// 本迁移只**加列**（纯增量、不碰存量数据）：
//   · evidence_text      —— 逐字引文（LLM 必须从对话原文里摘，不是自己总结）
//   · evidence_count     —— 该引文在来源消息里出现的第几次（≥1）
//   · evidence_msg_id    —— 引文所属的 raw_messages.id（定位比对源）
//   · evidence_verified  —— 复算结果（1=通过 / 0=未通过 / NULL=闸门未开或未校验）
//
// ⚠ 三列全部**可空**：闸门默认关闭（`FEATURE_MEMORY_EVIDENCE_GATE`），
//   关闭时写入 NULL，行为与上线前逐字节一致（项目红线 4「默认不改行为」）。
//
// ⚠ 加列前查 PRAGMA 判断，天然幂等（老库升级到本机制时 schema_migrations 为空，
//   会全部重跑一次，见红线 13）。

export const id = '002_memory_evidence_gate';
export const description = '记忆证据闸门：memory_fragments 增加逐字引文/出现次数/来源消息/校验结果四列';

export function run(db) {
  try {
    // ★ 依赖表兜底（F-15 顺带修正 F-11 的边界）：registry 的护栏测试要求
    //   「每个迁移都能在空库上独立跑通（依赖表缺失要自己兜底）」——与 003/007
    //   等迁移的 `CREATE TABLE IF NOT EXISTS` 约定一致。表已存在时本句无副作用；
    //   正常启动路径 initSchema 先建表，本句仅为空库/异常顺序场景兜底。
    //   （结构必须与 db/index.js initSchema 的 memory_fragments 保持一致。）
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_fragments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        source_msg_id INTEGER REFERENCES messages(id),
        source_raw_start_id INTEGER,
        source_raw_end_id INTEGER,
        fragment_type TEXT NOT NULL CHECK(fragment_type IN ('fact','preference','emotion')),
        content TEXT NOT NULL,
        entities TEXT DEFAULT '[]',
        chroma_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const cols = new Set(db.prepare('PRAGMA table_info(memory_fragments)').all().map(c => c.name));
    // ★ F-11：真正的异常**不得再吞错** —— 原实现整个 catch 吞掉后 registry 会误记
    //   「已应用」、永不重试。加列或兜底建表失败时抛出，由 registry 的失败隔离接管：
    //   记失败 + 下次启动重试，且不阻断启动。另有 initSchema 的幂等兜底双保险
    //   （db/index.js 的 migrateMemoryEvidenceColumns）。

    const add = (name, decl) => {
      if (cols.has(name)) return false;
      db.exec(`ALTER TABLE memory_fragments ADD COLUMN ${name} ${decl}`);
      return true;
    };

    // 逐字引文：LLM 必须原样摘录对话里的一句话，不许自己复述
    const a = add('evidence_text', 'TEXT');
    // 第几次出现：同一句在对话里出现多次时，用它定位是哪一处（1 起）
    const b = add('evidence_count', 'INTEGER');
    // 来源消息 id：指向 raw_messages.id，复算时拿它取原文
    const c = add('evidence_msg_id', 'INTEGER');
    // 校验结果：1 通过 / 0 未通过 / NULL 未校验（闸门关闭时的常态）
    const d = add('evidence_verified', 'INTEGER');

    const added = [a && 'evidence_text', b && 'evidence_count', c && 'evidence_msg_id', d && 'evidence_verified']
      .filter(Boolean);
    if (added.length) {
      console.log(`[migration] 记忆证据闸门：memory_fragments 新增 ${added.join(' / ')}`);
    }
  } catch (err) {
    // ★ F-11 修复（2026-10-12）：不再吞错 —— 原注释宣称「交给 registry 留痕重试」，
    //   但 catch 吞掉后 registry 会误记本迁移「已应用」：既不落 schema_migrations_failed、
    //   也永不重试（那套机制从未真正生效过）。抛出后由 registry 的失败隔离接管：
    //   记失败 + 下次启动重试，且不阻断启动。另有 initSchema 的幂等兜底双保险
    //   （db/index.js 的 migrateMemoryEvidenceColumns）。
    console.warn('[migration] 记忆证据闸门加列失败，交 registry 留痕重试:', err.message);
    throw err;
  }
}