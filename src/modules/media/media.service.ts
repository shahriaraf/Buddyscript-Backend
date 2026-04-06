import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { unlinkSync } from 'fs';
import * as sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';
import { Media } from './entities/media.entity';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectRepository(Media) private mediaRepo: Repository<Media>,
    private config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  async processAndSave(
    file: Express.Multer.File,
    uploaderId: string,
  ): Promise<{ url: string; mediaId: string }> {
    if (!file) throw new BadRequestException('No file provided');

    try {
      // Resize & convert to webp
      const outputPath = file.path.replace(/\.[^.]+$/, '_opt.webp');
      await sharp(file.path)
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 85 })
        .toFile(outputPath);

      try { unlinkSync(file.path); } catch {}

      // Upload to Cloudinary
      const result = await cloudinary.uploader.upload(outputPath, {
        folder: 'buddyscript',
        resource_type: 'image',
      });

      try { unlinkSync(outputPath); } catch {}

      const media = this.mediaRepo.create({
        uploaderId,
        storageKey: result.public_id,
        url: result.secure_url,
        mimeType: 'image/webp',
        sizeBytes: file.size,
        width: result.width,
        height: result.height,
      });
      const saved = await this.mediaRepo.save(media);

      return { url: result.secure_url, mediaId: saved.id };
    } catch (err) {
      this.logger.error('Media processing failed', err);
      try { unlinkSync(file.path); } catch {}
      throw new BadRequestException('Image processing failed');
    }
  }
}