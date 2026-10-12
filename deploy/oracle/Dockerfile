# Build from the NemoEngine repo root. Works on ARM64 and AMD64 Node.js hosts.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY . ./
RUN addgroup -S nemo && adduser -S -G nemo nemo && chown -R nemo:nemo /app
USER nemo
EXPOSE 8790
CMD ["node", "mcp/sillytavern-server.mjs"]
