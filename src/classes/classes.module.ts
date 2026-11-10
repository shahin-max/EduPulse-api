import { Module } from '@nestjs/common';
import {
  AttendanceController,
  ClassSessionsController,
} from './classes.controller.js';
import { ClassesService } from './classes.service.js';

/** Class sessions (timetable per batch) and attendance. */
@Module({
  controllers: [ClassSessionsController, AttendanceController],
  providers: [ClassesService],
})
export class ClassesModule {}
