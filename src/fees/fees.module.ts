import { Module } from '@nestjs/common';
import {
  FeeInvoicesController,
  FeePlansController,
  PaymentsController,
  RefundsController,
} from './fees.controller.js';
import { FeesService } from './fees.service.js';

/** Fee plans, invoices, payments and refunds. */
@Module({
  controllers: [
    FeePlansController,
    FeeInvoicesController,
    PaymentsController,
    RefundsController,
  ],
  providers: [FeesService],
})
export class FeesModule {}
