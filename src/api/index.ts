import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono, Context } from "hono";
import { client, graphql, sql } from "ponder";

const app = new Hono();

// Health check endpoint for Railway
// Checks database connectivity without requiring schema to be initialized
// Uses raw SQL SELECT 1 which works regardless of table existence
app.get("/health", async (c: Context) => {
  try {
    // Simple database connectivity check using raw SQL
    // This works even if tables don't exist yet (during initial startup)
    await db.execute(sql`SELECT 1`);
    return c.json({ status: "healthy", timestamp: Date.now() });
  } catch (error) {
    // Database is unavailable - return 503 so Railway knows service is unhealthy
    return c.json({ status: "unhealthy", error: String(error) }, 503);
  }
});

// Ready endpoint - check database connectivity and schema initialization
app.get("/ready", async (c: Context) => {
  try {
    await db.select().from(schema.buildersProject).limit(1);
    return c.json({ status: "ready", timestamp: Date.now() });
  } catch (error) {
    return c.json({ status: "not ready", error: String(error) }, 503);
  }
});

app.use("/sql/*", client({ db, schema }));

app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

export default app;