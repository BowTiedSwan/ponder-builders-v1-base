import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";

const app = new Hono();

// Health check endpoint for DigitalOcean
app.get("/health", async (c) => {
  try {
    // Simple database connectivity check
    await db.select().from(schema.buildersProject).limit(1);
    return c.json({ status: "healthy", timestamp: Date.now() });
  } catch (error) {
    return c.json({ status: "unhealthy", error: String(error) }, 503);
  }
});

// Ready endpoint - check database connectivity
app.get("/ready", async (c) => {
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
