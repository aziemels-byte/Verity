import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { HttpError } from "../../http-error.js";
import { assertPublicHttpUrl } from "../webhooks/url-guard.js";

export const WEBHOOK_EVENT_NAMES = [
  "submission.verified",
  "submission.slashed",
  "submission.disputed",
] as const;

const webhookIdSchema = z.object({ id: z.string().uuid() });
const webhookUpdateSchema = z.object({ active: z.boolean() });
const publicWebhookColumns = [
  "id",
  "url",
  "events",
  "active",
  "created_at",
] as const;

// All webhook operations have the same marketplace ownership boundary.
async function assertMarketplaceOwner(id: string, account: string | undefined): Promise<void> {
  const marketplace = await db
    .selectFrom("marketplace")
    .select(["stellar_account"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!marketplace || marketplace.stellar_account !== account) {
    throw new HttpError(403, "only the marketplace's own account can manage its webhooks");
  }
}

export async function marketplacesRoutes(app: FastifyInstance) {
  app.post("/v1/marketplaces", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const account = req.stellarAccount!;
    const existing = await db
      .selectFrom("marketplace")
      .selectAll()
      .where("stellar_account", "=", account)
      .executeTakeFirst();
    if (existing) return existing;
    const row = await db
      .insertInto("marketplace")
      .values({ stellar_account: account, name: body.name })
      .returningAll()
      .executeTakeFirstOrThrow();
    reply.code(201);
    return row;
  });

  app.post("/v1/marketplaces/:id/webhooks", { preHandler: requireAuth }, async (req, reply) => {
    const params = webhookIdSchema.parse(req.params);
    const body = z
      .object({
        url: z.string().url(),
        secret: z.string().min(8),
        events: z.array(z.enum(WEBHOOK_EVENT_NAMES)).min(1),
      })
      .parse(req.body);
    await assertMarketplaceOwner(params.id, req.stellarAccount);
    await assertPublicHttpUrl(body.url);
    const row = await db
      .insertInto("webhook_subscription")
      .values({
        marketplace_id: params.id,
        url: body.url,
        secret: body.secret,
        events: [...new Set(body.events)],
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    reply.code(201);
    return row;
  });

  app.get("/v1/marketplaces/:id/webhooks", { preHandler: requireAuth }, async (req) => {
    const params = webhookIdSchema.parse(req.params);
    await assertMarketplaceOwner(params.id, req.stellarAccount);
    return db
      .selectFrom("webhook_subscription")
      .select(publicWebhookColumns)
      .where("marketplace_id", "=", params.id)
      .orderBy("created_at", "desc")
      .execute();
  });

  app.patch("/v1/marketplaces/:id/webhooks/:webhookId", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid(), webhookId: z.string().uuid() }).parse(req.params);
    const body = webhookUpdateSchema.parse(req.body);
    await assertMarketplaceOwner(params.id, req.stellarAccount);
    const row = await db
      .updateTable("webhook_subscription")
      .set({ active: body.active })
      .where("id", "=", params.webhookId)
      .where("marketplace_id", "=", params.id)
      .returning(publicWebhookColumns)
      .executeTakeFirst();
    if (!row) {
      reply.code(404);
      return { error: "webhook subscription not found" };
    }
    return row;
  });
}

export async function findOrCreateMarketplaceForAccount(account: string) {
  const existing = await db
    .selectFrom("marketplace")
    .selectAll()
    .where("stellar_account", "=", account)
    .executeTakeFirst();
  if (existing) return existing;
  return db
    .insertInto("marketplace")
    .values({ stellar_account: account, name: account })
    .returningAll()
    .executeTakeFirstOrThrow();
}
