import { getDb } from '../db/index.js';

export function recordCompletedImageTask({
  conversationId = null,
  promptOriginal,
  promptRefined,
  outputPaths,
  style = null,
  resolution = null,
  workflowTemplate = null,
  anchorRef = null,
  db = getDb(),
}) {
  const paths = Array.isArray(outputPaths) ? outputPaths.filter(Boolean) : [];
  if (!promptOriginal || paths.length === 0) return null;
  const result = db.prepare(`
    INSERT INTO image_tasks (
      conversation_id, prompt_original, prompt_refined, style, resolution,
      workflow_template, anchor_ref, status, output_paths, finished_at
    ) VALUES (?, ?, ?, ?, COALESCE(?, '1024x1024'), ?, ?, 'done', ?, datetime('now'))
  `).run(
    conversationId,
    promptOriginal,
    promptRefined || promptOriginal,
    style,
    resolution,
    workflowTemplate,
    anchorRef ? String(anchorRef) : null,
    JSON.stringify(paths),
  );
  return Number(result.lastInsertRowid);
}
