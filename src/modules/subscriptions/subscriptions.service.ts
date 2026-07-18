import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';

@Injectable()
export class SubscriptionsService {
  private razorpay: Razorpay;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this.razorpay = new Razorpay({
      key_id: config.get<string>('RAZORPAY_KEY_ID', ''),
      key_secret: config.get<string>('RAZORPAY_KEY_SECRET', ''),
    });
  }

  // ---------- Public / customer-facing ----------

  async getActivePlans() {
    const plans = await this.prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return { data: plans };
  }

  async getMySubscription(userId: string) {
    const subscription = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE', endDate: { gte: new Date() } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    return { data: subscription };
  }

  /**
   * Starts checkout for a plan: opens a Razorpay order and records a
   * PENDING UserSubscription against it. The subscription only becomes
   * ACTIVE once verifyPayment() confirms the signature — mirrors the
   * same pattern bookings/payments.service.ts uses for paid bookings,
   * so an abandoned checkout never grants a free subscription.
   */
  async createOrder(userId: string, planId: string) {
    const plan = await this.prisma.subscriptionPlan.findFirst({
      where: { id: planId, isActive: true },
    });
    if (!plan) throw new NotFoundException('Plan not found or inactive');

    const existing = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE', endDate: { gte: new Date() } },
    });
    if (existing) {
      throw new ConflictException(
        'You already have an active subscription. Cancel it before subscribing to a new plan.',
      );
    }

    const order = await this.razorpay.orders.create({
      amount: Math.round(plan.price * 100),
      currency: 'INR',
      receipt: `HS-sub-${Date.now()}`,
    });

    const subscription = await this.prisma.userSubscription.create({
      data: {
        userId,
        planId,
        status: 'PENDING',
        razorpayOrderId: order.id,
      },
    });

    return {
      message: 'Subscription order created',
      data: {
        subscriptionId: subscription.id,
        razorpayOrderId: order.id,
        amount: Math.round(plan.price * 100), // paise, matches PaymentsService convention
        currency: 'INR',
        keyId: this.config.get<string>('RAZORPAY_KEY_ID', ''),
      },
    };
  }

  /**
   * Verifies the Razorpay payment signature for a subscription order,
   * then activates it. Same HMAC verification approach as
   * PaymentsService.verifyPayment, kept local here since subscriptions
   * are a separate payment flow from bookings.
   */
  async verifyPayment(
    userId: string,
    dto: {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
    },
  ) {
    const body = `${dto.razorpayOrderId}|${dto.razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.config.get<string>('RAZORPAY_KEY_SECRET', ''))
      .update(body)
      .digest('hex');

    const expected = Buffer.from(expectedSignature, 'utf8');
    const received = Buffer.from(dto.razorpaySignature ?? '', 'utf8');
    const isValid =
      expected.length === received.length &&
      crypto.timingSafeEqual(expected, received);

    if (!isValid) {
      throw new BadRequestException('Invalid payment signature');
    }

    const pending = await this.prisma.userSubscription.findFirst({
      where: {
        razorpayOrderId: dto.razorpayOrderId,
        userId,
        status: 'PENDING',
      },
      include: { plan: true },
    });
    if (!pending) {
      throw new NotFoundException('Pending subscription order not found');
    }

    const startDate = new Date();
    const endDate = new Date(
      startDate.getTime() + pending.plan.durationDays * 24 * 60 * 60 * 1000,
    );

    const activated = await this.prisma.userSubscription.update({
      where: { id: pending.id },
      data: {
        status: 'ACTIVE',
        startDate,
        endDate,
        razorpayPaymentId: dto.razorpayPaymentId,
      },
      include: { plan: true },
    });

    return { message: 'Subscription activated', data: activated };
  }

  async cancel(userId: string) {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' },
    });
    if (!active) throw new NotFoundException('No active subscription found');

    await this.prisma.userSubscription.update({
      where: { id: active.id },
      data: { status: 'CANCELLED' },
    });
    return { message: 'Subscription cancelled' };
  }

  /**
   * Used by BookingsService.computeOrderAmounts to apply the
   * subscription discount at checkout. Kept as a narrow, read-only
   * helper so bookings doesn't need to know about Razorpay/plan
   * internals — just "does this user get a discount, and how much".
   */
  async getActiveDiscountForUser(
    userId: string,
  ): Promise<{ discountPercent: number; maxDiscountPerBooking: number | null } | null> {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE', endDate: { gte: new Date() } },
      include: { plan: true },
    });
    if (!active) return null;
    return {
      discountPercent: active.plan.discountPercent,
      maxDiscountPerBooking: active.plan.maxDiscountPerBooking,
    };
  }

  /**
   * Flips subscriptions past their endDate from ACTIVE to EXPIRED.
   * This doesn't change any pricing behavior (getActiveDiscountForUser
   * already filters on endDate >= now), it's purely so admin dashboards
   * and getMySubscription reflect accurate status instead of showing
   * a stale "ACTIVE" tag after the period has actually lapsed.
   * Called from MaintenanceService's daily cron.
   */
  async expireLapsedSubscriptions(): Promise<number> {
    const result = await this.prisma.userSubscription.updateMany({
      where: { status: 'ACTIVE', endDate: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  // ---------- Admin ----------

  async adminListPlans() {
    const plans = await this.prisma.subscriptionPlan.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return { data: plans };
  }

  async adminCreatePlan(dto: {
    name: string;
    description?: string;
    price: number;
    durationDays: number;
    discountPercent: number;
    maxDiscountPerBooking?: number;
    sortOrder?: number;
  }) {
    const plan = await this.prisma.subscriptionPlan.create({ data: dto });
    return { message: 'Plan created', data: plan };
  }

  async adminUpdatePlan(id: string, dto: any) {
    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: dto,
    });
    return { message: 'Plan updated', data: plan };
  }

  async adminDeactivatePlan(id: string) {
    await this.prisma.subscriptionPlan.update({
      where: { id },
      data: { isActive: false },
    });
    return { message: 'Plan deactivated' };
  }

  async adminListSubscribers(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [subscriptions, total] = await Promise.all([
      this.prisma.userSubscription.findMany({
        where: { status: 'ACTIVE' },
        include: { plan: true, user: { select: { id: true, name: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.userSubscription.count({ where: { status: 'ACTIVE' } }),
    ]);
    return { data: { subscriptions, total, page, limit } };
  }
}
