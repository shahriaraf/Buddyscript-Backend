import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { unlinkSync } from 'fs';
import * as sharp from 'sharp';
import { Media } from './entities/media.entity';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectRepository(Media) private mediaRepo: Repository<Media>,
    private config: ConfigService,
  ) {}

  async processAndSave(
    file: Express.Multer.File,
    uploaderId: string,
  ): Promise<{ url: string; mediaId: string }> {
    if (!file) throw new BadRequestException('No file provided');

    try {
      // Resize to max 1200px wide, strip metadata (privacy)
      const outputPath = file.path.replace(/\.[^.]+$/, '_opt.webp');
      await sharp(file.path)
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 85 })
        .toFile(outputPath);

      // Remove original
      try { unlinkSync(file.path); } catch {}

      const filename = outputPath.split('/').pop()!;
      const baseUrl = this.config.get<string>('app.frontendUrl', 'http://localhost:3000');
      const url = `${this.config.get('app.backendUrl', 'http://localhost:3001')}/uploads/${filename}`;

      const media = this.mediaRepo.create({
        uploaderId,
        storageKey: filename,
        url,
        mimeType: 'image/webp',
        sizeBytes: file.size,
      });
      const saved = await this.mediaRepo.save(media);

      return { url, mediaId: saved.id };
    } catch (err) {
      this.logger.error('Media processing failed', err);
      try { unlinkSync(file.path); } catch {}
      throw new BadRequestException('Image processing failed');
    }
  }
}
