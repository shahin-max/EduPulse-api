import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CloudinaryService } from '../storage/cloudinary.service.js';
import {
  MAX_WEBSITE_IMAGE_BYTES,
  WebsiteMediaService,
} from './website-media.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

function service(enabled = true) {
  const uploadWebsiteImage = vi.fn().mockResolvedValue({
    secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/x.png',
    width: 1200,
    height: 800,
  });
  const cloudinary = {
    enabled,
    assertEnabled: () => {
      if (!enabled) throw new ServiceUnavailableException('off');
    },
    uploadWebsiteImage,
  } as unknown as CloudinaryService;
  return { media: new WebsiteMediaService(cloudinary), uploadWebsiteImage };
}

describe('WebsiteMediaService', () => {
  it('uploads a real image and returns its public URL', async () => {
    const { media, uploadWebsiteImage } = service();
    await expect(
      media.uploadImage({ size: PNG.length, buffer: PNG }),
    ).resolves.toEqual({
      url: 'https://res.cloudinary.com/demo/image/upload/v1/x.png',
      width: 1200,
      height: 800,
    });
    expect(uploadWebsiteImage).toHaveBeenCalledOnce();
  });

  it('refuses a missing file, an oversized one and anything that is not an image', async () => {
    const { media, uploadWebsiteImage } = service();
    await expect(media.uploadImage(undefined)).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      media.uploadImage({ size: MAX_WEBSITE_IMAGE_BYTES + 1, buffer: PNG }),
    ).rejects.toThrow('at most 5 MB');
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script/>',
    );
    await expect(
      media.uploadImage({ size: svg.length, buffer: svg }),
    ).rejects.toThrow('JPEG, PNG, WebP or GIF');
    expect(uploadWebsiteImage).not.toHaveBeenCalled();
  });

  it('answers 503 when Cloudinary is not configured', async () => {
    const { media } = service(false);
    await expect(
      media.uploadImage({ size: PNG.length, buffer: PNG }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
