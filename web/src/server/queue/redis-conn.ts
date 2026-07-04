// BullMQ / Pub-Sub 专用 Redis 连接工厂。
// 刻意不复用 server/redis.ts 的限流单例：
//   - 限流单例用 maxRetriesPerRequest: 3，而 BullMQ 强制要求 null（否则拒绝启动）；
//   - 订阅态连接进入 subscriber 模式后不能再发普通命令，必须独立；
//   - 队列/发布/订阅/信号量各有生命周期，混用会互相干扰。
import "server-only";
import Redis from "ioredis";
import type { RedisOptions } from "ioredis";

function redisUrl(): string {
    const url = process.env.REDIS_URL?.trim();
    if (!url || url === "memory") {
        // 队列/事件总线无法在内存回退上工作，缺失直接失败（与 server/redis.ts 的生产强制一致）。
        throw new Error("图片生成队列需要真实 REDIS_URL（不支持内存回退）。");
    }
    return url;
}

// 进程级复用：web 进程用 bull 连接背 Queue；worker 进程用 bull 连接背 Worker、pub 连接发事件、
// command 连接跑信号量；WS 网关用 createSubscriber 每次新建订阅连接。
const g = globalThis as unknown as {
    __bullConn?: Redis;
    __pubConn?: Redis;
    __cmdConn?: Redis;
};

/** BullMQ Queue（web 侧 add）与 Worker（worker 侧消费）使用的连接配置：必须 maxRetriesPerRequest: null。 */
export function bullConnectionOptions(): RedisOptions {
    const parsed = new URL(redisUrl());
    return {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        db: parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : undefined,
        tls: parsed.protocol === "rediss:" ? {} : undefined,
        maxRetriesPerRequest: null,
    };
}

/** 普通 Redis 实例连接；保留给非 BullMQ 调用。 */
export function bullConnection(): Redis {
    return (g.__bullConn ??= new Redis(redisUrl(), { maxRetriesPerRequest: null }));
}

/** 事件发布连接（worker 侧 publish），一个共享即可。 */
export function publisherConnection(): Redis {
    return (g.__pubConn ??= new Redis(redisUrl(), { maxRetriesPerRequest: null }));
}

/** 普通命令连接（用户/渠道信号量的 incr/eval），与 Worker 的阻塞连接分开，避免阻塞命令互相干扰。 */
export function commandConnection(): Redis {
    return (g.__cmdConn ??= new Redis(redisUrl(), { maxRetriesPerRequest: null }));
}

/** 新建一个订阅连接：订阅态连接不能再发普通命令，每个网关实例独立持有并负责关闭。 */
export function createSubscriberConnection(): Redis {
    return new Redis(redisUrl(), { maxRetriesPerRequest: null });
}
