import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Reaction } from './entities/reaction.entity';
import { Post } from '../posts/entities/post.entity';
import { Comment } from '../comments/entities/comment.entity';
import { ReactionTarget } from '../../shared/enums';
import { RedisService } from '../redis/redis.service';
import { CacheKeys, CacheTTL } from '../redis/cache-keys';

export interface ToggleResult {
  liked: boolean;
  likesCount: number;
}

export interface LikerInfo {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

@Injectable()
export class ReactionsService {
  constructor(
    @InjectRepository(Reaction) private reactionsRepo: Repository<Reaction>,
    @InjectRepository(Post) private postsRepo: Repository<Post>,
    @InjectRepository(Comment) private commentsRepo: Repository<Comment>,
    private redis: RedisService,
    private dataSource: DataSource,
  ) {}

  // ── Toggle like (idempotent) ─────────────────────────────────────

  async togglePostLike(postId: string, userId: string): Promise<ToggleResult> {
    return this.dataSource.transaction(async (manager) => {
      const post = await manager.findOne(Post, { where: { id: postId } });
      if (!post) throw new NotFoundException('Post not found');

      const existing = await manager.findOne(Reaction, {
        where: { userId, targetType: ReactionTarget.POST, targetId: postId },
      });

      let liked: boolean;

      if (existing) {
        await manager.remove(existing);
        await manager
          .createQueryBuilder()
          .update(Post)
          .set({ likesCount: () => 'GREATEST("likes_count" - 1, 0)' })
          .where('id = :id', { id: postId })
          .execute();
        liked = false;
      } else {
        await manager.save(Reaction, {
          userId,
          targetType: ReactionTarget.POST,
          targetId: postId,
        });
        await manager
          .createQueryBuilder()
          .update(Post)
          .set({ likesCount: () => '"likes_count" + 1' })
          .where('id = :id', { id: postId })
          .execute();
        liked = true;
      }

      const updated = await manager.findOne(Post, {
        where: { id: postId },
        select: ['id', 'likesCount'],
      });
      const likesCount = updated?.likesCount ?? 0;

      this.updateReactionCache(userId, ReactionTarget.POST, postId, liked, likesCount);

      return { liked, likesCount };
    });
  }

  async toggleCommentLike(commentId: string, userId: string): Promise<ToggleResult> {
    return this.dataSource.transaction(async (manager) => {
      const comment = await manager.findOne(Comment, { where: { id: commentId } });
      if (!comment) throw new NotFoundException('Comment not found');

      const existing = await manager.findOne(Reaction, {
        where: { userId, targetType: ReactionTarget.COMMENT, targetId: commentId },
      });

      let liked: boolean;

      if (existing) {
        await manager.remove(existing);
        await manager
          .createQueryBuilder()
          .update(Comment)
          .set({ likesCount: () => 'GREATEST("likes_count" - 1, 0)' })
          .where('id = :id', { id: commentId })
          .execute();
        liked = false;
      } else {
        await manager.save(Reaction, {
          userId,
          targetType: ReactionTarget.COMMENT,
          targetId: commentId,
        });
        await manager
          .createQueryBuilder()
          .update(Comment)
          .set({ likesCount: () => '"likes_count" + 1' })
          .where('id = :id', { id: commentId })
          .execute();
        liked = true;
      }

      const updated = await manager.findOne(Comment, {
        where: { id: commentId },
        select: ['id', 'likesCount'],
      });
      const likesCount = updated?.likesCount ?? 0;

      this.updateReactionCache(userId, ReactionTarget.COMMENT, commentId, liked, likesCount);

      return { liked, likesCount };
    });
  }

  // ── Who liked? ───────────────────────────────────────────────────

  async getPostLikers(postId: string, limit = 50): Promise<LikerInfo[]> {
    const rows = await this.reactionsRepo
      .createQueryBuilder('r')
      // Use explicit AS aliases so getRawMany() keys are predictable
      .select([
        'u.id        AS "id"',
        'u.first_name  AS "firstName"',
        'u.last_name   AS "lastName"',
        'u.avatar_url  AS "avatarUrl"',
      ])
      .innerJoin('users', 'u', 'u.id = r.user_id')
      .where('r.target_type = :type AND r.target_id = :id', {
        type: ReactionTarget.POST,
        id: postId,
      })
      .orderBy('r.created_at', 'DESC')
      .limit(limit)
      .getRawMany();

    // rows already have the exact keys we need — no remapping required
    return rows as LikerInfo[];
  }

  async getCommentLikers(commentId: string, limit = 50): Promise<LikerInfo[]> {
    const rows = await this.reactionsRepo
      .createQueryBuilder('r')
      .select([
        'u.id        AS "id"',
        'u.first_name  AS "firstName"',
        'u.last_name   AS "lastName"',
        'u.avatar_url  AS "avatarUrl"',
      ])
      .innerJoin('users', 'u', 'u.id = r.user_id')
      .where('r.target_type = :type AND r.target_id = :id', {
        type: ReactionTarget.COMMENT,
        id: commentId,
      })
      .orderBy('r.created_at', 'DESC')
      .limit(limit)
      .getRawMany();

    return rows as LikerInfo[];
  }

  // ── Cache sync ───────────────────────────────────────────────────

  private async updateReactionCache(
    userId: string,
    targetType: ReactionTarget,
    targetId: string,
    liked: boolean,
    count: number,
  ): Promise<void> {
    try {
      if (targetType === ReactionTarget.POST) {
        const key = CacheKeys.userLikedPosts(userId);
        const countKey = CacheKeys.postLikes(targetId);
        if (liked) {
          await this.redis.sadd(key, targetId);
        } else {
          await this.redis.srem(key, targetId);
        }
        await this.redis.set(countKey, count, CacheTTL.LIKES_COUNT);
        await this.redis.delPattern('feed:*');
      } else {
        const key = CacheKeys.userLikedComments(userId);
        const countKey = CacheKeys.commentLikes(targetId);
        if (liked) {
          await this.redis.sadd(key, targetId);
        } else {
          await this.redis.srem(key, targetId);
        }
        await this.redis.set(countKey, count, CacheTTL.LIKES_COUNT);
      }
    } catch {
      // Cache errors are non-fatal
    }
  }
}