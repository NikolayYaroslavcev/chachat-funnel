FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

EXPOSE 3000
ENV PORT=3000

# Apply pending migrations, then seed the plans catalog, then start the
# server. Both steps are safe to run on every container start: migrate
# deploy is a no-op once migrations are applied, and the seed script
# upserts by slug so re-running it against an already-seeded database is a
# no-op too. This is what makes the plan catalog available on a clean
# `docker compose up` without any manual seed command.
CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seed.mjs && npm run start"]
