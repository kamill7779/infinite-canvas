// 初始化种子数据：管理员、上游渠道、分档定价、示例兑换码。
// 运行：cd web && bun prisma/seed.ts
// 依赖环境变量：DATABASE_URL、DATA_ENCRYPTION_KEY，以及（可选）SEED_ADMIN_EMAIL/PASSWORD、SEED_UPSTREAM_BASEURL/KEY/MODEL。
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

const db = new PrismaClient();

// 与 src/server/crypto.ts 等价的加密（种子脚本自包含，避免 server-only 依赖链）
function encrypt(plain: string): string {
    const key = createHash("sha256").update(process.env.DATA_ENCRYPTION_KEY || "dev-insecure-key").digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

async function main() {
    const adminEmail = (process.env.SEED_ADMIN_EMAIL || "admin@example.com").toLowerCase();
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || "admin12345";
    const admin = await db.user.upsert({
        where: { email: adminEmail },
        update: { role: "superadmin" },
        create: { email: adminEmail, username: "admin", passwordHash: await bcrypt.hash(adminPassword, 10), role: "superadmin", creditBalance: 100000 },
    });
    console.log(`admin: ${adminEmail} / ${adminPassword}`);

    const channelName = "default";
    const upstreamKey = process.env.SEED_UPSTREAM_KEY || "sk-REPLACE-ME";
    const channel = await db.aiChannel.upsert({
        where: { id: "seed-default" },
        update: { baseUrl: process.env.SEED_UPSTREAM_BASEURL || "https://api.openai.com", apiKeyEnc: encrypt(upstreamKey) },
        create: { id: "seed-default", name: channelName, type: "openai", baseUrl: process.env.SEED_UPSTREAM_BASEURL || "https://api.openai.com", apiKeyEnc: encrypt(upstreamKey) },
    });

    const pricingChannel = channel.name;
    const model = process.env.SEED_UPSTREAM_MODEL || "gpt-image-2";
    const tiers: { sizeTier: "t1k" | "t2k" | "t4k"; cost: number }[] = [
        { sizeTier: "t1k", cost: 5 },
        { sizeTier: "t2k", cost: 12 },
        { sizeTier: "t4k", cost: 30 },
    ];
    for (const t of tiers) {
        await db.modelPricing.upsert({
            where: { channel_model_capability_sizeTier: { channel: pricingChannel, model, capability: "image", sizeTier: t.sizeTier } },
            update: { creditsCost: t.cost, enabled: true },
            create: { channel: pricingChannel, model, capability: "image", sizeTier: t.sizeTier, creditsCost: t.cost, enabled: true },
        });
    }
    console.log(`channel=${channel.name} model=${model} pricing: 1k=5 2k=12 4k=30`);

    // 示例兑换码（明文打印，DB 存哈希）
    const codes = ["DEMO-AAAA-BBBB-CCCC", "DEMO-DDDD-EEEE-FFFF"];
    for (const code of codes) {
        const codeHash = createHash("sha256").update(code).digest("hex");
        await db.redemptionCode.upsert({ where: { codeHash }, update: {}, create: { codeHash, credits: 1000, batchId: "seed" } });
    }
    console.log(`redeem codes (each 1000 pts): ${codes.join(", ")}`);
}

main()
    .then(() => db.$disconnect())
    .catch(async (e) => {
        console.error(e);
        await db.$disconnect();
        process.exit(1);
    });
