import {
  Controller, Post, Delete, Get, Param, ParseUUIDPipe,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ReactionsService } from './reactions.service';
import { JwtAuthGuard, CurrentUser } from '../../common/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';

@ApiTags('reactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ReactionsController {
  constructor(private reactionsService: ReactionsService) {}

  // ── Post likes ──────────────────────────────────────────────────

  @Post('posts/:postId/like')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle like on a post' })
  togglePostLike(
    @Param('postId', ParseUUIDPipe) postId: string,
    @CurrentUser() user: User,
  ) {
    return this.reactionsService.togglePostLike(postId, user.id);
  }

  @Get('posts/:postId/likers')
  @ApiOperation({ summary: 'Get users who liked a post' })
  getPostLikers(@Param('postId', ParseUUIDPipe) postId: string) {
    return this.reactionsService.getPostLikers(postId);
  }

  // ── Comment likes ────────────────────────────────────────────────

  @Post('comments/:commentId/like')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle like on a comment or reply' })
  toggleCommentLike(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: User,
  ) {
    return this.reactionsService.toggleCommentLike(commentId, user.id);
  }

  @Get('comments/:commentId/likers')
  @ApiOperation({ summary: 'Get users who liked a comment' })
  getCommentLikers(@Param('commentId', ParseUUIDPipe) commentId: string) {
    return this.reactionsService.getCommentLikers(commentId);
  }
}
