import {
  Controller,
  Delete,
  Param,
  ParseIntPipe,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, RoleCode, Roles } from '../common/auth.js';
import { MAX_PHOTO_BYTES, PhotosService } from './photos.service.js';
import type { PhotoUpload } from './photos.service.js';

const photoBody = {
  schema: {
    type: 'object',
    required: ['photo'],
    properties: { photo: { type: 'string', format: 'binary' } },
  },
};

// A little over the limit, so the service can answer an oversized photo with a clear message.
const photoUpload = FileInterceptor('photo', {
  limits: { fileSize: MAX_PHOTO_BYTES + 1, files: 1 },
});

@ApiTags('Profile photos')
@ApiBearerAuth()
@Controller()
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  /** Upload or replace your profile photo (JPEG, PNG, WebP or GIF, max 5 MB) in the field `photo`. */
  @ApiConsumes('multipart/form-data')
  @ApiBody(photoBody)
  @UseInterceptors(photoUpload)
  @Put('me/photo')
  setMine(
    @UploadedFile() file: PhotoUpload | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.photos.set(user.id, file);
  }

  @Delete('me/photo')
  removeMine(@CurrentUser() user: AuthUser) {
    return this.photos.remove(user.id);
  }

  /** Set any user's photo. Admin only. */
  @Roles(RoleCode.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiBody(photoBody)
  @UseInterceptors(photoUpload)
  @Put('users/:id/photo')
  setFor(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: PhotoUpload | undefined,
  ) {
    return this.photos.set(BigInt(id), file);
  }

  @Roles(RoleCode.ADMIN)
  @Delete('users/:id/photo')
  removeFor(@Param('id', ParseIntPipe) id: number) {
    return this.photos.remove(BigInt(id));
  }
}
