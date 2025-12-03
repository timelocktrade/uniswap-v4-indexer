import {PoolManager} from 'generated';
import * as intervalUpdates from '~/utils/intervalUpdates';
import {ADDRESS_ZERO} from '~/utils/constants';
import {getOrCreateTransaction} from '~/utils/transaction';

PoolManager.Donate.handler(async ({event, context}) => {
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

  const amount0 = event.params.amount0;
  const amount1 = event.params.amount1;

  // Update pool TVL with donated amounts
  pool.tvl0 = pool.tvl0 + amount0;
  pool.tvl1 = pool.tvl1 + amount1;
  pool.txCount = pool.txCount + 1n;

  // Donations increase the pool's reserves which effectively increases fees for LPs
  // Update fee growth global to reflect the donation
  if (pool.liquidity > 0n) {
    const Q128 = 2n ** 128n;
    pool.feeGrowthGlobal0X128 =
      pool.feeGrowthGlobal0X128 + (amount0 * Q128) / pool.liquidity;
    pool.feeGrowthGlobal1X128 =
      pool.feeGrowthGlobal1X128 + (amount1 * Q128) / pool.liquidity;
    pool.fees0 = pool.fees0 + amount0;
    pool.fees1 = pool.fees1 + amount1;
  }

  // Update token TVL
  token0.tvl = token0.tvl + amount0;
  token0.txCount = token0.txCount + 1n;

  token1.tvl = token1.tvl + amount1;
  token1.txCount = token1.txCount + 1n;

  if (pool.hooks !== ADDRESS_ZERO) {
    const hookStatsId = `${event.chainId}_${pool.hooks}`;
    const hookStatsRO = await context.HookStats.get(hookStatsId);

    if (hookStatsRO) {
      const hookStats = {...hookStatsRO};
      hookStats.fees0 = hookStats.fees0 + amount0;
      hookStats.fees1 = hookStats.fees1 + amount1;
      hookStats.tvl0 = hookStats.tvl0 + amount0;
      hookStats.tvl1 = hookStats.tvl1 + amount1;
      context.HookStats.set(hookStats);
    }
  }

  // Create transaction record
  await getOrCreateTransaction(event, context);

  // Update interval data
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

  // Update fee metrics in interval data
  poolDayData.fees0 = poolDayData.fees0 + amount0;
  poolDayData.fees1 = poolDayData.fees1 + amount1;

  poolHourData.fees0 = poolHourData.fees0 + amount0;
  poolHourData.fees1 = poolHourData.fees1 + amount1;

  pool5MinuteData.fees0 = pool5MinuteData.fees0 + amount0;
  pool5MinuteData.fees1 = pool5MinuteData.fees1 + amount1;

  context.PoolDayData.set(poolDayData);
  context.PoolHourData.set(poolHourData);
  context.Pool5MinuteData.set(pool5MinuteData);
  context.TokenDayData.set(token0DayData);
  context.TokenDayData.set(token1DayData);
  context.TokenHourData.set(token0HourData);
  context.TokenHourData.set(token1HourData);
  context.Pool.set(pool);
  context.Token.set(token0);
  context.Token.set(token1);

  console.log(
    `Donation to pool ${poolId}: ${amount0} token0, ${amount1} token1`,
  );
});
