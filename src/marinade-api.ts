import { PublicKey, EpochSchedule, Connection, Keypair } from '@solana/web3.js';
import {
  BN,
  Marinade,
  MarinadeConfig,
} from '@marinade.finance/marinade-ts-sdk';
import { Provider, Wallet } from '@project-serum/anchor';
import { TicketAccountInfo } from './monitoring.service';

export function getMarinadeProvider(): Provider {
  const url =
    process.env.MARINADE_RPC_URL ??
    process.env.RPC_URL ??
    'https://api.devnet.solana.com';
  console.log('marinade rpc url:', url);
  const connection = new Connection(url);

  return new Provider(
    connection,
    new Wallet(Keypair.generate()),
    Provider.defaultOptions(),
  );
}

const provider = getMarinadeProvider();
const marinade = new Marinade(
  new MarinadeConfig({ connection: provider.connection }),
);

export async function getMarinadeDelayedUnstakeTickets(): Promise<
  TicketAccountInfo[]
> {
  const allDelayedUnstakedTickets = await marinade.getDelayedUnstakeTickets();

  console.log(
    `Found total ${allDelayedUnstakedTickets.size} delayed unstaked tickets on Marinade (${process.env.MARINADE_RPC_URL}).`,
  );
  const ret: TicketAccountInfo[] = Array.from(
    allDelayedUnstakedTickets,
    ([pk, val]) => {
      return {
        ticketPda: pk.toBase58(),
        stateAddress: val.stateAddress,
        beneficiary: val.beneficiary,
        lamportsAmount: val.lamportsAmount,
        createdEpoch: val.createdEpoch,
        ticketDue: val.ticketDue,
        ticketDueDate: val.ticketDueDate,
      } as TicketAccountInfo;
    },
  );
  //console.log(ret);

  return Promise.resolve(ret);
}

// (async () => {
//   const provider = await getMarinadeProvider();
//   const currentEpochInfo = await provider.connection.getEpochInfo();
//   const currentSlot = await provider.connection.getSlot();
//   const currentSlotTimestamp = await provider.connection.getBlockTime(currentSlot);
//   console.log(currentEpochInfo);
//   const epochSchedule = await provider.connection.getEpochSchedule();
//   const firstEpSlot = epochSchedule.getFirstSlotInEpoch(currentEpochInfo.epoch);
//   console.log(firstEpSlot);
//   const firstSlotTimestamp = await provider.connection.getBlockTime(firstEpSlot);
//   console.log(currentSlotTimestamp);
//   console.log(firstSlotTimestamp);
//   if (currentSlotTimestamp && firstSlotTimestamp) {
//     console.log((currentSlotTimestamp - firstSlotTimestamp));
//   }
//   // Test marinade SDK
//   //await getDelayedUnstakeTickets();
// })()
