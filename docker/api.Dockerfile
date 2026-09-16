FROM node:22-alpine AS dependencies
RUN npm install --global npm@11.19.1
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM dependencies AS build
COPY apps/api apps/api
RUN npm run db:generate && npm run build --workspace=@pastagansa/api

FROM node:22-alpine AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/scripts apps/api/scripts
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/node_modules node_modules
COPY --chmod=755 docker/api-entrypoint.sh /usr/local/bin/api-entrypoint
USER node
EXPOSE 3000
ENTRYPOINT ["api-entrypoint"]

FROM runtime-base AS production

FROM runtime-base AS runtime
COPY scripts/seed-demo.mjs scripts/seed-demo.mjs
