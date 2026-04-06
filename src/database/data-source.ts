import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from '../modules/users/entities/user.entity';
import { RefreshToken } from '../modules/auth/entities/refresh-token.entity';
import { Post } from '../modules/posts/entities/post.entity';
import { Comment } from '../modules/comments/entities/comment.entity';
import { Reaction } from '../modules/reactions/entities/reaction.entity';
import { Media } from '../modules/media/entities/media.entity';

// Helper to parse DATABASE_URL or use individual env vars
function getDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    return {
      url: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
      } : false,
    };
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    username: process.env.DB_USER || 'buddyscript',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'buddyscript_db',
  };
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  ...getDatabaseConfig(),
  entities: [User, RefreshToken, Post, Comment, Reaction, Media],
  migrations: ['dist/database/migrations/*.js'], // ← Use compiled JS in production
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
  extra: {
    max: parseInt(process.env.DB_POOL_SIZE || '20'),
    min: parseInt(process.env.DB_POOL_MIN || '5'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
});