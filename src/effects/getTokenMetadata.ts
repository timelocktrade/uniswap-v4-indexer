import {createEffect, S} from 'envio';
import {type Address, getContract, erc20Abi, zeroAddress} from 'viem';
import {getChain, getPublicClient} from '../utils/rpc';

const getNativeTokenMetadata = (chainId: number) => {
  const chain = getChain(chainId);

  if (!chain) {
    return {name: 'Ether', symbol: 'ETH', decimals: 18};
  }
  const {name, symbol, decimals} = chain.nativeCurrency;
  return {name, symbol, decimals};
};

export const getTokenMetadataEffect = createEffect(
  {
    name: 'getTokenMetadata',
    input: {
      address: S.string,
      chainId: S.number,
    },
    output: {
      name: S.string,
      symbol: S.string,
      decimals: S.number,
    },
    rateLimit: false,
    cache: true,
  },
  async ({input}) => {
    const {address, chainId} = input;
    const normalizedAddress = address.toLowerCase();

    if (normalizedAddress === zeroAddress.toLowerCase()) {
      return getNativeTokenMetadata(chainId);
    }
    const client = getPublicClient(chainId);

    const contract = getContract({
      address: address as Address,
      abi: erc20Abi,
      client,
    });
    const [name, symbol, decimals] = await Promise.all([
      contract.read.name().catch(() => 'unknown'),
      contract.read.symbol().catch(() => 'UNKNOWN'),
      contract.read.decimals().catch(() => 0),
    ]);
    return {name, symbol, decimals};
  },
);
