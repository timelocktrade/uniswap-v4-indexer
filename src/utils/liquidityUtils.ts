import {TickMath, SqrtPriceMath} from '@uniswap/v3-sdk';
import JSBI from 'jsbi';

// Helper function to calculate fee growth inside a position's tick range
export const getFeeGrowthInside = (
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
export const calculateAccruedFees = (
  liquidity: bigint,
  feeGrowthInside: bigint,
  feeGrowthInsideLast: bigint,
): bigint => {
  return (liquidity * (feeGrowthInside - feeGrowthInsideLast)) / 2n ** 128n;
};

// Helper function to calculate token amounts from liquidity delta
export const calculateTokenAmounts = (
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
