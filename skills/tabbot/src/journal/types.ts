/** 事件来源：human 是真人输入，agent 是 TabBot 自己发的动作，page 是页面自己做的（请求、脚本触发的事件）。 */
export type Src = "human" | "agent" | "page";
export type Kind = "input" | "nav" | "net" | "snap" | "ws" | "tab" | "bg";

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
  /** 响应体文件（相对 journal/bodies/<day>/ 的名字）；snap 是快照文件。 */
  body?: string;
  /** 1 = 埋点、广告等噪声，默认视图隐藏。 */
  noise?: number;
  /** 这个动作引发了哪个请求：指向最近一次人或 agent 动作的 seq。 */
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
