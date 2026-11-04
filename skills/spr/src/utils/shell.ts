/** 生成启动脚本时给路径加引号：sh 用单引号（里面的单引号写成 '\''），cmd / bat 用双引号（% 写成 %%）。 */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
export const cmdQuote = (s: string): string => `"${s.replace(/%/g, "%%")}"`;
