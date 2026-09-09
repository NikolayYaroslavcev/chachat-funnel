// Seeds the plans reference catalog (spec.md section 14).
//
// Deliberately separate from the schema migration: plans is reference data,
// not schema — it doesn't belong in migration.sql, and unlike the schema it
// may need to be re-run/upserted independently of a migration. Run with
// `npx prisma db seed` (or let `prisma migrate dev` invoke it automatically
// for a fresh dev database). The Docker startup command (see Dockerfile)
// also runs this directly on every container start, so a clean
// `docker compose up` always has the plan catalog available.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const plans = [
  {
    slug: "weekly",
    name: "Weekly",
    priceAmount: "6.99",
    currency: "USD",
    billingPeriodDays: 7,
    displayOrder: 1,
  },
  {
    slug: "monthly",
    name: "Monthly",
    priceAmount: "14.99",
    currency: "USD",
    billingPeriodDays: 30,
    displayOrder: 2,
  },
  {
    slug: "3-months",
    name: "3 Months",
    priceAmount: "29.99",
    currency: "USD",
    billingPeriodDays: 90,
    displayOrder: 3,
  },
];

async function main() {
  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { slug: plan.slug },
      update: plan,
      create: plan,
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
