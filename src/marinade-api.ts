import { PublicKey, EpochSchedule, Connection, Keypair } from '@solana/web3.js';
import { BN, Marinade, MarinadeConfig } from '@marinade.finance/marinade-ts-sdk'
import * as Axios from 'axios';
import { Provider, Wallet } from '@project-serum/anchor';
import { ResourceId } from '@dialectlabs/monitor';
import { TicketAccountInfo } from './monitoring.service';

export async function getMarinadeProvider(): Promise<Provider> {
  const url = process.env.MARINADE_RPC_URL ?? process.env.RPC_URL ?? 'https://api.devnet.solana.com';
  console.log('marinade rpc url:', url);
  const connection = new Connection(
    url,
    Provider.defaultOptions(),
  );
  
  return new Provider(
    connection,
    new Wallet(Keypair.generate()),
    Provider.defaultOptions(),
  );
}

export async function getMarinadeDelayedUnstakeTickets(): Promise<TicketAccountInfo[]> {
  const provider = await getMarinadeProvider();
  const marinade = new Marinade(new MarinadeConfig({ connection: provider.connection}));
  const allDelayedUnstakedTickets = await marinade.getDelayedUnstakeTickets();
  //console.log(allDelayedUnstakedTickets);
  console.log(`Found total ${allDelayedUnstakedTickets.size} delayed unstaked tickets on Marinade (${process.env.MARINADE_RPC_URL}).`);
  const ret: TicketAccountInfo[] = Array.from(allDelayedUnstakedTickets, ([pk, val]) => {
    return {
      ticketPda: pk.toBase58(),
      stateAddress: val.stateAddress,
      beneficiary: val.beneficiary,
      lamportsAmount: val.lamportsAmount,
      createdEpoch: val.createdEpoch,
    } as TicketAccountInfo;
  });
  //console.log(ret);

  return Promise.resolve(ret);
}

// (async () => {
//   // Test marinade SDK
//   await getDelayedUnstakeTickets();
// })()
