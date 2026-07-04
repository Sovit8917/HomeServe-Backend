import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private connectedUsers = new Map<string, string>(); // socketId → userId

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(socket: Socket) {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      const payload = this.jwtService.verify(token, { secret: this.config.get('JWT_SECRET') });
      this.connectedUsers.set(socket.id, payload.sub);
      socket.join(`user:${payload.sub}`);
    } catch {
      socket.disconnect();
    }
  }

  handleDisconnect(socket: Socket) {
    this.connectedUsers.delete(socket.id);
  }

  @SubscribeMessage('join-booking')
  async handleJoinBooking(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { bookingId: string },
  ) {
    socket.join(`booking:${data.bookingId}`);
  }

  @SubscribeMessage('send-message')
  async handleMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { bookingId: string; message: string; senderType: string },
  ) {
    const senderId = this.connectedUsers.get(socket.id);
    if (!senderId) return;

    const chatMessage = await this.prisma.chatMessage.create({
      data: {
        bookingId: data.bookingId,
        senderId,
        senderType: data.senderType,
        message: data.message,
      },
    });

    this.server.to(`booking:${data.bookingId}`).emit('new-message', chatMessage);
  }

  @SubscribeMessage('mark-read')
  async handleMarkRead(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { bookingId: string },
  ) {
    const userId = this.connectedUsers.get(socket.id);
    if (!userId) return;

    await this.prisma.chatMessage.updateMany({
      where: { bookingId: data.bookingId, senderId: { not: userId } },
      data: { isRead: true },
    });
  }

  // Called from TrackingGateway or BookingsService

  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  // Lets ChatService push a REST-created message to anyone already
  // connected over the socket (e.g. a customer app watching this booking's
  // room), without requiring the sender to also be on a socket connection.
  broadcastToBooking(bookingId: string, event: string, data: any) {
    this.server?.to(`booking:${bookingId}`).emit(event, data);
  }
}
