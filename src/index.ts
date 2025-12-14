import { ponder } from "ponder:registry";
import { 
  buildersProject, 
  buildersUser, 
  stakingEvent, 
  morTransfer, 
  counters 
} from "ponder:schema";
import { isAddressEqual } from "viem";
import { eq, sql } from "ponder";

// Helper function to create composite user ID
const createUserId = (projectId: string, userAddress: string) => 
  `${projectId}-${userAddress.toLowerCase()}`;

// Helper function to get or create counters
const getOrCreateCounters = async (context: any, blockTimestamp: number) => {
  let counter = await context.db
    .select()
    .from(counters)
    .where(eq(counters.id, "global"))
    .limit(1);

  if (counter.length === 0) {
    await context.db.insert(counters).values({
      id: "global",
      totalBuildersProjects: 0n, // Changed to BigInt to match expected schema
      totalSubnets: 0n, // Changed to BigInt to match expected schema
      totalStaked: 0n,
      totalUsers: 0,
      lastUpdated: blockTimestamp,
    });
    
    counter = await context.db
      .select()
      .from(counters)
      .where(eq(counters.id, "global"))
      .limit(1);
  }

  return counter[0];
};

// Builders Contract Events

ponder.on("Builders:BuilderPoolCreated", async ({ event, context }: any) => {
  const { builderPoolId, builderPool } = event.args;
  // builderPool is a tuple with: name, admin, poolStart, withdrawLockPeriodAfterDeposit, claimLockEnd, minimalDeposit
  
  // Extract fields from the builderPool tuple
  const {
    name,
    admin,
    poolStart,
    withdrawLockPeriodAfterDeposit,
    claimLockEnd,
    minimalDeposit,
  } = builderPool;

  // Create the builders project
  await context.db.insert(buildersProject).values({
    id: builderPoolId,
    name: name,
    admin: admin,
    totalStaked: 0n,
    totalUsers: 0n, // Changed to BigInt to match expected schema
    totalClaimed: 0n,
    minimalDeposit: minimalDeposit,
    withdrawLockPeriodAfterDeposit: BigInt(withdrawLockPeriodAfterDeposit),
    claimLockEnd: BigInt(claimLockEnd),
    startsAt: BigInt(poolStart),
    chainId: context.chain.id,
    contractAddress: event.log.address,
    createdAt: Number(event.block.timestamp),
    createdAtBlock: event.block.number,
  });

  // Update counters
  const counter = await getOrCreateCounters(context, Number(event.block.timestamp));
  await context.db
    .update(counters)
    .set({
      totalBuildersProjects: BigInt(counter.totalBuildersProjects) + 1n, // Changed to BigInt to match expected schema
      lastUpdated: Number(event.block.timestamp),
    })
    .where(eq(counters.id, "global"));
});

ponder.on("Builders:UserDeposited", async ({ event, context }: any) => {
  const { builderPool, user, amount } = event.args;
  const builderPoolId = builderPool;
  
  const userId = createUserId(builderPoolId, user);
  
  // Create staking event record
  await context.db.insert(stakingEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    buildersProjectId: builderPoolId,
    userAddress: user,
    eventType: "DEPOSIT",
    amount: amount,
    blockNumber: event.block.number,
    blockTimestamp: Number(event.block.timestamp),
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    chainId: context.chain.id,
  });

  // Get current user data from contract
  const userData = await context.client.readContract({
    address: event.log.address,
    abi: context.contracts.Builders.abi,
    functionName: "usersData",
    args: [user, builderPoolId],
  });

  const [lastDeposit, claimLockStart, deposited, virtualDeposited] = userData;

  // Upsert user record
  await context.db
    .insert(buildersUser)
    .values({
      id: userId,
      buildersProjectId: builderPoolId,
      address: user,
      staked: deposited,
      claimed: 0n, // Will be updated on claim events
      lastStake: BigInt(event.block.timestamp),
      claimLockEnd: claimLockStart,
      lastDeposit: lastDeposit,
      virtualDeposited: virtualDeposited,
      chainId: context.chain.id,
    })
    .onConflictDoUpdate({
      staked: deposited,
      lastStake: BigInt(event.block.timestamp),
      claimLockEnd: claimLockStart,
      lastDeposit: lastDeposit,
      virtualDeposited: virtualDeposited,
    });

  // Update project totals
  const existingUsers = await context.db
    .select({ count: sql`count(*)` })
    .from(buildersUser)
    .where(eq(buildersUser.buildersProjectId, builderPoolId));

  const totalStaked = await context.db
    .select({ sum: sql`sum(${buildersUser.staked})` })
    .from(buildersUser)
    .where(eq(buildersUser.buildersProjectId, builderPoolId));

  await context.db
    .update(buildersProject)
    .set({
      totalStaked: totalStaked[0].sum || 0n,
      totalUsers: BigInt(existingUsers[0].count), // Changed to BigInt to match expected schema
    })
    .where(eq(buildersProject.id, builderPoolId));
});

ponder.on("Builders:UserWithdrawn", async ({ event, context }: any) => {
  const { builderPool, user, amount } = event.args;
  const builderPoolId = builderPool;
  
  const userId = createUserId(builderPoolId, user);
  
  // Create staking event record
  await context.db.insert(stakingEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    buildersProjectId: builderPoolId,
    userAddress: user,
    eventType: "WITHDRAW",
    amount: amount,
    blockNumber: event.block.number,
    blockTimestamp: Number(event.block.timestamp),
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    chainId: context.chain.id,
  });

  // Get updated user data from contract
  const userData = await context.client.readContract({
    address: event.log.address,
    abi: context.contracts.Builders.abi,
    functionName: "usersData",
    args: [user, builderPoolId],
  });

  const [lastDeposit, claimLockStart, deposited, virtualDeposited] = userData;

  // Update user record
  await context.db
    .update(buildersUser)
    .set({
      staked: deposited,
      lastDeposit: lastDeposit,
      virtualDeposited: virtualDeposited,
    })
    .where(eq(buildersUser.id, userId));

  // Update project totals
  const totalStaked = await context.db
    .select({ sum: sql`sum(${buildersUser.staked})` })
    .from(buildersUser)
    .where(eq(buildersUser.buildersProjectId, builderPoolId));

  await context.db
    .update(buildersProject)
    .set({
      totalStaked: totalStaked[0].sum || 0n,
    })
    .where(eq(buildersProject.id, builderPoolId));
});

// Note: There's no "Claimed" event in the ABI. User claims are not emitted as events.
// If claims need to be tracked, they would need to be calculated from contract state
// by reading user data periodically or tracking claim transactions differently.

// MOR Token Transfer Events
ponder.on("MorToken:Transfer", async ({ event, context }: any) => {
  const { from, to, value } = event.args;
  
  // Check if this transfer is related to builders staking
  // Base mainnet Builders contract address only
  const buildersAddress = "0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9" as `0x${string}`;
  
  const isStakingRelated = 
    isAddressEqual(to as `0x${string}`, buildersAddress) || 
    isAddressEqual(from as `0x${string}`, buildersAddress);
  
  let isStakingDeposit = false;
  let isStakingWithdraw = false;
  let relatedProjectId = null;
  
  if (isStakingRelated) {
    isStakingDeposit = isAddressEqual(to as `0x${string}`, buildersAddress);
    isStakingWithdraw = isAddressEqual(from as `0x${string}`, buildersAddress);
  }

  await context.db.insert(morTransfer).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    from: from,
    to: to,
    value: value,
    blockNumber: event.block.number,
    blockTimestamp: Number(event.block.timestamp),
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    chainId: context.chain.id,
    isStakingDeposit,
    isStakingWithdraw,
    relatedProjectId,
  });
});
