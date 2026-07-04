// BullMQ 单 job 处理器：用户/渠道并发信号量 + 重试语义，包住 gen-service.runImageGenerationJob。
import "server-only";
import { DelayedError, type Job } from "bullmq";
import type Redis from "ioredis";
import { commandConnection } from "../queue/redis-conn";
import type { ImageJobData } from "../queue/image-queue";
import { runImageGenerationJob, type RunImageJobOutcome } from "../services/gen-service";

const USER_LIMIT = Math.max(1, Number(process.env.IMAGE_USER_CONCURRENCY || 2));
const CHANNEL_LIMIT = Math.max(1, Number(process.env.IMAGE_CHANNEL_CONCURRENCY || 4));
const SEM_TTL_MS = 5 * 60_000; // 安全 TTL：持有者进程崩溃也不会永久占用槽位
const REQUEUE_DELAY_MS = 1500; // 拿不到槽位时延迟重排（moveToDelayed 不计入 attempts）

// Redis 计数信号量：acquire 原子 incr + 越界回滚；release 原子 decr + 归零清理。
const ACQUIRE = `
local n = redis.call('incr', KEYS[1])
redis.call('pexpire', KEYS[1], ARGV[2])
if n <= tonumber(ARGV[1]) then return 1 else redis.call('decr', KEYS[1]); return 0 end`;
const RELEASE = `
local n = redis.call('decr', KEYS[1])
if n <= 0 then redis.call('del', KEYS[1]) end
return n`;

async function acquire(conn: Redis, key: string, limit: number): Promise<boolean> {
    return ((await conn.eval(ACQUIRE, 1, key, String(limit), String(SEM_TTL_MS))) as number) === 1;
}
async function release(conn: Redis, key: string): Promise<void> {
    await conn.eval(RELEASE, 1, key);
}

/**
 * 处理器：先抢用户槽、再抢渠道槽（§2.9）；任一拿不到 → 延迟重排（不计 attempts，防单用户/单渠道打满）。
 * 两槽到手后执行生成，无论成败都释放槽位。isLastAttempt 由 job.attempts 推导，交执行层决定是否退点终态。
 */
export async function processImageJob(job: Job<ImageJobData>, token?: string): Promise<RunImageJobOutcome | "delayed"> {
    const d = job.data;
    const conn = commandConnection();
    const userKey = `sem:image:user:${d.userId}`;
    const channelKey = `sem:image:channel:${d.channelId}`;

    if (!(await acquire(conn, userKey, USER_LIMIT))) {
        await job.moveToDelayed(Date.now() + REQUEUE_DELAY_MS, token);
        throw new DelayedError();
    }
    if (!(await acquire(conn, channelKey, CHANNEL_LIMIT))) {
        await release(conn, userKey);
        await job.moveToDelayed(Date.now() + REQUEUE_DELAY_MS, token);
        throw new DelayedError();
    }

    try {
        const attempts = job.opts.attempts ?? 1;
        const isLastAttempt = job.attemptsMade + 1 >= attempts;
        return await runImageGenerationJob(
            {
                recordId: d.recordId,
                userId: d.userId,
                clientRequestId: d.clientRequestId,
                model: d.model,
                prompt: d.prompt,
                size: d.size,
                quality: d.quality,
                mode: d.mode,
                references: d.references,
                mask: d.mask,
                channelId: d.channelId,
            },
            { isLastAttempt },
        );
    } finally {
        await release(conn, channelKey);
        await release(conn, userKey);
    }
}
