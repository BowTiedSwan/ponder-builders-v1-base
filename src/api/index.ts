import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";

const app = new Hono();

// Health check endpoint for Railway
// Using /healthz instead of /health because /health is reserved by Ponder
// Simple endpoint that just checks if the server is responding
// Don't check database schema as it may not be initialized yet
app.get("/healthz", async (c) => {
  try {
    // Simple database connectivity check
    await db.select().from(schema.buildersProject).limit(1);
    return c.json({ status: "healthy", timestamp: Date.now() });
  } catch (error) {
    return c.json({ status: "unhealthy", error: String(error) }, 503);
  }
});

// Ready endpoint - check database connectivity and schema initialization
// Using /readyz instead of /ready because /ready is reserved by Ponder
app.get("/readyz", async (c) => {
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