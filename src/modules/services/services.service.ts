import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { withServiceAlias, withServiceAliasList } from '../../common/utils/serialize.util';

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService) {}

  async findAll(categoryId?: string, search?: string) {
    const services = await this.prisma.service.findMany({
      where: {
        isActive: true,
        ...(categoryId && { categoryId }),
        ...(search && { name: { contains: search, mode: 'insensitive' } }),
      },
      include: { category: { select: { name: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    return { data: withServiceAliasList(services) };
  }

  async findOne(id: string) {
    const service = await this.prisma.service.findUnique({
      where: { id },
      include: {
        category: true,
        workerServices: {
          include: {
            worker: {
              select: { id: true, name: true, avatar: true, rating: true, totalJobs: true },
            },
          },
          where: { worker: { isActive: true, status: 'APPROVED' } },
        },
      },
    });
    if (!service) throw new NotFoundException('Service not found');
    return { data: withServiceAlias(service) };
  }

  async getPopular() {
    const services = await this.prisma.service.findMany({
      where: { isActive: true },
      include: {
        category: { select: { name: true } },
        _count: { select: { bookingItems: true } },
      },
      orderBy: { bookingItems: { _count: 'desc' } },
      take: 10,
    });
    return { data: withServiceAliasList(services) };
  }

  async create(data: any) {
    const service = await this.prisma.service.create({
      data,
      include: { category: true },
    });
    return { message: 'Service created', data: service };
  }

  async update(id: string, data: any) {
    const service = await this.prisma.service.update({ where: { id }, data });
    return { message: 'Service updated', data: service };
  }

  async remove(id: string) {
    await this.prisma.service.update({ where: { id }, data: { isActive: false } });
    return { message: 'Service deleted' };
  }
}