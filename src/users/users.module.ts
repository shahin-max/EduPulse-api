import { Module } from '@nestjs/common';
import {
  FacultyController,
  StudentsController,
  UsersController,
} from './users.controller.js';
import { UsersService } from './users.service.js';
import { ProfilesService } from './profiles.service.js';
import { PhotosController } from './photos.controller.js';
import { PhotosService } from './photos.service.js';

@Module({
  controllers: [
    UsersController,
    StudentsController,
    FacultyController,
    PhotosController,
  ],
  providers: [UsersService, ProfilesService, PhotosService],
})
export class UsersModule {}
