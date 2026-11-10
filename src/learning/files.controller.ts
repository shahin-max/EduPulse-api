import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, Public, RoleCode, Roles } from '../common/auth.js';
import { FilesService, MAX_UPLOAD_BYTES } from './files.service.js';
import type { UploadedFileInput } from './files.service.js';
import { UploadFileDto } from './dto/learning.dto.js';

@ApiTags('Files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /**
   * Upload a file (max 25 MB) in the multipart field `file`. Admins and faculty may upload
   * PUBLIC or PRIVATE files; students only PRIVATE ones (for assignment submissions).
   */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY, RoleCode.STUDENT)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        visibility: {
          type: 'string',
          enum: ['PUBLIC', 'PRIVATE'],
          default: 'PRIVATE',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @Post()
  upload(
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() dto: UploadFileDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.files.upload(file, dto.visibility, user);
  }

  /** File metadata. PUBLIC files are open to everyone; PRIVATE ones need access. */
  @Public()
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.files.getMetadata(BigInt(id), user);
  }

  /** Download the file. Images and PDFs open inline; other types download as attachments. */
  @Public()
  @Get(':id/content')
  content(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user?: AuthUser,
  ): Promise<StreamableFile> {
    return this.files.download(BigInt(id), user);
  }

  /** Delete a file. Admin or uploader; 409 while a course, material, assignment or submission uses it. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY, RoleCode.STUDENT)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.files.remove(BigInt(id), user);
  }
}
