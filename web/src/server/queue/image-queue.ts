// 图片生成 BullMQ 队列封装：web 侧 add、worker 侧消费共用同一 name 与 payload 定义。
import "server-only";
import { Queue, type JobsOptions } from "bullmq";
import { bullConnectionOptions } from "./redis-conn";
import type { SizeTier } from "@/lib/size-tier";

export const IMAGE_QUEUE_NAME = process.env.IMAGE_QUEUE_NAME?.trim() || "image-generation";

/**
 * job.data：worker 执行一次生成所需的全部输入。
 * 注意不放上游 API Key —— worker 侧按 channelId 重新解析取 Key，避免密钥落进 Redis。
 */
export type ImageJobData = {
    recordId: string;
    userId: string;
    clientRequestId?: string;
    model: string;
    prompt: string;
    size?: string;
    quality?: string;
    sizeTier: SizeTier;
    mode: "generation" | "edit";
    references?: string[];
    mask?: string;
    channelId: string;
    channelName: string;
};

type ImageQueue = Queue<ImageJobData, unknown, "generate">;
const g = globalThis as unknown as { __imageQueue?: ImageQueue };

export function imageQueue(): ImageQueue {
    return (g.__imageQueue ??= new Queue<ImageJobData, unknown, "generate">(IMAGE_QUEUE_NAME, { connection: bullConnectionOptions() }));
}

const ATTEMPTS = Math.max(1, Number(process.env.IMAGE_JOB_ATTEMPTS || 3));
const BACKOFF_MS = Math.max(0, Number(process.env.IMAGE_JOB_BACKOFF_MS || 3000));

/** jobId = record.id：同一条记录不会被重复排队（入队幂等）。 */
export function imageJobOptions(jobId: string): JobsOptions {
    return {
        jobId,
        attempts: ATTEMPTS,
        backoff: { type: "exponential", delay: BACKOFF_MS },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
    };
}

export async function enqueueImageJob(data: ImageJobData): Promise<string> {
    const job = await imageQueue().add("generate", data, imageJobOptions(data.recordId));
    return job.id ?? data.recordId;
}
