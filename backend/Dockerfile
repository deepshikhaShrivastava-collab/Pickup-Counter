FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY seeds ./seeds
USER node
EXPOSE 4000
# Migrations take an advisory lock and the seed is idempotent, so restarts are safe.
CMD ["sh", "-c", "node dist/db/cli.js migrate seed && exec node dist/server.js"]
