import {
  Global,
  Injectable,
  Logger,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';

export const CLOUDINARY_BUCKET = 'cloudinary';

/** Cloudinary keeps images and other files ("raw") apart; the type is part of every address. */
export type CloudinaryResourceType = 'image' | 'raw';

/** Images Cloudinary can transform; everything else (PDF, Word, video, zip) is stored as raw bytes. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * `file_assets.object_key` for a Cloudinary file: `<resource type>/<public id>`, e.g.
 * `raw/edupulse/files/2026/11/<uuid>.pdf`. The public id never contains user input.
 */
export const cloudinaryKey = (type: CloudinaryResourceType, publicId: string) =>
  `${type}/${publicId}`;

export function parseCloudinaryKey(objectKey: string): {
  resourceType: CloudinaryResourceType;
  publicId: string;
} {
  const slash = objectKey.indexOf('/');
  const type = objectKey.slice(0, slash);
  if (slash < 1 || (type !== 'image' && type !== 'raw'))
    throw new Error(`Not a Cloudinary object key: ${objectKey}`);
  return { resourceType: type, publicId: objectKey.slice(slash + 1) };
}

export const resourceTypeFor = (mimeType: string): CloudinaryResourceType =>
  IMAGE_TYPES.has(mimeType) ? 'image' : 'raw';

/**
 * File storage on Cloudinary, used when CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and
 * CLOUDINARY_API_SECRET are set (otherwise uploads stay on the local disk).
 *
 * - Course files and submissions are uploaded as `authenticated`: Cloudinary refuses plain links to
 *   them, and the API streams them to people it has checked (GET /files/:id/content).
 * - Profile photos are public (`upload`), so the website can show them directly.
 */
@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  readonly enabled: boolean;
  /** Top-level folder, so several environments can share one Cloudinary account. */
  readonly folder: string;

  constructor(config: ConfigService) {
    const cloudName = config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = config.get<string>('CLOUDINARY_API_SECRET');
    this.enabled = !!(cloudName && apiKey && apiSecret);
    this.folder = (config.get<string>('CLOUDINARY_FOLDER') || 'edupulse').replace(
      /^\/+|\/+$/g,
      '',
    );
    if (this.enabled) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
    } else if (config.get<string>('NODE_ENV') === 'production') {
      this.logger.warn(
        'Cloudinary is not configured: uploads go to the local disk and profile photos are disabled.',
      );
    }
  }

  assertEnabled(): void {
    if (!this.enabled)
      throw new ServiceUnavailableException(
        'File storage (Cloudinary) is not configured on the server',
      );
  }

  /** Uploads a private file. `publicId` is relative to the app folder; raw ids keep the extension. */
  uploadPrivate(
    buffer: Buffer,
    resourceType: CloudinaryResourceType,
    publicId: string,
  ): Promise<UploadApiResponse> {
    return this.uploadBuffer(buffer, {
      resource_type: resourceType,
      type: 'authenticated',
      public_id: `${this.folder}/${publicId}`,
      overwrite: false,
    });
  }

  /** Uploads a public profile photo, cropped square around the face and capped at 512 px. */
  uploadPhoto(buffer: Buffer, publicId: string): Promise<UploadApiResponse> {
    return this.uploadBuffer(buffer, {
      resource_type: 'image',
      type: 'upload',
      public_id: `${this.folder}/photos/${publicId}`,
      overwrite: true,
      invalidate: true,
      transformation: [
        { width: 512, height: 512, crop: 'fill', gravity: 'face' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });
  }

  /**
   * A short-lived signed link to a private file, fetched by the API (never handed to the browser,
   * so the access check in FilesService stays the only way in).
   */
  privateDownloadUrl(
    resourceType: CloudinaryResourceType,
    publicId: string,
  ): string {
    // Images are addressed without their format; raw files carry the extension in the public id.
    return cloudinary.utils.private_download_url(publicId, '', {
      resource_type: resourceType,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
  }

  async destroy(
    resourceType: CloudinaryResourceType,
    publicId: string,
    type: 'authenticated' | 'upload',
  ): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        type,
        invalidate: true,
      });
    } catch (error) {
      // The database row is already gone; a stray object only costs storage.
      this.logger.warn(`Could not delete ${publicId} from Cloudinary: ${describe(error)}`);
    }
  }

  private uploadBuffer(
    buffer: Buffer,
    options: Record<string, unknown>,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        options,
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary upload failed: ${describe(error)}`);
            reject(
              new ServiceUnavailableException(
                'The file could not be stored. Please try again.',
              ),
            );
          } else resolve(result);
        },
      );
      stream.end(buffer);
    });
  }
}

/** Cloudinary errors are plain objects such as { message, http_code }. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

@Global()
@Module({ providers: [CloudinaryService], exports: [CloudinaryService] })
export class StorageModule {}
