import { Module } from '@nestjs/common';
import {
  AttemptsController,
  ExamsController,
  QuestionsController,
} from './exams.controller.js';
import { QuestionsService } from './questions.service.js';
import { ExamsService } from './exams.service.js';
import { AttemptsService } from './attempts.service.js';

/** Question bank, exams, attempts, grading and rankings. */
@Module({
  controllers: [QuestionsController, ExamsController, AttemptsController],
  providers: [QuestionsService, ExamsService, AttemptsService],
})
export class ExamsModule {}
