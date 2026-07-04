// 后台业务：用户管理、生成记录、定价/渠道配置、数据看板。
import "server-only";
import type { Prisma, SizeTier } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../errors";
import { encrypt } from "../crypto";
import { applyLedger } from "./credit-service";

// ── 用户 ────────────────────────────────────────────────
export async function listUsers(page = 1, pageSize = 20, keyword?: string) {
    const where: Prisma.UserWhereInput = keyword ? { OR: [{ email: { contains: keyword, mode: "insensitive" } }, { username: { contains: keyword, mode: "insensitive" } }] } : {};
    const [items, total] = await Promise.all([
        db.user.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, select: { id: true, email: true, username: true, role: true, status: true, creditBalance: true, createdAt: true } }),
        db.user.count({ where }),
    ]);
    return { items, total, page, pageSize };
}

export async function setBanned(userId: string, banned: boolean) {
    await db.user.update({ where: { id: userId }, data: { status: banned ? "banned" : "active" } });
    if (banned) await db.session.deleteMany({ where: { userId } }); // 封号即踢下线
}

export async function adjustCredits(userId: string, delta: number, remark: string) {
    if (!Number.isInteger(delta) || delta === 0) throw new AppError("调整额必须是非零整数");
    return applyLedger({ userId, delta, reason: "admin_adjust", remark });
}

// ── 生成记录（全站）────────────────────────────────────
export async function listGenerations(page = 1, pageSize = 20, filter: { userId?: string; status?: string; model?: string } = {}) {
    const where: Prisma.GenerationRecordWhereInput = {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.status ? { status: filter.status as Prisma.GenerationRecordWhereInput["status"] } : {}),
        ...(filter.model ? { model: filter.model } : {}),
    };
    const [items, total] = await Promise.all([
        db.generationRecord.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
        db.generationRecord.count({ where }),
    ]);
    return { items, total, page, pageSize };
}

// ── 定价 ────────────────────────────────────────────────
export function listPricing() {
    return db.modelPricing.findMany({ orderBy: [{ channel: "asc" }, { model: "asc" }, { sizeTier: "asc" }] });
}

export async function upsertPricing(input: { channel: string; model: string; capability: string; sizeTier: SizeTier; creditsCost: number; enabled: boolean }) {
    const { channel, model, capability, sizeTier, creditsCost, enabled } = input;
    if (creditsCost < 0) throw new AppError("单价不能为负");
    const exists = await db.aiChannel.findUnique({ where: { name: channel }, select: { id: true } });
    if (!exists) throw new AppError("渠道不存在，请先在渠道管理中创建");
    return db.modelPricing.upsert({
        where: { channel_model_capability_sizeTier: { channel, model, capability, sizeTier } },
        update: { creditsCost, enabled },
        create: { channel, model, capability, sizeTier, creditsCost, enabled },
    });
}

// ── 渠道（绝不回传明文 Key）────────────────────────────
export function listChannels() {
    return db.aiChannel.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, type: true, baseUrl: true, weight: true, enabled: true } });
}

export async function upsertChannel(input: { id?: string; name: string; type: string; baseUrl: string; apiKey?: string; weight?: number; enabled?: boolean }) {
    const duplicated = await db.aiChannel.findUnique({ where: { name: input.name }, select: { id: true } });
    if (duplicated && duplicated.id !== input.id) throw new AppError("渠道名已存在");

    const base = { name: input.name, type: input.type, baseUrl: input.baseUrl, weight: input.weight ?? 1, enabled: input.enabled ?? true };
    if (input.id) {
        // 留空 apiKey 表示不修改原 Key
        const data = input.apiKey ? { ...base, apiKeyEnc: encrypt(input.apiKey) } : base;
        return db.aiChannel.update({ where: { id: input.id }, data, select: { id: true } });
    }
    if (!input.apiKey) throw new AppError("新建渠道必须提供 API Key");
    return db.aiChannel.create({ data: { ...base, apiKeyEnc: encrypt(input.apiKey) }, select: { id: true } });
}

// ── 看板 ────────────────────────────────────────────────
export async function stats() {
    const dayAgo = new Date(Date.now() - 86400_000);
    const [totalUsers, newUsers, genTotal, genFailed, consumedAgg, redeemAgg] = await Promise.all([
        db.user.count(),
        db.user.count({ where: { createdAt: { gte: dayAgo } } }),
        db.generationRecord.count({ where: { createdAt: { gte: dayAgo } } }),
        db.generationRecord.count({ where: { createdAt: { gte: dayAgo }, status: "failed" } }),
        db.creditLedger.aggregate({ _sum: { delta: true }, where: { reason: "generate", createdAt: { gte: dayAgo } } }),
        db.creditLedger.aggregate({ _sum: { delta: true }, where: { reason: "redeem", createdAt: { gte: dayAgo } } }),
    ]);
    return {
        totalUsers,
        newUsers,
        genTotal,
        genFailRate: genTotal ? Math.round((genFailed / genTotal) * 100) : 0,
        creditsConsumed: Math.abs(consumedAgg._sum.delta ?? 0),
        redeemAmount: redeemAgg._sum.delta ?? 0,
    };
}
