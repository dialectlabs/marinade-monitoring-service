import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  Monitors,
  Pipelines,
  ResourceId,
  SourceData,
} from '@dialectlabs/monitor';
import { DialectConnection } from './dialect-connection';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Duration } from 'luxon';
import { getMarinadeDelayedUnstakeTickets, getMarinadeProvider } from './marinade-api';
import { BN } from '@project-serum/anchor';
import { time } from 'console';

const test_mode = process.env.TEST_MODE;
const testSubs: string[] = [];

export interface UserDelayedUnstakeTickets {
  subscriber: PublicKey;
  tickets: TicketAccountInfo[];
}

export interface TicketAccountInfo {
  ticketPda: string;
  stateAddress: PublicKey;
  beneficiary: PublicKey;
  lamportsAmount: BN;
  createdEpoch: BN;
}

@Injectable()
export class DelayedUnstakeMonitoringService implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly dialectConnection: DialectConnection) {}
  private readonly logger = new Logger(DelayedUnstakeMonitoringService.name);

  onModuleInit() {
    const delayedUnstakeMonitor = Monitors.builder({
      monitorKeypair: this.dialectConnection.getKeypair(),
      dialectProgram: this.dialectConnection.getProgram(),
      sinks: {
        sms: {
          twilioUsername: process.env.TWILIO_ACCOUNT_SID!,
          twilioPassword: process.env.TWILIO_AUTH_TOKEN!,
          senderSmsNumber: process.env.TWILIO_SMS_SENDER!,
        },
        email: {
          apiToken: process.env.SENDGRID_KEY!,
          senderEmail: process.env.SENDGRID_EMAIL!,
        },
        telegram: {
          telegramBotToken: process.env.TELEGRAM_TOKEN!,
        },
      },
      web2SubscriberRepositoryUrl: process.env.WEB2_SUBSCRIBER_SERVICE_BASE_URL,
    })
      .defineDataSource<UserDelayedUnstakeTickets>()
      .poll(
        async (subscribers) => this.getSubscribersDelayedUnstakeTickets(subscribers),
        Duration.fromObject({ seconds: 15 }),
      )
      .transform<TicketAccountInfo[], TicketAccountInfo[]>({
        keys: ['tickets'],
        pipelines: [
          Pipelines.added(
            (t1, t2) => t1.ticketPda === t2.ticketPda,
          ),
        ],
      })
      .notify()
      .dialectThread(({ value }) => ({
        message: this.constructDelayedUnstakeTicketsRedeemableMessage(value),
      }),
      { 
        dispatch: 'unicast', to: ({ origin }) => origin.subscriber,
      }
      )
      .telegram(
        ({ value }) => {
          const message: string = `🥩 Marinade: ` + this.constructDelayedUnstakeTicketsRedeemableMessage(value);
          return {
            body: message,
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .sms(
        ({ value }) => {
          const message: string = `🥩 Marinade: ` + this.constructDelayedUnstakeTicketsRedeemableMessage(value);
          return {
            body: message,
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .email(
        ({ value }) => {
          const message: string = this.constructDelayedUnstakeTicketsRedeemableMessage(value);
          return {
            subject: '🥩 Marinade: ✅ Delayed Unstake Ticket(s) Redeemable',
            text: message,
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .and()
      .build();
    delayedUnstakeMonitor.start();
  }

  private constructDelayedUnstakeTicketsRedeemableMessage(
    value: TicketAccountInfo[],
  ): string {
    let message = '';
    this.logger.log(`Constructing notification message for reedamable ticket:`);
    this.logger.log({ value });
    if (value.length === 1) {
      const valueInSol = 
      message = `✅ Delayed unstake ticket available to redeem for ${
        value[0].lamportsAmount.div(new BN(LAMPORTS_PER_SOL)) } SOL.`;
    } else if (value.length > 1) {
      message =
        '✅ Delayed unstake tickets available to redeem:\n';
      const tickets = value.map((info) => {
        return `Ticket for ${
          info.lamportsAmount.div(new BN(LAMPORTS_PER_SOL))} SOL.\n`;
      });
      this.logger.log({ les: tickets });
      message = message.concat(...tickets);
    }
    this.logger.log(message);
    return message;
  }

  async onModuleDestroy() {
    await Monitors.shutdown();
  }

  private async getSubscribersDelayedUnstakeTickets(
    subscribers: ResourceId[],
  ): Promise<SourceData<UserDelayedUnstakeTickets>[]> {
    this.logger.log(`Polling data for ${subscribers.length} subscriber(s)`);
    const data: Promise<SourceData<UserDelayedUnstakeTickets>>[] = [];
    const subscriberToRedeemableTicketsMap: Map<string, TicketAccountInfo[]> = new Map();
    const provider = await getMarinadeProvider();
    const currentEpoch = await provider.connection.getEpochInfo();
    this.logger.log(`Current Epoch is ${currentEpoch.epoch}:`, currentEpoch);
    // TODO confirm this logic: only poll for tickets 30 minutes after current epoch start
    //   otherwise, tickets may not yet be redeemable <link to source>
    // reference: https://docs.solana.com/developing/clients/jsonrpc-api#getblocktime
    // timestamp will be "estimated production time, as Unix timestamp (seconds since the Unix epoch)""
    const slot = await provider.connection.getSlot();
    const timestamp = await provider.connection.getBlockTime(slot);
    if (timestamp === null || timestamp < 1800)  {
      if (timestamp === null) {
        this.logger.warn("getBlockTime returns null for connection: ", provider.connection);
      }
      // if not 30+ minutes into epoch, just return early with nothing
      return Promise.resolve([]);
    }

    const allMarinadeDelayedUnstakeTickets: TicketAccountInfo[] = await getMarinadeDelayedUnstakeTickets();
    if (test_mode) {
      allMarinadeDelayedUnstakeTickets.forEach((ticket) => {
        if (testSubs.findIndex((it) => it === ticket.beneficiary.toBase58()) != -1 ) {
          console.log("Winding back time.", ticket);
          ticket.createdEpoch = ticket.createdEpoch.sub(new BN(1));
        }
      });
    }

    // only consider subscriber's tickets that have a created epoch of this epoch minus 1 or 2
    const allSubscribersRedeemableTickets = allMarinadeDelayedUnstakeTickets.filter((ticket) => {
      const exists = subscribers.find((sub) => sub.equals(ticket.beneficiary) &&
      ((currentEpoch.epoch - ticket.createdEpoch.toNumber()) === 1 || (currentEpoch.epoch - ticket.createdEpoch.toNumber()) === 2)
      );
      return (exists);
    }
   );

    this.logger.log(
      `Found ${allSubscribersRedeemableTickets.length} redeemable delayed unstake tickets pertaining to subscribers.`,
    );
    //this.logger.log(subscribersRedeemableTickets);
    console.log(allSubscribersRedeemableTickets);

    // aggregate tickets by subscriber
    allSubscribersRedeemableTickets.map((ticket) => {
      let tryFindTicket = subscriberToRedeemableTicketsMap.get(
        ticket.beneficiary.toBase58(),
      );
      if (!tryFindTicket) {
        tryFindTicket = [ticket];
      } else {
        tryFindTicket.push(ticket);
      }
      subscriberToRedeemableTicketsMap.set(
        ticket.beneficiary.toBase58(),
        tryFindTicket,
      );
    });
    console.log(subscriberToRedeemableTicketsMap);

    subscribers.forEach((it: ResourceId) => {
      console.log(it.toBase58());
      if (!subscriberToRedeemableTicketsMap.has(it.toBase58())) {
        subscriberToRedeemableTicketsMap.set(it.toBase58(), []);
      }
    });

    this.logger.log("Map of subscriber's to their redeemable delayed unstake tickets:\n");
    console.log(subscriberToRedeemableTicketsMap);

    subscriberToRedeemableTicketsMap.forEach((tickets, beneficiary) => {
      const beneficiaryPk = new PublicKey(beneficiary);
      const sourceData: SourceData<UserDelayedUnstakeTickets> = {
        groupingKey: beneficiaryPk.toBase58(),
        data: {
          subscriber: beneficiaryPk,
          tickets: tickets,
        },
      };
      data.push(Promise.resolve(sourceData));
    });

    this.logger.log(
      `Polling complete. Found ${data.length} subscriber(s) with redeemable delayed unstake tickets(s)`,
    );
    return await Promise.all(data);
  }
}
