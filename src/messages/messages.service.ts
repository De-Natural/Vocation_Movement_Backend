import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.module';
import { AppException } from '../common/http/app-exception';
import { serializeMessage } from '../common/serializers';
import { ThankYouMessage } from '../common/serializers/api-types';
import { SendMessageInput, ReplyInput } from './messages.dto';

// Include shape used everywhere a message is returned to the client.
const messageInclude = {
  student: { include: { user: true } },
  sponsor: { include: { user: true } },
  replies: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.MessageInclude;

type MessageWithRelations = Prisma.MessageGetPayload<{
  include: typeof messageInclude;
}>;

/**
 * Messaging service (PRD 3.6 / ARCHITECTURE §7.6).
 *
 * A religious student sends a thank-you note to a sponsor who funded them;
 * both parties can then reply in the thread. When the donor gave anonymously
 * the whole exchange is proxied through the platform — the student never
 * learns the sponsor's identity, and the sponsor's replies reach the student
 * without a name. Anonymity is applied at the serialisation layer
 * (`serializeMessage`) and in every notification, never by dropping data.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Resolve the ReligiousProfile owned by a user (throws if none). */
  private async requireStudent(userId: string) {
    const student = await this.prisma.religiousProfile.findUnique({
      where: { userId },
    });
    if (!student) {
      throw AppException.notFound(
        'No religious profile for this account',
        'PROFILE_NOT_FOUND',
      );
    }
    return student;
  }

  // ─────────────────── List threads (GET /api/messages) ───────────────────

  /**
   * Return every thread visible to the authenticated user. Students see the
   * notes they've sent (anonymous sponsors shown as "Anonymous (via Admin)");
   * sponsors see the notes they've received (students are always named).
   */
  async list(user: {
    userId: string;
    role: string;
  }): Promise<ThankYouMessage[]> {
    const where = await this.scopeFor(user);
    const rows = await this.prisma.message.findMany({
      where,
      include: messageInclude,
      orderBy: { createdAt: 'desc' },
    });
    // Neither participant is an admin — anonymity stays enforced.
    return rows.map((m) => serializeMessage(m, { viewerIsAdmin: false }));
  }

  /** Build the where-clause that scopes messages to this user's own threads. */
  private async scopeFor(user: {
    userId: string;
    role: string;
  }): Promise<Prisma.MessageWhereInput> {
    if (user.role === 'SPONSOR') {
      const sponsor = await this.prisma.sponsorProfile.findUnique({
        where: { userId: user.userId },
        select: { id: true },
      });
      return { sponsorId: sponsor?.id ?? '__none__' };
    }
    if (user.role === 'RELIGIOUS') {
      const student = await this.prisma.religiousProfile.findUnique({
        where: { userId: user.userId },
        select: { id: true },
      });
      return { studentId: student?.id ?? '__none__' };
    }
    // Admins have no personal inbox here (they use the admin views).
    return { id: '__none__' };
  }

  // ─────────────────── Send a thank-you (POST /api/messages) ───────────────────

  /**
   * A student composes a thank-you note to a sponsor who funded them. The
   * recipient is resolved from a specific gift (`paymentId`) or directly by
   * `sponsorId`; either way a confirmed funding relationship must exist. The
   * donor's anonymity at send time is snapshotted onto the message so the
   * exchange can be proxied for the life of the thread.
   */
  async send(userId: string, dto: SendMessageInput): Promise<ThankYouMessage> {
    const student = await this.requireStudent(userId);
    const { sponsorId, sponsorEmail, sponsorUserId, anonymousDonor } =
      await this.resolveRecipient(student.id, dto);

    const created = await this.prisma.message.create({
      data: {
        studentId: student.id,
        sponsorId,
        anonymousDonor,
        subject: dto.subject?.trim() || 'Thank you',
        body: dto.body.trim(),
        photoAttachment: dto.photoAttachment,
        read: false,
      },
      include: messageInclude,
    });

    // Notify the sponsor. The student is a public profile, so naming them
    // here leaks nothing — anonymity only ever hides the *sponsor*.
    await this.notifications.notify({
      userId: sponsorUserId,
      type: 'MESSAGE_RECEIVED',
      title: 'You received a thank-you note',
      body: `${student.fullName} sent you a message: "${created.subject}"`,
      meta: { messageId: created.id, studentId: student.id },
    });
    await this.notifications.sendEmail({
      to: sponsorEmail,
      template: 'thankyou-received',
      subject: 'A student you supported sent you a thank-you note',
      data: {
        studentName: student.fullName,
        subject: created.subject,
        preview: created.body.slice(0, 240),
      },
    });

    // The sender is a student → serialize from the non-admin perspective.
    return serializeMessage(created, { viewerIsAdmin: false });
  }

  /**
   * Find the sponsor a thank-you should go to and snapshot their anonymity.
   * Enforces that the student may only thank someone who actually funded them.
   */
  private async resolveRecipient(
    studentId: string,
    dto: SendMessageInput,
  ): Promise<{
    sponsorId: string;
    sponsorUserId: string;
    sponsorEmail: string;
    anonymousDonor: boolean;
  }> {
    // (a) Resolved from a specific confirmed gift.
    if (dto.paymentId) {
      const payment = await this.prisma.payment.findUnique({
        where: { id: dto.paymentId },
        include: { sponsor: { include: { user: true } } },
      });
      if (!payment || payment.religiousId !== studentId) {
        throw AppException.notFound(
          'That gift was not found on your account',
          'PAYMENT_NOT_FOUND',
        );
      }
      if (payment.status !== 'CONFIRMED') {
        throw AppException.unprocessable(
          'You can only thank a sponsor once their gift has completed',
          'GIFT_NOT_CONFIRMED',
        );
      }
      return {
        sponsorId: payment.sponsorId,
        sponsorUserId: payment.sponsor.userId,
        sponsorEmail: payment.sponsor.user.email,
        anonymousDonor: payment.isAnonymous,
      };
    }

    // (b) Resolved directly by sponsor — a funding relationship must exist.
    const sponsor = await this.prisma.sponsorProfile.findUnique({
      where: { id: dto.sponsorId },
      include: { user: true },
    });
    if (!sponsor) {
      throw AppException.notFound('Sponsor not found', 'SPONSOR_NOT_FOUND');
    }

    const gifts = await this.prisma.payment.findMany({
      where: {
        sponsorId: sponsor.id,
        religiousId: studentId,
        status: 'CONFIRMED',
      },
      select: { isAnonymous: true },
    });
    if (gifts.length === 0) {
      throw AppException.forbidden(
        'You can only message a sponsor who has funded you',
        'NO_FUNDING_RELATIONSHIP',
      );
    }
    // Only anonymous if the sponsor never once gave under their real name.
    const anonymousDonor = gifts.every((g) => g.isAnonymous);

    return {
      sponsorId: sponsor.id,
      sponsorUserId: sponsor.userId,
      sponsorEmail: sponsor.user.email,
      anonymousDonor,
    };
  }

  // ─────────────────── Reply (POST /api/messages/:id/replies) ───────────────────

  /** Add a reply to a thread. Either participant may reply. */
  async reply(
    userId: string,
    messageId: string,
    dto: ReplyInput,
  ): Promise<ThankYouMessage> {
    const { message, side } = await this.requireParticipant(userId, messageId);

    await this.prisma.messageReply.create({
      data: {
        messageId: message.id,
        from: side === 'student' ? 'STUDENT' : 'SPONSOR',
        body: dto.body.trim(),
      },
    });

    // A reply re-opens the thread for the *other* party.
    await this.notifyReply(message, side);

    const updated = await this.prisma.message.findUniqueOrThrow({
      where: { id: message.id },
      include: messageInclude,
    });
    return serializeMessage(updated, { viewerIsAdmin: false });
  }

  /** Notify the counterpart of a new reply, respecting donor anonymity. */
  private async notifyReply(
    message: MessageWithRelations,
    side: 'student' | 'sponsor',
  ): Promise<void> {
    if (side === 'student') {
      // Student replied → tell the sponsor. Student name is never hidden.
      await this.notifications.notify({
        userId: message.sponsor.userId,
        type: 'MESSAGE_REPLY',
        title: 'New reply from a student',
        body: `${message.student.fullName} replied to "${message.subject}"`,
        meta: { messageId: message.id },
      });
      await this.notifications.sendEmail({
        to: message.sponsor.user.email,
        template: 'message-reply',
        subject: 'New reply on your thank-you thread',
        data: { from: message.student.fullName, subject: message.subject },
      });
      return;
    }

    // Sponsor replied → tell the student. If the donor is anonymous, the
    // reply is relayed through the platform with no identifying name.
    const fromLabel = message.anonymousDonor
      ? 'Your anonymous sponsor'
      : message.sponsor.fullName;
    await this.notifications.notify({
      userId: message.student.userId,
      type: 'MESSAGE_REPLY',
      title: 'New reply from your sponsor',
      body: `${fromLabel} replied to "${message.subject}"`,
      meta: { messageId: message.id },
    });
    await this.notifications.sendEmail({
      to: message.student.user.email,
      template: 'message-reply',
      subject: 'New reply on your thank-you thread',
      data: { from: fromLabel, subject: message.subject },
    });
  }

  // ─────────────────── Mark read (PATCH /api/messages/:id/read) ───────────────────

  /** Mark a thread read. Either participant may do this on open. */
  async markRead(userId: string, messageId: string): Promise<ThankYouMessage> {
    const { message } = await this.requireParticipant(userId, messageId);
    if (!message.read) {
      await this.prisma.message.update({
        where: { id: message.id },
        data: { read: true },
      });
    }
    const updated = await this.prisma.message.findUniqueOrThrow({
      where: { id: message.id },
      include: messageInclude,
    });
    return serializeMessage(updated, { viewerIsAdmin: false });
  }

  // ─────────────────── Shared authorization ───────────────────

  /**
   * Load a message and confirm the caller is one of its two participants,
   * returning which side they are on. The student's `userId` lives on the
   * related ReligiousProfile; the sponsor's on the SponsorProfile.
   */
  private async requireParticipant(
    userId: string,
    messageId: string,
  ): Promise<{ message: MessageWithRelations; side: 'student' | 'sponsor' }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: messageInclude,
    });
    if (!message) {
      throw AppException.notFound('Message not found', 'MESSAGE_NOT_FOUND');
    }
    if (message.student.userId === userId) return { message, side: 'student' };
    if (message.sponsor.userId === userId) return { message, side: 'sponsor' };
    throw AppException.forbidden(
      'This conversation is not yours',
      'NOT_MESSAGE_PARTICIPANT',
    );
  }
}
