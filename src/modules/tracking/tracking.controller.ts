import {
  Controller,
  Get,
  Param,
  ForbiddenException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

@ApiTags('Tracking')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tracking')
export class TrackingController {
  constructor(private prisma: PrismaService) {}

  /**
   * Last-known worker location for a booking, for the initial screen
   * render before the socket connects (or if the socket briefly drops).
   * Same authorization rule as the socket: only the booking's customer,
   * its assigned worker, or an admin can see it.
   */
  @Get('booking/:bookingId')
  @ApiOperation({ summary: 'Get last known worker location for a booking' })
  async getLastLocation(
    @CurrentUser('id') requesterId: string,
    @CurrentUser('role') requesterRole: string,
    @Param('bookingId') bookingId: string,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { userId: true, workerId: true, status: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const isAuthorized =
      requesterRole === 'ADMIN' ||
      (requesterRole === 'CUSTOMER' && booking.userId === requesterId) ||
      (requesterRole === 'WORKER' && booking.workerId === requesterId);
    if (!isAuthorized) {
      throw new ForbiddenException('Not authorized to view this booking');
    }

    const latest = await this.prisma.workerTracking.findFirst({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      bookingStatus: booking.status,
      location: latest
        ? {
            latitude: latest.latitude,
            longitude: latest.longitude,
            updatedAt: latest.createdAt,
          }
        : null,
    };
  }
}
