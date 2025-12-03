import * as dotenv from 'dotenv';
import {createPublicClient, http} from 'viem';
import * as chains from 'viem/chains';
dotenv.config();

export const getChain = (chainId: number) => {
  return Object.values(chains).find(chain => chain.id === chainId);
};

export const getRpcUrl = (chainId: number) => {
  const envRpcUrl = process.env[`RPC_URL_${chainId}`];

  if (envRpcUrl) return envRpcUrl;

  const chain = getChain(chainId);
  return chain?.rpcUrls?.default?.http?.[0];
};

export const getPublicClient = (chainId: number) => {
  const rpcUrl = getRpcUrl(chainId);
  const chain = getChain(chainId);

  return createPublicClient({chain, transport: http(rpcUrl)});
};
