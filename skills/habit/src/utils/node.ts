export function assertNode24(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 24) throw new Error(`habit 需要 Node >=24，当前 ${process.version}`);
}
