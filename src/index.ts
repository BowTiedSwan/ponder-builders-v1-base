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
const getOrCreateCounters = async (context: any) => {
  let counter = await context.db
    .select()
    .from(counters)
    .where(eq(counters.id, "global"))
    .limit(1);

  if (counter.length === 0) {
    await context.db.insert(counters).values({
      id: "global",
      totalBuildersProjects: 0,
      totalSubnets: 0,
      totalStaked: 0n,
      totalUsers: 0,
      lastUpdated: Number(context.block.timestamp),
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
  const { poolId, name, admin } = event.args;
  
  // Read additional pool parameters from contract
  const [poolInfo, currentReward] = await Promise.all([
    context.client.readContract({
      address: event.log.address,
      abi: context.contracts.Builders.abi,
      functionName: "usersData",
      args: [admin, poolId], // Get admin's data to understand pool structure
    }),
    context.client.readContract({
      address: event.log.address,
      abi: context.contracts.Builders.abi,
      functionName: "getCurrentBuilderReward",
      args: [poolId],
    }),
  ]);

  // Create the builders project
  await context.db.insert(buildersProject).values({
    id: poolId,
    name: name,
    admin: admin,
    totalStaked: 0n,
    totalUsers: 0,
    totalClaimed: 0n,
    // Note: These would need to be derived from pool creation parameters
    // For now using placeholder values - in practice, these should come from the createBuilderPool call data
    minimalDeposit: 1000000000000000000n, // 1 MOR placeholder
    withdrawLockPeriodAfterDeposit: 86400n * 30n, // 30 days placeholder
    claimLockEnd: BigInt(context.block.timestamp) + 86400n * 365n, // 1 year placeholder
    startsAt: BigInt(context.block.timestamp),
    chainId: context.chain.id,
    contractAddress: event.log.address,
    createdAt: Number(context.block.timestamp),
    createdAtBlock: event.block.number,
  });

  // Update counters
  const counter = await getOrCreateCounters(context);
  await context.db
    .update(counters)
    .set({
      totalBuildersProjects: counter.totalBuildersProjects + 1,
      lastUpdated: Number(context.block.timestamp),
    })
    .where(eq(counters.id, "global"));
});

ponder.on("Builders:Deposited", async ({ event, context }: any) => {
  const { user, builderPoolId, amount } = event.args;
  
  const userId = createUserId(builderPoolId, user);
  
  // Create staking event record
  await context.db.insert(stakingEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    buildersProjectId: builderPoolId,
    userAddress: user,
    eventType: "DEPOSIT",
    amount: amount,
    blockNumber: event.block.number,
    blockTimestamp: Number(context.block.timestamp),
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
      lastStake: BigInt(context.block.timestamp),
      claimLockEnd: claimLockStart,
      lastDeposit: lastDeposit,
      virtualDeposited: virtualDeposited,
      chainId: context.chain.id,
    })
    .onConflictDoUpdate({
      staked: deposited,
      lastStake: BigInt(context.block.timestamp),
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
      totalUsers: existingUsers[0].count,
    })
    .where(eq(buildersProject.id, builderPoolId));
});

ponder.on("Builders:Withdrawn", async ({ event, context }: any) => {
  const { user, builderPoolId, amount } = event.args;
  
  const userId = createUserId(builderPoolId, user);
  
  // Create staking event record
  await context.db.insert(stakingEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    buildersProjectId: builderPoolId,
    userAddress: user,
    eventType: "WITHDRAW",
    amount: amount,
    blockNumber: event.block.number,
    blockTimestamp: Number(context.block.timestamp),
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

ponder.on("Builders:Claimed", async ({ event, context }: any) => {
  const { user, builderPoolId, amount } = event.args;
  
  const userId = createUserId(builderPoolId, user);
  
  // Create staking event record
  await context.db.insert(stakingEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    buildersProjectId: builderPoolId,
    userAddress: user,
    eventType: "CLAIM",
    amount: amount,
    blockNumber: event.block.number,
    blockTimestamp: Number(context.block.timestamp),
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    chainId: context.chain.id,
  });

  // Update user claimed amount
  const existingUser = await context.db
    .select()
    .from(buildersUser)
    .where(eq(buildersUser.id, userId))
    .limit(1);

  if (existingUser.length > 0) {
    await context.db
      .update(buildersUser)
      .set({
        claimed: existingUser[0].claimed + amount,
      })
      .where(eq(buildersUser.id, userId));
  }

  // Update project total claimed
  const totalClaimed = await context.db
    .select({ sum: sql`sum(${buildersUser.claimed})` })
    .from(buildersUser)
    .where(eq(buildersUser.buildersProjectId, builderPoolId));

  await context.db
    .update(buildersProject)
    .set({
      totalClaimed: totalClaimed[0].sum || 0n,
    })
    .where(eq(buildersProject.id, builderPoolId));
});

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
    blockTimestamp: Number(context.block.timestamp),
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    chainId: context.chain.id,
    isStakingDeposit,
    isStakingWithdraw,
    relatedProjectId,
  });
});
