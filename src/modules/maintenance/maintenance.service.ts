import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

// Booking statuses that mean "this job is over" — only chats attached to
// bookings in one of these states are eligible for deletion. Anything
// PENDING / ACCEPTED / IN_PROGRESS is left alone no matter how old it is.
const FINISHED_BOOKING_STATUSES = ['COMPLETED', 'CANCELLED', 'REJECTED'] as const;

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private subscriptionsService: SubscriptionsService,
  ) {}

  private get notificationRetentionDays(): number {
    return this.config.get<number>('retention.notificationDays') ?? 7;
  }

  private get chatRetentionDays(): number {
    return this.config.get<number>('retention.chatDays') ?? 30;
  }

  private get pendingBookingRetentionDays(): number {
    return this.config.get<number>('retention.pendingBookingDays') ?? 10;
  }

  // Runs every day at 3 AM server time. Low-traffic hour, keeps deletes
  // small and incremental instead of a giant backlog building up.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runDailyCleanup() {
    await this.cleanupOldNotifications();
    await this.cleanupOldChatMessages();
    await this.cleanupAbandonedPendingBookings();
    await this.expireLapsedSubscriptions();
  }

  async expireLapsedSubscriptions() {
    const count = await this.subscriptionsService.expireLapsedSubscriptions();
    if (count > 0) {
      this.logger.log(`Marked ${count} lapsed subscription(s) as EXPIRED`);
    }
    return count;
  }

  async cleanupAbandonedPendingBookings() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.pendingBookingRetentionDays);

    // A PendingBooking this old was created for a Razorpay order whose
    // checkout was abandoned or failed and never came back — Razorpay
    // orders themselves expire long before this, so there's no risk of
    // deleting a draft that could still be paid for and finalized.
    const result = await this.prisma.pendingBooking.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    if (result.count > 0) {
      this.logger.log(
        `Deleted ${result.count} abandoned pending booking(s) older than ` +
          `${this.pendingBookingRetentionDays} day(s)`,
      );
    }
    return result.count;
  }

  async cleanupOldNotifications() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.notificationRetentionDays);

    // Notification rows are self-contained (no FK from Booking/Payment/etc
    // points at them), so deleting old ones can never cascade into or
    // affect any business record.
    const result = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    if (result.count > 0) {
      this.logger.log(
        `Deleted ${result.count} notification(s) older than ${this.notificationRetentionDays} day(s)`,
      );
    }
    return result.count;
  }

  async cleanupOldChatMessages() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.chatRetentionDays);

    const result = await this.prisma.chatMessage.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        booking: { status: { in: [...FINISHED_BOOKING_STATUSES] } },
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `Deleted ${result.count} chat message(s) older than ${this.chatRetentionDays} day(s) ` +
          `from finished bookings`,
      );
    }
    return result.count;
  }
}