import {
  PoolManager_Donate_event,
  PoolManager_ModifyLiquidity_event,
  PoolManager_Swap_event,
} from 'generated';
import {handlerContext, Transaction} from 'generated';

export const getOrCreateTransaction = async (
  event:
    | PoolManager_Donate_event
    | PoolManager_ModifyLiquidity_event
    | PoolManager_Swap_event,
  context: handlerContext,
): Promise<Transaction> => {
  const txHash = event.transaction.hash;
  const blockNumber = BigInt(event.block.number);
  const timestamp = BigInt(event.block.timestamp);
  const gasPrice = 0n; // gasPrice not available in event.transaction
  const chainId = event.chainId;

  const txId = `${chainId}_${txHash}`;
  const txRO = await context.Transaction.get(txId);
  const transaction = txRO
    ? {...txRO}
    : {
        id: txId,
        chainId: BigInt(chainId),
        blockNumber: 0n,
        timestamp: 0n,
        gasUsed: 0n,
        gasPrice: 0n,
      };

  transaction.blockNumber = blockNumber;
  transaction.timestamp = timestamp;
  transaction.gasUsed = 0n;
  transaction.gasPrice = gasPrice;

  context.Transaction.set(transaction);
  return transaction as Transaction;
};
