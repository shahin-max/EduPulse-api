import { attendanceSummary, submissionState } from './reports.service.js';
import { isSupportedImage } from '../users/photos.service.js';
import { cloudinaryKey, parseCloudinaryKey, resourceTypeFor } from '../storage/cloudinary.service.js';

describe('attendanceSummary', () => {
  it('counts late as attended and leaves excused classes out', () => {
    expect(attendanceSummary({ PRESENT: 6, LATE: 1, ABSENT: 1, EXCUSED: 2 })).toEqual({
      present: 6, late: 1, absent: 1, excused: 2, percentage: 87.5,
    });
  });

  it('has no percentage before any class is marked', () => {
    expect(attendanceSummary({ EXCUSED: 1 }).percentage).toBeNull();
  });
});

describe('submissionState', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  const due = new Date('2026-11-12T10:00:00Z');

  it('separates missing from not yet due', () => {
    expect(submissionState(undefined, due, now)).toBe('MISSING');
    expect(submissionState(undefined, new Date('2026-11-14T00:00:00Z'), now)).toBe('NOT_DUE');
    expect(submissionState(undefined, null, now)).toBe('MISSING');
  });

  it('marks late and reviewed submissions', () => {
    expect(submissionState({ submitted_at: new Date('2026-11-12T11:00:00Z'), reviewed_at: null }, due, now)).toBe('LATE');
    expect(submissionState({ submitted_at: new Date('2026-11-11T11:00:00Z'), reviewed_at: null }, due, now)).toBe('SUBMITTED');
    expect(submissionState({ submitted_at: new Date('2026-11-12T11:00:00Z'), reviewed_at: now }, due, now)).toBe('REVIEWED');
  });
});

describe('isSupportedImage', () => {
  const pad = (hex: string) => Buffer.concat([Buffer.from(hex, 'hex'), Buffer.alloc(8)]);

  it('accepts JPEG, PNG, GIF and WebP by their first bytes', () => {
    expect(isSupportedImage(pad('ffd8ffe0'))).toBe(true);
    expect(isSupportedImage(pad('89504e470d0a1a0a'))).toBe(true);
    expect(isSupportedImage(pad(Buffer.from('GIF89a').toString('hex')))).toBe(true);
    expect(isSupportedImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
  });

  it('refuses other files, whatever they are called', () => {
    expect(isSupportedImage(pad(Buffer.from('%PDF-1.7').toString('hex')))).toBe(false);
    expect(isSupportedImage(Buffer.from('<svg></svg>'))).toBe(false);
    expect(isSupportedImage(Buffer.alloc(4))).toBe(false);
  });
});

describe('Cloudinary object keys', () => {
  it('round-trip the resource type and public id', () => {
    const key = cloudinaryKey('raw', 'edupulse/files/2026/11/a.pdf');
    expect(key).toBe('raw/edupulse/files/2026/11/a.pdf');
    expect(parseCloudinaryKey(key)).toEqual({ resourceType: 'raw', publicId: 'edupulse/files/2026/11/a.pdf' });
  });

  it('rejects keys that are not Cloudinary keys', () => {
    expect(() => parseCloudinaryKey('2026/11/a.pdf')).toThrow();
    expect(() => parseCloudinaryKey('video/x')).toThrow();
  });

  it('stores images as images and everything else as raw files', () => {
    expect(resourceTypeFor('image/jpeg')).toBe('image');
    expect(resourceTypeFor('application/pdf')).toBe('raw');
    expect(resourceTypeFor('image/svg+xml')).toBe('raw');
  });
});
