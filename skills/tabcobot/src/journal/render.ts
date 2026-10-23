/** 页面快照（hook.js 的 snap 输出）渲染成给 agent 读的文本，元素编号 @e1、@e2… 用于后面的 act。 */
export type SnapItem = { ref: string; t: string; n?: string; k?: string; nm?: string; v?: string; c?: boolean; h?: string; s?: string };
export type Snapshot = {
  why?: string; url: string; title: string; headings?: string[];
  interactiveTotal: number; interactiveVisible: number; inViewShown: number; items: SnapItem[]; textChars?: number; iframes?: number; focus?: string | null;
};

function itemLine(i: SnapItem): string {
  const parts = [`@${i.ref}`, i.k ? `${i.t}[${i.k}]` : i.t];
  if (i.n) parts.push(`"${i.n}"`);
  if (i.nm && !i.n) parts.push(`name=${i.nm}`);
  if (i.v !== undefined) parts.push(`value="${i.v}"`);
  if (i.c !== undefined) parts.push(i.c ? "checked" : "unchecked");
  if (i.h) parts.push(`→ ${i.h}`);
  return parts.join(" ");
}

export function renderSnapshot(snap: Snapshot, tab: number): string {
  const lines = [`tab${tab} ${snap.url} "${snap.title}"`];
  lines.push(`可交互元素：视图内 ${snap.inViewShown}，页面可见 ${snap.interactiveVisible}，全部 ${snap.interactiveTotal}${snap.iframes ? `，iframe ${snap.iframes}` : ""}`);
  if (snap.headings?.length) lines.push(`标题：${snap.headings.join(" | ")}`);
  for (const item of snap.items) lines.push(itemLine(item));
  if (snap.inViewShown < snap.interactiveVisible) lines.push(`（只列出视图内的元素；滚动后再取，或加 --full）`);
  return lines.join("\n");
}
