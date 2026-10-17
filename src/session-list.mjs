/**
 * Session list projection for the WeChat `/list` command.
 *
 * Visibility mirrors the Web sidebar rule of
 * `@deepseek-ai/dsh-client-ui-workspace`: a subagent Session never appears, a
 * blank Session appears only while it is the current one, and the
 * workspace-registry archive set hides archived Sessions. The runtime's own
 * `sessionController.list` returns every persisted Session, so the filter is
 * the caller's responsibility.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

/** Longest list that stays comfortably inside one WeChat reply. */
export const MAX_LISTED_SESSIONS = 15;
/** Label budget that keeps 15 rendered rows inside one 800-character reply. */
export const MAX_LABEL_CHARS = 24;

const titleOf = summary => {
  const title = summary?.projections?.values?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : '';
};

const directoryOf = cwd => typeof cwd === 'string' && cwd
  ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  : '';

const shortId = sessionId => typeof sessionId === 'string'
  ? sessionId.replace(/^session-/, '').slice(0, 8)
  : '';

/** Keep one label on one line and inside the row budget.
 * Strips C0/C1 controls and bidi overrides. Zero-width joiners stay: they carry
 * emoji sequences, and an invisible character cannot reorder the row. */
const clip = value => {
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > MAX_LABEL_CHARS
    ? `${chars.slice(0, MAX_LABEL_CHARS - 1).join('')}…`
    : flat;
};

/** Human-readable list label: durable title, then workspace directory, then id. */
export function sessionLabel(summary) {
  return clip(titleOf(summary)) || clip(directoryOf(summary?.cwd)) || shortId(summary?.sessionId) || '会话';
}

/** Coarse age of the last activity. Empty for sessions without a usable time. */
export function relativeTime(updatedAt, now = Date.now()) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < MINUTE) return '刚刚';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / DAY)} 天前`;
  const date = new Date(updatedAt);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Keep the Session rows the owner recognises from the Web sidebar.
 * The bound Session is always kept: it stays the reply target even after the
 * owner archives it, and hiding it would leave `/list` without a current row.
 * @param items - raw `sessionController.list` summaries.
 * @param archived - registry-global archive set.
 * @param currentSessionId - Session currently bound to WeChat.
 * @returns visible summaries, preserving the runtime's activity order.
 */
export function visibleSessions(items, { archived = [], currentSessionId = null } = {}) {
  const hidden = new Set(Array.isArray(archived) ? archived : []);
  return (Array.isArray(items) ? items : []).filter(summary => {
    if (!summary || typeof summary.sessionId !== 'string' || !summary.sessionId) return false;
    if (summary.sessionId === currentSessionId) return true;
    if (summary.origin === 'subagent') return false;
    if (summary.blank === true) return false;
    return !hidden.has(summary.sessionId);
  });
}

/** Rows `/list` renders and `/switch` numbers, in activity order.
 * When activity order alone would drop the bound Session, it joins the rows so
 * the owner always sees where WeChat messages go. */
export function listedSessions(items, { currentSessionId = null, limit = MAX_LISTED_SESSIONS } = {}) {
  const listed = items.slice(0, limit);
  if (!currentSessionId || listed.some(summary => summary.sessionId === currentSessionId)) return listed;
  const current = items.find(summary => summary.sessionId === currentSessionId);
  if (!current) return listed;
  if (listed.length >= limit) listed.pop();
  listed.push(current);
  return listed;
}

/** Render one numbered WeChat list. The bound Session ends its row with `✅`,
 * plus `已归档` when the owner archived it. Rows keep no marker prefix. */
export function formatSessionList(items, { currentSessionId = null, archived = [],
  now = Date.now(), limit = MAX_LISTED_SESSIONS } = {}) {
  const hidden = new Set(Array.isArray(archived) ? archived : []);
  const listed = listedSessions(items, { currentSessionId, limit });
  const lines = [`会话列表（${items.length} 个）`];
  let currentListed = false;
  for (const [index, summary] of listed.entries()) {
    const parts = [sessionLabel(summary)];
    const age = relativeTime(summary.updatedAt, now);
    if (age) parts.push(age);
    if (summary.running) parts.push('运行中');
    if (summary.sessionId === currentSessionId) {
      currentListed = true;
      if (hidden.has(currentSessionId)) parts.push('已归档');
      parts.push('✅');
    }
    lines.push(`${index + 1}. ${parts.join(' · ')}`);
  }
  if (currentSessionId && !currentListed) lines.push('当前会话不在列表中（可能已删除），回复 /new 或 /switch 换一个。');
  if (items.length > listed.length) lines.push(`仅列出最近 ${listed.length} 个。`);
  lines.push('回复 /switch 序号 切换当前会话');
  return lines.join('\n');
}
