// 生成编排。异步化后拆成两段：
//  - createImageGenerationJob：web 侧同步完成「建记录 + 预扣 + 入队」并立即返回 pending；
//  - runImageGenerationJob：worker 侧执行「上游 + 落 R2 + 结算/退点 + 发事件」。
// 旧的 generateImage（同步全链路）为画布等历史调用兼容保留；新路由走异步入队。
import "server-only";
import { db } from "../db";
import { AppError } from "../errors";
import { charge, refund, getBalance } from "./credit-service";
import { resolveModel, resolveChannelById } from "./pricing-service";
import { putObject, signedGetUrl, objectKey } from "../r2";
import { generateImageOpenAI, editImageOpenAI } from "../ai/openai-image";
import { resolveSizeTierFromInput, type SizeTier } from "@/lib/size-tier";
import { enqueueImageJob } from "../queue/image-queue";
import { publishImageEvent } from "../queue/image-events";

export type ImageRequest = {
    model: string;
    prompt: string;
    size?: string;
    quality?: string;
    count?: number;
    mode?: "generation" | "edit";
    references?: string[]; // dataUrl 或 http(s) url
    mask?: string;
    clientRequestId?: string; // 前端 slotId，用于 WebSocket 事件精准匹配 slot
};

/**
 * 兜底对账：把超时仍 pending / worker 崩溃留下 running 的生成记录退点并标记失败。
 * 处理「上游极慢 / 客户端断开 / 进程重启 / worker 崩溃」导致预扣未结算的孤儿记录。应由定时任务周期调用。
 */
export async function reconcilePending(maxAgeMs = 10 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stuck = await db.generationRecord.findMany({
        where: { status: { in: ["pending", "running"] }, createdAt: { lt: cutoff } },
        select: { id: true, userId: true, creditsHeld: true },
    });
    let count = 0;
    for (const rec of stuck) {
        // 单事务内「若未终态则退点并标 failed」，与 worker 最终失败分支共用同一「只退一次」语义。
        if (await failAndRefund(rec.id, rec.userId, "超时未完成，已退点")) count += 1;
    }
    return count;
}

/** 把 dataUrl 或远程 url 解析为字节。 */
async function fetchBytes(src: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const m = src.match(/^data:([^;,]+);base64,(.+)$/);
    if (m) return { buffer: Buffer.from(m[2], "base64"), mimeType: m[1] };
    const res = await fetch(src);
    if (!res.ok) throw new Error(`参考图获取失败 ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type") || "image/png" };
}

export type GenImageResult = {
    recordId: string;
    creditsCost: number;
    balance: number;
    images: { id: string; url: string }[];
};

const EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

// ───────────────────────── 异步：入队 ─────────────────────────

export type CreateImageJobResult = {
    recordId: string;
    jobId: string;
    clientRequestId?: string;
    status: "pending";
    creditsCost: number;
    balance: number;
};

/**
 * web 侧同步路径：不调用上游。
 *  1) 归档分辨率档 → 查价 + 取渠道（仅拿 channelId/Name，不把 Key 带进队列）
 *  2) 事务内：建 GenerationRecord(pending, jobId=id) + 预扣点（余额不足直接抛，不入队）
 *  3) 入队 BullMQ（jobId=record.id，入队幂等）
 *  4) 立即返回 pending
 */
export async function createImageGenerationJob(userId: string, req: ImageRequest): Promise<CreateImageJobResult> {
    const sizeTier: SizeTier = resolveSizeTierFromInput(req.quality || req.size);
    const { creditsCost, channel } = await resolveModel(req.model, "image", sizeTier);
    const mode: "generation" | "edit" = req.mode === "edit" ? "edit" : "generation";

    const { record, chargedBalance } = await db.$transaction(async (tx) => {
        const rec = await tx.generationRecord.create({
            data: {
                userId,
                channel: channel.name,
                model: req.model,
                capability: "image",
                sizeTier,
                prompt: req.prompt,
                params: { size: req.size, quality: req.quality, count: 1, mode },
                status: "pending",
                creditsHeld: creditsCost,
                clientRequestId: req.clientRequestId,
            },
        });
        // jobId = record.id：入队幂等（同一条记录不会被重复排队）
        await tx.generationRecord.update({ where: { id: rec.id }, data: { jobId: rec.id } });
        const bal = await charge(userId, creditsCost, { reason: "generate", refType: "generation", refId: rec.id, remark: `${req.model} ${sizeTier}` }, tx);
        return { record: rec, chargedBalance: bal };
    });

    try {
        await enqueueImageJob({
            recordId: record.id,
            userId,
            clientRequestId: req.clientRequestId,
            model: req.model,
            prompt: req.prompt,
            size: req.size,
            quality: req.quality,
            sizeTier,
            mode,
            references: req.references,
            mask: req.mask,
            channelId: channel.id,
            channelName: channel.name,
        });
    } catch (error) {
        await failAndRefund(record.id, userId, "入队失败，已退点");
        throw new AppError(error instanceof Error ? `入队失败：${error.message}` : "入队失败", 1, 502);
    }

    const balance = creditsCost > 0 ? chargedBalance : await getBalance(userId);
    return { recordId: record.id, jobId: record.id, clientRequestId: req.clientRequestId, status: "pending", creditsCost, balance };
}

// ───────────────────────── 异步：执行 ─────────────────────────

export type RunImageJobInput = {
    recordId: string;
    userId: string;
    clientRequestId?: string;
    model: string;
    prompt: string;
    size?: string;
    quality?: string;
    mode: "generation" | "edit";
    references?: string[];
    mask?: string;
    channelId: string;
};

export type RunImageJobOutcome = "success" | "failed" | "skipped";

/**
 * worker 侧执行一次生成。事件（running/success/failed）在此发布，DB 始终为状态真值。
 * 幂等：终态（success/failed）直接跳过；重试期（非最后一次）失败只抛错、不退点、不标终态；
 * 最后一次失败才退预扣点并标 failed（退点前校验未终态，保证只退一次）。
 */
export async function runImageGenerationJob(input: RunImageJobInput, ctx: { isLastAttempt: boolean }): Promise<RunImageJobOutcome> {
    const rec = await db.generationRecord.findUnique({ where: { id: input.recordId } });
    if (!rec) return "skipped";
    if (rec.status === "success" || rec.status === "failed") return "skipped"; // 幂等：终态跳过
    const clientRequestId = input.clientRequestId ?? rec.clientRequestId ?? undefined;

    await db.generationRecord.update({
        where: { id: rec.id },
        data: { status: "running", startedAt: rec.startedAt ?? new Date(), retryCount: { increment: 1 } },
    });
    await notifyImageEvent(input.userId, { type: "image.running", recordId: rec.id, clientRequestId, status: "running" });

    try {
        const channel = await resolveChannelById(input.channelId);
        const genInput = { model: input.model, prompt: input.prompt, size: input.size, quality: input.quality, count: 1 };
        const result =
            input.mode === "edit" && input.references?.length
                ? await editImageOpenAI(channel, genInput, await Promise.all(input.references.map(fetchBytes)), input.mask ? await fetchBytes(input.mask) : undefined)
                : await generateImageOpenAI(channel, genInput);

        const outputs = await Promise.all(
            result.images.map(async (img, i) => {
                const ext = EXT_BY_MIME[img.mimeType] || "png";
                const key = objectKey(input.userId, rec.id, i, ext);
                await putObject(key, img.buffer, img.mimeType);
                return { key, mimeType: img.mimeType, bytes: img.buffer.length };
            }),
        );
        const images = await Promise.all(outputs.map(async (o, i) => ({ id: `${rec.id}-${i}`, url: await signedGetUrl(o.key), mimeType: o.mimeType, bytes: o.bytes })));
        await db.generationRecord.update({
            where: { id: rec.id },
            data: { status: "success", creditsCost: rec.creditsHeld, outputs, upstreamId: result.upstreamId, finishedAt: new Date() },
        });
        const balance = await getBalance(input.userId);
        await notifyImageEvent(input.userId, { type: "image.success", recordId: rec.id, clientRequestId, status: "success", images, balance });
        return "success";
    } catch (error) {
        const msg = error instanceof Error ? error.message : "生成失败";
        // 还会重试：只抛错交给 BullMQ 退避重试，不退点、不标终态
        if (!ctx.isLastAttempt) throw error instanceof Error ? error : new Error(msg);
        // 最后一次失败：退预扣点 + 标 failed（原子，只退一次）
        await failAndRefund(rec.id, input.userId, msg);
        const balance = await getBalance(input.userId);
        await notifyImageEvent(input.userId, { type: "image.failed", recordId: rec.id, clientRequestId, status: "failed", errorMsg: msg.slice(0, 500), balance });
        return "failed";
    }
}

async function notifyImageEvent(userId: string, event: Parameters<typeof publishImageEvent>[1]): Promise<void> {
    try {
        await publishImageEvent(userId, event);
    } catch (error) {
        console.warn("[image-event] publish failed:", error instanceof Error ? error.message : error);
    }
}

/** 单事务内「若未进终态则退回预扣点并标 failed」。worker 最终失败与兜底对账共用，保证只退一次。 */
async function failAndRefund(recordId: string, userId: string, msg: string): Promise<boolean> {
    return db.$transaction(async (tx) => {
        const rec = await tx.generationRecord.findUnique({ where: { id: recordId }, select: { status: true, creditsHeld: true } });
        if (!rec || rec.status === "success" || rec.status === "failed") return false; // 已终态：不重复退/标
        if (rec.creditsHeld > 0) await refund(userId, rec.creditsHeld, { refType: "generation", refId: recordId, remark: "生成失败退点" }, tx);
        await tx.generationRecord.update({ where: { id: recordId }, data: { status: "failed", errorMsg: msg.slice(0, 500), finishedAt: new Date() } });
        return true;
    });
}

// ───────────────────────── 旧同步实现（兼容保留）─────────────────────────

/**
 * 图片生成全链路（同步）：建记录 + 预扣 → 调上游 → 落 R2 → 结算/退点。
 * @deprecated 改异步入队后由 createImageGenerationJob + runImageGenerationJob 取代。
 */
export async function generateImage(userId: string, req: ImageRequest): Promise<GenImageResult> {
    const count = Math.max(1, Math.min(10, Math.floor(req.count || 1)));
    const sizeTier: SizeTier = resolveSizeTierFromInput(req.quality || req.size);
    const { creditsCost, channel } = await resolveModel(req.model, "image", sizeTier);
    const totalCost = creditsCost * count;

    const record = await db.$transaction(async (tx) => {
        const rec = await tx.generationRecord.create({
            data: {
                userId,
                channel: channel.name,
                model: req.model,
                capability: "image",
                sizeTier,
                prompt: req.prompt,
                params: { size: req.size, quality: req.quality, count },
                status: "pending",
                creditsHeld: totalCost,
            },
        });
        await charge(userId, totalCost, { reason: "generate", refType: "generation", refId: rec.id, remark: `${req.model} ${sizeTier}×${count}` }, tx);
        return rec;
    });

    try {
        const genInput = { model: req.model, prompt: req.prompt, size: req.size, quality: req.quality, count };
        const result =
            req.mode === "edit" && req.references?.length
                ? await editImageOpenAI(channel, genInput, await Promise.all(req.references.map(fetchBytes)), req.mask ? await fetchBytes(req.mask) : undefined)
                : await generateImageOpenAI(channel, genInput);
        const outputs = await Promise.all(
            result.images.map(async (img, i) => {
                const ext = EXT_BY_MIME[img.mimeType] || "png";
                const key = objectKey(userId, record.id, i, ext);
                await putObject(key, img.buffer, img.mimeType);
                return { key, mimeType: img.mimeType };
            }),
        );
        const balance = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } });
        await db.generationRecord.update({
            where: { id: record.id },
            data: { status: "success", creditsCost: totalCost, outputs, upstreamId: result.upstreamId },
        });
        const images = await Promise.all(outputs.map(async (o, i) => ({ id: `${record.id}-${i}`, url: await signedGetUrl(o.key) })));
        return { recordId: record.id, creditsCost: totalCost, balance: balance.creditBalance, images };
    } catch (error) {
        const msg = error instanceof Error ? error.message : "生成失败";
        await refund(userId, totalCost, { refType: "generation", refId: record.id, remark: "生成失败退点" });
        await db.generationRecord.update({ where: { id: record.id }, data: { status: "failed", errorMsg: msg.slice(0, 500) } });
        throw new AppError(error instanceof AppError ? msg : `生成失败：${msg}`, 1, 502);
    }
}
