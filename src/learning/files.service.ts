import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { file_assets_visibility } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, hasRole, isStaff, RoleCode } from '../common/auth.js';
import { LearningAccessService } from './learning-access.service.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const LOCAL_BUCKET = 'local';

/** MIME types safe to show inline in a browser; everything else downloads as an attachment. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export interface UploadedFileInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** `.pdf` style extension from a client file name, or '' when it looks odd. */
export function safeExtension(originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** Keeps the display name, minus any directory part and control characters. */
export function safeDisplayName(originalName: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || 'file').slice(0, 255);
}

/** Object keys look like `2026/11/<uuid>.pdf`; nothing user-controlled reaches the path. */
export function buildObjectKey(originalName: string, now = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}/${mm}/${randomUUID()}${safeExtension(originalName)}`;
}

/** Resolves an object key inside the upload root, refusing anything that escapes it. */
export function resolveInside(root: string, objectKey: string): string {
  const base = resolve(root);
  const full = resolve(base, objectKey);
  if (!full.startsWith(base + sep))
    throw new BadRequestException('Invalid file location');
  return full;
}

/** Local-disk file storage for file_assets (bucket "local"). Swap for S3 later by bucket name. */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly root: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    config: ConfigService,
  ) {
    this.root = resolve(config.get<string>('UPLOAD_DIR') ?? './uploads');
  }

  async upload(
    file: UploadedFileInput | undefined,
    visibility: file_assets_visibility | undefined,
    user: AuthUser,
  ) {
    if (!file)
      throw new BadRequestException(
        'Attach the file in a multipart field named "file"',
      );
    if (file.size === 0) throw new BadRequestException('The file is empty');
    if (file.size > MAX_UPLOAD_BYTES)
      throw new BadRequestException('Files may be at most 25 MB');
    const chosen = visibility ?? 'PRIVATE';
    if (chosen === 'PUBLIC' && !isStaff(user)) {
      throw new ForbiddenException(
        'Only admins and faculty can upload PUBLIC files',
      );
    }
    if (!hasRole(user, RoleCode.ADMIN, RoleCode.FACULTY, RoleCode.STUDENT))
      throw new ForbiddenException();

    const objectKey = buildObjectKey(file.originalname);
    const path = resolveInside(this.root, objectKey);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, file.buffer, { flag: 'wx' });
    try {
      return await this.prisma.file_assets.create({
        data: {
          bucket: LOCAL_BUCKET,
          object_key: objectKey,
          original_filename: safeDisplayName(file.originalname),
          mime_type: (file.mimetype || 'application/octet-stream').slice(
            0,
            120,
          ),
          size_bytes: BigInt(file.size),
          visibility: chosen,
          uploaded_by: user.id,
        },
      });
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  /** Metadata, subject to the same access rule as the content. */
  async getMetadata(id: bigint, user?: AuthUser) {
    return this.getReadable(id, user);
  }

  async download(id: bigint, user?: AuthUser): Promise<StreamableFile> {
    const asset = await this.getReadable(id, user);
    if (asset.bucket !== LOCAL_BUCKET)
      throw new NotFoundException('File content is not stored locally');
    const path = resolveInside(this.root, asset.object_key);
    try {
      await stat(path);
    } catch {
      throw new NotFoundException('File content is missing');
    }
    const inline = INLINE_TYPES.has(asset.mime_type);
    const encoded = encodeURIComponent(asset.original_filename);
    return new StreamableFile(createReadStream(path), {
      type: inline ? asset.mime_type : 'application/octet-stream',
      length: Number(asset.size_bytes),
      disposition: `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
    });
  }

  /** Admin or uploader. 409 (via the Prisma filter) while anything references the file. */
  async remove(id: bigint, user: AuthUser): Promise<void> {
    const asset = await this.prisma.file_assets.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('File not found');
    if (!hasRole(user, RoleCode.ADMIN) && asset.uploaded_by !== user.id) {
      throw new ForbiddenException(
        'Only admins and the uploader can delete a file',
      );
    }
    await this.prisma.file_assets.delete({ where: { id } });
    if (asset.bucket === LOCAL_BUCKET) {
      await unlink(resolveInside(this.root, asset.object_key)).catch(
        (error: unknown) =>
          this.logger.warn(
            `Could not remove ${asset.object_key}: ${String(error)}`,
          ),
      );
    }
  }

  private async getReadable(id: bigint, user?: AuthUser) {
    const asset = await this.prisma.file_assets.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('File not found');
    if (!(await this.access.canReadFile(user, asset))) {
      if (!user) throw new UnauthorizedException('Log in to access this file');
      throw new ForbiddenException('You do not have access to this file');
    }
    return asset;
  }
}
