import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { ok } from '../common/http/response';
import { Roles, CurrentUser } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  sendMessageSchema,
  SendMessageInput,
  replySchema,
  ReplyInput,
  listMessagesQuerySchema,
  ListMessagesQuery,
} from './messages.dto';

/**
 * Messaging endpoints (PRD 3.6 / ARCHITECTURE §7.6).
 * Both students and sponsors reach their own threads; only students may
 * compose the initial thank-you note. Anonymity is enforced in the service.
 */
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  // GET /api/messages?role= — the caller's own threads (role scopes the view)
  @Roles('RELIGIOUS', 'SPONSOR')
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listMessagesQuerySchema))
    _query: ListMessagesQuery,
  ) {
    return ok(await this.messages.list(user));
  }

  // POST /api/messages — a student sends a thank-you note to a sponsor
  @Roles('RELIGIOUS')
  @Post()
  async send(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(sendMessageSchema)) dto: SendMessageInput,
  ) {
    const message = await this.messages.send(user.userId, dto);
    return ok(
      message,
      'Thank-you message sent. Your sponsor will be notified by email.',
    );
  }

  // POST /api/messages/:id/replies — either participant continues the thread
  @Roles('RELIGIOUS', 'SPONSOR')
  @Post(':id/replies')
  async reply(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(replySchema)) dto: ReplyInput,
  ) {
    const message = await this.messages.reply(user.userId, id, dto);
    return ok(message, 'Reply sent.');
  }

  // PATCH /api/messages/:id/read — mark a thread read (on open)
  @Roles('RELIGIOUS', 'SPONSOR')
  @Patch(':id/read')
  async markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return ok(await this.messages.markRead(user.userId, id));
  }
}
