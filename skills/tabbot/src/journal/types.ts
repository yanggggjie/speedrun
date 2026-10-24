/**
 * 事件来源：human 是真人输入（isTrusted 为真），page 是页面里的脚本触发的（isTrusted 为假，包括 agent 的 DOM 事件，观察端分不出也不去分）和所有请求、导航，
 * agent 只用于命令记录（TabBot 自己发出的动作和重放）和租约。
 */
export type Src = "human" | "agent" | "page";
/** input 是页面里的输入事件，cmd 是 agent 的命令记录，doc 是主文档渲染后的 HTML，snap 是页面快照。 */
export type Kind = "input" | "cmd" | "nav" | "net" | "doc" | "snap" | "tab" | "bg" | "lease";

/** 写进 events 表的一行（不含 seq）。 */
export type NewEvent = {
  ts: number;
  tab: number;
  frame: number;
  src: Src;
  kind: Kind;
  verb: string;
  /** 页面地址（脱敏后，不含参数）。 */
  page?: string;
  /** 动作的目标元素描述，或 ws 的地址。 */
  target?: string;
  url?: string;
  method?: string;
  status?: number;
  size?: number;
  /** 响应体或文档文件的引用 `<分段序号>/<文件名>`（bodies/ 下）；snap 是快照文件（snapshots/ 下）。 */
  body?: string;
  /** 1 = 埋点、广告等噪声，默认视图隐藏。 */
  noise?: number;
  /** 这个请求是被哪个动作引发的：指向 2 秒内最近一次人的事件或 agent 命令的 seq。 */
  cause?: number;
  /** 其它字段（JSON 文本）：请求头、请求体、脱敏记录等。 */
  detail?: string;
};

export type EventRow = NewEvent & { seq: number; ts_last: number | null; dup: number };

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ts_last INTEGER,
  tab INTEGER NOT NULL,
  frame INTEGER NOT NULL DEFAULT 0,
  src TEXT NOT NULL,
  kind TEXT NOT NULL,
  verb TEXT NOT NULL,
  page TEXT,
  target TEXT,
  url TEXT,
  method TEXT,
  status INTEGER,
  size INTEGER,
  body TEXT,
  noise INTEGER NOT NULL DEFAULT 0,
  dup INTEGER NOT NULL DEFAULT 1,
  cause INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ev_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ev_tab_seq ON events(tab, seq);
`;
