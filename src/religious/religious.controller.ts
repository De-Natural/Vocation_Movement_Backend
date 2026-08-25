import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ReligiousService } from './religious.service';
import { ok } from '../common/http/response';
import {
  Public,
  Roles,
  CurrentUser,
  RateLimit,
} from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { IncomingFile } from '../uploads/uploads.service';
import { AppException } from '../common/http/app-exception';
import {
  addVerificationDocSchema,
  AddVerificationDocInput,
  listReligiousQuerySchema,
  ListReligiousQuery,
  upsertReligiousProfileSchema,
  UpsertReligiousProfileInput,
} from './religious.dto';

@Controller('religious')
export class ReligiousController {
  constructor(private readonly religious: ReligiousService) {}

  // GET /api/religious  — public browse/search (verified only)
  @Public()
  @Get()
  async list(
    @Query(new ZodValidationPipe(listReligiousQuerySchema))
    query: ListReligiousQuery,
  ) {
    const { students, meta } = await this.religious.list(query);
    return ok(students, undefined, meta);
  }

  // GET /api/religious/me/dashboard — student's own dashboard
  // NOTE: declared before ':id' so "me" is not captured as an id.
  @Roles('RELIGIOUS')
  @Get('me/dashboard')
  async dashboard(@CurrentUser() user: AuthUser) {
    const data = await this.religious.dashboard(user.userId);
    return ok(data);
  }

  // GET /api/religious/me/payments — received contributions
  @Roles('RELIGIOUS')
  @Get('me/payments')
  async myPayments(@CurrentUser() user: AuthUser) {
    const payments = await this.religious.receivedPayments(user.userId);
    return ok(payments);
  }

  // GET /api/religious/me/documents — own verification docs
  @Roles('RELIGIOUS')
  @Get('me/documents')
  async myDocuments(@CurrentUser() user: AuthUser) {
    const docs = await this.religious.listOwnDocuments(user.userId);
    return ok(docs);
  }

  // POST /api/religious/profile — create/update own profile
  @Roles('RELIGIOUS')
  @Post('profile')
  async upsertProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(upsertReligiousProfileSchema))
    dto: UpsertReligiousProfileInput,
  ) {
    const student = await this.religious.upsertOwnProfile(user.userId, dto);
    return ok(student, 'Profile saved');
  }

  // PATCH /api/religious/profile — alias for partial edits
  @Roles('RELIGIOUS')
  @Patch('profile')
  async patchProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(upsertReligiousProfileSchema))
    dto: UpsertReligiousProfileInput,
  ) {
    const student = await this.religious.upsertOwnProfile(user.userId, dto);
    return ok(student, 'Profile updated');
  }

  // POST /api/religious/photo — profile image upload
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 20, windowSeconds: 3600, name: 'religious-photo' })
  @Post('photo')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPhoto(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: IncomingFile,
  ) {
    if (!file) throw AppException.badRequest('No file provided', 'NO_FILE');
    const student = await this.religious.uploadPhoto(user.userId, file);
    return ok(student, 'Photo updated');
  }

  // POST /api/religious/documents — verification document upload
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 30, windowSeconds: 3600, name: 'religious-docs' })
  @Post('documents')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: IncomingFile,
    @Body(new ZodValidationPipe(addVerificationDocSchema))
    dto: AddVerificationDocInput,
  ) {
    if (!file) throw AppException.badRequest('No file provided', 'NO_FILE');
    const doc = await this.religious.addVerificationDoc(
      user.userId,
      dto.label,
      file,
    );
    return ok(doc, 'Document uploaded for review');
  }

  // GET /api/religious/:id  — public profile by id or slug (verified only)
  // Declared LAST so static routes above take precedence.
  @Public()
  @Get(':id')
  async getOne(@Param('id') idOrSlug: string) {
    const student = await this.religious.getPublic(idOrSlug);
    return ok(student);
  }
}
