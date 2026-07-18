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

interface SocketPrincipal {
  id: string;
  role: 'CUSTOMER' | 'WORKER' | 'ADMIN';
}

// Only write a location row to the DB (and update Worker.lat/lng) at most
// this often per worker, even if the phone sends updates every second.
// The live broadcast to watchers still happens on every message —
// this only throttles what gets persisted, so WorkerTracking doesn't
// grow into millions of rows over a few months of operation.
const MIN_PERSIST_INTERVAL_MS = 15_000;

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/tracking',
})
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private connectedUsers = new Map<string, SocketPrincipal>(); // socketId → principal
  private lastPersistedAt = new Map<string, number>(); // workerId → timestamp

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(socket: Socket) {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];
      const payload = this.jwtService.verify(token, {
        secret: this.config.get('JWT_SECRET'),
      });
      this.connectedUsers.set(socket.id, { id: payload.sub, role: payload.role });
    } catch {
      socket.disconnect();
    }
  }

  handleDisconnect(socket: Socket) {
    this.connectedUsers.delete(socket.id);
  }

  @SubscribeMessage('worker:location')
  async handleWorkerLocation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { bookingId: string; latitude: number; longitude: number },
  ) {
    const principal = this.connectedUsers.get(socket.id);
    if (!principal || principal.role !== 'WORKER') return;
    const workerId = principal.id;

    // Only the worker actually assigned to this booking may push a
    // location for it — otherwise any worker could spoof another
    // worker's booking location.
    const booking = await this.prisma.booking.findUnique({
      where: { id: data.bookingId },
      select: { workerId: true, status: true },
    });
    if (!booking || booking.workerId !== workerId) return;
    if (!['ACCEPTED', 'IN_PROGRESS'].includes(booking.status)) return;

    // Always broadcast live to whoever is watching this booking...
    this.server.to(`track:${data.bookingId}`).emit('location:update', {
      workerId,
      latitude: data.latitude,
      longitude: data.longitude,
      timestamp: new Date(),
    });

    // ...but only persist to the DB at a throttled interval.
    const now = Date.now();
    const last = this.lastPersistedAt.get(workerId) ?? 0;
    if (now - last < MIN_PERSIST_INTERVAL_MS) return;
    this.lastPersistedAt.set(workerId, now);

    await this.prisma.worker.update({
      where: { id: workerId },
      data: { latitude: data.latitude, longitude: data.longitude },
    });

    await this.prisma.workerTracking.create({
      data: {
        bookingId: data.bookingId,
        workerId,
        latitude: data.latitude,
        longitude: data.longitude,
      },
    });
  }

  @SubscribeMessage('track:booking')
  async handleTrackBooking(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { bookingId: string },
  ) {
    const principal = this.connectedUsers.get(socket.id);
    if (!principal) return;

    // Prevent any logged-in user from watching an arbitrary booking —
    // only that booking's own customer, its assigned worker, or an
    // admin may join its tracking room.
    const booking = await this.prisma.booking.findUnique({
      where: { id: data.bookingId },
      select: { userId: true, workerId: true },
    });
    if (!booking) return;

    const isAuthorized =
      principal.role === 'ADMIN' ||
      (principal.role === 'CUSTOMER' && booking.userId === principal.id) ||
      (principal.role === 'WORKER' && booking.workerId === principal.id);
    if (!isAuthorized) return;

    socket.join(`track:${data.bookingId}`);
  }

  @SubscribeMessage('track:stop')
  handleStopTracking(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { bookingId: string },
  ) {
    socket.leave(`track:${data.bookingId}`);
  }

  // Emit booking events to specific users
  emitBookingEvent(bookingId: string, event: string, data: any) {
    this.server.to(`track:${bookingId}`).emit(event, data);
  }
}
