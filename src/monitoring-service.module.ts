import { Module } from '@nestjs/common';
import { DelayedUnstakeMonitoringService } from './monitoring.service';
import { DialectConnection } from './dialect-connection';

@Module({
  imports: [],
  controllers: [],
  providers: [
    {
      provide: DialectConnection,
      useValue: DialectConnection.initialize(),
    },
    DelayedUnstakeMonitoringService,
  ],
})
export class MonitoringServiceModule {}
