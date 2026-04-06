import {
  Injectable, ExecutionContext, createParamDecorator,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { User } from '../../modules/users/entities/user.entity';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }
}

/** Extracts the authenticated user from the request */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
