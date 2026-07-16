FROM node:20-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY LICENSE README.md ./
COPY cli ./cli
COPY migrations ./migrations
COPY public ./public
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
