import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { EVENTS } from '../../common/events/events.constants';
import { BookingsService } from '../bookings/bookings.service';
import { CreateBookingDto } from '../bookings/dto/create-booking.dto';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';

@Injectable()
export class PaymentsService {
  private razorpay: Razorpay;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private eventEmitter: EventEmitter2,
    private bookingsService: BookingsService,
  ) {
    this.razorpay = new Razorpay({
      key_id: config.get<string>('RAZORPAY_KEY_ID', ''),
      key_secret: config.get<string>('RAZORPAY_KEY_SECRET', ''),
    });
  }

  /**
   * Online-payment entry point: prices the booking and opens a Razorpay
   * order WITHOUT creating a Booking row yet. The booking only comes into
   * existence once payment is confirmed (see finalizeFromDraft), so an
   * abandoned/failed checkout never leaves a phantom booking behind.
   * Cash-on-delivery bypasses this entirely and calls bookings.create()
   * directly, since there's nothing to wait on.
   */
  async createOrderForNewBooking(userId: string, dto: CreateBookingDto) {
    const computed = await this.bookingsService.computeOrderAmounts(dto, userId);

    const order = await this.razorpay.orders.create({
      amount: Math.round(computed.finalAmount * 100),
      currency: 'INR',
      receipt: `HS-draft-${Date.now()}`,
    });

    await this.prisma.pendingBooking.create({
      data: {
        userId,
        razorpayOrderId: order.id,
        addressId: dto.addressId,
        scheduledDate: new Date(dto.scheduledDate),
        scheduledTime: dto.scheduledTime,
        description: dto.description,
        images: dto.images ?? [],
        items: computed.items,
        couponId: computed.couponId,
        totalAmount: computed.totalAmount,
        discountAmount: computed.discountAmount,
        taxAmount: computed.taxAmount,
        finalAmount: computed.finalAmount,
      },
    });

    return {
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: this.config.get('RAZORPAY_KEY_ID'),
      },
    };
  }

  /**
   * Turns a paid Razorpay order into a real booking. Called from both the
   * client's verifyPayment() call and the payment.captured webhook — safe
   * to call from both, since only whichever call arrives first actually
   * claims the draft (via the deleteMany race below) and creates the
   * booking; the other becomes a no-op that returns the same result.
   */
  private async finalizeFromDraft(
    razorpayOrderId: string,
    paymentInfo: { razorpayPaymentId: string; razorpaySignature?: string; method?: string },
    opts: { throwIfMissing?: boolean } = {},
  ) {
    const existingPayment = await this.prisma.payment.findFirst({
      where: { razorpayOrderId },
      include: { booking: { include: { items: { include: { service: true } }, address: true } } },
    });
    if (existingPayment?.status === 'SUCCESS') {
      return existingPayment.booking;
    }

    const draft = await this.prisma.pendingBooking.findUnique({ where: { razorpayOrderId } });
    if (!draft) {
      if (opts.throwIfMissing) {
        throw new NotFoundException('No pending booking found for this payment order');
      }
      return null;
    }

    // Whichever caller (client verify vs. webhook) actually deletes the
    // draft "wins" and creates the booking; the loser sees count === 0
    // and just reads back the booking the winner already created.
    const claimed = await this.prisma.pendingBooking.deleteMany({ where: { id: draft.id } });
    if (claimed.count === 0) {
      const payment = await this.prisma.payment.findFirst({
        where: { razorpayOrderId },
        include: { booking: { include: { items: { include: { service: true } }, address: true } } },
      });
      return payment?.booking ?? null;
    }

    return this.bookingsService.createFromPaidDraft(draft, paymentInfo);
  }

  async createOrder(bookingId: string, userId: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, userId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const order = await this.razorpay.orders.create({
      amount: Math.round(booking.finalAmount * 100),
      currency: 'INR',
      receipt: booking.bookingNumber,
    });

    await this.prisma.payment.upsert({
      where: { bookingId },
      update: { razorpayOrderId: order.id },
      create: { bookingId, amount: booking.finalAmount, method: 'UPI', razorpayOrderId: order.id },
    });

    return {
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: this.config.get('RAZORPAY_KEY_ID'),
        bookingNumber: booking.bookingNumber,
      },
    };
  }

  /**
   * Verifies a payment for the new pre-booking flow (no bookingId exists
   * yet — the booking is created here, from the draft, on success).
   * `bookingId` is intentionally NOT part of this dto: it doesn't exist
   * until this call succeeds.
   */
  async verifyPayment(dto: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
    method: string;
  }) {
    const body = `${dto.razorpayOrderId}|${dto.razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.config.get<string>('RAZORPAY_KEY_SECRET', ''))
      .update(body)
      .digest('hex');

    const expected = Buffer.from(expectedSignature, 'utf8');
    const received = Buffer.from(dto.razorpaySignature ?? '', 'utf8');
    const isValid =
      expected.length === received.length && crypto.timingSafeEqual(expected, received);

    if (!isValid) {
      throw new BadRequestException('Invalid payment signature');
    }

    const booking = await this.finalizeFromDraft(
      dto.razorpayOrderId,
      {
        razorpayPaymentId: dto.razorpayPaymentId,
        razorpaySignature: dto.razorpaySignature,
        method: dto.method,
      },
      { throwIfMissing: true },
    );

    return { message: 'Payment verified, booking confirmed', data: booking };
  }

  async handleRazorpayWebhook(
    rawBody: Buffer,
    payload: any,
    signature: string,
    webhookSecret: string,
  ) {
    if (!signature || !webhookSecret) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    const expected = Buffer.from(expectedSignature, 'utf8');
    const received = Buffer.from(signature, 'utf8');

    // timingSafeEqual throws if buffer lengths differ, and a length
    // mismatch itself means "not a match" — so treat that as invalid
    // rather than letting the exception bubble up as a 500.
    const isValid =
      expected.length === received.length && crypto.timingSafeEqual(expected, received);

    if (!isValid) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = payload.event;
    const paymentEntity = payload.payload?.payment?.entity;

    if (event === 'payment.captured' && paymentEntity) {
      // New flow: the booking doesn't exist yet — it's created here (or
      // by the client's verify() call, whichever arrives first) from the
      // PendingBooking draft tied to this order. throwIfMissing is false
      // because a captured event for an order this webhook doesn't
      // recognize (e.g. unrelated to bookings) should be a quiet no-op,
      // not a 400 that makes Razorpay keep retrying forever.
      await this.finalizeFromDraft(
        paymentEntity.order_id,
        { razorpayPaymentId: paymentEntity.id, method: paymentEntity.method },
        { throwIfMissing: false },
      );
    }

    if (event === 'refund.processed' && paymentEntity) {
      const payment = await this.prisma.payment.findFirst({
        where: { razorpayPaymentId: paymentEntity.payment_id },
        include: { booking: { select: { bookingNumber: true, userId: true } } },
      });

      if (payment) {
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'REFUNDED',
            refundId: paymentEntity.id,
            refundAmount: paymentEntity.amount / 100,
            refundedAt: new Date(),
          },
        });

        this.eventEmitter.emit(EVENTS.PAYMENT_REFUNDED, {
          bookingId: payment.bookingId,
          bookingNumber: payment.booking.bookingNumber,
          userId: payment.booking.userId,
          refundAmount: paymentEntity.amount / 100,
        });
      }
    }

    return { received: true };
  }

  async payCash(bookingId: string, userId: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, userId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const payment = await this.prisma.payment.upsert({
      where: { bookingId },
      update: { method: 'CASH', status: 'PENDING' },
      create: { bookingId, amount: booking.finalAmount, method: 'CASH', status: 'PENDING' },
    });

    return { message: 'Cash payment recorded', data: payment };
  }

  async payFromWallet(bookingId: string, userId: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, userId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || wallet.balance < booking.finalAmount) {
      throw new BadRequestException(`Insufficient wallet balance. Balance: ₹${wallet?.balance ?? 0}`);
    }

    await this.prisma.$transaction([
      this.prisma.wallet.update({
        where: { userId },
        data: { balance: { decrement: booking.finalAmount } },
      }),
      this.prisma.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'DEBIT',
          amount: booking.finalAmount,
          description: `Payment for booking #${booking.bookingNumber}`,
          referenceId: bookingId,
        },
      }),
      this.prisma.payment.upsert({
        where: { bookingId },
        update: { method: 'WALLET', status: 'SUCCESS' },
        create: { bookingId, amount: booking.finalAmount, method: 'WALLET', status: 'SUCCESS' },
      }),
    ]);

    this.eventEmitter.emit(EVENTS.PAYMENT_SUCCESS, {
      bookingId,
      bookingNumber: booking.bookingNumber,
      userId,
      amount: booking.finalAmount,
      method: 'WALLET',
    });

    return { message: 'Payment successful from wallet' };
  }

  async initiateRefund(bookingId: string, amount?: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { bookingId },
      include: { booking: { select: { bookingNumber: true, userId: true } } },
    });
    if (!payment || payment.status !== 'SUCCESS') {
      throw new BadRequestException('No successful payment found for refund');
    }

    const refundAmount = amount ?? payment.amount;

    if (payment.razorpayPaymentId) {
      const refund = await this.razorpay.payments.refund(payment.razorpayPaymentId, {
        amount: Math.round(refundAmount * 100),
      });
      await this.prisma.payment.update({
        where: { bookingId },
        data: { status: 'REFUNDED', refundId: refund.id, refundAmount, refundedAt: new Date() },
      });
    } else if (payment.method === 'WALLET') {
      const wallet = await this.prisma.wallet.findUnique({ where: { userId: payment.booking.userId } });
      if (wallet) {
        await this.prisma.wallet.update({
          where: { userId: payment.booking.userId },
          data: { balance: { increment: refundAmount } },
        });
        await this.prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'CREDIT',
            amount: refundAmount,
            description: `Refund for booking #${payment.booking.bookingNumber}`,
            referenceId: bookingId,
          },
        });
      }
      await this.prisma.payment.update({
        where: { bookingId },
        data: { status: 'REFUNDED', refundAmount, refundedAt: new Date() },
      });
    }

    this.eventEmitter.emit(EVENTS.PAYMENT_REFUNDED, {
      bookingId,
      bookingNumber: payment.booking.bookingNumber,
      userId: payment.booking.userId,
      refundAmount,
    });

    return { message: 'Refund initiated successfully' };
  }

  async getPaymentDetails(bookingId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { bookingId } });
    if (!payment) throw new NotFoundException('Payment not found');
    return { data: payment };
  }

  async getAllPaymentsList(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        include: {
          booking: {
            select: {
              bookingNumber: true,
              user: { select: { name: true, phone: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payment.count(),
    ]);
    return { data: { payments, total, page, limit } };
  }
}