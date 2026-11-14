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
  resendVerificationSchema,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  ResendVerificationInput,
} from './auth.dto';
import { Role } from '@prisma/client';
import { UserWithProfiles } from './auth.service';
import { ok } from '../common/http/response';
import {
  roleToApi,
  serializeSponsor,
  serializeStudent,
} from '../common/serializers';

const REFRESH_COOKIE = 'vm_refresh';
/**
 * Session hint cookie read by the frontend's Next.js middleware to guard
 * /dashboard routes. The refresh cookie is scoped to /api/auth, so pages
 * never see it; this one is scoped to "/" and only carries the role. It is
 * NOT a credential — every API call is still authorised by the access token.
 */
const ROLE_COOKIE = 'vm_role';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Display name for the signed-in user (profiles hold the name). */
function displayName(user: UserWithProfiles): string {
  return (
    user.religiousProfile?.fullName ??
    user.sponsorProfile?.fullName ??
    user.name ??
    (user.role === 'SUPERADMIN'
      ? 'Super Administrator'
      : user.role === 'ADMIN'
        ? 'Administrator'
        : user.email)
  );
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  private setSessionCookies(res: Response, token: string, role: Role): void {
    const secure = process.env.NODE_ENV === 'production';
    // httpOnly, Secure, SameSite=Strict (PRD §5.1). Secure only in prod
    // so it works over http://localhost in dev.
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: SESSION_MAX_AGE_MS,
    });
    // Lax so a top-level navigation from an email link still sees it.
    res.cookie(ROLE_COOKIE, roleToApi[role], {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });
  }

  private clearSessionCookies(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.clearCookie(ROLE_COOKIE, { path: '/' });
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
    this.setSessionCookies(res, tokens.refreshToken, user.role);
    return ok(
      {
        accessToken: tokens.accessToken,
        // The frontend routes by role after login.
        role: roleToApi[user.role],
        userId: user.id,
        name: displayName(user),
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
    try {
      const tokens = await this.auth.refresh(raw);
      this.setSessionCookies(res, tokens.refreshToken, tokens.role);
      return ok({ accessToken: tokens.accessToken });
    } catch (err) {
      // Dead session: drop the hint cookie too, so the frontend middleware
      // stops treating this browser as signed in.
      this.clearSessionCookies(res);
      throw err;
    }
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
    this.clearSessionCookies(res);
    return ok({ loggedOut: true }, 'Signed out');
  }

  // POST /api/auth/resend-verification
  @Public()
  @RateLimit({ limit: 3, windowSeconds: 900, name: 'resend-verify' })
  @Post('resend-verification')
  async resendVerification(
    @Body(new ZodValidationPipe(resendVerificationSchema)) dto: ResendVerificationInput,
  ) {
    await this.auth.resendVerification(dto.email);
    return ok(
      { sent: true },
      'If that account still needs verifying, a new link has been sent.',
    );
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
      // userId / name / photo are what the frontend session store reads.
      userId: user.id,
      name: displayName(user),
      photo: user.religiousProfile?.photoUrl ?? undefined,
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
