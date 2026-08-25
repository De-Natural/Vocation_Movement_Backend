import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.module';
import { AppException } from '../common/http/app-exception';
import { serializeInquiry } from '../common/serializers';
import { ContactInquiry } from '../common/serializers/api-types';
import { CreateInquiryInput, ListInquiriesQuery } from './inquiries.dto';

const SETTINGS_ID = 'singleton';

/**
 * Contact inquiries (ARCHITECTURE §7.7).
 *
 * A public visitor submits the contact form; the message lands in the admin
 * inbox and the support team is emailed. Admins can mark inquiries read and
 * delete them — a delete is a genuine removal (unlike sponsor anonymity, an
 * inquiry carries no funding history to preserve) and is recorded in the
 * admin audit log.
 */
@Injectable()
export class InquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─────────────────── Public: submit the contact form ───────────────────

  /** POST /api/inquiries — create an inquiry and notify the support team. */
  async create(dto: CreateInquiryInput): Promise<ContactInquiry> {
    const inquiry = await this.prisma.contactInquiry.create({
      data: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        message: dto.message,
        // status defaults to UNREAD
      },
    });

    // Email the support inbox (address is configurable in platform settings).
    const supportEmail = await this.supportEmail();
    await this.notifications.sendEmail({
      to: supportEmail,
      template: 'contact-inquiry',
      subject: `New contact inquiry from ${dto.name}`,
      data: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        message: dto.message,
      },
    });

    return serializeInquiry(inquiry);
  }

  /** Support address from platform settings (falls back to the seeded default). */
  private async supportEmail(): Promise<string> {
    const settings = await this.prisma.platformSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { supportEmail: true },
    });
    return settings?.supportEmail ?? 'support@vocationmovement.org';
  }

  // ─────────────────── Admin: inbox management ───────────────────

  /** GET /api/inquiries — the admin inbox, optionally filtered to unread. */
  async list(query: ListInquiriesQuery): Promise<{
    inquiries: ContactInquiry[];
    total: number;
    unread: number;
  }> {
    const [rows, total, unread] = await Promise.all([
      this.prisma.contactInquiry.findMany({
        where: query.filter === 'unread' ? { status: 'UNREAD' } : {},
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.contactInquiry.count(),
      this.prisma.contactInquiry.count({ where: { status: 'UNREAD' } }),
    ]);
    return { inquiries: rows.map(serializeInquiry), total, unread };
  }

  private async requireInquiry(id: string) {
    const inquiry = await this.prisma.contactInquiry.findUnique({
      where: { id },
    });
    if (!inquiry) {
      throw AppException.notFound('Inquiry not found', 'INQUIRY_NOT_FOUND');
    }
    return inquiry;
  }

  /** PATCH /api/inquiries/:id/read — mark an inquiry read. */
  async markRead(id: string): Promise<ContactInquiry> {
    const inquiry = await this.requireInquiry(id);
    if (inquiry.status === 'UNREAD') {
      const updated = await this.prisma.contactInquiry.update({
        where: { id },
        data: { status: 'READ' },
      });
      return serializeInquiry(updated);
    }
    return serializeInquiry(inquiry);
  }

  /** DELETE /api/inquiries/:id — remove an inquiry (audit-logged). */
  async remove(
    adminUserId: string,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const inquiry = await this.requireInquiry(id);

    await this.prisma.$transaction([
      this.prisma.contactInquiry.delete({ where: { id } }),
      this.prisma.adminAction.create({
        data: {
          actorId: adminUserId,
          action: 'DELETE_INQUIRY',
          meta: {
            inquiryId: inquiry.id,
            name: inquiry.name,
            email: inquiry.email,
          },
        },
      }),
    ]);

    return { id, deleted: true };
  }
}
