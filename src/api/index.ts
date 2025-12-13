import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono, Context } from "hono";
import { client, graphql } from "ponder";

const app = new Hono();

// Health check endpoint for Railway
// Simple endpoint that just checks if the server is responding
// Don't check database schema as it may not be initialized yet
app.get("/health", async (c: Context) => {
  return c.json({ status: "healthy", timestamp: Date.now() });
});

// Ready endpoint - check database connectivity
app.get("/ready", async (c: Context) => {
  try {
    // Try a simple query to check database connectivity
    // This will fail if schema isn't initialized yet, which is expected during startup
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
