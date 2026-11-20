import {
  BadRequestException,
  Controller,
  Injectable,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { RoleCode, Roles } from '../common/auth.js';
import { CloudinaryService } from '../storage/cloudinary.service.js';
import { isSupportedImage } from '../users/photos.service.js';

export const MAX_WEBSITE_IMAGE_BYTES = 5 * 1024 * 1024;

export interface WebsiteImageUpload {
  size: number;
  buffer: Buffer;
}

/** Public images for the website sections, stored on Cloudinary and linked by URL from the content. */
@Injectable()
export class WebsiteMediaService {
  constructor(private readonly cloudinary: CloudinaryService) {}

  async uploadImage(file: WebsiteImageUpload | undefined) {
    this.cloudinary.assertEnabled();
    if (!file)
      throw new BadRequestException(
        'Attach the image in a multipart field named "image"',
      );
    if (file.size > MAX_WEBSITE_IMAGE_BYTES)
      throw new BadRequestException('Website images may be at most 5 MB');
    // Judged by the file's first bytes: SVG and other types that can carry scripts are refused.
    if (!isSupportedImage(file.buffer))
      throw new BadRequestException('Upload a JPEG, PNG, WebP or GIF image');
    const result = await this.cloudinary.uploadWebsiteImage(
      file.buffer,
      randomUUID(),
    );
    return {
      url: result.secure_url,
      width: result.width,
      height: result.height,
    };
  }
}

@ApiTags('Website content')
@ApiBearerAuth()
@Controller('website-content')
export class WebsiteMediaController {
  constructor(private readonly media: WebsiteMediaService) {}

  /** Upload a website image (JPEG, PNG, WebP or GIF, max 5 MB) in the field `image`. Admins only. */
  @Roles(RoleCode.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image'],
      properties: { image: { type: 'string', format: 'binary' } },
    },
  })
  // A little over the limit, so the service can answer an oversized image with a clear message.
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_WEBSITE_IMAGE_BYTES + 1, files: 1 },
    }),
  )
  @Post('images')
  upload(@UploadedFile() file: WebsiteImageUpload | undefined) {
    return this.media.uploadImage(file);
  }
}
