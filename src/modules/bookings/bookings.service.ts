import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BookingStatus } from '../../common/enums';
import { EVENTS } from '../../common/events/events.constants';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  withBookingAlias,
  withBookingAliasList,
} from '../../common/utils/serialize.util';

function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private subscriptionsService: SubscriptionsService,
  ) {}

  /**
   * Validates the requested services and coupon, and computes pricing.
   * Does NOT write anything to the database and does NOT reserve coupon
   * usage — safe to call speculatively (e.g. to price a Razorpay order
   * before any booking exists).
   *
   * `userId` is optional only so existing callers that genuinely have no
   * user context keep compiling — but any real booking flow should pass
   * it, or the customer's subscription discount silently won't apply.
   */
  async computeOrderAmounts(dto: CreateBookingDto, userId?: string) {
    const services = await this.prisma.service.findMany({
      where: { id: { in: dto.items.map((i) => i.serviceId) }, isActive: true },
    });

    if (services.length !== dto.items.length) {
      throw new BadRequestException('One or more services are invalid');
    }

    let totalAmount = 0;
    const items = dto.items.map((item) => {
      const service = services.find((s) => s.id === item.serviceId)!;
      const price = service.basePrice * item.quantity;
      totalAmount += price;
      return { serviceId: item.serviceId, quantity: item.quantity, price };
    });

    let discountAmount = 0;
    let couponId: string | undefined = dto.couponId;
    if (couponId) {
      const coupon = await this.prisma.coupon.findFirst({
        where: {
          id: couponId,
          isActive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
        },
      });

      const usageOk =
        !coupon || !coupon.usageLimit || coupon.usedCount < coupon.usageLimit;

      if (coupon && usageOk && totalAmount >= coupon.minOrderValue) {
        discountAmount = roundMoney(
          coupon.discountType === 'percentage'
            ? Math.min(
                (totalAmount * coupon.discountValue) / 100,
                coupon.maxDiscount ?? Infinity,
              )
            : coupon.discountValue,
        );
      } else {
        couponId = undefined;
      }
    }

    // Subscription discount is intentionally mutually exclusive with a
    // coupon — if a coupon already discounted this order, we don't stack
    // a second discount on top of it. This keeps the pricing simple and
    // avoids two independently-configured discounts combining into an
    // unintended (and possibly loss-making) total discount.
    let subscriptionDiscount = 0;
    if (!couponId && userId) {
      const subDiscount = await this.subscriptionsService.getActiveDiscountForUser(userId);
      if (subDiscount) {
        subscriptionDiscount = roundMoney(
          Math.min(
            (totalAmount * subDiscount.discountPercent) / 100,
            subDiscount.maxDiscountPerBooking ?? Infinity,
          ),
        );
        discountAmount = subscriptionDiscount;
      }
    }

    const commissionSetting = await this.prisma.appSetting.findUnique({
      where: { key: 'gst_rate' },
    });
    const taxPercent = parseFloat(commissionSetting?.value ?? '18');
    const taxAmount = roundMoney(
      ((totalAmount - discountAmount) * taxPercent) / 100,
    );
    const finalAmount = roundMoney(
  totalAmount - discountAmount + taxAmount
);

    return {
      items,
      totalAmount,
      discountAmount,
      taxAmount,
      finalAmount,
      couponId,
    };
  }

  /**
   * Atomically reserves one use of a coupon (increments usedCount only
   * while still under the limit), avoiding a race where two concurrent
   * bookings both pass the eligibility check and push usedCount past
   * usageLimit. Returns whether the reservation succeeded.
   */
  private async reserveCoupon(couponId: string | undefined): Promise<boolean> {
    if (!couponId) return false;
    const coupon = await this.prisma.coupon.findUnique({
      where: { id: couponId },
    });
    if (!coupon) return false;

    const updateResult = await this.prisma.coupon.updateMany({
      where: {
        id: couponId,
        ...(coupon.usageLimit ? { usedCount: { lt: coupon.usageLimit } } : {}),
      },
      data: { usedCount: { increment: 1 } },
    });

    return updateResult.count > 0;
  }

  async create(userId: string, dto: CreateBookingDto) {
    const computed = await this.computeOrderAmounts(dto, userId);

    let { discountAmount, couponId, taxAmount, finalAmount } = computed;
    if (couponId && !(await this.reserveCoupon(couponId))) {
      // Lost the race for the last coupon use — recompute without it.
      discountAmount = 0;
      couponId = undefined;
      const commissionSetting = await this.prisma.appSetting.findUnique({
        where: { key: 'gst_rate' },
      });
      const taxPercent = parseFloat(commissionSetting?.value ?? '18');
      taxAmount = (computed.totalAmount * taxPercent) / 100;
      finalAmount = computed.totalAmount + taxAmount;
    }

    const booking = await this.prisma.booking.create({
      data: {
        bookingNumber: `HS${Date.now()}`,
        userId,
        addressId: dto.addressId,
        scheduledDate: new Date(dto.scheduledDate),
        scheduledTime: dto.scheduledTime,
        description: dto.description,
        images: dto.images ?? [],
        totalAmount: computed.totalAmount,
        discountAmount,
        taxAmount,
        finalAmount,
        couponId,
        items: { create: computed.items },
      },
      include: {
        items: { include: { service: { select: { name: true } } } },
        address: true,
      },
    });

    this.eventEmitter.emit(EVENTS.BOOKING_CREATED, {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      userId,
      serviceIds: booking.items.map((i: any) => i.serviceId),
      serviceNames: booking.items.map((i: any) => i.service.name),
      scheduledDate: booking.scheduledDate,
      scheduledTime: booking.scheduledTime,
      finalAmount: booking.finalAmount,
      addressCity: booking.address?.city ?? '',
    });

    return {
      message: 'Booking created successfully',
      data: withBookingAlias(booking),
    };
  }

  /**
   * Creates the real Booking (+ its Payment row, already SUCCESS) from a
   * PendingBooking draft, once Razorpay has confirmed the payment. This is
   * the only place a Booking is created for the online-payment flow — no
   * Booking row exists before this point, so a customer who never
   * completes payment never gets a phantom booking.
   */
  async createFromPaidDraft(
    draft: {
      id: string;
      userId: string;
      addressId: string | null;
      scheduledDate: Date;
      scheduledTime: string;
      description: string | null;
      images: string[];
      items: unknown;
      couponId: string | null;
      totalAmount: number;
      discountAmount: number;
      taxAmount: number;
      finalAmount: number;
      razorpayOrderId: string;
    },
    paymentInfo: {
      razorpayPaymentId: string;
      razorpaySignature?: string;
      method?: string;
    },
  ) {
    const items = draft.items as {
      serviceId: string;
      quantity: number;
      price: number;
    }[];
    const method = (
      ['UPI', 'CARD', 'WALLET', 'CASH'].includes(
        (paymentInfo.method ?? '').toUpperCase(),
      )
        ? (paymentInfo.method ?? '').toUpperCase()
        : 'UPI'
    ) as 'UPI' | 'CARD' | 'WALLET' | 'CASH';

    const booking = await this.prisma.booking.create({
      data: {
        bookingNumber: `HS${Date.now()}`,
        userId: draft.userId,
        addressId: draft.addressId ?? undefined,
        scheduledDate: draft.scheduledDate,
        scheduledTime: draft.scheduledTime,
        description: draft.description ?? undefined,
        images: draft.images ?? [],
        totalAmount: draft.totalAmount,
        discountAmount: draft.discountAmount,
        taxAmount: draft.taxAmount,
        finalAmount: draft.finalAmount,
        couponId: draft.couponId ?? undefined,
        items: { create: items },
        payment: {
          create: {
            amount: draft.finalAmount,
            method,
            status: 'SUCCESS',
            razorpayOrderId: draft.razorpayOrderId,
            razorpayPaymentId: paymentInfo.razorpayPaymentId,
            razorpaySignature: paymentInfo.razorpaySignature,
          },
        },
      },
      include: {
        items: { include: { service: { select: { name: true } } } },
        address: true,
      },
    });

    this.eventEmitter.emit(EVENTS.BOOKING_CREATED, {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      userId: draft.userId,
      serviceIds: booking.items.map((i: any) => i.serviceId),
      serviceNames: booking.items.map((i: any) => i.service.name),
      scheduledDate: booking.scheduledDate,
      scheduledTime: booking.scheduledTime,
      finalAmount: booking.finalAmount,
      addressCity: booking.address?.city ?? '',
    });

    return withBookingAlias(booking);
  }

  async findUserBookings(userId: string, status?: BookingStatus) {
    const bookings = await this.prisma.booking.findMany({
      where: { userId, ...(status && { status }) },
      include: {
        items: {
          include: { service: { select: { name: true, image: true } } },
        },
        worker: {
          select: { name: true, avatar: true, phone: true, rating: true },
        },
        address: true,
        payment: true,
        review: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: withBookingAliasList(bookings) };
  }

  async findWorkerBookings(workerId: string, status?: BookingStatus) {
    const bookings = await this.prisma.booking.findMany({
      where: { workerId, ...(status && { status }) },
      include: {
        items: { include: { service: { select: { name: true } } } },
        user: { select: { name: true, avatar: true, phone: true } },
        address: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: bookings.map((b) => this.redactCustomerContact(b)) };
  }

  async findOne(id: string, requesterId: string, requesterRole: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        items: { include: { service: true } },
        worker: {
          select: {
            id: true,
            name: true,
            avatar: true,
            phone: true,
            rating: true,
          },
        },
        user: { select: { id: true, name: true, avatar: true, phone: true } },
        address: true,
        payment: true,
        review: true,
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');

    const isEligibleWorkerPreview =
      requesterRole === 'WORKER' &&
      booking.status === BookingStatus.PENDING &&
      !booking.workerId &&
      (await this.workerOffersAnyService(
        requesterId,
        booking.items.map((i) => i.serviceId),
      ));

    if (
      requesterRole !== 'ADMIN' &&
      booking.userId !== requesterId &&
      booking.workerId !== requesterId &&
      !isEligibleWorkerPreview
    ) {
      throw new ForbiddenException('Access denied');
    }

    // Workers only need the customer's contact details while a job is
    // actively assigned to them. Once it's finished (completed/cancelled/
    // rejected) or not yet accepted by anyone, strip personal contact info.
    const sanitized =
      requesterRole === 'WORKER'
        ? this.redactCustomerContact(booking)
        : booking;

    return { data: withBookingAlias(sanitized) };
  }

  /**
   * True if the worker has this service in their own offered-services list.
   * Used to let a worker preview a still-open job request (to decide whether
   * to accept/decline) without exposing arbitrary bookings to every worker.
   */
  private async workerOffersAnyService(
    workerId: string,
    serviceIds: string[],
  ): Promise<boolean> {
    if (serviceIds.length === 0) return false;
    const match = await this.prisma.workerService.findFirst({
      where: { workerId, serviceId: { in: serviceIds } },
    });
    return !!match;
  }

  /**
   * Removes the customer's phone number from a booking payload once the
   * job is no longer active for the worker. "Active" = ACCEPTED or
   * IN_PROGRESS. Anything else (PENDING with no worker yet, COMPLETED,
   * CANCELLED, REJECTED) should not expose the customer's personal
   * contact info to the worker.
   */
  private redactCustomerContact<T extends { status: string; user?: any }>(
    booking: T,
  ): T {
    const activeStatuses = [BookingStatus.ACCEPTED, BookingStatus.IN_PROGRESS];
    if (
      !booking.user ||
      activeStatuses.includes(booking.status as BookingStatus)
    ) {
      return booking;
    }
    return {
      ...booking,
      user: { ...booking.user, phone: null },
    };
  }

  async acceptBooking(bookingId: string, workerId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException('Booking is no longer available');
    }

    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { name: true, phone: true },
    });

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.ACCEPTED, workerId },
    });

    this.eventEmitter.emit(EVENTS.BOOKING_ACCEPTED, {
      bookingId,
      bookingNumber: booking.bookingNumber,
      userId: booking.userId,
      workerId,
      workerName: worker?.name ?? '',
      workerPhone: worker?.phone ?? '',
    });

    return { message: 'Booking accepted', data: updated };
  }

  async rejectBooking(bookingId: string, workerId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Case 1: worker is declining a still-open, unassigned job request shown
    // on the "New" tab. Record the decline so it stops showing up for this
    // worker, without touching the booking itself (it stays open for other
    // matching workers to accept).
    if (booking.status === BookingStatus.PENDING && !booking.workerId) {
      await this.prisma.bookingDecline.upsert({
        where: { bookingId_workerId: { bookingId, workerId } },
        create: { bookingId, workerId },
        update: {},
      });
      return { message: 'Job declined' };
    }

    // Case 2: worker had already accepted this booking and is now backing
    // out before starting the job. Reopen it as PENDING (unassigned) so it
    // goes back into the pool for other matching workers, instead of
    // REJECTED which is a terminal status that never resurfaces in the
    // "available jobs" query.
    if (
      booking.status === BookingStatus.ACCEPTED &&
      booking.workerId === workerId
    ) {
      const fullBooking = await this.prisma.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.PENDING, workerId: null },
        include: {
          items: { include: { service: { select: { name: true } } } },
          address: true,
        },
      });

      // Don't immediately re-offer this job to the same worker who backed out
      await this.prisma.bookingDecline.upsert({
        where: { bookingId_workerId: { bookingId, workerId } },
        create: { bookingId, workerId },
        update: {},
      });

      this.eventEmitter.emit(EVENTS.BOOKING_REJECTED, {
        bookingId,
        bookingNumber: booking.bookingNumber,
        userId: booking.userId,
        serviceIds: fullBooking.items.map((i: any) => i.serviceId),
        serviceNames: fullBooking.items.map((i: any) => i.service.name),
        addressCity: fullBooking.address?.city ?? '',
        finalAmount: fullBooking.finalAmount,
      });

      return { message: 'Booking rejected' };
    }

    throw new BadRequestException('Cannot reject this booking');
  }

  async startJob(bookingId: string, workerId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workerId, status: BookingStatus.ACCEPTED },
    });
    if (!booking) throw new BadRequestException('Cannot start this job');

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.IN_PROGRESS },
    });

    this.eventEmitter.emit(EVENTS.BOOKING_STARTED, {
      bookingId,
      userId: booking.userId,
      workerId,
    });

    return { message: 'Job started' };
  }

  async completeJob(bookingId: string, workerId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workerId, status: BookingStatus.IN_PROGRESS },
    });
    if (!booking) throw new BadRequestException('Cannot complete this job');

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.COMPLETED, completedAt: new Date() },
    });

    // Calculate and credit worker earnings
    const commissionSetting = await this.prisma.appSetting.findUnique({
      where: { key: 'commission_rate' },
    });
    const commissionPercent = parseFloat(commissionSetting?.value ?? '20');
    const commission = (booking.finalAmount * commissionPercent) / 100;
    const netAmount = booking.finalAmount - commission;

    await this.prisma.earning.create({
      data: {
        workerId,
        bookingId,
        amount: booking.finalAmount,
        commission,
        netAmount,
      },
    });

    const workerWallet = await this.prisma.workerWallet.findUnique({
      where: { workerId },
    });
    if (workerWallet) {
      await this.prisma.workerWallet.update({
        where: { workerId },
        data: { balance: { increment: netAmount } },
      });
      await this.prisma.transaction.create({
        data: {
          workerWalletId: workerWallet.id,
          type: 'CREDIT',
          amount: netAmount,
          description: `Earnings from booking #${booking.bookingNumber}`,
          referenceId: bookingId,
        },
      });
    }

    await this.prisma.worker.update({
      where: { id: workerId },
      data: { totalJobs: { increment: 1 } },
    });

    this.eventEmitter.emit(EVENTS.BOOKING_COMPLETED, {
      bookingId,
      bookingNumber: booking.bookingNumber,
      userId: booking.userId,
      workerId,
      finalAmount: booking.finalAmount,
      netWorkerEarning: netAmount,
    });

    return { message: 'Job completed successfully' };
  }

  async cancelBooking(
    bookingId: string,
    requesterId: string,
    reason: string,
    refundTo?: 'ORIGINAL' | 'WALLET',
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const cancellableStatuses = [BookingStatus.PENDING, BookingStatus.ACCEPTED];
    if (!cancellableStatuses.includes(booking.status as BookingStatus)) {
      throw new BadRequestException(
        'Booking cannot be cancelled at this stage',
      );
    }

    if (booking.userId !== requesterId && booking.workerId !== requesterId) {
      throw new ForbiddenException('Cannot cancel this booking');
    }

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CANCELLED, cancelReason: reason },
    });

    this.eventEmitter.emit(EVENTS.BOOKING_CANCELLED, {
      bookingId,
      bookingNumber: booking.bookingNumber,
      userId: booking.userId,
      workerId: booking.workerId ?? undefined,
      cancelReason: reason,
      refundTo: refundTo ?? 'ORIGINAL',
    });

    return { message: 'Booking cancelled successfully' };
  }

  async getTodayJobs(workerId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const bookings = await this.prisma.booking.findMany({
      where: {
        workerId,
        scheduledDate: { gte: today, lt: tomorrow },
        status: { in: [BookingStatus.ACCEPTED, BookingStatus.IN_PROGRESS] },
      },
      include: {
        user: { select: { name: true, phone: true } },
        address: true,
        items: { include: { service: { select: { name: true } } } },
      },
      orderBy: { scheduledTime: 'asc' },
    });
    return { data: bookings };
  }

  async getUpcomingJobs(workerId: string) {
    const now = new Date();
    const bookings = await this.prisma.booking.findMany({
      where: {
        workerId,
        scheduledDate: { gte: now },
        status: BookingStatus.ACCEPTED,
      },
      include: {
        user: { select: { name: true, phone: true } },
        address: true,
        items: { include: { service: { select: { name: true } } } },
      },
      orderBy: { scheduledDate: 'asc' },
    });
    return { data: bookings };
  }

  async getPendingJobsForWorker(workerId: string) {
    // New bookings matching worker's services that haven't been assigned yet
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      include: { services: { select: { serviceId: true } } },
    });
    if (!worker) throw new NotFoundException('Worker not found');

    const serviceIds = worker.services.map((s) => s.serviceId);

    // A worker who hasn't selected any services yet would otherwise match
    // an empty `in: []` filter, which silently returns zero rows and looks
    // like "the app is broken" rather than "you haven't set up services".
    if (serviceIds.length === 0) {
      return { data: [], meta: { reason: 'NO_SERVICES_SELECTED' } };
    }

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PENDING,
        workerId: null,
        items: { some: { serviceId: { in: serviceIds } } },
        declines: { none: { workerId } },
      },
      include: {
        items: { include: { service: { select: { name: true } } } },
        address: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return { data: bookings };
  }
}
