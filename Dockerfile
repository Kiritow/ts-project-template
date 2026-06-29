# Build Stage
FROM node:24-alpine AS builder
COPY package.json /app/
COPY package-lock.json /app/
RUN cd /app && npm install --loglevel verbose
COPY . /app
RUN cd /app && npm run build:prod

# Dependency Stage
FROM node:24-alpine AS prod-deps
COPY package.json /app/
COPY package-lock.json /app/
RUN cd /app && npm install --loglevel verbose --omit=dev

# Runtime Stage
FROM node:24-alpine
COPY --from=builder /app/dist /app/dist
COPY --from=prod-deps /app/node_modules /app/node_modules
CMD ["node", "--enable-source-maps", "/app/dist/index.js"]

# Alternatively, use distroless for better security
# FROM gcr.io/distroless/nodejs24-debian13
# COPY --from=builder /app/dist /app/dist
# COPY --from=prod-deps /app/node_modules /app/node_modules
# CMD ["--enable-source-maps", "/app/dist/index.js"]
