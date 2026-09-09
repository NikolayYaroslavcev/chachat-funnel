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
