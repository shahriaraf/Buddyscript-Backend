import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1704600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Extensions
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // Users table
    await queryRunner.query(`
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
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX idx_users_email ON users (LOWER(email))`);
    await queryRunner.query(`CREATE INDEX idx_users_created ON users (created_at DESC)`);

    // Refresh tokens
    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )
    `);

    await queryRunner.query(`CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id)`);
    await queryRunner.query(`CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash)`);
    await queryRunner.query(`
      CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens (expires_at)
        WHERE revoked_at IS NULL
    `);

    // Post visibility enum
    await queryRunner.query(`CREATE TYPE post_visibility AS ENUM ('public', 'private')`);

    // Posts table
    await queryRunner.query(`
      CREATE TABLE posts (
        id             UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
        author_id      UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content        TEXT            NOT NULL CHECK (length(content) BETWEEN 1 AND 5000),
        image_url      VARCHAR(500),
        visibility     post_visibility NOT NULL DEFAULT 'public',
        likes_count    INT             NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
        comments_count INT             NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
        created_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_posts_feed ON posts (created_at DESC, id DESC)
        WHERE visibility = 'public'
    `);
    await queryRunner.query(`CREATE INDEX idx_posts_author ON posts (author_id, created_at DESC)`);

    // Comments table
    await queryRunner.query(`
      CREATE TABLE comments (
        id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        post_id       UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        author_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id     UUID        REFERENCES comments(id) ON DELETE CASCADE,
        content       TEXT        NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
        likes_count   INT         NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
        replies_count INT         NOT NULL DEFAULT 0 CHECK (replies_count >= 0),
        depth         SMALLINT    NOT NULL DEFAULT 0 CHECK (depth <= 2),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_comments_post ON comments (post_id, created_at ASC)
        WHERE parent_id IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_comments_parent ON comments (parent_id, created_at ASC)
        WHERE parent_id IS NOT NULL
    `);
    await queryRunner.query(`CREATE INDEX idx_comments_author ON comments (author_id)`);

    // Reaction target enum
    await queryRunner.query(`CREATE TYPE reaction_target AS ENUM ('post', 'comment')`);

    // Reactions table
    await queryRunner.query(`
      CREATE TABLE reactions (
        id          UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id     UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_type reaction_target NOT NULL,
        target_id   UUID            NOT NULL,
        created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_reactions_unique ON reactions (user_id, target_type, target_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_reactions_target ON reactions (target_type, target_id, created_at DESC)
    `);
    await queryRunner.query(`CREATE INDEX idx_reactions_user ON reactions (user_id, target_type)`);

    // Media table
    await queryRunner.query(`
      CREATE TABLE media (
        id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        uploader_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        storage_key  VARCHAR(500) NOT NULL,
        url          VARCHAR(500) NOT NULL,
        mime_type    VARCHAR(100) NOT NULL,
        size_bytes   INT,
        width        INT,
        height       INT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE INDEX idx_media_uploader ON media (uploader_id)`);

    // Triggers for updated_at
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trigger_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER set_users_updated_at 
        BEFORE UPDATE ON users 
        FOR EACH ROW 
        EXECUTE FUNCTION trigger_set_updated_at()
    `);

    await queryRunner.query(`
      CREATE TRIGGER set_posts_updated_at 
        BEFORE UPDATE ON posts 
        FOR EACH ROW 
        EXECUTE FUNCTION trigger_set_updated_at()
    `);

    await queryRunner.query(`
      CREATE TRIGGER set_comments_updated_at 
        BEFORE UPDATE ON comments 
        FOR EACH ROW 
        EXECUTE FUNCTION trigger_set_updated_at()
    `);

    // Trigger for post comment count
    await queryRunner.query(`
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
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER maintain_post_comment_count
        AFTER INSERT OR DELETE ON comments
        FOR EACH ROW 
        EXECUTE FUNCTION trigger_post_comment_count()
    `);

    // Trigger for comment reply count
    await queryRunner.query(`
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
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER maintain_comment_reply_count
        AFTER INSERT OR DELETE ON comments
        FOR EACH ROW 
        EXECUTE FUNCTION trigger_comment_reply_count()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse order
    await queryRunner.query(`DROP TABLE IF EXISTS media CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS reactions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS comments CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS posts CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS refresh_tokens CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS users CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS reaction_target`);
    await queryRunner.query(`DROP TYPE IF EXISTS post_visibility`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS trigger_comment_reply_count() CASCADE`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS trigger_post_comment_count() CASCADE`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS trigger_set_updated_at() CASCADE`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS pg_trgm`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS "uuid-ossp"`);
  }
}