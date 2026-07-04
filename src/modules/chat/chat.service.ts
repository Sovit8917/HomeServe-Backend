import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private chatGateway: ChatGateway,
  ) {}

  async getMessages(bookingId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const messages = await this.prisma.chatMessage.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    });
    return { data: messages };
  }

  async sendMessage(
    bookingId: string,
    senderId: string,
    senderRole: string,
    message: string,
  ) {
    if (!message?.trim()) {
      throw new ForbiddenException('Message cannot be empty');
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { userId: true, workerId: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const isParticipant = booking.userId === senderId || booking.workerId === senderId;
    if (!isParticipant) throw new ForbiddenException('Not part of this booking');

    const chatMessage = await this.prisma.chatMessage.create({
      data: {
        bookingId,
        senderId,
        senderType: senderRole,
        message: message.trim(),
      },
    });

    // Push instantly to anyone connected over the socket (e.g. the customer
    // app watching this booking's chat room); the worker app itself also
    // picks this up on its next 3s poll regardless.
    this.chatGateway.broadcastToBooking(bookingId, 'new-message', chatMessage);

    return { data: chatMessage };
  }

  async getBookingChats(userId: string, role: string) {
    const bookings = await this.prisma.booking.findMany({
      where: role === 'WORKER' ? { workerId: userId } : { userId },
      include: {
        chatMessages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        user: { select: { name: true, avatar: true } },
        worker: { select: { name: true, avatar: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return { data: bookings };
  }

  async getUnreadCount(bookingId: string, userId: string) {
    const count = await this.prisma.chatMessage.count({
      where: { bookingId, senderId: { not: userId }, isRead: false },
    });
    return { data: { count } };
  }
}