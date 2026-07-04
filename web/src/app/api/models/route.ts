// 面向终端用户的可用模型列表。只暴露「渠道名(通用) + 模型 + 各档位单价」，绝不返回 baseUrl/Key。
import { ok, handle } from "@/server/http";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

export async function GET() {
    return handle(async () => {
        await requireUser();
        const rows = await db.modelPricing.findMany({
            where: { enabled: true, aiChannel: { enabled: true } },
            select: { channel: true, model: true, capability: true, sizeTier: true, creditsCost: true },
            orderBy: [{ channel: "asc" }, { model: "asc" }],
        });
        // 按 渠道+模型+能力 聚合各档位价格
        const map = new Map<string, { channel: string; model: string; capability: string; tiers: Record<string, number> }>();
        for (const r of rows) {
            const key = `${r.channel}|${r.model}|${r.capability}`;
            const entry = map.get(key) ?? { channel: r.channel, model: r.model, capability: r.capability, tiers: {} };
            entry.tiers[r.sizeTier] = r.creditsCost;
            map.set(key, entry);
        }
        return ok([...map.values()]);
    });
}
