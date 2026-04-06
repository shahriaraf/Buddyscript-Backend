export const CacheKeys = {
  // Feed page (cursor-based key per user per cursor)
  feedPage: (userId: string, cursor: string) =>
    `feed:${userId}:${cursor}`,

  // Single post
  post: (postId: string) => `post:${postId}`,

  // Post like count (hot counter, synced to DB periodically)
  postLikes: (postId: string) => `likes:post:${postId}`,

  // Comment like count
  commentLikes: (commentId: string) => `likes:comment:${commentId}`,

  // Set of userIds who liked a target (for "who liked?" modal)
  postLikers: (postId: string) => `likers:post:${postId}`,
  commentLikers: (commentId: string) => `likers:comment:${commentId}`,

  // Set of postIds liked by a user (for rendering liked state in feed)
  userLikedPosts: (userId: string) => `user_liked_posts:${userId}`,
  userLikedComments: (userId: string) => `user_liked_comments:${userId}`,

  // Comments list for a post (first page only)
  postComments: (postId: string) => `comments:${postId}`,

  // User profile
  userProfile: (userId: string) => `user:${userId}`,
} as const;

export const CacheTTL = {
  FEED: 30,          // 30 seconds — feeds are very fresh
  POST: 300,         // 5 minutes
  COMMENTS: 60,      // 1 minute
  USER: 600,         // 10 minutes
  LIKES_COUNT: 60,   // 1 minute — hot data
  LIKERS: 30,        // 30 seconds
} as const;
