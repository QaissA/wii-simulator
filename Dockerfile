# Relay (apps/server) only. The display and controller are static sites; host them separately.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @wii/server... build
ENV HOST=0.0.0.0 PORT=8081
EXPOSE 8081
CMD ["node", "apps/server/dist/index.js"]
