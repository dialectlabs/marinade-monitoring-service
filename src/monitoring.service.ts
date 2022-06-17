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
import {
  getMarinadeDelayedUnstakeTickets,
  getMarinadeProvider,
} from './marinade-api';
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
  ticketDue: Boolean;
  ticketDueDate: Date;
}

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
        Duration.fromObject({ seconds: 60 }),
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
          to: ({ origin }) => origin.subscriber,
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
      const valueInSol =
        (message = `✅ Delayed unstake ticket available to redeem for ${value[0].lamportsAmount.div(
          new BN(LAMPORTS_PER_SOL),
        )} SOL.`);
    } else if (value.length > 1) {
      message = '✅ Delayed unstake tickets available to redeem:\n';
      const tickets = value.map((info) => {
        return `Ticket for ${info.lamportsAmount.div(
          new BN(LAMPORTS_PER_SOL),
        )} SOL.\n`;
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
    const subscriberToRedeemableTicketsMap: Map<string, TicketAccountInfo[]> =
      new Map();
    const provider = await getMarinadeProvider();
    const currentEpochInfo = await provider.connection.getEpochInfo();
    this.logger.log(
      `Current Epoch is ${currentEpochInfo.epoch}:`,
      currentEpochInfo,
    );
    const currentSlot = await provider.connection.getSlot();
    this.logger.log(`Current slot in current epoch: ${currentSlot}`);
    const epochSchedule = await provider.connection.getEpochSchedule();
    const firstSlotInCurrEpoch = epochSchedule.getFirstSlotInEpoch(
      currentEpochInfo.epoch,
    );
    this.logger.log(`First slot in current epoch: ${firstSlotInCurrEpoch}`);
    const elapsedSlotsInCurrentEpoch = currentSlot - firstSlotInCurrEpoch;
    const THEORETICAL_SLOT_DURATION_MS = 400; // 400ms theoretical slot time
    const WAIT_TIME_IN_MS = 17100000; // 4.75 hours into epoch when bot wait time required
    const THEORETICAL_SLOTS_TO_WAIT =
      WAIT_TIME_IN_MS / THEORETICAL_SLOT_DURATION_MS;
    const MINIMUM_EPOCHS_FOR_TICKET_REDEMPTION = 1;

    // Now, we will get all delayed unstake tickets returned by Marinade API.
    //   This API returns any ticket created for any Marinade user (regardless if it is ready to redeem or not).
    //   In the code below, we will filter these tickets for ONLY tickets that are redeemable, and then we
    //   will group them for each subscriber. The array-diff type pipeline will then only track subscriber's
    //   tickets that are new-AND-redeemable.
    //Note: Delayed unstake tickets are redeemable when epoch has increased by 1, and we are atleast 4.75 hours
    //   into that next epoch (or anytime during an epoch increased by 2 or more)

    const allMarinadeDelayedUnstakeTickets: TicketAccountInfo[] =
      await getMarinadeDelayedUnstakeTickets();

    if (test_mode) {
      allMarinadeDelayedUnstakeTickets.forEach((ticket) => {
        if (
          testSubs.findIndex((it) => it === ticket.beneficiary.toBase58()) != -1
        ) {
          console.log('Winding back time.', ticket);
          ticket.createdEpoch = ticket.createdEpoch.sub(new BN(1));
        }
      });
    }

    /***
     *  MARK:: This code needed anymore, all of this calculation was moved to SDK.
     *  Left just in case
     *  */

    // Only monitor subscriber's tickets that have a created epoch of current epoch + 1 or greater.
    //   if the created epoch is precisely current epoch + 1, we also need to be sure we are atleast
    //   4.75 hours into the current epoch

    //   const allSubscribersRedeemableTickets = allMarinadeDelayedUnstakeTickets.filter((ticket) => {
    //     let shouldMonitorTicket = false;
    //     const isSubscribersTicket = subscribers.find((sub) => sub.equals(ticket.beneficiary));
    //     if (isSubscribersTicket) {
    //       this.logger.log(`Discovered ticket ${ticket.ticketPda} for subscriber ${ticket.beneficiary.toBase58()}.`);
    //       this.logger.log(`Checking whether it is redeemable or not:`);
    //       const totalEpochsElapsedSinceTicketCreated = currentEpochInfo.epoch - ticket.createdEpoch.toNumber();
    //       this.logger.log(`totalEpochsElapsedSinceTicketCreated: ${totalEpochsElapsedSinceTicketCreated}`);
    //       this.logger.log(`MINIMUM_EPOCHS_FOR_TICKET_REDEMPTION: ${MINIMUM_EPOCHS_FOR_TICKET_REDEMPTION}`);
    //       this.logger.log(`elapsedSlotsInCurrentEpoch: ${elapsedSlotsInCurrentEpoch}`);
    //       this.logger.log(`THEORETICAL_SLOTS_TO_WAIT: ${THEORETICAL_SLOTS_TO_WAIT}`);
    //       shouldMonitorTicket = (totalEpochsElapsedSinceTicketCreated > MINIMUM_EPOCHS_FOR_TICKET_REDEMPTION ||
    //          (totalEpochsElapsedSinceTicketCreated === MINIMUM_EPOCHS_FOR_TICKET_REDEMPTION && elapsedSlotsInCurrentEpoch >= THEORETICAL_SLOTS_TO_WAIT));
    //       this.logger.log(`Include this ticket in subscribers monitor array? ${shouldMonitorTicket}`);
    //     }
    //     return (shouldMonitorTicket);
    //   }
    //  );

    const allSubscribersRedeemableTickets =
      allMarinadeDelayedUnstakeTickets.filter((ticket) => {
        const isSubscribersTicket = subscribers.find((sub) =>
          sub.equals(ticket.beneficiary),
        );
        if (isSubscribersTicket) {
          return ticket.ticketDue;
        }
      });

    this.logger.log(
      `Found ${allMarinadeDelayedUnstakeTickets.length} unstake tickets.`,
    );

    this.logger.log(
      `Found ${allSubscribersRedeemableTickets.length} redeemable delayed unstake tickets pertaining to subscribers.`,
    );
    //this.logger.log(subscribersRedeemableTickets);
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

    subscribers.forEach((it: ResourceId) => {
      console.log(it.toBase58());
      if (!subscriberToRedeemableTicketsMap.has(it.toBase58())) {
        subscriberToRedeemableTicketsMap.set(it.toBase58(), []);
      }
    });

    this.logger.log(
      "Map of subscriber's to their redeemable delayed unstake tickets:\n",
    );
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
