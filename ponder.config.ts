import { createConfig } from "ponder";
import { http, type Abi } from "viem";
import { loadBalance, rateLimit } from "ponder";

// Import ABIs from local files
import { BuildersAbi, ERC20Abi } from "./abis/index.js";

// Detect production environment
const isProduction = 
  process.env.NODE_ENV === "production" ||
  process.env.RAILWAY_ENVIRONMENT !== undefined ||
  process.env.RAILWAY_ENVIRONMENT_NAME === "production" ||
  process.env.VERCEL_ENV === "production" ||
  process.env.FLY_APP_NAME !== undefined;

// Validate database configuration
const databaseUrl = process.env.DATABASE_URL;
const usingPostgres = !!databaseUrl;
const usingPGlite = !databaseUrl;

if (isProduction && usingPGlite) {
  console.error("⚠️  CRITICAL WARNING: Running in production without DATABASE_URL!");
  console.error("⚠️  PGlite (ephemeral file-based database) will be used, which will cause DATA LOSS on restart!");
  console.error("⚠️  Set DATABASE_URL environment variable to use PostgreSQL for persistent storage.");
  console.error("⚠️  This is a production deployment - data will NOT persist across restarts!");
  throw new Error(
    "DATABASE_URL is required in production. PGlite is ephemeral and will cause data loss. " +
    "Please set DATABASE_URL to a PostgreSQL connection string."
  );
}

if (usingPostgres) {
  console.log("✅ Using PostgreSQL database (persistent storage)");
  console.log(`   Connection: ${databaseUrl?.replace(/:[^:@]+@/, ":****@")}`); // Mask password
} else {
  console.warn("⚠️  Using PGlite database (ephemeral file-based storage)");
  console.warn("⚠️  This is suitable for local development only.");
  console.warn("⚠️  Data will be lost on restart. Use DATABASE_URL for production.");
}

export default createConfig({
  // Database configuration: Use Postgres if DATABASE_URL is provided, otherwise use PGlite for local dev
  ...(databaseUrl
    ? {
        database: {
          kind: "postgres",
          connectionString: databaseUrl,
          poolConfig: {
            max: 30,
          },
        },
      }
    : {}),
  chains: {
    base: {
      id: 8453,
      rpc: loadBalance([
        http(process.env.PONDER_RPC_URL_8453 || "https://mainnet.base.org"),
        rateLimit(http("https://base-rpc.publicnode.com"), { 
          requestsPerSecond: 25 
        }),
      ]),
    },
  },
  contracts: {
    // Main Builders staking contract - Base mainnet
    Builders: {
      abi: BuildersAbi as Abi,
      chain: "base",
      address: (process.env.BUILDERS_CONTRACT_ADDRESS || "0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9") as `0x${string}`,
      startBlock: Number(process.env.BUILDERS_START_BLOCK || "24381796"),
      includeTransactionReceipts: true,
    },

    // MOR Token contract - for tracking transfers and approvals
    MorToken: {
      abi: ERC20Abi as Abi,
      chain: "base",
      address: (process.env.MOR_TOKEN_ADDRESS || "0x7431ADA8A591C955A994A21710752ef9b882b8e3") as `0x${string}`,
      startBlock: Number(process.env.MOR_TOKEN_START_BLOCK || "7500000"),
    },
  },
});
