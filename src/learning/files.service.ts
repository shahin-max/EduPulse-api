import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { file_assets_visibility } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, hasRole, isStaff, RoleCode } from '../common/auth.js';
import { LearningAccessService } from './learning-access.service.js';
import {
  CLOUDINARY_BUCKET,
  CloudinaryService,
  cloudinaryKey,
  parseCloudinaryKey,
  resourceTypeFor,
} from '../storage/cloudinary.service.js';

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

/**
 * Storage for file_assets. New files go to Cloudinary when it is configured (bucket "cloudinary"),
 * otherwise to the local disk (bucket "local"). Files are read from whichever bucket their row
 * names, so files uploaded before Cloudinary was set up keep working.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly root: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly cloudinary: CloudinaryService,
    config: ConfigService,
  ) {
    const dir = config.get<string>('UPLOAD_DIR') ?? './uploads';
    this.root = resolve(dir);
    // Container hosts (Railway, Render, Docker) wipe the app's own disk on every deploy. A relative
    // upload folder there means every uploaded PDF and worksheet disappears with the next release.
    if (
      config.get<string>('NODE_ENV') === 'production' &&
      !isAbsolute(dir) &&
      !cloudinary.enabled
    ) {
      this.logger.warn(
        `UPLOAD_DIR is "${dir}" inside the app folder: on Railway this disk is wiped on every deploy. ` +
          'Attach a Volume (e.g. at /data) and set UPLOAD_DIR=/data/uploads.',
      );
    }
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

    const mimeType = (file.mimetype || 'application/octet-stream').slice(0, 120);
    const stored = await this.store(file, mimeType);
    try {
      return await this.prisma.file_assets.create({
        data: {
          bucket: stored.bucket,
          object_key: stored.objectKey,
          original_filename: safeDisplayName(file.originalname),
          mime_type: mimeType,
          size_bytes: BigInt(file.size),
          visibility: chosen,
          uploaded_by: user.id,
        },
      });
    } catch (error) {
      await this.deleteContent(stored.bucket, stored.objectKey);
      throw error;
    }
  }

  private async store(
    file: UploadedFileInput,
    mimeType: string,
  ): Promise<{ bucket: string; objectKey: string }> {
    const objectKey = buildObjectKey(file.originalname);
    if (this.cloudinary.enabled) {
      const type = resourceTypeFor(mimeType);
      // Raw files keep their extension in the public id (Cloudinary serves them by that name);
      // images are addressed without it.
      const publicId = `files/${type === 'image' ? objectKey.replace(/\.[^./]+$/, '') : objectKey}`;
      const result = await this.cloudinary.uploadPrivate(
        file.buffer,
        type,
        publicId,
      );
      return {
        bucket: CLOUDINARY_BUCKET,
        objectKey: cloudinaryKey(type, result.public_id),
      };
    }
    const path = resolveInside(this.root, objectKey);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, file.buffer, { flag: 'wx' });
    return { bucket: LOCAL_BUCKET, objectKey };
  }

  private async deleteContent(bucket: string, objectKey: string) {
    if (bucket === CLOUDINARY_BUCKET) {
      const { resourceType, publicId } = parseCloudinaryKey(objectKey);
      await this.cloudinary.destroy(resourceType, publicId, 'authenticated');
    } else if (bucket === LOCAL_BUCKET) {
      await unlink(resolveInside(this.root, objectKey)).catch(
        (error: unknown) =>
          this.logger.warn(`Could not remove ${objectKey}: ${String(error)}`),
      );
    }
  }

  /** Metadata, subject to the same access rule as the content. */
  async getMetadata(id: bigint, user?: AuthUser) {
    return this.getReadable(id, user);
  }

  async download(id: bigint, user?: AuthUser): Promise<StreamableFile> {
    const asset = await this.getReadable(id, user);
    const inline = INLINE_TYPES.has(asset.mime_type);
    const encoded = encodeURIComponent(asset.original_filename);
    return new StreamableFile(await this.openContent(asset), {
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
    await this.deleteContent(asset.bucket, asset.object_key);
  }

  /** The file's bytes as a stream, from the disk or (through a one-minute signed link) Cloudinary. */
  private async openContent(asset: {
    bucket: string;
    object_key: string;
  }): Promise<Readable> {
    if (asset.bucket === LOCAL_BUCKET) {
      const path = resolveInside(this.root, asset.object_key);
      try {
        await stat(path);
      } catch {
        throw new NotFoundException('File content is missing');
      }
      return createReadStream(path);
    }
    if (asset.bucket === CLOUDINARY_BUCKET) {
      this.cloudinary.assertEnabled();
      const { resourceType, publicId } = parseCloudinaryKey(asset.object_key);
      let response: Response;
      try {
        response = await fetch(
          this.cloudinary.privateDownloadUrl(resourceType, publicId),
        );
      } catch (error) {
        this.logger.error(`Cloudinary download failed: ${String(error)}`);
        throw new ServiceUnavailableException(
          'The file could not be fetched. Please try again.',
        );
      }
      if (response.status === 404)
        throw new NotFoundException('File content is missing');
      if (!response.ok || !response.body) {
        this.logger.error(
          `Cloudinary download of ${asset.object_key} failed with HTTP ${response.status}`,
        );
        throw new ServiceUnavailableException(
          'The file could not be fetched. Please try again.',
        );
      }
      return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    }
    throw new NotFoundException('File content is not available');
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
