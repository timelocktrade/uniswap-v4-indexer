import {TickMath, SqrtPriceMath, Position} from '@uniswap/v3-sdk';
import JSBI from 'jsbi';
import {PoolManager, PoolManager_ModifyLiquidity_event} from 'generated';
import {handlerContext, LiquidityProvider} from 'generated';
import * as intervalUpdates from '~/utils/intervalUpdates';
import {getOrCreateTransaction} from '~/utils/transaction';

// Helper function to calculate fee growth inside a position's tick range
const getFeeGrowthInside = (
  feeGrowthGlobal: bigint,
  feeGrowthOutsideLower: bigint,
  feeGrowthOutsideUpper: bigint,
  tickLower: bigint,
  tickUpper: bigint,
  currentTick: bigint,
): bigint => {
  let feeGrowthBelow: bigint;
  let feeGrowthAbove: bigint;

  // Calculate fee growth below the lower tick
  if (currentTick >= tickLower) {
    feeGrowthBelow = feeGrowthOutsideLower;
  } else {
    feeGrowthBelow = feeGrowthGlobal - feeGrowthOutsideLower;
  }

  // Calculate fee growth above the upper tick
  if (currentTick < tickUpper) {
    feeGrowthAbove = feeGrowthOutsideUpper;
  } else {
    feeGrowthAbove = feeGrowthGlobal - feeGrowthOutsideUpper;
  }

  // Fee growth inside is global minus outside
  return feeGrowthGlobal - feeGrowthBelow - feeGrowthAbove;
};

// Helper function to calculate accrued fees (uncollected fees)
const calculateAccruedFees = (
  liquidity: bigint,
  feeGrowthInside: bigint,
  feeGrowthInsideLast: bigint,
): bigint => {
  return (liquidity * (feeGrowthInside - feeGrowthInsideLast)) / 2n ** 128n;
};

// Helper function to calculate token amounts from liquidity delta
const calculateTokenAmounts = (
  liquidityDelta: bigint,
  tickLower: bigint,
  tickUpper: bigint,
  sqrtPriceX96: bigint,
): {
  amount0: bigint;
  amount1: bigint;
  amount0Abs: bigint;
  amount1Abs: bigint;
} => {
  const isAddingLiquidity = liquidityDelta > 0n;
  const liquidityAbs = liquidityDelta < 0n ? -liquidityDelta : liquidityDelta;

  // Calculate sqrt prices at tick boundaries
  const sqrtPriceLowerX96 = BigInt(
    TickMath.getSqrtRatioAtTick(Number(tickLower)).toString(),
  );
  const sqrtPriceUpperX96 = BigInt(
    TickMath.getSqrtRatioAtTick(Number(tickUpper)).toString(),
  );

  // Convert bigints to JSBI for SDK compatibility
  const sqrtRatioX96JSBI = JSBI.BigInt(sqrtPriceX96.toString());
  const sqrtRatioAX96JSBI = JSBI.BigInt(sqrtPriceLowerX96.toString());
  const sqrtRatioBX96JSBI = JSBI.BigInt(sqrtPriceUpperX96.toString());
  const liquidityJSBI = JSBI.BigInt(liquidityAbs.toString());

  // Calculate amounts using Position.getAmount0Delta and getAmount1Delta
  let amount0Calculated: bigint;
  let amount1Calculated: bigint;

  if (JSBI.lessThanOrEqual(sqrtRatioX96JSBI, sqrtRatioAX96JSBI)) {
    // Current price is below the position range - only token0
    amount0Calculated = BigInt(
      SqrtPriceMath.getAmount0Delta(
        sqrtRatioAX96JSBI,
        sqrtRatioBX96JSBI,
        liquidityJSBI,
        false,
      ).toString(),
    );
    amount1Calculated = 0n;
  } else if (JSBI.greaterThanOrEqual(sqrtRatioX96JSBI, sqrtRatioBX96JSBI)) {
    // Current price is above the position range - only token1
    amount0Calculated = 0n;
    amount1Calculated = BigInt(
      SqrtPriceMath.getAmount1Delta(
        sqrtRatioAX96JSBI,
        sqrtRatioBX96JSBI,
        liquidityJSBI,
        false,
      ).toString(),
    );
  } else {
    // Current price is within the position range - both tokens
    amount0Calculated = BigInt(
      SqrtPriceMath.getAmount0Delta(
        sqrtRatioX96JSBI,
        sqrtRatioBX96JSBI,
        liquidityJSBI,
        false,
      ).toString(),
    );
    amount1Calculated = BigInt(
      SqrtPriceMath.getAmount1Delta(
        sqrtRatioAX96JSBI,
        sqrtRatioX96JSBI,
        liquidityJSBI,
        false,
      ).toString(),
    );
  }

  // If removing liquidity, amounts are negative
  const amount0 = isAddingLiquidity ? amount0Calculated : -amount0Calculated;
  const amount1 = isAddingLiquidity ? amount1Calculated : -amount1Calculated;

  return {
    amount0,
    amount1,
    amount0Abs: amount0Calculated,
    amount1Abs: amount1Calculated,
  };
};

const getOrCreateLiquidityProvider = async (
  poolId: string,
  event: PoolManager_ModifyLiquidity_event,
  context: handlerContext,
): Promise<LiquidityProvider> => {
  const chainId = event.chainId;
  const address = event.params.sender;
  const timestamp = BigInt(event.block.timestamp);
  const blockNumber = BigInt(event.block.number);

  const lpId = `${chainId}_${poolId}-${address.toLowerCase()}`;
  const lpRO = await context.LiquidityProvider.get(lpId);

  if (lpRO) return {...lpRO};

  const newLP: LiquidityProvider = {
    id: lpId,
    chainId: BigInt(chainId),
    address: address.toLowerCase(),
    deposited0: 0n,
    deposited1: 0n,
    withdrawn0: 0n,
    withdrawn1: 0n,
    fees0: 0n,
    fees1: 0n,
    positionCount: 0n,
    modifyLiquidityCount: 0n,
    createdAtTimestamp: timestamp,
    createdAtBlockNumber: blockNumber,
  };
  context.LiquidityProvider.set(newLP);
  return newLP;
};

PoolManager.ModifyLiquidity.handler(async ({event, context}) => {
  const poolId = `${event.chainId}_${event.params.id}`;
  const poolRO = await context.Pool.get(poolId);
  if (!poolRO) return;

  const lowerTickId = `${poolId}#${event.params.tickLower}`;
  const upperTickId = `${poolId}#${event.params.tickUpper}`;
  const positionId = `${poolId}#${event.params.sender.toLowerCase()}#${event.params.tickLower}#${event.params.tickUpper}`;

  const [
    token0RO,
    token1RO,
    lowerTickRO,
    upperTickRO,
    positionRO,
    liquidityProviderRO,
  ] = await Promise.all([
    context.Token.get(poolRO.token0_id),
    context.Token.get(poolRO.token1_id),
    context.Tick.get(lowerTickId),
    context.Tick.get(upperTickId),
    context.Position.get(positionId),
    getOrCreateLiquidityProvider(poolId, event, context),
  ]);

  if (!token0RO || !token1RO) return;

  // Create mutable copies of the entities
  const token0 = {...token0RO};
  const token1 = {...token1RO};
  const pool = {...poolRO};
  const liquidityProvider = {...liquidityProviderRO};
  const timestamp = event.block.timestamp;

  const liquidityDelta = event.params.liquidityDelta;
  const isAddingLiquidity = liquidityDelta > 0n;

  // Calculate amount0 and amount1 from liquidityDelta and price range
  const {amount0, amount1, amount0Abs, amount1Abs} = calculateTokenAmounts(
    liquidityDelta,
    event.params.tickLower,
    event.params.tickUpper,
    pool.sqrtPriceX96,
  );

  // update token data
  token0.txCount = token0.txCount + 1n;
  token0.modifyLiquidityCount = token0.modifyLiquidityCount + 1n;

  token1.txCount = token1.txCount + 1n;
  token1.modifyLiquidityCount = token1.modifyLiquidityCount + 1n;

  // pool data
  pool.txCount = pool.txCount + 1n;
  pool.modifyLiquidityCount = pool.modifyLiquidityCount + 1n;

  // Update pool TVL based on token amounts
  pool.tvl0 = pool.tvl0 + amount0;
  pool.tvl1 = pool.tvl1 + amount1;

  // Pools liquidity tracks the currently active liquidity given pools current tick.
  // We only want to update it if the position includes the current tick.
  if (
    event.params.tickLower <= pool.tick &&
    event.params.tickUpper > pool.tick
  ) {
    pool.liquidity = pool.liquidity + liquidityDelta;
  }

  const transaction = await getOrCreateTransaction(event, context);

  const modifyLiquidity = {
    id: `${transaction.id}-${event.logIndex}`,
    chainId: BigInt(event.chainId),
    transaction_id: transaction.id,
    timestamp: BigInt(timestamp),
    pool_id: pool.id,
    token0_id: poolRO.token0_id,
    token1_id: poolRO.token1_id,
    sender: event.params.sender,
    origin: event.transaction.from?.toLowerCase() || '',
    amount: liquidityDelta,
    amount0: amount0,
    amount1: amount1,
    tickLower: event.params.tickLower,
    tickUpper: event.params.tickUpper,
    logIndex: BigInt(event.logIndex),
  };

  // tick entities
  const lowerTickIdx = event.params.tickLower;
  const upperTickIdx = event.params.tickUpper;
  const ltId = `${pool.id}#${lowerTickIdx}`;
  const utId = `${pool.id}#${upperTickIdx}`;

  const lowerTick = lowerTickRO
    ? {...lowerTickRO}
    : createTick(
        ltId,
        lowerTickIdx,
        pool.id,
        pool.poolId,
        pool.chainId,
        BigInt(timestamp),
        BigInt(event.block.number),
      );

  const upperTick = upperTickRO
    ? {...upperTickRO}
    : createTick(
        utId,
        upperTickIdx,
        pool.id,
        pool.poolId,
        pool.chainId,
        BigInt(timestamp),
        BigInt(event.block.number),
      );

  lowerTick.liquidityGross = lowerTick.liquidityGross + liquidityDelta;
  lowerTick.liquidityNet = lowerTick.liquidityNet + liquidityDelta;
  upperTick.liquidityGross = upperTick.liquidityGross + liquidityDelta;
  upperTick.liquidityNet = upperTick.liquidityNet - liquidityDelta;

  // Increment tick position count if this is a new position
  if (!positionRO && isAddingLiquidity) {
    lowerTick.positionCount = lowerTick.positionCount + 1n;
    upperTick.positionCount = upperTick.positionCount + 1n;
  }

  context.Tick.set(lowerTick);
  context.Tick.set(upperTick);

  // Calculate fee growth inside position range
  const feeGrowthInside0X128 = getFeeGrowthInside(
    pool.feeGrowthGlobal0X128,
    lowerTick.feeGrowthOutside0X128,
    upperTick.feeGrowthOutside0X128,
    event.params.tickLower,
    event.params.tickUpper,
    pool.tick ?? 0n,
  );

  const feeGrowthInside1X128 = getFeeGrowthInside(
    pool.feeGrowthGlobal1X128,
    lowerTick.feeGrowthOutside1X128,
    upperTick.feeGrowthOutside1X128,
    event.params.tickLower,
    event.params.tickUpper,
    pool.tick ?? 0n,
  );

  // position entity
  const position = positionRO
    ? {...positionRO}
    : createPosition(
        positionId,
        event.params.sender,
        pool.id,
        poolRO.token0_id,
        poolRO.token1_id,
        event.params.tickLower,
        event.params.tickUpper,
        transaction.id,
        BigInt(timestamp),
        BigInt(event.block.number),
        liquidityProvider.id,
        pool.chainId,
      );

  // Calculate accrued fees if position already exists
  if (positionRO && positionRO.liquidity > 0n) {
    const accruedFees0 = calculateAccruedFees(
      positionRO.liquidity,
      feeGrowthInside0X128,
      positionRO.feeGrowthInside0LastX128,
    );
    const accruedFees1 = calculateAccruedFees(
      positionRO.liquidity,
      feeGrowthInside1X128,
      positionRO.feeGrowthInside1LastX128,
    );

    // Add accrued fees to fees tracking
    position.fees0 = position.fees0 + accruedFees0;
    position.fees1 = position.fees1 + accruedFees1;

    // Update LP fees
    liquidityProvider.fees0 = liquidityProvider.fees0 + accruedFees0;
    liquidityProvider.fees1 = liquidityProvider.fees1 + accruedFees1;
  }

  position.liquidity = position.liquidity + liquidityDelta;
  position.feeGrowthInside0LastX128 = feeGrowthInside0X128;
  position.feeGrowthInside1LastX128 = feeGrowthInside1X128;
  position.modifyLiquidityCount = position.modifyLiquidityCount + 1n;

  // Update position deposited/withdrawn amounts
  if (isAddingLiquidity) {
    position.deposited0 = position.deposited0 + amount0Abs;
    position.deposited1 = position.deposited1 + amount1Abs;
  } else {
    position.withdrawn0 = position.withdrawn0 + amount0Abs;
    position.withdrawn1 = position.withdrawn1 + amount1Abs;
  }

  // Update liquidity provider deposited/withdrawn amounts
  if (isAddingLiquidity) {
    liquidityProvider.deposited0 = liquidityProvider.deposited0 + amount0Abs;
    liquidityProvider.deposited1 = liquidityProvider.deposited1 + amount1Abs;
  } else {
    liquidityProvider.withdrawn0 = liquidityProvider.withdrawn0 + amount0Abs;
    liquidityProvider.withdrawn1 = liquidityProvider.withdrawn1 + amount1Abs;
  }

  // Update LiquidityProvider stats
  liquidityProvider.modifyLiquidityCount =
    liquidityProvider.modifyLiquidityCount + 1n;

  // Increment pool and token position counts if this is a new position
  if (!positionRO) {
    liquidityProvider.positionCount = liquidityProvider.positionCount + 1n;
    pool.positionCount = pool.positionCount + 1n;
    token0.positionCount = token0.positionCount + 1n;
    token1.positionCount = token1.positionCount + 1n;
  }

  // Update active position count
  if (position.liquidity > 0n && (!positionRO || positionRO.liquidity === 0n)) {
    pool.activePositionCount = pool.activePositionCount + 1n;
  } else if (
    position.liquidity === 0n &&
    positionRO &&
    positionRO.liquidity > 0n
  ) {
    pool.activePositionCount = pool.activePositionCount - 1n;
  }

  context.Position.set(position);
  context.LiquidityProvider.set(liquidityProvider);

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

  // Update modify liquidity counts for interval data
  poolDayData.modifyLiquidityCount = poolDayData.modifyLiquidityCount + 1n;
  poolHourData.modifyLiquidityCount = poolHourData.modifyLiquidityCount + 1n;
  pool5MinuteData.modifyLiquidityCount =
    pool5MinuteData.modifyLiquidityCount + 1n;
  token0DayData.modifyLiquidityCount = token0DayData.modifyLiquidityCount + 1n;
  token1DayData.modifyLiquidityCount = token1DayData.modifyLiquidityCount + 1n;
  token0HourData.modifyLiquidityCount =
    token0HourData.modifyLiquidityCount + 1n;
  token1HourData.modifyLiquidityCount =
    token1HourData.modifyLiquidityCount + 1n;

  context.PoolDayData.set(poolDayData);
  context.PoolHourData.set(poolHourData);
  context.Pool5MinuteData.set(pool5MinuteData);
  context.TokenDayData.set(token0DayData);
  context.TokenDayData.set(token1DayData);
  context.TokenHourData.set(token0HourData);
  context.TokenHourData.set(token1HourData);
  context.Token.set(token0);
  context.Token.set(token1);
  context.Pool.set(pool);
  context.ModifyLiquidity.set(modifyLiquidity);
});

const createTick = (
  tickId: string,
  tickIdx: bigint,
  poolId: string,
  poolIdString: string,
  chainId: bigint,
  timestamp: bigint,
  blockNumber: bigint,
) => ({
  id: tickId,
  chainId: chainId,
  poolId: poolIdString,
  tickIdx: tickIdx,
  pool_id: poolId,
  liquidityGross: 0n,
  liquidityNet: 0n,
  price0: 0n,
  price1: 0n,
  feeGrowthOutside0X128: 0n,
  feeGrowthOutside1X128: 0n,
  positionCount: 0n,
  createdAtTimestamp: timestamp,
  createdAtBlockNumber: blockNumber,
});

const createPosition = (
  positionId: string,
  owner: string,
  poolId: string,
  token0Id: string,
  token1Id: string,
  tickLower: bigint,
  tickUpper: bigint,
  transactionId: string,
  timestamp: bigint,
  blockNumber: bigint,
  liquidityProviderId: string,
  chainId: bigint,
) => ({
  id: positionId,
  chainId: chainId,
  owner: owner.toLowerCase(),
  liquidityProvider_id: liquidityProviderId,
  pool_id: poolId,
  token0_id: token0Id,
  token1_id: token1Id,
  tickLower: tickLower,
  tickUpper: tickUpper,
  liquidity: 0n,
  deposited0: 0n,
  deposited1: 0n,
  withdrawn0: 0n,
  withdrawn1: 0n,
  fees0: 0n,
  fees1: 0n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  modifyLiquidityCount: 0n,
  transaction_id: transactionId,
  createdAtTimestamp: timestamp,
  createdAtBlockNumber: blockNumber,
});
