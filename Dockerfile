FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS production
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p uploads && chown -R node:node /app/uploads
EXPOSE 3001
USER node
COPY --from=builder /app/node_modules ./node_modules
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main"]