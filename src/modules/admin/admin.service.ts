import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENTS } from '../../common/events/events.constants';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  // ─── Admin Auth ────────────────────────────────────────────────

  async seedAdmin(email: string, password: string, name: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException('Admin already exists');

    const hashed = await bcrypt.hash(password, 10);
    const admin = await this.prisma.user.create({
      data: { phone: email, email, name, role: 'ADMIN', password: hashed },
    });
    return { message: 'Admin created', data: { id: admin.id, email } };
  }

  // ─── Customer Management ───────────────────────────────────────

  async getCustomers(search?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = search
      ? {
          role: 'CUSTOMER' as const,
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : { role: 'CUSTOMER' as const };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { _count: { select: { bookings: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { data: { users, total, page, limit } };
  }

  async getCustomerDetails(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        bookings: {
          include: { items: { include: { service: { select: { name: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        wallet: true,
        _count: { select: { bookings: true, reviews: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return { data: user };
  }

  async blockUser(userId: string, isBlocked: boolean) {
    await this.prisma.user.update({ where: { id: userId }, data: { isBlocked } });
    return { message: `User ${isBlocked ? 'blocked' : 'unblocked'}` };
  }

  // ─── Worker Management ─────────────────────────────────────────

  async getWorkers(status?: string, search?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }

    const [workers, total] = await Promise.all([
      this.prisma.worker.findMany({
        where,
        include: {
          documents: true,
          services: { include: { service: { select: { name: true } } } },
          _count: { select: { bookings: true, reviews: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.worker.count({ where }),
    ]);
    return { data: { workers, total, page, limit } };
  }

  async getWorkerDetails(workerId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      include: {
        documents: true,
        skills: true,
        bankDetail: true,
        services: { include: { service: true } },
        earnings: { orderBy: { date: 'desc' }, take: 10 },
        wallet: true,
        reviews: { include: { user: { select: { name: true } } }, take: 5 },
        _count: { select: { bookings: true, reviews: true } },
      },
    });
    if (!worker) throw new NotFoundException('Worker not found');
    return { data: worker };
  }

  async updateWorkerStatus(workerId: string, status: 'APPROVED' | 'REJECTED' | 'SUSPENDED') {
    const worker = await this.prisma.worker.update({
      where: { id: workerId },
      data: { status },
    });
    if (status === 'APPROVED') {
      this.eventEmitter.emit(EVENTS.WORKER_APPROVED, {
        workerId,
        workerName: worker.name ?? '',
        workerPhone: worker.phone,
      });
    }
    if (status === 'APPROVED') {
      this.eventEmitter.emit(EVENTS.WORKER_APPROVED, {
        workerId,
        workerName: worker.name ?? '',
        workerPhone: worker.phone,
      });
    }
    return { message: `Worker ${status.toLowerCase()}`, data: worker };
  }

  async verifyDocument(documentId: string, isVerified: boolean) {
    await this.prisma.workerDocument.update({
      where: { id: documentId },
      data: { isVerified },
    });
    return { message: `Document ${isVerified ? 'verified' : 'rejected'}` };
  }

  // ─── Booking Management ────────────────────────────────────────

  async getAllBookings(status?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = status ? { status: status as any } : {};

    const [bookings, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: {
          user: { select: { name: true, phone: true } },
          worker: { select: { name: true, phone: true } },
          items: { include: { service: { select: { name: true } } } },
          payment: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);
    return { data: { bookings, total, page, limit } };
  }

  async assignWorker(bookingId: string, workerId: string) {
    const booking = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { workerId, status: 'ACCEPTED' },
    });
    return { message: 'Worker assigned', data: booking };
  }

  async cancelBookingAdmin(bookingId: string, reason: string) {
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CANCELLED', cancelReason: reason },
    });
    return { message: 'Booking cancelled' };
  }

  // ─── Settings ──────────────────────────────────────────────────

  async getSettings() {
    const settings = await this.prisma.appSetting.findMany();
    const result = settings.reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {});
    return { data: result };
  }

  async updateSetting(key: string, value: string) {
    const setting = await this.prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    return { message: 'Setting updated', data: setting };
  }

  async updateSettings(settings: Record<string, string>) {
    for (const [key, value] of Object.entries(settings)) {
      await this.prisma.appSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }
    return { message: 'Settings updated' };
  }


// ─── Banners ───────────────────────────────────────────────────

  async getBanners(activeOnly = true) {
    const banners = await this.prisma.banner.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { sortOrder: 'asc' },
    });
    return { data: banners };
  }

  private validateBannerInput(data: {
    title?: string;
    image?: string;
    startDate?: string | Date | null;
    endDate?: string | Date | null;
  }) {
    if (data.title !== undefined && !data.title?.trim()) {
      throw new BadRequestException('Banner title is required');
    }
    if (data.image !== undefined) {
      const image = data.image?.trim();
      if (!image) throw new BadRequestException('Banner image is required');
      const looksLikeUrl = /^https?:\/\//i.test(image) || image.startsWith('/');
      if (!looksLikeUrl) {
        throw new BadRequestException('Banner image must be a valid URL or uploaded file path');
      }
    }
    if (data.startDate && data.endDate) {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);
      if (start >= end) {
        throw new BadRequestException('Banner end date must be after the start date');
      }
    }
  }

  async createBanner(data: {
    title: string;
    image: string;
    link?: string;
    sortOrder?: number;
    isActive?: boolean;
    startDate?: string | null;
    endDate?: string | null;
  }) {
    this.validateBannerInput(data);
    const banner = await this.prisma.banner.create({
      data: {
        title: data.title.trim(),
        image: data.image.trim(),
        link: data.link?.trim() || null,
        sortOrder: data.sortOrder ?? 0,
        isActive: data.isActive ?? true,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
      },
    });
    return { message: 'Banner created', data: banner };
  }

  async updateBanner(id: string, data: any) {
    this.validateBannerInput(data);
    const banner = await this.prisma.banner.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title.trim() } : {}),
        ...(data.image !== undefined ? { image: data.image.trim() } : {}),
        ...(data.link !== undefined ? { link: data.link?.trim() || null } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.startDate !== undefined
          ? { startDate: data.startDate ? new Date(data.startDate) : null }
          : {}),
        ...(data.endDate !== undefined
          ? { endDate: data.endDate ? new Date(data.endDate) : null }
          : {}),
      },
    });
    return { message: 'Banner updated', data: banner };
  }

  async deleteBanner(id: string) {
  // ─── Payment Management ────────────────────────────────────────

  async getAllPayments(status?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = status ? { status: status as any } : {};

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: {
          booking: {
            include: {
              user: { select: { name: true, phone: true } },
              worker: { select: { name: true, phone: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { data: { payments, total, page, limit } };
  }

  async getWorkerWallets(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [wallets, total] = await Promise.all([
      this.prisma.workerWallet.findMany({
        include: { worker: { select: { name: true, phone: true } } },
        orderBy: { balance: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.workerWallet.count(),
    ]);
    return { data: { wallets, total, page, limit } };
  }
}
