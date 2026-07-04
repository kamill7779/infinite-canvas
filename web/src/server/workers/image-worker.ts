// 独立 worker 进程入口（esbuild 打包目标 → .next/standalone/worker.cjs；本地 bun 直跑）。
// web 与 worker 共用运行镜像，靠不同 CMD 区分：web=node server.js，worker=node worker.cjs。
import "server-only";
import { Worker } from "bullmq";
import { IMAGE_QUEUE_NAME, type ImageJobData } from "../queue/image-queue";
import { bullConnectionOptions, commandConnection } from "../queue/redis-conn";
import { processImageJob } from "./image-job";
import { reconcilePending } from "../services/gen-service";

const concurrency = Math.max(1, Number(process.env.IMAGE_WORKER_CONCURRENCY || 8));
const RECONCILE_INTERVAL_MS = Math.max(60_000, Number(process.env.RECONCILE_INTERVAL_MS || 120_000));
const RECONCILE_MAX_AGE_MS = Math.max(60_000, Number(process.env.RECONCILE_MAX_AGE_MS || 600_000));

const worker = new Worker<ImageJobData>(IMAGE_QUEUE_NAME, (job, token) => processImageJob(job, token), {
    connection: bullConnectionOptions(),
    concurrency,
});

worker.on("ready", () => console.log(`[image-worker] ready queue=${IMAGE_QUEUE_NAME} concurrency=${concurrency}`));
worker.on("active", (job) => console.log(`[image-worker] active job=${job.id} record=${job.data.recordId} user=${job.data.userId} channel=${job.data.channelName}`));
worker.on("completed", (job, result) => console.log(`[image-worker] completed job=${job.id} record=${job.data.recordId} outcome=${result}`));
worker.on("failed", (job, err) => console.error(`[image-worker] failed job=${job?.id} record=${job?.data?.recordId} attempt=${job?.attemptsMade}: ${err?.message}`));
worker.on("error", (err) => console.error("[image-worker] error:", err));

async function shutdown(signal: string) {
    console.log(`[image-worker] ${signal} received, draining...`);
    try {
        await worker.close();
    } finally {
        process.exit(0);
    }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// 兜底对账定时调度：退点并失败化「超时仍 pending / worker 崩溃留下 running」的孤儿记录（§2.11）。
// 用 Redis NX 锁保证多副本下每轮只有一个 worker 执行，避免重复扫描。
const reconcileTimer = setInterval(async () => {
    try {
        const lock = await commandConnection().set("lock:reconcile-pending", "1", "PX", RECONCILE_INTERVAL_MS - 5000, "NX");
        if (lock !== "OK") return; // 本轮已由其它副本执行
        const n = await reconcilePending(RECONCILE_MAX_AGE_MS);
        if (n > 0) console.log(`[image-worker] reconciled ${n} stuck record(s)`);
    } catch (e) {
        console.error("[image-worker] reconcile error:", e instanceof Error ? e.message : e);
    }
}, RECONCILE_INTERVAL_MS);
reconcileTimer.unref();

console.log(`[image-worker] starting queue=${IMAGE_QUEUE_NAME} concurrency=${concurrency}`);
