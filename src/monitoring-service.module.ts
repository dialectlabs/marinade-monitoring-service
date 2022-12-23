import { Module } from '@nestjs/common';
import { DelayedUnstakeMonitoringService } from './monitoring.service';
import { LoggerModule } from 'nestjs-pino';
import { HttpModule } from '@nestjs/axios';
import { Dialect, DialectSdk, Environment } from '@dialectlabs/sdk';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './health.controller';
import { TerminusModule } from '@nestjs/terminus';
import {
  NodeDialectSolanaWalletAdapter,
  Solana,
  SolanaNetwork,
  SolanaSdkFactory,
} from '@dialectlabs/blockchain-sdk-solana';

@Module({
  imports: [
    TerminusModule,
    HttpModule,
    ScheduleModule.forRoot(),
    ConfigModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        autoLogging: process.env.ENVIRONMENT !== 'production',
        redact: ['req.headers'],
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: process.env.ENVIRONMENT === 'local-development',
            translateTime: true,
            singleLine: true,
            ignore: 'pid,hostname',
          },
        },
      },
    }),
  ],
  controllers: [HealthController],
  providers: [
    DelayedUnstakeMonitoringService,
    {
      provide: DialectSdk,
      useValue: Dialect.sdk<Solana>(
        {
          environment: process.env.DIALECT_SDK_ENVIRONMENT as Environment,
          dialectCloud: {
            url: process.env.DIALECT_SDK_DIALECT_CLOUD_URL,
          },
        },
        SolanaSdkFactory.create({
          wallet: NodeDialectSolanaWalletAdapter.create(),
          network: process.env.DIALECT_SDK_SOLANA_NETWORK_NAME as SolanaNetwork,
          rpcUrl: process.env.DIALECT_SDK_SOLANA_RPC_URL,
        }),
      ),
    },
  ],
})
export class MonitoringServiceModule {}
