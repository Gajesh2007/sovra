FROM oven/bun:1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --production

COPY src/ src/
COPY tsconfig.json ./

VOLUME /app/.data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["bun", "src/main.ts"]
