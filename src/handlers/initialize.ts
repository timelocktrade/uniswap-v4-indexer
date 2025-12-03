import {PoolManager, handlerContext} from 'generated';
import {
  updatePoolDayData,
  updatePoolHourData,
  updatePool5MinuteData,
} from '../utils/intervalUpdates';
import {getTokenMetadataEffect} from '~/effects/getTokenMetadata';
import {ADDRESS_ZERO} from '~/utils/constants';

export const getOrCreateToken = async (
  tokenId: string,
  tokenAddress: string,
  chainId: number,
  context: handlerContext,
) => {
  let token = await context.Token.get(tokenId);

  if (!token) {
    const metadata = await context.effect(getTokenMetadataEffect, {
      address: tokenAddress,
      chainId: chainId,
    });
    token = {
      id: tokenId,
      chainId: BigInt(chainId),
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: BigInt(metadata.decimals),
      totalSupply: 0n,
      volume: 0n,
      txCount: 0n,
      poolCount: 0n,
      swapCount: 0n,
      modifyLiquidityCount: 0n,
      positionCount: 0n,
      lpCount: 0n,
      tvl: 0n,
      whitelistPools: [],
    };
    context.Token.set(token);
    console.log(`Created token: ${token.symbol} (${tokenId})`);
  }
  return token;
};

PoolManager.Initialize.handler(async ({event, context}) => {
  const poolId = `${event.chainId}_${event.params.id}`;

  console.log(`Creating new pool: ${poolId}`);

  const token0Id = `${event.chainId}_${event.params.currency0.toLowerCase()}`;
  const token1Id = `${event.chainId}_${event.params.currency1.toLowerCase()}`;

  // Get or create tokens
  const token0 = await getOrCreateToken(
    token0Id,
    event.params.currency0,
    event.chainId,
    context,
  );
  const token1 = await getOrCreateToken(
    token1Id,
    event.params.currency1,
    event.chainId,
    context,
  );

  // Update token pool counts
  const updatedToken0 = {...token0, poolCount: token0.poolCount + 1n};
  const updatedToken1 = {...token1, poolCount: token1.poolCount + 1n};
  context.Token.set(updatedToken0);
  context.Token.set(updatedToken1);

  if (event.params.hooks !== ADDRESS_ZERO) {
    // Create or update HookStats
    const hookStatsId = `${event.chainId}_${event.params.hooks}`;
    let hookStats = await context.HookStats.get(hookStatsId);

    if (!hookStats) {
      hookStats = {
        id: hookStatsId,
        chainId: BigInt(event.chainId),
        poolCount: 0n,
        swapCount: 0n,
        firstPoolCreatedAt: BigInt(event.block.timestamp),
        volume0: 0n,
        volume1: 0n,
        fees0: 0n,
        fees1: 0n,
        tvl0: 0n,
        tvl1: 0n,
      };
    }
    hookStats = {
      ...hookStats,
      poolCount: hookStats.poolCount + 1n,
    };
    context.HookStats.set(hookStats);
  }

  // Create the pool entity
  const pool = {
    id: poolId,
    chainId: BigInt(event.chainId),
    poolId: event.params.id,
    name: `${token0.symbol}/${token1.symbol}`,
    createdAtTimestamp: BigInt(event.block.timestamp),
    createdAtBlockNumber: BigInt(event.block.number),
    token0_id: token0Id,
    token1_id: token1Id,
    feeTier: BigInt(event.params.fee),
    tickSpacing: BigInt(event.params.tickSpacing),
    hooks: event.params.hooks,
    liquidity: 0n,
    sqrtPrice: event.params.sqrtPriceX96,
    sqrtPriceX96: event.params.sqrtPriceX96,
    tick: event.params.tick,
    observationIndex: 0n,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
    volume0: 0n,
    volume1: 0n,
    fees0: 0n,
    fees1: 0n,
    tvl0: 0n,
    tvl1: 0n,
    txCount: 0n,
    swapCount: 0n,
    modifyLiquidityCount: 0n,
    positionCount: 0n,
    activePositionCount: 0n,
    lpCount: 0n,
  };
  context.Pool.set(pool);

  // Initialize interval data
  await updatePoolDayData(event.block.timestamp, pool, context);
  await updatePoolHourData(event.block.timestamp, pool, context);
  await updatePool5MinuteData(event.block.timestamp, pool, context);

  console.log(
    `Initialized pool: ${token0.symbol}/${token1.symbol} at sqrtPrice ${pool.sqrtPriceX96} (tick ${pool.tick})`,
  );
});
