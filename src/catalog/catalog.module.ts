import { Module } from '@nestjs/common';
import {
  ChaptersController,
  CoursesController,
  SubjectsController,
} from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({
  controllers: [SubjectsController, CoursesController, ChaptersController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
