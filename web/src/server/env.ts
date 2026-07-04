// 服务端环境变量集中读取与校验。仅在服务端模块引用，禁止被客户端组件导入。
import "server-only";

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`缺少环境变量 ${name}`);
    return value;
}

function optional(name: string, fallback = ""): string {
    return process.env[name] ?? fallback;
}

export const env = {
    databaseUrl: required("DATABASE_URL"),
    // 注：REDIS_URL 由 server/redis.ts 直接读取并做生产强制校验，不在此重复导出（避免死代码/双来源）。
    // 用于加密上游 AI Key（AiChannel.apiKeyEnc）。32 字节，hex/base64 编码。
    dataEncryptionKey: optional("DATA_ENCRYPTION_KEY"),
    // 会话 Cookie 名与有效期（天）
    sessionCookieName: optional("SESSION_COOKIE_NAME", "ic_session"),
    sessionTtlDays: Number(optional("SESSION_TTL_DAYS", "30")),
    // 新用户注册赠送算力点
    signupBonusCredits: Number(optional("SIGNUP_BONUS_CREDITS", "100")),
    // Cloudflare R2（S3 兼容）
    r2: {
        accountId: optional("R2_ACCOUNT_ID"),
        accessKeyId: optional("R2_ACCESS_KEY_ID"),
        secretAccessKey: optional("R2_SECRET_ACCESS_KEY"),
        bucket: optional("R2_BUCKET"),
        // 对外读取的公开域（绑定自定义域或 r2.dev），用于拼访问 URL
        publicBase: optional("R2_PUBLIC_BASE"),
    },
    isProd: process.env.NODE_ENV === "production",
};
