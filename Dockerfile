# 构建 Next.js 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
# Next 构建期会静态导入服务端模块；这里只需要占位 DATABASE_URL，不连接真实库。
ENV DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/infinite_canvas
RUN bun run db:generate && bun run build

# 运行镜像：同一镜像可启动 web / worker / WS 网关，由 compose command 区分。
FROM node:22-bookworm-slim

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

EXPOSE 3000 3001
CMD ["sh", "-c", "cd /app/web && PORT=3000 node server.js"]
