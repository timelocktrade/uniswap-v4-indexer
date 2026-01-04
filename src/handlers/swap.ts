import {zeroAddress} from 'viem';
import {handlerContext, PoolManager, Swap} from 'generated';
import * as intervalUpdates from '../utils/intervalUpdates';
import {getOrCreateTransaction} from '../utils/transaction';
import {ALLOWED_POOL_IDS} from '../utils/allowedPools';

// Q128 constant for fee growth precision (Q128.128 format)
const Q128 = 2n ** 128n;

// Helper function to calculate fees from amount and fee tier
const calculateFees = (amount: bigint, feeTier: bigint): bigint => {
  return (amount * feeTier) / 1000000n;
};

const abs = (value: bigint): bigint => {
  return value < 0n ? -value : value;
};

// Helper function to update global fee growth
const updateFeeGrowth = (
  currentFeeGrowth: bigint,
  fees: bigint,
  liquidity: bigint,
): bigint => {
  if (liquidity === 0n) {
    return currentFeeGrowth;
  }
  return currentFeeGrowth + (fees * Q128) / liquidity;
};

// Helper function to calculate fee growth outside when tick is crossed
const flipFeeGrowthOutside = (
  feeGrowthGlobal: bigint,
  feeGrowthOutside: bigint,
): bigint => {
  return feeGrowthGlobal - feeGrowthOutside;
};

// Helper function to get initialized ticks that were crossed
const getInitializedTicksCrossed = async (
  poolId: string,
  oldTick: bigint,
  newTick: bigint,
  tickSpacing: bigint,
  context: handlerContext,
): Promise<bigint[]> => {
  const ticksCrossed: bigint[] = [];

  if (newTick === oldTick) {
    return ticksCrossed;
  }

  // Determine direction and bounds
  const ascending = newTick > oldTick;
  const startTick = ascending ? oldTick + 1n : oldTick;
  const endTick = ascending ? newTick : newTick + 1n;

  // Only check ticks that align with tickSpacing
  // Round to nearest tick spacing boundary
  let currentTick = startTick;
  const remainder = currentTick % tickSpacing;
  if (remainder !== 0n) {
    if (ascending) {
      currentTick = currentTick + (tickSpacing - remainder);
    } else {
      currentTick = currentTick - remainder;
    }
  }

  // Iterate through potential initialized ticks
  // We check existence in database rather than iterating every single tick
  const ticksToCheck: bigint[] = [];
  if (ascending) {
    for (let tick = currentTick; tick <= endTick; tick += tickSpacing) {
      ticksToCheck.push(tick);
    }
  } else {
    for (let tick = currentTick; tick >= endTick; tick -= tickSpacing) {
      ticksToCheck.push(tick);
    }
  }

  // Batch check which ticks exist (are initialized)
  const tickCheckPromises = ticksToCheck.map(async tickIdx => {
    const tickId = `${poolId}#${tickIdx}`;
    const tick = await context.Tick.get(tickId);
    return tick ? tickIdx : null;
  });

  const results = await Promise.all(tickCheckPromises);

  // Filter out null values and return only initialized ticks
  for (const tickIdx of results) {
    if (tickIdx !== null) {
      ticksCrossed.push(tickIdx);
    }
  }

  return ticksCrossed;
};

// Helper function to update tick fee growth when tick is crossed
const updateTickCrossed = async (
  tickId: string,
  feeGrowthGlobal0X128: bigint,
  feeGrowthGlobal1X128: bigint,
  context: handlerContext,
) => {
  const tickRO = await context.Tick.get(tickId);

  if (tickRO) {
    const tick = {...tickRO};
    // When a tick is crossed, we flip the fee growth outside
    tick.feeGrowthOutside0X128 = flipFeeGrowthOutside(
      feeGrowthGlobal0X128,
      tick.feeGrowthOutside0X128,
    );
    tick.feeGrowthOutside1X128 = flipFeeGrowthOutside(
      feeGrowthGlobal1X128,
      tick.feeGrowthOutside1X128,
    );
    context.Tick.set(tick);
  }
};

PoolManager.Swap.handler(
  async ({event, context}) => {
    const poolId = `${event.chainId}_${event.params.id}`;
    const poolRO = await context.Pool.get(poolId);
    if (!poolRO) return;

    const [token0RO, token1RO] = await Promise.all([
      context.Token.get(poolRO.token0_id),
      context.Token.get(poolRO.token1_id),
    ]);

    if (!token0RO || !token1RO) return;

    // Create mutable copies of the entities
    const token0 = {...token0RO};
    const token1 = {...token1RO};
    const pool = {...poolRO};
    const timestamp = event.block.timestamp;

    // amounts - 0/1 are token deltas: can be positive or negative
    // In V4, negative amount represents that amount is being sent to the pool, so invert the sign
    const amount0 = -event.params.amount0;
    const amount1 = -event.params.amount1;

    // need absolute amounts for volume
    const amount0Abs = abs(amount0);
    const amount1Abs = abs(amount1);

    const fees0 = calculateFees(amount0Abs, pool.feeTier);
    const fees1 = calculateFees(amount1Abs, pool.feeTier);

    // Update global fee growth using liquidity BEFORE the swap
    pool.feeGrowthGlobal0X128 = updateFeeGrowth(
      pool.feeGrowthGlobal0X128,
      fees0,
      poolRO.liquidity,
    );
    pool.feeGrowthGlobal1X128 = updateFeeGrowth(
      pool.feeGrowthGlobal1X128,
      fees1,
      poolRO.liquidity,
    );

    // Handle tick crossing - update fee growth outside for crossed ticks
    const oldTick = poolRO.tick ?? 0n;
    const newTick = event.params.tick;

    // If ticks changed, we need to update all initialized crossed ticks
    if (oldTick !== newTick) {
      const ticksCrossed = await getInitializedTicksCrossed(
        poolId,
        oldTick,
        newTick,
        pool.tickSpacing,
        context,
      );

      // Update each crossed tick's fee growth outside
      // Only initialized ticks (ticks with liquidity) are updated
      await Promise.all(
        ticksCrossed.map(tickIdx =>
          updateTickCrossed(
            `${poolId}#${tickIdx}`,
            pool.feeGrowthGlobal0X128,
            pool.feeGrowthGlobal1X128,
            context,
          ),
        ),
      );
    }

    // pool volume
    pool.volume0 = pool.volume0 + amount0Abs;
    pool.volume1 = pool.volume1 + amount1Abs;
    pool.fees0 = pool.fees0 + fees0;
    pool.fees1 = pool.fees1 + fees1;
    pool.txCount = pool.txCount + 1n;
    pool.swapCount = pool.swapCount + 1n;

    // Update the pool with the new active liquidity, price, and tick.
    pool.liquidity = event.params.liquidity;
    pool.tick = event.params.tick;
    pool.sqrtPrice = event.params.sqrtPriceX96;
    pool.sqrtPriceX96 = event.params.sqrtPriceX96;
    pool.tvl0 = pool.tvl0 + amount0;
    pool.tvl1 = pool.tvl1 + amount1;

    // update token0 data
    token0.volume = token0.volume + amount0Abs;
    token0.tvl = token0.tvl + amount0;
    token0.txCount = token0.txCount + 1n;
    token0.swapCount = token0.swapCount + 1n;

    // update token1 data
    token1.volume = token1.volume + amount1Abs;
    token1.tvl = token1.tvl + amount1;
    token1.txCount = token1.txCount + 1n;
    token1.swapCount = token1.swapCount + 1n;

    if (pool.hooks !== zeroAddress) {
      // Update HookStats
      const hookStatsId = `${event.chainId}_${pool.hooks}`;
      const hookStatsRO = await context.HookStats.get(hookStatsId);
      if (hookStatsRO) {
        const hookStats = {...hookStatsRO};
        hookStats.swapCount = hookStats.swapCount + 1n;
        hookStats.volume0 = hookStats.volume0 + amount0Abs;
        hookStats.volume1 = hookStats.volume1 + amount1Abs;
        hookStats.fees0 = hookStats.fees0 + fees0;
        hookStats.fees1 = hookStats.fees1 + fees1;
        hookStats.tvl0 = hookStats.tvl0 + amount0;
        hookStats.tvl1 = hookStats.tvl1 + amount1;
        context.HookStats.set(hookStats);
      }
    }
    // create Swap event
    const transaction = await getOrCreateTransaction(event, context);

    const swap: Swap = {
      id: `${event.chainId}_${event.transaction.hash}_${event.logIndex}`,
      chainId: BigInt(event.chainId),
      transaction_id: transaction.id,
      timestamp: BigInt(timestamp),
      pool_id: pool.id,
      token0_id: poolRO.token0_id,
      token1_id: poolRO.token1_id,
      sender: event.params.sender,
      recipient: event.params.sender, // V4 doesn't have separate recipient
      origin: event.transaction.from?.toLowerCase() || '',
      amount0: amount0,
      amount1: amount1,
      tick: event.params.tick,
      sqrtPriceX96: event.params.sqrtPriceX96,
      logIndex: BigInt(event.logIndex),
    };

    // interval data
    const [
      poolDayData,
      poolHourData,
      pool5MinuteData,
      token0DayData,
      token1DayData,
      token0HourData,
      token1HourData,
    ] = await Promise.all([
      intervalUpdates.updatePoolDayData(timestamp, pool, context),
      intervalUpdates.updatePoolHourData(timestamp, pool, context),
      intervalUpdates.updatePool5MinuteData(timestamp, pool, context),
      intervalUpdates.updateTokenDayData(timestamp, token0, context),
      intervalUpdates.updateTokenDayData(timestamp, token1, context),
      intervalUpdates.updateTokenHourData(timestamp, token0, context),
      intervalUpdates.updateTokenHourData(timestamp, token1, context),
    ]);

    // update volume metrics
    poolDayData.volume0 = poolDayData.volume0 + amount0Abs;
    poolDayData.volume1 = poolDayData.volume1 + amount1Abs;
    poolDayData.fees0 = poolDayData.fees0 + fees0;
    poolDayData.fees1 = poolDayData.fees1 + fees1;
    poolDayData.swapCount = poolDayData.swapCount + 1n;

    poolHourData.volume0 = poolHourData.volume0 + amount0Abs;
    poolHourData.volume1 = poolHourData.volume1 + amount1Abs;
    poolHourData.fees0 = poolHourData.fees0 + fees0;
    poolHourData.fees1 = poolHourData.fees1 + fees1;
    poolHourData.swapCount = poolHourData.swapCount + 1n;

    pool5MinuteData.volume0 = pool5MinuteData.volume0 + amount0Abs;
    pool5MinuteData.volume1 = pool5MinuteData.volume1 + amount1Abs;
    pool5MinuteData.fees0 = pool5MinuteData.fees0 + fees0;
    pool5MinuteData.fees1 = pool5MinuteData.fees1 + fees1;
    pool5MinuteData.swapCount = pool5MinuteData.swapCount + 1n;

    token0DayData.volume = token0DayData.volume + amount0Abs;
    token0DayData.swapCount = token0DayData.swapCount + 1n;
    token0HourData.volume = token0HourData.volume + amount0Abs;
    token0HourData.swapCount = token0HourData.swapCount + 1n;

    token1DayData.volume = token1DayData.volume + amount1Abs;
    token1DayData.swapCount = token1DayData.swapCount + 1n;
    token1HourData.volume = token1HourData.volume + amount1Abs;
    token1HourData.swapCount = token1HourData.swapCount + 1n;

    context.Swap.set(swap);
    context.TokenDayData.set(token0DayData);
    context.TokenDayData.set(token1DayData);
    context.PoolDayData.set(poolDayData);
    context.PoolHourData.set(poolHourData);
    context.Pool5MinuteData.set(pool5MinuteData);
    context.TokenHourData.set(token0HourData);
    context.TokenHourData.set(token1HourData);
    context.Pool.set(pool);
    context.Token.set(token0);
    context.Token.set(token1);
  },
  {eventFilters: {id: ALLOWED_POOL_IDS}},
);
