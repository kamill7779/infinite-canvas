import type { NextRequest } from "next/server";
import { ok, fail, handle } from "@/server/http";
import { requireUser } from "@/server/auth";
import { rateLimit, acquireLock, releaseLock } from "@/server/redis";
import { createImageGenerationJob } from "@/server/services/gen-service";

// 入队即返回，不再等待上游生图；明确动态执行。
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    return handle(async () => {
        const user = await requireUser();
        if (!(await rateLimit(`gen:${user.id}`, 20, 60))) return fail("生成过于频繁，请稍后再试", 429, 429);

        const body = await req.json();
        const { clientRequestId, model, prompt, size, quality, mode, references, mask, idempotencyKey } = body ?? {};
        if (!model || !prompt) return fail("缺少模型或提示词");

        // 幂等：同一 key 在建记录/入队期间加锁，防双击重复扣费。入队很快，锁 30s 足够。
        const lockKey = idempotencyKey ? `idem:${user.id}:${idempotencyKey}` : "";
        if (lockKey && !(await acquireLock(lockKey, 30_000))) return fail("请求正在处理中，请勿重复提交", 409, 409);
        try {
            // 预扣与建记录同事务；余额不足抛 InsufficientCreditsError → handle 转 402，不入队。
            const result = await createImageGenerationJob(user.id, { clientRequestId, model, prompt, size, quality, mode, references, mask });
            return ok(result);
        } finally {
            if (lockKey) await releaseLock(lockKey);
        }
    });
}
