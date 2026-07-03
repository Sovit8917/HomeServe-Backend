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
import { withBookingAlias, withBookingAliasList } from '../../common/utils/serialize.util';

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(userId: string, dto: CreateBookingDto) {
    // Validate services and calculate total
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

    // Apply coupon
    let discountAmount = 0;
    let couponId = dto.couponId;
    if (couponId) {
      const coupon = await this.prisma.coupon.findFirst({
        where: { id: couponId, isActive: true, expiresAt: { gte: new Date() } },
      });
      if (coupon && totalAmount >= coupon.minOrderValue) {
        discountAmount =
          coupon.discountType === 'percentage'
            ? Math.min((totalAmount * coupon.discountValue) / 100, coupon.maxDiscount ?? Infinity)
            : coupon.discountValue;
        await this.prisma.coupon.update({
          where: { id: couponId },
          data: { usedCount: { increment: 1 } },
        });
      } else {
        couponId = undefined;
      }
    }

    const commissionSetting = await this.prisma.appSetting.findUnique({
      where: { key: 'tax_percent' },
    });
    const taxPercent = parseFloat(commissionSetting?.value ?? '18');
    const taxAmount = ((totalAmount - discountAmount) * taxPercent) / 100;
    const finalAmount = totalAmount - discountAmount + taxAmount;

    const booking = await this.prisma.booking.create({
      data: {
        bookingNumber: `HS${Date.now()}`,
        userId,
        addressId: dto.addressId,
        scheduledDate: new Date(dto.scheduledDate),
        scheduledTime: dto.scheduledTime,
        description: dto.description,
        images: dto.images ?? [],
        totalAmount,
        discountAmount,
        taxAmount,
        finalAmount,
        couponId,
        items: { create: items },
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
      serviceNames: booking.items.map((i: any) => i.service.name),
      scheduledDate: booking.scheduledDate,
      scheduledTime: booking.scheduledTime,
      finalAmount: booking.finalAmount,
      addressCity: booking.address?.city ?? '',
    });

    return { message: 'Booking created successfully', data: withBookingAlias(booking) };
  }

  async findUserBookings(userId: string, status?: BookingStatus) {
    const bookings = await this.prisma.booking.findMany({
      where: { userId, ...(status && { status }) },
      include: {
        items: { include: { service: { select: { name: true, image: true } } } },
        worker: { select: { name: true, avatar: true, phone: true, rating: true } },
        address: true,
        payment: true,
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
    return { data: bookings };
  }

  async findOne(id: string, requesterId: string, requesterRole: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        items: { include: { service: true } },
        worker: { select: { id: true, name: true, avatar: true, phone: true, rating: true } },
        user: { select: { id: true, name: true, avatar: true, phone: true } },
        address: true,
        payment: true,
        review: true,
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');

    if (
      requesterRole !== 'ADMIN' &&
      booking.userId !== requesterId &&
      booking.workerId !== requesterId
    ) {
      throw new ForbiddenException('Access denied');
    }

    return { data: withBookingAlias(booking) };
  }

  async acceptBooking(bookingId: string, workerId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
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
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, workerId, status: BookingStatus.ACCEPTED },
    });
    if (!booking) throw new BadRequestException('Cannot reject this booking');

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.REJECTED },
    });

    this.eventEmitter.emit(EVENTS.BOOKING_REJECTED, {
      bookingId,
      bookingNumber: booking.bookingNumber,
      userId: booking.userId,
    });

    return { message: 'Booking rejected' };
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
      where: { key: 'commission_percent' },
    });
    const commissionPercent = parseFloat(commissionSetting?.value ?? '20');
    const commission = (booking.finalAmount * commissionPercent) / 100;
    const netAmount = booking.finalAmount - commission;

    await this.prisma.earning.create({
      data: { workerId, bookingId, amount: booking.finalAmount, commission, netAmount },
    });

    const workerWallet = await this.prisma.workerWallet.findUnique({ where: { workerId } });
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

  async cancelBooking(bookingId: string, requesterId: string, reason: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const cancellableStatuses = [BookingStatus.PENDING, BookingStatus.ACCEPTED];
    if (!cancellableStatuses.includes(booking.status as BookingStatus)) {
      throw new BadRequestException('Booking cannot be cancelled at this stage');
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

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PENDING,
        workerId: null,
        items: { some: { serviceId: { in: serviceIds } } },
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