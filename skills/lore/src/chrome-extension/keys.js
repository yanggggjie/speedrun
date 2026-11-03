// 键名 → CDP Input.dispatchKeyEvent / insertText 的参数。纯函数，没有浏览器 API：扩展（cdp.js）和自检（keys.selfcheck.ts）共用。
// 写法和 computer 的 key 一样：空格分隔多个，`+` 组合，修饰键 cmd / ctrl / alt / shift 不分大小写。

/** CDP 的修饰键位：Alt 1，Ctrl 2，Meta（cmd）4，Shift 8。 */
export const MOD_BITS = { alt: 1, ctrl: 2, cmd: 4, shift: 8 };
const MOD_NAMES = { cmd: "cmd", command: "cmd", meta: "cmd", super: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift" };

// 不产生文字的特殊键：key、code、虚拟键码；Enter 和 Space 带文字（页面的 keypress、表单提交靠它）
const SPECIAL = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Escape: { code: "Escape", vk: 27 },
  " ": { code: "Space", vk: 32, text: " " },
  ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowRight: { code: "ArrowRight", vk: 39 }, ArrowDown: { code: "ArrowDown", vk: 40 },
  Home: { code: "Home", vk: 36 }, End: { code: "End", vk: 35 }, PageUp: { code: "PageUp", vk: 33 }, PageDown: { code: "PageDown", vk: 34 },
  Insert: { code: "Insert", vk: 45 },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, vk: 112 + i }])),
};
const ALIASES = { enter: "Enter", return: "Enter", tab: "Tab", backspace: "Backspace", delete: "Delete", del: "Delete", escape: "Escape", esc: "Escape", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", insert: "Insert" };

// 可打印 ASCII 字符所在的物理键：code、虚拟键码、要不要按 shift
const PUNCT = { "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192] };
const SHIFTED = { "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`" };

/** 一个可打印 ASCII 字符在键盘上的样子：{ code, vk, shift }；中文、emoji 这类没有对应按键的返回 null。 */
export function charKey(ch) {
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, vk: ch.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false };
  if (ch === " ") return { code: "Space", vk: 32, shift: false };
  if (PUNCT[ch]) return { code: PUNCT[ch][0], vk: PUNCT[ch][1], shift: false };
  if (SHIFTED[ch]) { const base = charKey(SHIFTED[ch]); return { ...base, shift: true }; }
  return null;
}

// macOS 上 cmd 组合键的编辑命令：CDP 发的按键不会触发系统快捷键，要用 commands 告诉 Chrome 做什么（和 Puppeteer 一样）
const MAC_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

/** 解析 "cmd+a Enter" → [{ key, mods: { cmd: true } }, { key: "Enter", mods: {} }]；写错的修饰键抛错。 */
export function parseKeys(spec) {
  return String(spec).trim().split(/\s+/).filter(Boolean).map((combo) => {
    const parts = combo.split("+");
    const last = parts.pop() || (combo.endsWith("+") ? "+" : "");
    const mods = {};
    for (const p of parts.filter(Boolean)) {
      const m = MOD_NAMES[p.toLowerCase()];
      if (!m) throw new Error(`不认识的修饰键「${p}」：用 cmd、ctrl、alt、shift`);
      mods[m] = true;
    }
    const key = last.length === 1 ? last : ALIASES[last.toLowerCase()] ?? last;
    if (key.length !== 1 && !SPECIAL[key]) throw new Error(`不认识的按键「${last}」：用 Enter、Tab、Backspace、Escape、方向键、单个字符等`);
    return { key, mods };
  });
}

const bitsOf = (mods) => Object.entries(mods).reduce((n, [m, on]) => (on ? n | MOD_BITS[m] : n), 0);

/** 一个组合键的 dispatchKeyEvent 参数：按下、松开。mac 为真时 cmd 组合键带上编辑命令。 */
export function keyEvents({ key, mods }, mac = true) {
  let modifiers = bitsOf(mods);
  let def;
  if (SPECIAL[key]) def = { key, ...SPECIAL[key] };
  else {
    const c = charKey(key) ?? { code: "", vk: 0, shift: false };
    if (c.shift) modifiers |= MOD_BITS.shift;
    def = { key, code: c.code, vk: c.vk, text: key };
  }
  // 按着 cmd / ctrl / alt 时不产生文字（否则 cmd+a 会输入一个 a）
  const text = def.text !== undefined && !(modifiers & (MOD_BITS.ctrl | MOD_BITS.cmd | MOD_BITS.alt)) ? def.text : undefined;
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, modifiers };
  const down = { type: text !== undefined ? "keyDown" : "rawKeyDown", ...base, ...(text !== undefined ? { text, unmodifiedText: text } : {}) };
  const command = mac && mods.cmd && !mods.ctrl && !mods.alt ? (key.toLowerCase() === "z" && mods.shift ? "redo" : MAC_COMMANDS[key.toLowerCase()]) : undefined;
  if (command) down.commands = [command];
  return [down, { type: "keyUp", ...base }];
}

/** "cmd+a Backspace"（重复 repeat 次）的全部 dispatchKeyEvent 参数，按发送顺序。 */
export function keySequence(spec, repeat = 1, mac = true) {
  const combos = parseKeys(spec);
  if (!combos.length) throw new Error("key 要写按键，如 Enter、cmd+a、Backspace Backspace");
  const out = [];
  for (let r = 0; r < Math.min(Math.max(1, repeat), 100); r++) for (const c of combos) out.push(...keyEvents(c, mac));
  return out;
}

/**
 * 输入文字的步骤（和 Claude in Chrome 的 type 一样）：每个可打印 ASCII 字符发 rawKeyDown → insertText → keyUp，
 * 页面能收到按键事件，文字只由 insertText 插入一次；中文、emoji 这类没有对应按键的只发 insertText。
 * 返回 [{ method, params }]。
 */
export function typeSteps(text) {
  const out = [];
  for (const ch of String(text)) {
    const c = charKey(ch);
    const base = c ? { key: ch, code: c.code, windowsVirtualKeyCode: c.vk, modifiers: c.shift ? MOD_BITS.shift : 0 } : null;
    if (base) out.push({ method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", ...base } });
    out.push({ method: "Input.insertText", params: { text: ch } });
    if (base) out.push({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } });
  }
  return out;
}

/** 修饰键对象 { cmd, shift } → CDP 位。 */
export const modBits = (mods) => bitsOf(mods || {});
