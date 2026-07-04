import type { NextRequest } from "next/server";
import { ok, fail, handle } from "@/server/http";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { signedGetUrl } from "@/server/r2";
import { getBalance } from "@/server/services/credit-service";

// 单条生成状态查询（补偿/恢复用，非轮询主路径）：
//   WebSocket 断线补偿、页面刷新恢复、失败排查、WebSocket 不可用场景。只能查本人记录。
export const dynamic = "force-dynamic";

type StoredOutput = { key: string; mimeType?: string; bytes?: number };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    return handle(async () => {
        const user = await requireUser();
        const { id } = await params;

        const rec = await db.generationRecord.findUnique({ where: { id } });
        if (!rec || rec.userId !== user.id) return fail("记录不存在", 404, 404); // 越权与不存在一律 404，不泄漏他人记录

        const outputs: StoredOutput[] = Array.isArray(rec.outputs) ? (rec.outputs as StoredOutput[]) : [];
        const images = await Promise.all(
            outputs.map(async (o, i) => ({ id: `${rec.id}-${i}`, url: await signedGetUrl(o.key), mimeType: o.mimeType, bytes: o.bytes })),
        );
        const balance = await getBalance(user.id);

        return ok({
            recordId: rec.id,
            clientRequestId: rec.clientRequestId ?? undefined,
            status: rec.status,
            images,
            errorMsg: rec.errorMsg ?? undefined,
            creditsCost: rec.creditsCost,
            balance,
        });
    });
}
