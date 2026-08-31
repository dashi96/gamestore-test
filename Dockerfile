FROM node:22-alpine

WORKDIR /app

# Зависимости отдельным слоем — код меняется чаще, чем package-lock
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY server ./server
COPY provider-stub ./provider-stub
COPY migrations ./migrations
COPY scripts ./scripts
COPY data ./data

# Команду задаёт compose: api / worker / provider / migrate / races
CMD ["npx", "tsx", "server/src/index.ts"]
