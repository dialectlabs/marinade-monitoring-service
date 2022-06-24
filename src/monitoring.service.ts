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
import { PublicKey } from '@solana/web3.js';
import { Duration } from 'luxon';
import { getMarinadeDelayedUnstakeTickets } from './marinade-api';
import { BN } from '@project-serum/anchor';
import { format5Dec, LamportsToSol } from './utils';
import JSBI from 'jsbi';

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
  ticketDue: Boolean;
  ticketDueDate: Date;
}

const mockedTest = [
  {
    ticketPda: '888877zGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC',
    stateAddress: new PublicKey('8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC'),
    beneficiary: new PublicKey('DQQq7G4vvuVkSoLzqsrEUqbqC62fjY726BGNA7L6zKRh'),
    lamportsAmount: new BN(0),
    createdEpoch: new BN(0),
    ticketDue: true,
    ticketDueDate: new Date('2022-06-23T11:53:54.101Z'),
  },
  {
    ticketPda: '97777zGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC',
    stateAddress: new PublicKey('8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC'),
    beneficiary: new PublicKey('DQQq7G4vvuVkSoLzqsrEUqbqC62fjY726BGNA7L6zKRh'),
    lamportsAmount: new BN(0),
    createdEpoch: new BN(0),
    ticketDue: true,
    ticketDueDate: new Date('2022-06-23T11:53:54.101Z'),
  },
];

@Injectable()
export class DelayedUnstakeMonitoringService
  implements OnModuleInit, OnModuleDestroy
{
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
        async (subscribers) =>
          this.getSubscribersDelayedUnstakeTickets(subscribers),
        Duration.fromObject({ seconds: 3600 }),
      )
      .transform<TicketAccountInfo[], TicketAccountInfo[]>({
        keys: ['tickets'],
        pipelines: [Pipelines.added((t1, t2) => t1.ticketPda === t2.ticketPda)],
      })
      .notify()
      .dialectThread(
        ({ value }) => ({
          message: this.constructDelayedUnstakeTicketsRedeemableMessage(value),
        }),
        {
          dispatch: 'unicast',
          to: ({ origin }) => {
            console.log(origin);
            return origin.subscriber;
          },
        },
      )
      .telegram(
        ({ value }) => {
          const message: string =
            `🥩 Marinade: ` +
            this.constructDelayedUnstakeTicketsRedeemableMessage(value);
          return {
            body: message,
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .sms(
        ({ value }) => {
          const message: string =
            `🥩 Marinade: ` +
            this.constructDelayedUnstakeTicketsRedeemableMessage(value);
          return {
            body: message,
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .email(
        ({ value }) => {
          const message: string =
            this.constructDelayedUnstakeTicketsRedeemableMessage(value);
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
      const amount = format5Dec(
        LamportsToSol(JSBI.BigInt(value[0].lamportsAmount.toString())),
      );
      message = `✅ Delayed unstake ticket available to redeem for ${amount} SOL.`;
    } else if (value.length > 1) {
      message = '✅ Delayed unstake tickets available to redeem:\n';

      const tickets = value.map((info) => {
        const amount = format5Dec(
          LamportsToSol(JSBI.BigInt(info.lamportsAmount.toString())),
        );
        return `Ticket for ${amount} SOL.\n`;
      });
      this.logger.log({ les: tickets });
      message = message.concat(...tickets);
    }
    return message;
  }

  async onModuleDestroy() {
    await Monitors.shutdown();
  }

  private async getSubscribersDelayedUnstakeTickets(
    subscribers: ResourceId[],
  ): Promise<SourceData<UserDelayedUnstakeTickets>[]> {
    this.logger.log(`Polling data for ${subscribers.length} subscriber(s)`);
    const data: SourceData<UserDelayedUnstakeTickets>[] = [];

    const allDelayedUnstakedTickets = await getMarinadeDelayedUnstakeTickets();

    const allDelayedUnstakedTicket = allDelayedUnstakedTickets
      .filter((ticket) => ticket.ticketDue)
      .reduce((owners, ticket) => {
        const ownerPK = ticket.beneficiary.toBase58();
        return {
          ...owners,
          [ownerPK]: [...(owners[ownerPK] || []), ticket],
        };
      }, {} as any);

    subscribers.forEach((subscriber) => {
      const sourceData: SourceData<UserDelayedUnstakeTickets> = {
        groupingKey: subscriber.toBase58(),
        data: {
          subscriber: subscriber,
          tickets:
            allDelayedUnstakedTicket[subscriber.toBase58()] ||
            process.env.TEST_MODE
              ? mockedTest.slice(0, Math.round(Math.random() * Math.max(0, 2)))
              : [],
        },
      };
      data.push(sourceData);
    });

    this.logger.log({ data });
    return data;
  }
}
