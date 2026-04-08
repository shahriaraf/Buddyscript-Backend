import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';


async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port', 3001);
  const frontendUrl = config.get<string>('app.frontendUrl', 'http://localhost:3000');
  const isProd = config.get('app.nodeEnv') === 'production';

  // ── Security ─────────────────────────────────────────────────────
  const origins = [
    'https://buddyscript-tw.vercel.app',
    'http://localhost:3000',
  ];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ── Global prefix ─────────────────────────────────────────────────
  app.setGlobalPrefix('api/v1');

  // ── Validation ───────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,          // strip unknown properties
      forbidNonWhitelisted: true,
      transform: true,          // auto-cast query params
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  // ── Exception filter ──────────────────────────────────────────────
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ── Swagger (dev only) ────────────────────────────────────────────
  if (!isProd) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('BuddyScript API')
      .setDescription('Social platform API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
    new Logger('Swagger').log(`Docs: http://localhost:${port}/api/docs`);
  }

  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`API running on http://0.0.0.0:${port}/api/v1`);
}

bootstrap();
