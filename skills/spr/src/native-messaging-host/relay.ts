/**
 * native messaging host（由 Chrome 拉起）：把 stdio 逐字节转给 daemon，不解析、不持有状态。
 * 连 daemon（不在就拉起）用和 CLI 同一个 connectDaemon；任一端断开就退出，Chrome 下次连接时重新拉起。
 */
import { connectDaemon } from "../session/client.ts";

const sock = await connectDaemon("relay").catch(() => process.exit(1));
const exit = (): void => process.exit(0);
process.stdin.pipe(sock);
sock.pipe(process.stdout);
process.stdin.on("end", exit);
sock.on("end", exit);
sock.on("close", exit);
sock.on("error", exit);
process.stdout.on("error", exit);
