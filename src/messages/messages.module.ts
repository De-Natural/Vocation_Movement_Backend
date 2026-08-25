import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

/**
 * Messages module — PRD 3.6 / ARCHITECTURE §7.6.
 *
 * Thank-you notes from religious students to the sponsors who funded them,
 * with threaded replies from both sides. When a donor gave anonymously the
 * exchange is proxied through the platform: the student sees "Anonymous (via
 * Admin)" and the sponsor's replies arrive without a name. Anonymity is
 * applied at serialisation time — the DB always keeps the true identity.
 */
@Module({
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
