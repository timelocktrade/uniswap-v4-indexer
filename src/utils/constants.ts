import {BigDecimal} from 'generated';

// Note: BigInt is a native type in TypeScript/JavaScript
// so we don't need to import it specifically for Envio

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';

// Re-export functions from @uniswap/v3-sdk for use in handlers
export {
  TickMath,
  SqrtPriceMath,
  LiquidityMath,
  Position,
} from '@uniswap/v3-sdk';
