import { Module } from '@nestjs/common';
import {
  FacultyController,
  StudentsController,
  UsersController,
} from './users.controller.js';
import { UsersService } from './users.service.js';
import { ProfilesService } from './profiles.service.js';

@Module({
  controllers: [UsersController, StudentsController, FacultyController],
  providers: [UsersService, ProfilesService],
})
export class UsersModule {}
