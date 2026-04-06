import {
  Injectable, UnauthorizedException, ConflictException,
  BadRequestException, Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { RegisterDto, LoginDto, AuthResponseDto } from './dto/auth.dto';

const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_BYTES = 40;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private usersRepo: Repository<User>,
    @InjectRepository(RefreshToken) private refreshRepo: Repository<RefreshToken>,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // ── Register ────────────────────────────────────────────────────

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    // Case-insensitive duplicate check
    const exists = await this.usersRepo.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (exists) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = this.usersRepo.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email.toLowerCase(),
      passwordHash,
    });
    await this.usersRepo.save(user);

    this.logger.log(`New user registered: ${user.id}`);
    return this.generateTokenPair(user);
  }

  // ── Login ───────────────────────────────────────────────────────

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.usersRepo.findOne({
      where: { email: dto.email.toLowerCase(), isActive: true },
    });

    // Constant-time comparison to prevent timing attacks
    const passwordMatch = user
      ? await bcrypt.compare(dto.password, user.passwordHash)
      : await bcrypt.compare(dto.password, '$2b$12$invalidhashfortimingprotection000000');

    if (!user || !passwordMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.generateTokenPair(user);
  }

  // ── Refresh token rotation ────────────────────────────────────

  async refreshTokens(rawRefreshToken: string): Promise<AuthResponseDto> {
    // 1. Verify JWT structure first (fast fail)
    let payload: { sub: string; jti: string };
    try {
      payload = this.jwt.verify(rawRefreshToken, {
        secret: this.config.get('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 2. Find the stored token by jti
    const stored = await this.refreshRepo.findOne({
      where: { id: payload.jti, userId: payload.sub },
      relations: ['user'],
    });

    if (!stored || !stored.isValid) {
      // Token reuse detected — revoke ALL tokens for this user (security)
      if (stored) {
        await this.refreshRepo.update({ userId: payload.sub }, { revokedAt: new Date() });
        this.logger.warn(`Refresh token reuse detected for user ${payload.sub}`);
      }
      throw new UnauthorizedException('Refresh token invalid or expired');
    }

    // 3. Revoke old token (rotation)
    stored.revokedAt = new Date();
    await this.refreshRepo.save(stored);

    return this.generateTokenPair(stored.user);
  }

  // ── Logout ──────────────────────────────────────────────────────

  async logout(userId: string): Promise<void> {
    await this.refreshRepo.update(
      { userId, revokedAt: undefined as any },
      { revokedAt: new Date() },
    );
  }

  // ── Validate user (used by JWT strategy) ────────────────────────

  async validateUserById(userId: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { id: userId, isActive: true } });
  }

  // ── Token generation ────────────────────────────────────────────

  private async generateTokenPair(user: User): Promise<AuthResponseDto> {
    // Access token — short-lived, stateless
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email },
      {
        secret: this.config.get('jwt.accessSecret'),
        expiresIn: this.config.get('jwt.accessExpires', '15m'),
      },
    );

    // Refresh token — long-lived, stored in DB for revocation
    const refreshRecord = this.refreshRepo.create({
      userId: user.id,
      tokenHash: '', // will update after generating
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });
    const saved = await this.refreshRepo.save(refreshRecord);

    // JWT-encoded refresh token with jti = DB record id
    const refreshToken = this.jwt.sign(
      { sub: user.id, jti: saved.id },
      {
        secret: this.config.get('jwt.refreshSecret'),
        expiresIn: this.config.get('jwt.refreshExpires', '7d'),
      },
    );

    // Store hash for revocation checks (not the raw JWT — defense in depth)
    saved.tokenHash = await bcrypt.hash(refreshToken, 10);
    await this.refreshRepo.save(saved);

    // Clean up expired tokens for this user (housekeeping)
    this.cleanExpiredTokens(user.id).catch(() => {});

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  private async cleanExpiredTokens(userId: string): Promise<void> {
    await this.refreshRepo
      .createQueryBuilder()
      .delete()
      .where('user_id = :userId AND expires_at < NOW()', { userId })
      .execute();
  }
}
