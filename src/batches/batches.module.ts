import { Module } from '@nestjs/common';
import {
  BatchesController,
  EnrollmentsController,
} from './batches.controller.js';
import { BatchesService } from './batches.service.js';
import { EnrollmentsService } from './enrollments.service.js';

@Module({
  controllers: [BatchesController, EnrollmentsController],
  providers: [BatchesService, EnrollmentsService],
})
export class BatchesModule {}
