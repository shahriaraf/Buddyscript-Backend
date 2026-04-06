import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

import { appConfig, dbConfig, redisConfig, jwtConfig, throttleConfig } from './config';
import { RedisModule } from './modules/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { PostsModule } from './modules/posts/posts.module';
import { CommentsModule } from './modules/comments/comments.module';
import { ReactionsModule } from './modules/reactions/reactions.module';
import { MediaModule } from './modules/media/media.module';

import { User } from './modules/users/entities/user.entity';
import { RefreshToken } from './modules/auth/entities/refresh-token.entity';
import { Post } from './modules/posts/entities/post.entity';
import { Comment } from './modules/comments/entities/comment.entity';
import { Reaction } from './modules/reactions/entities/reaction.entity';
import { Media } from './modules/media/entities/media.entity';

@Module({
  imports: [
    // ── Config ──────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, dbConfig, redisConfig, jwtConfig, throttleConfig],
      envFilePath: ['.env.local', '.env'],
    }),

    // ── Rate limiting ────────────────────────────────────────────
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [{
        ttl: config.get<number>('throttle.ttl', 60000),
        limit: config.get<number>('throttle.limit', 100),
      }],
    }),

    // ── PostgreSQL ───────────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.username'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.database'),
        entities: [User, RefreshToken, Post, Comment, Reaction, Media],
        synchronize: config.get('app.nodeEnv') === 'development', // use migrations in prod
        logging: config.get('app.nodeEnv') === 'development',
        extra: {
          max: config.get<number>('database.poolSize', 20),
          min: 2,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 3000,
        },
      }),
    }),

    // ── Static file serving (uploaded images) ───────────────────
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),

    // ── Feature modules ──────────────────────────────────────────
    RedisModule,
    UsersModule,
    AuthModule,
    PostsModule,
    CommentsModule,
    ReactionsModule,
    MediaModule,
  ],
})
export class AppModule {}
