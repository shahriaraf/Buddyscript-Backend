// src/config/database.config.ts
import { registerAs } from '@nestjs/config';

export const dbConfig = registerAs('database', () => {
  // Production uses DATABASE_URL, local uses individual vars
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10),
      username: url.username,
      password: url.password,
      database: url.pathname.slice(1), // Remove leading /
      poolSize: parseInt(process.env.DB_POOL_SIZE || '20', 10),
      poolMin: parseInt(process.env.DB_POOL_MIN || '5', 10),
      ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
      } : false,
    };
  }

  // Local Docker setup
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USER || 'buddyscript',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'buddyscript_db',
    poolSize: parseInt(process.env.DB_POOL_SIZE || '20', 10),
    poolMin: parseInt(process.env.DB_POOL_MIN || '5', 10),
  };
});

export const appConfig = registerAs('app', () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
}));


export const jwtConfig = registerAs('jwt', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET || 'your-access-secret',
  refreshSecret: process.env.JWT_REFRESH_SECRET || 'your-refresh-secret',
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
}));


export const throttleConfig = registerAs('throttle', () => ({
  ttl: parseInt(process.env.THROTTLE_TTL || '60000', 10),
  limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
}));

// src/config/redis.config.tsa
export const redisConfig = registerAs('redis', () => {
  // Production uses REDIS_URL
  if (process.env.REDIS_URL) {
    const url = new URL(process.env.REDIS_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10),
      password: url.password || undefined,
    };
  }

  // Local Docker setup
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  };
});