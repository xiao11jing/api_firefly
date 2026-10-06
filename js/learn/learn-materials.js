/**
 * learn-materials.js — 学习资料库纯逻辑：归档条目构建、检索、可插入判定
 *
 * 资料库归属主题（跨会话）；文件正文存 IndexedDB（learn-store.saveMaterial），
 * 图片只归档元数据（无可复用文本）。AI 通过上下文里的清单知道资料存在，
 * 用户从进度面板「插入对话」把文档正文重新带进当前会话。
 */
import { fileExtension } from '../attachments.js';
import { uid } from '../storage.js';

const CODE_EXTENSIONS = new Set([
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'go',
  'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'bat',
  'ps1', 'sql',
]);

/** 文件名 → 资料类型（对应 learn-store 的 kind 取值） */
export function materialKindOf(name) {
  const ext = fileExtension(name);
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'docx') return 'docx';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return 'text';
}

/**
 * 待发送附件 → 可写入 topic.materials 的资料条目。
 * 图片无提取文本，kind 固定 image（正文不入库）。
 */
export function buildMaterialMeta(attachment, at = Date.now()) {
  const a = attachment || {};
  const isImage = a.kind === 'image';
  return {
    id: uid(),
    name: String(a.name || '').trim() || '未命名文件',
    kind: isImage ? 'image' : materialKindOf(a.name),
    size: Math.max(0, Math.round(Number(a.size) || 0)),
    addedAt: Number.isFinite(at) ? at : Date.now(),
    summary: String(a.summary || ''),
    truncated: a.truncated === true,
  };
}

/** 检索：文件名 / 摘要关键词（不区分大小写）；空查询返回全部 */
export function findMaterials(topic, query = '') {
  const list = (topic && topic.materials) || [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      String(m.summary || '').toLowerCase().includes(q)
  );
}

/** 是否可插入对话（图片没有可复用正文，只能作清单记录） */
export function canInsertMaterial(material) {
  return !!material && material.kind !== 'image';
}
