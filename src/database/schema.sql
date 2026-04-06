-- ============================================================
-- BuddyScript Database Schema
-- Design: Facebook-style counter tables, cursor pagination,
--         denormalized counts, partial indexes
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for full-text search later

-- ── USERS ────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name    VARCHAR(50)  NOT NULL,
  last_name     VARCHAR(50)  NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url    VARCHAR(500),
  bio           VARCHAR(500),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unique, case-insensitive email index
CREATE UNIQUE INDEX idx_users_email ON users (LOWER(email));
CREATE INDEX idx_users_created ON users (created_at DESC);

-- ── REFRESH TOKENS ───────────────────────────────────────────
-- Stored server-side for rotation + revocation
CREATE TABLE refresh_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,  -- bcrypt hash of the raw token
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash);
-- Auto-clean expired tokens
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- ── POSTS ────────────────────────────────────────────────────
CREATE TYPE post_visibility AS ENUM ('public', 'private');

CREATE TABLE posts (
  id           UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  author_id    UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT            NOT NULL CHECK (length(content) BETWEEN 1 AND 5000),
  image_url    VARCHAR(500),
  visibility   post_visibility NOT NULL DEFAULT 'public',
  -- Denormalized counts (Facebook pattern: avoid COUNT(*) on hot tables)
  likes_count    INT NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  comments_count INT NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary feed query: all public posts newest-first (cursor-based)
CREATE INDEX idx_posts_feed ON posts (created_at DESC, id DESC)
  WHERE visibility = 'public';

-- Author's own posts (profile page, includes private)
CREATE INDEX idx_posts_author ON posts (author_id, created_at DESC);

-- ── COMMENTS ─────────────────────────────────────────────────
CREATE TABLE comments (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id    UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  UUID        REFERENCES comments(id) ON DELETE CASCADE,  -- NULL = top-level
  content    TEXT        NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  -- Denormalized counts
  likes_count INT NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  replies_count INT NOT NULL DEFAULT 0 CHECK (replies_count >= 0),
  depth      SMALLINT    NOT NULL DEFAULT 0 CHECK (depth <= 2),  -- max 2 levels (comment + reply)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Load top-level comments for a post
CREATE INDEX idx_comments_post ON comments (post_id, created_at ASC)
  WHERE parent_id IS NULL;

-- Load replies for a comment
CREATE INDEX idx_comments_parent ON comments (parent_id, created_at ASC)
  WHERE parent_id IS NOT NULL;

CREATE INDEX idx_comments_author ON comments (author_id);

-- ── REACTIONS (likes) ─────────────────────────────────────────
-- Single table for post likes, comment likes, reply likes
-- target_type differentiates them — avoids 3 separate tables
CREATE TYPE reaction_target AS ENUM ('post', 'comment');

CREATE TABLE reactions (
  id          UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type reaction_target NOT NULL,
  target_id   UUID            NOT NULL,
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- A user can only like a target once
CREATE UNIQUE INDEX idx_reactions_unique ON reactions (user_id, target_type, target_id);

-- "Who liked this?" query
CREATE INDEX idx_reactions_target ON reactions (target_type, target_id, created_at DESC);

-- "What has this user liked?" (for rendering liked state in feed)
CREATE INDEX idx_reactions_user ON reactions (user_id, target_type);

-- ── MEDIA ─────────────────────────────────────────────────────
CREATE TABLE media (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  uploader_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key  VARCHAR(500) NOT NULL,  -- S3 key or local path
  url          VARCHAR(500) NOT NULL,
  mime_type    VARCHAR(100) NOT NULL,
  size_bytes   INT,
  width        INT,
  height       INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_uploader ON media (uploader_id);

-- ── TRIGGER: auto-update updated_at ───────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_posts_updated_at    BEFORE UPDATE ON posts    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_comments_updated_at BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ── TRIGGER: maintain denormalized post comment count ─────────
CREATE OR REPLACE FUNCTION trigger_post_comment_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.parent_id IS NULL THEN
    UPDATE posts SET comments_count = comments_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' AND OLD.parent_id IS NULL THEN
    UPDATE posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = OLD.post_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER maintain_post_comment_count
  AFTER INSERT OR DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION trigger_post_comment_count();

-- ── TRIGGER: maintain reply count on parent comment ───────────
CREATE OR REPLACE FUNCTION trigger_comment_reply_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.parent_id IS NOT NULL THEN
    UPDATE comments SET replies_count = replies_count + 1 WHERE id = NEW.parent_id;
  ELSIF TG_OP = 'DELETE' AND OLD.parent_id IS NOT NULL THEN
    UPDATE comments SET replies_count = GREATEST(replies_count - 1, 0) WHERE id = OLD.parent_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER maintain_comment_reply_count
  AFTER INSERT OR DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION trigger_comment_reply_count();
