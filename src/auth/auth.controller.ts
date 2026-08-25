import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import {
  Public,
  CurrentUser,
  RateLimit,
} from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  forgotPasswordSchema,
  loginSchema,
  RegisterInput,
  registerSchema,
  resetPasswordSchema,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from './auth.dto';
import { ok } from '../common/http/response';
import {
  roleToApi,
  serializeSponsor,
  serializeStudent,
} from '../common/serializers';

const REFRESH_COOKIE = 'vm_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  private setRefreshCookie(res: Response, token: string): void {
    // httpOnly, Secure, SameSite=Strict (PRD §5.1). Secure only in prod
    // so it works over http://localhost in dev.
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  // POST /api/auth/register  (student | sponsor only)
  @Public()
  @RateLimit({ limit: 10, windowSeconds: 900, name: 'register' })
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterInput,
  ) {
    const { userId, role } = await this.auth.register(dto);
    return ok(
      { userId, role: roleToApi[role] },
      'Account created. Please check your email to verify your address.',
    );
  }

  // POST /api/auth/login
  @Public()
  @RateLimit({ limit: 10, windowSeconds: 900, name: 'login' }) // PRD §5.2
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.auth.login(dto);
    this.setRefreshCookie(res, tokens.refreshToken);
    return ok(
      {
        accessToken: tokens.accessToken,
        // The frontend routes by role after login.
        role: roleToApi[user.role],
        userId: user.id,
      },
      'Signed in successfully',
    );
  }

  // POST /api/auth/refresh
  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { refreshToken?: string },
  ) {
    const raw = body?.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    const tokens = await this.auth.refresh(raw);
    this.setRefreshCookie(res, tokens.refreshToken);
    return ok({ accessToken: tokens.accessToken });
  }

  // POST /api/auth/logout
  @Public()
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = req.cookies?.[REFRESH_COOKIE];
    await this.auth.logout(raw);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return ok({ loggedOut: true }, 'Signed out');
  }

  // GET /api/auth/verify-email/:token
  @Public()
  @Get('verify-email/:token')
  async verifyEmail(@Param('token') token: string) {
    await this.auth.verifyEmail(token);
    return ok({ verified: true }, 'Email verified. You can now sign in.');
  }

  // POST /api/auth/forgot-password
  @Public()
  @RateLimit({ limit: 5, windowSeconds: 900, name: 'forgot' })
  @Post('forgot-password')
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) dto: ForgotPasswordInput,
  ) {
    await this.auth.forgotPassword(dto);
    return ok(
      { sent: true },
      'If an account exists for that email, a reset link has been sent.',
    );
  }

  // POST /api/auth/reset-password
  @Public()
  @RateLimit({ limit: 5, windowSeconds: 900, name: 'reset' })
  @Post('reset-password')
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) dto: ResetPasswordInput,
  ) {
    await this.auth.resetPassword(dto);
    return ok({ reset: true }, 'Password updated. Please sign in.');
  }

  // GET /api/auth/me
  @Get('me')
  async me(@CurrentUser() principal: AuthUser) {
    const user = await this.auth.me(principal.userId);
    const base = {
      id: user.id,
      email: user.email,
      role: roleToApi[user.role],
      isVerified: user.isVerified,
      isApproved: user.isApproved,
    };
    if (user.religiousProfile) {
      return ok({
        ...base,
        profile: serializeStudent(user.religiousProfile),
      });
    }
    if (user.sponsorProfile) {
      return ok({
        ...base,
        profile: serializeSponsor({ ...user.sponsorProfile, user }),
      });
    }
    return ok(base);
  }
}
