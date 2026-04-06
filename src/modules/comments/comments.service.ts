import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Comment } from './entities/comment.entity';
import { Post } from '../posts/entities/post.entity';
import { Reaction } from '../reactions/entities/reaction.entity';
import { CreateCommentDto, UpdateCommentDto } from './dto/comment.dto';
import { ReactionTarget } from '../../shared/enums';
import { RedisService } from '../redis/redis.service';
import { CacheKeys, CacheTTL } from '../redis/cache-keys';

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment) private commentsRepo: Repository<Comment>,
    @InjectRepository(Post) private postsRepo: Repository<Post>,
    @InjectRepository(Reaction) private reactionsRepo: Repository<Reaction>,
    private redis: RedisService,
    private dataSource: DataSource,
  ) {}

  // ── Create comment or reply ──────────────────────────────────────

  async create(
    postId: string,
    authorId: string,
    dto: CreateCommentDto,
  ): Promise<Comment> {
    const post = await this.postsRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');

    let depth = 0;

    if (dto.parentId) {
      const parent = await this.commentsRepo.findOne({
        where: { id: dto.parentId, postId },
      });
      if (!parent) throw new NotFoundException('Parent comment not found');
      if (parent.depth >= 1) {
        throw new BadRequestException('Replies can only be one level deep');
      }
      depth = parent.depth + 1;
    }

    const comment = this.commentsRepo.create({
      postId,
      authorId,
      parentId: dto.parentId ?? null,
      content: dto.content,
      depth,
    });

    const saved = await this.commentsRepo.save(comment);

    // Bust comment cache for this post
    await this.redis.del(CacheKeys.postComments(postId));

    return this.loadOne(saved.id, authorId);
  }

  // ── Get top-level comments for a post ───────────────────────────

  async getPostComments(
    postId: string,
    requestingUserId: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ data: Comment[]; nextCursor: string | null; hasMore: boolean }> {
    const qb = this.commentsRepo
      .createQueryBuilder('c')
      .select(['c.id', 'c.content', 'c.likesCount', 'c.repliesCount', 'c.createdAt', 'c.updatedAt', 'c.authorId'])
      .leftJoin('c.author', 'a')
      .addSelect(['a.id', 'a.firstName', 'a.lastName', 'a.avatarUrl'])
      .where('c.post_id = :postId AND c.parent_id IS NULL', { postId })
      .orderBy('c.createdAt', 'ASC')
      .limit(limit + 1);

    if (cursor) {
      qb.andWhere('c.created_at > :cursor', { cursor: new Date(cursor) });
    }

    const comments = await qb.getMany();
    const hasMore = comments.length > limit;
    if (hasMore) comments.pop();

    await this.hydrateLikedState(comments, requestingUserId);

    return {
      data: comments,
      nextCursor: hasMore ? comments[comments.length - 1].createdAt.toISOString() : null,
      hasMore,
    };
  }

  // ── Get replies for a comment ────────────────────────────────────

  async getReplies(
    commentId: string,
    requestingUserId: string,
  ): Promise<Comment[]> {
    const replies = await this.commentsRepo
      .createQueryBuilder('c')
      .select(['c.id', 'c.content', 'c.likesCount', 'c.createdAt', 'c.authorId', 'c.parentId'])
      .leftJoin('c.author', 'a')
      .addSelect(['a.id', 'a.firstName', 'a.lastName', 'a.avatarUrl'])
      .where('c.parent_id = :commentId', { commentId })
      .orderBy('c.createdAt', 'ASC')
      .getMany();

    await this.hydrateLikedState(replies, requestingUserId);
    return replies;
  }

  // ── Update ──────────────────────────────────────────────────────

  async update(
    commentId: string,
    userId: string,
    dto: UpdateCommentDto,
  ): Promise<Comment> {
    const comment = await this.commentsRepo.findOne({ where: { id: commentId } });
    if (!comment) throw new NotFoundException();
    if (comment.authorId !== userId) throw new ForbiddenException();

    comment.content = dto.content;
    await this.commentsRepo.save(comment);
    await this.redis.del(CacheKeys.postComments(comment.postId));

    return this.loadOne(commentId, userId);
  }

  // ── Delete ──────────────────────────────────────────────────────

  async delete(commentId: string, userId: string): Promise<void> {
    const comment = await this.commentsRepo.findOne({ where: { id: commentId } });
    if (!comment) throw new NotFoundException();
    if (comment.authorId !== userId) throw new ForbiddenException();

    await this.commentsRepo.remove(comment);
    await this.redis.del(CacheKeys.postComments(comment.postId));
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private async loadOne(id: string, requestingUserId: string): Promise<Comment> {
    const comment = await this.commentsRepo.findOne({
      where: { id },
      relations: ['author'],
    });
    if (!comment) throw new NotFoundException();
    await this.hydrateLikedState([comment], requestingUserId);
    return comment;
  }

  private async hydrateLikedState(
    comments: Comment[],
    userId: string,
  ): Promise<void> {
    if (!comments.length) return;
    const ids = comments.map((c) => c.id);

    const reactions = await this.reactionsRepo
      .createQueryBuilder('r')
      .select('r.target_id', 'targetId')
      .where('r.user_id = :userId', { userId })
      .andWhere('r.target_type = :type', { type: ReactionTarget.COMMENT })
      .andWhere('r.target_id IN (:...ids)', { ids })
      .getRawMany<{ targetId: string }>();

    const likedSet = new Set(reactions.map((r) => r.targetId));
    for (const c of comments) {
      c.isLikedByCurrentUser = likedSet.has(c.id);
    }
  }
}
