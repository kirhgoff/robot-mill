FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .

# Run vite dev server which includes the API proxy from vite.config.ts
EXPOSE 3000
CMD ["bun", "run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"]
