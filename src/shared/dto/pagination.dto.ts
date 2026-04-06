import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CursorPaginationDto {
  @ApiPropertyOptional({ description: 'Cursor (last seen post created_at::id)' })
  @IsOptional()
  @IsString()
  cursor?: string; // format: "ISO_DATE__UUID"

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Encode cursor from last item in a page */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}__${id}`).toString('base64url');
}

/** Decode cursor back to components */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [isoDate, id] = decoded.split('__');
    return { createdAt: new Date(isoDate), id };
  } catch {
    return null;
  }
}
