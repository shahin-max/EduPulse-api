import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CloudinaryService } from '../storage/cloudinary.service.js';
import { safeUserSelect, withRoles } from './user-select.js';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export interface PhotoUpload {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** JPEG, PNG, WebP or GIF, judged by the file's first bytes rather than the name the browser sent. */
export function isSupportedImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const gif = buffer.subarray(0, 4).toString('latin1') === 'GIF8';
  const webp =
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || gif || webp;
}

/** Profile photos, stored publicly on Cloudinary (users.photo_url). */
@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async set(userId: bigint, file: PhotoUpload | undefined) {
    this.cloudinary.assertEnabled();
    if (!file)
      throw new BadRequestException(
        'Attach the photo in a multipart field named "photo"',
      );
    if (file.size > MAX_PHOTO_BYTES)
      throw new BadRequestException('Photos may be at most 5 MB');
    if (!isSupportedImage(file.buffer))
      throw new BadRequestException('Upload a JPEG, PNG, WebP or GIF image');
    const user = await this.findUser(userId);
    // One photo per user, overwritten in place: the public id is the user's random public_id.
    const result = await this.cloudinary.uploadPhoto(file.buffer, user.public_id);
    const updated = await this.prisma.users.update({
      where: { id: userId },
      // secure_url includes the version, so browsers fetch the new photo instead of a cached one.
      data: { photo_url: result.secure_url, photo_public_id: result.public_id },
      select: safeUserSelect,
    });
    return withRoles(updated);
  }

  async remove(userId: bigint) {
    const user = await this.findUser(userId);
    const updated = await this.prisma.users.update({
      where: { id: userId },
      data: { photo_url: null, photo_public_id: null },
      select: safeUserSelect,
    });
    if (user.photo_public_id && this.cloudinary.enabled)
      await this.cloudinary.destroy('image', user.photo_public_id, 'upload');
    return withRoles(updated);
  }

  private async findUser(userId: bigint) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { public_id: true, photo_public_id: true, deleted_at: true },
    });
    if (!user || user.deleted_at) throw new NotFoundException('User not found');
    return user;
  }
}
