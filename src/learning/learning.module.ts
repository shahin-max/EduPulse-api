import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { MaterialsController } from './materials.controller.js';
import { MaterialsService } from './materials.service.js';
import {
  AssignmentsController,
  SubmissionsController,
} from './assignments.controller.js';
import { AssignmentsService } from './assignments.service.js';
import { LearningAccessService } from './learning-access.service.js';

/** Files, study materials, material progress, assignments and submissions. */
@Module({
  controllers: [
    FilesController,
    MaterialsController,
    AssignmentsController,
    SubmissionsController,
  ],
  providers: [
    FilesService,
    MaterialsService,
    AssignmentsService,
    LearningAccessService,
  ],
  exports: [FilesService, LearningAccessService],
})
export class LearningModule {}
