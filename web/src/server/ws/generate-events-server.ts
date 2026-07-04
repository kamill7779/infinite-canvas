// WebSocket 事件网关（独立进程，自有端口）。
// 为什么独立进程：Next 的 App Router route 不适合作为 WS upgrade 终点，standalone 的 server.js 又是生成的、
// 不便挂自定义 upgrade。故按方案 §2.2 的「独立 WS 网关」选项：本进程只负责 /api/generate/events 的
// 握手鉴权、用户 socket 集合、订阅并转发本用户的 Redis 事件频道、心跳保活。worker 只 publish，不感知连接。
// 生产由反向代理把 /api/generate/events 透传到本端口（需透传 Upgrade/Connection 头）。
import "server-only";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "../db";
import { createSubscriberConnection } from "../queue/redis-conn";
import { userEventChannel } from "../queue/image-events";

const PORT = Number(process.env.WS_PORT || 3001);
const WS_PATH = "/api/generate/events";
const HEARTBEAT_MS = Math.max(5000, Number(process.env.IMAGE_EVENT_HEARTBEAT_MS || 25000));
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "ic_session";
const CHANNEL_PREFIX = "gen-events:user:";

// userId -> 该用户所有在线 socket。worker 事件到达后向集合内全部 socket 广播。
const userSockets = new Map<string, Set<WebSocket>>();

// 单个共享订阅连接：按 userId 频道做 subscribe/unsubscribe 引用计数（首个连接订阅、末个断开退订）。
const sub = createSubscriberConnection();
sub.on("message", (channel, message) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const userId = channel.slice(CHANNEL_PREFIX.length);
    const set = userSockets.get(userId);
    if (!set) return;
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(message); // message 已是 JSON 串，原样转发
});
sub.on("error", (e) => console.error("[ws] subscriber error:", e));

function parseCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
}

// 复用与 auth.getCurrentUser 一致的会话解析（但不经 next/headers）：直接查 Session 表。
async function resolveUserId(req: IncomingMessage): Promise<string | null> {
    const token = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (!token) return null;
    const session = await db.session.findUnique({ where: { id: token }, include: { user: true } });
    if (!session || session.expiresAt < new Date()) return null;
    if (session.user.status === "banned") return null;
    return session.user.id;
}

const server = createServer((req, res) => {
    if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
    }
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("Upgrade Required");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname !== WS_PATH) {
        socket.destroy();
        return;
    }
    resolveUserId(req)
        .then((userId) => {
            if (!userId) {
                socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, userId));
        })
        .catch((e) => {
            console.error("[ws] upgrade error:", e);
            socket.destroy();
        });
});

function onConnection(ws: WebSocket, userId: string) {
    let set = userSockets.get(userId);
    if (!set) {
        set = new Set();
        userSockets.set(userId, set);
    }
    const firstForUser = set.size === 0;
    set.add(ws);
    if (firstForUser) sub.subscribe(userEventChannel(userId)).catch((e) => console.error("[ws] subscribe failed:", e));

    // 心跳：协议层 ping + 应用层 {type:"ping"}；连续一轮无响应即断开回收。
    let alive = true;
    ws.on("pong", () => (alive = true));
    const timer = setInterval(() => {
        if (!alive) {
            ws.terminate();
            return;
        }
        alive = false;
        try {
            ws.ping();
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        } catch {
            /* 发送失败下轮回收 */
        }
    }, HEARTBEAT_MS);

    ws.on("message", (raw) => {
        try {
            const msg = JSON.parse(raw.toString()) as { type?: string };
            if (msg?.type === "pong") alive = true;
            // 未来在此扩展取消任务 / 重订阅 / 优先级等控制消息
        } catch {
            /* 忽略非 JSON */
        }
    });

    const cleanup = () => {
        clearInterval(timer);
        const s = userSockets.get(userId);
        if (!s) return;
        s.delete(ws);
        if (s.size === 0) {
            userSockets.delete(userId);
            sub.unsubscribe(userEventChannel(userId)).catch(() => {});
        }
    };
    ws.on("close", cleanup);
    ws.on("error", () => {
        try {
            ws.terminate();
        } catch {
            /* ignore */
        }
    });
}

server.listen(PORT, () => console.log(`[ws] generate-events gateway on :${PORT}${WS_PATH} heartbeat=${HEARTBEAT_MS}ms`));

function shutdown(signal: string) {
    console.log(`[ws] ${signal} received, closing...`);
    for (const c of wss.clients) {
        try {
            c.close();
        } catch {
            /* ignore */
        }
    }
    sub.quit().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
