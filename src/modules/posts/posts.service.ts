import {
  Injectable, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Post } from './entities/post.entity';
import { Reaction } from '../reactions/entities/reaction.entity';
import { CreatePostDto, UpdatePostDto } from './dto/post.dto';
import { CursorPaginationDto, encodeCursor, decodeCursor, PaginatedResponse } from '../../shared/dto/pagination.dto';
import { PostVisibility, ReactionTarget } from '../../shared/enums';
import { RedisService } from '../redis/redis.service';
import { CacheKeys, CacheTTL } from '../redis/cache-keys';

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    @InjectRepository(Post) private postsRepo: Repository<Post>,
    @InjectRepository(Reaction) private reactionsRepo: Repository<Reaction>,
    private redis: RedisService,
    private dataSource: DataSource,
  ) {}

  // ── Create ──────────────────────────────────────────────────────

  async create(authorId: string, dto: CreatePostDto): Promise<Post> {
    const post = this.postsRepo.create({ ...dto, authorId });
    const saved = await this.postsRepo.save(post);

    // Invalidate feed cache for all users (simple approach for this scale)
    await this.redis.delPattern('feed:*');

    return this.findOneOrFail(saved.id, authorId);
  }

  // ── Public feed (cursor-based) ───────────────────────────────────
  // This is the core performance-critical path.
  // Pattern: WHERE (created_at, id) < (cursor_date, cursor_id) ORDER BY created_at DESC
  // The partial index on posts(created_at DESC, id DESC) WHERE visibility='public'
  // makes this O(log N) regardless of table size.

  async getFeed(
    requestingUserId: string,
    pagination: CursorPaginationDto,
  ): Promise<PaginatedResponse<Post>> {
    const limit = pagination.limit ?? 20;
    const cacheKey = CacheKeys.feedPage(
      requestingUserId,
      pagination.cursor ?? 'first',
    );

    // Try cache first
    const cached = await this.redis.get<PaginatedResponse<Post>>(cacheKey);
    if (cached) return cached;

    const qb = this.postsRepo
      .createQueryBuilder('p')
      .select([
        'p.id', 'p.authorId', 'p.content', 'p.imageUrl', 'p.visibility',
        'p.likesCount', 'p.commentsCount', 'p.createdAt', 'p.updatedAt',
      ])
      .leftJoin('p.author', 'a')
      .addSelect(['a.id', 'a.firstName', 'a.lastName', 'a.avatarUrl'])
      .where('p.visibility = :pub', { pub: PostVisibility.PUBLIC })
      .orderBy('p.createdAt', 'DESC')
      .addOrderBy('p.id', 'DESC')
      .limit(limit + 1); // fetch one extra to determine hasMore

    // Apply cursor
    if (pagination.cursor) {
      const decoded = decodeCursor(pagination.cursor);
      if (decoded) {
        qb.andWhere(
          '(p.createdAt, p.id) < (:cursorDate, :cursorId)',
          { cursorDate: decoded.createdAt, cursorId: decoded.id },
        );
      }
    }

    const posts = await qb.getMany();
    const hasMore = posts.length > limit;
    if (hasMore) posts.pop();

    // Batch-load liked state for current user
    await this.hydrateLikedState(posts, requestingUserId);

    const nextCursor =
      hasMore && posts.length > 0
        ? encodeCursor(posts[posts.length - 1].createdAt, posts[posts.length - 1].id)
        : null;

    const result: PaginatedResponse<Post> = { data: posts, nextCursor, hasMore };
    await this.redis.set(cacheKey, result, CacheTTL.FEED);

    return result;
  }

  // ── Single post ──────────────────────────────────────────────────

  async findOne(postId: string, requestingUserId: string): Promise<Post> {
    const post = await this.findOneOrFail(postId, requestingUserId);

    // Visibility check: private posts only visible to their author
    if (post.visibility === PostVisibility.PRIVATE && post.authorId !== requestingUserId) {
      throw new NotFoundException('Post not found');
    }

    await this.hydrateLikedState([post], requestingUserId);
    return post;
  }

  // ── Update ──────────────────────────────────────────────────────

  async update(postId: string, userId: string, dto: UpdatePostDto): Promise<Post> {
    const post = await this.findOneOrFail(postId, userId);
    if (post.authorId !== userId) throw new ForbiddenException();

    Object.assign(post, dto);
    await this.postsRepo.save(post);

    // Bust cache
    await Promise.all([
      this.redis.del(CacheKeys.post(postId)),
      this.redis.delPattern('feed:*'),
    ]);

    return post;
  }

  // ── Delete ──────────────────────────────────────────────────────

  async delete(postId: string, userId: string): Promise<void> {
    const post = await this.findOneOrFail(postId, userId);
    if (post.authorId !== userId) throw new ForbiddenException();

    await this.postsRepo.remove(post);

    await Promise.all([
      this.redis.del(CacheKeys.post(postId)),
      this.redis.delPattern('feed:*'),
    ]);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private async findOneOrFail(postId: string, _requestingUserId: string): Promise<Post> {
    const post = await this.postsRepo.findOne({
      where: { id: postId },
      relations: ['author'],
    });
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  /**
   * Batch-load like states for a list of posts.
   * Single Redis SMEMBERS call per user vs N individual checks.
   */
  private async hydrateLikedState(posts: Post[], userId: string): Promise<void> {
    if (!posts.length) return;

    const likedKey = CacheKeys.userLikedPosts(userId);
    let likedPostIds: Set<string>;

    // Try Redis first
    const cached = await this.redis.smembers(likedKey);
    if (cached.length > 0) {
      likedPostIds = new Set(cached);
    } else {
      // Fallback to DB — batch query for all postIds at once
      const postIds = posts.map((p) => p.id);
      const reactions = await this.reactionsRepo
        .createQueryBuilder('r')
        .select('r.target_id', 'targetId')
        .where('r.user_id = :userId', { userId })
        .andWhere('r.target_type = :type', { type: ReactionTarget.POST })
        .andWhere('r.target_id IN (:...postIds)', { postIds })
        .getRawMany<{ targetId: string }>();

      likedPostIds = new Set(reactions.map((r) => r.targetId));
    }

    for (const post of posts) {
      post.isLikedByCurrentUser = likedPostIds.has(post.id);
    }
  }
}
