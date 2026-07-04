// 定价与渠道解析：根据 (模型, 能力, 分辨率档) 找到计价行与所属上游渠道。
import "server-only";
import { db } from "../db";
import { AppError } from "../errors";
import { decrypt } from "../crypto";
import type { SizeTier } from "@/lib/size-tier";

export type ResolvedModel = {
    creditsCost: number;
    channel: { id: string; name: string; type: string; baseUrl: string; apiKey: string };
};

/**
 * 解析一次生成的计价与上游渠道。
 * 计价行 ModelPricing 决定 creditsCost 与归属渠道名；再取启用的 AiChannel 拿 baseUrl/Key。
 */
export async function resolveModel(model: string, capability: string, sizeTier: SizeTier): Promise<ResolvedModel> {
    const pricing = await db.modelPricing.findFirst({ where: { model, capability, sizeTier, enabled: true, aiChannel: { enabled: true } }, include: { aiChannel: true } });
    if (!pricing) throw new AppError(`模型 ${model} 在 ${sizeTier} 档位未配置或未启用`);

    const channel = pricing.aiChannel;

    return {
        creditsCost: pricing.creditsCost,
        channel: { id: channel.id, name: channel.name, type: channel.type, baseUrl: channel.baseUrl, apiKey: decrypt(channel.apiKeyEnc) },
    };
}

/** 仅估算单次消耗（不解析渠道/Key），供前端展示「预计消耗」。无配置返回 null。 */
export async function estimateCost(model: string, capability: string, sizeTier: SizeTier): Promise<number | null> {
    const pricing = await db.modelPricing.findFirst({ where: { model, capability, sizeTier, enabled: true, aiChannel: { enabled: true } }, select: { creditsCost: true } });
    return pricing?.creditsCost ?? null;
}
