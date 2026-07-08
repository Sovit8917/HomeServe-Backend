import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateWorkerDto } from './dto/update-worker.dto';

@Injectable()
export class WorkersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(workerId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      include: { skills: true, documents: true, bankDetail: true, services: { include: { service: true } } },
    });
    if (!worker) throw new NotFoundException('Worker not found');
    return { data: worker };
  }

  async updateProfile(workerId: string, dto: UpdateWorkerDto) {
    const worker = await this.prisma.worker.update({
      where: { id: workerId },
      data: dto,
    });
    return { message: 'Profile updated', data: worker };
  }

  async updateLocation(workerId: string, latitude: number, longitude: number) {
    await this.prisma.worker.update({
      where: { id: workerId },
      data: { latitude, longitude, isOnline: true },
    });
    return { message: 'Location updated' };
  }

  async setOnlineStatus(workerId: string, isOnline: boolean) {
    await this.prisma.worker.update({ where: { id: workerId }, data: { isOnline } });
    return { message: `Status set to ${isOnline ? 'online' : 'offline'}` };
  }

  async uploadDocument(workerId: string, type: string, url: string) {
    const doc = await this.prisma.workerDocument.create({
      data: { workerId, type, url },
    });
    return { message: 'Document uploaded', data: doc };
  }

  async getDocuments(workerId: string) {
    const docs = await this.prisma.workerDocument.findMany({ where: { workerId } });
    return { data: docs };
  }

  async updateBankDetails(workerId: string, data: any) {
    const bankDetail = await this.prisma.bankDetail.upsert({
      where: { workerId },
      update: data,
      create: { ...data, workerId },
    });
    return { message: 'Bank details updated', data: bankDetail };
  }

  async updateSkills(workerId: string, skills: string[]) {
    await this.prisma.workerSkill.deleteMany({ where: { workerId } });
    await this.prisma.workerSkill.createMany({
      data: skills.map((skill) => ({ workerId, skill })),
    });
    return { message: 'Skills updated' };
  }

  async updateServices(workerId: string, serviceIds: string[]) {
    await this.prisma.workerService.deleteMany({ where: { workerId } });
    await this.prisma.workerService.createMany({
      data: serviceIds.map((serviceId) => ({ workerId, serviceId })),
    });
    return { message: 'Services updated' };
  }

  async getWorkingHours(workerId: string) {
    const hours = await this.prisma.workingHour.findMany({ where: { workerId } });
    return { data: hours };
  }

  async setWorkingHours(workerId: string, hours: any[]) {
    for (const h of hours) {
      await this.prisma.workingHour.upsert({
        where: { workerId_dayOfWeek: { workerId, dayOfWeek: h.dayOfWeek } },
        update: h,
        create: { ...h, workerId },
      });
    }
    return { message: 'Working hours updated' };
  }

  async setAvailability(workerId: string, date: Date, isOff: boolean) {
    const availability = await this.prisma.availability.create({
      data: { workerId, date, isOff },
    });
    return { message: 'Availability set', data: availability };
  }

  async getPublicWorker(workerId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: {
        id: true, name: true, avatar: true, rating: true, totalJobs: true,
        latitude: true, longitude: true, skills: true, experience: true,
        bio: true, isOnline: true, totalReviews: true, status: true,
      },
    });
    if (!worker) throw new NotFoundException('Worker not found');
    return { data: worker };
  }

  async getReviews(workerId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where: { workerId },
        include: { user: { select: { name: true, avatar: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.review.count({ where: { workerId } }),
    ]);
    return { data: { reviews, total, page, limit } };
  }

  async getNearbyWorkers(latitude: number, longitude: number, serviceId?: string) {
    // Basic nearby query — for production use PostGIS extension
    const workers = await this.prisma.worker.findMany({
      where: {
        isOnline: true,
        isActive: true,
        status: 'APPROVED',
        ...(serviceId && { services: { some: { serviceId } } }),
      },
      select: {
        id: true, name: true, avatar: true, rating: true,
        totalJobs: true, latitude: true, longitude: true,
        serviceRadius: true, skills: true, status: true,
      },
    });

    // Filter by distance (Haversine)
    return {
      data: workers.filter((w) => {
        if (!w.latitude || !w.longitude) return false;
        const dist = this.haversine(latitude, longitude, w.latitude, w.longitude);
        return dist <= (w.serviceRadius || 10);
      }),
    };
  }

  private haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
