FROM node:26.12.0-bookworm-slim AS dependencies
ENV NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
RUN npm install --global @yarnpkg/cli-dist@4.18.1
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

FROM dependencies AS build
COPY . .
RUN NODE_ENV=production yarn build

FROM node:26.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 STORAGE_PATH=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts/cleanup-drafts.mjs ./scripts/cleanup-drafts.mjs
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
