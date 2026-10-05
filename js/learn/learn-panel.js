/**
 * learn-panel.js — 进度面板数据模型（纯逻辑，无 DOM）
 *
 * 面板只展示可验证的结构（learn_project.md §3.3）：
 * 计划条目状态与完成度、练习正确率（窗口 + AI 判定口径）、open 待解决问题。
 */
import { computeAccuracy, openQuestions } from './learn-quiz.js';
import { needsInterview } from './learn.js';

/** 未关联主题时的空态模型 */
export function emptyPanelModel() {
  return {
    empty: true,
    title: '学习进度',
    emptyHint: '当前会话未关联学习主题。点击顶栏 Learn 后，在设置 → 学习中新建主题，再从输入框的学习菜单关联。',
  };
}

/**
 * 主题 → 进度面板模型。
 * @param {object|null} topic
 */
export function buildPanelModel(topic) {
  if (!topic) return emptyPanelModel();

  const items = topic.plan.items;
  const total = items.length;
  const done = items.filter((i) => i.status === 'done').length;
  const acc = computeAccuracy(topic);

  return {
    empty: false,
    name: topic.name,
    modeLabel: topic.mode === 'plan' ? '计划驱动' : '陪伴',
    interviewPending: needsInterview(topic),
    plan: {
      total,
      done,
      percent: total ? Math.round((done / total) * 100) : 0,
      items: items.map((i) => ({ id: i.id, title: i.title, note: i.note, status: i.status })),
    },
    accuracy: {
      right: acc.right,
      wrong: acc.wrong,
      considered: acc.considered,
      excluded: acc.excluded,
      ratio: acc.ratio,
      percent: acc.ratio === null ? null : Math.round(acc.ratio * 100),
      window: acc.window,
      // 口径必须可解释：窗口条数 + 判定来源
      text: acc.considered ? `近 ${acc.window} 条作答 · AI 判定` : '暂无作答记录',
    },
    questions: openQuestions(topic).map((q) => ({ id: q.id, text: q.text })),
  };
}
