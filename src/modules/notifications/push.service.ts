import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private enabled = false;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    const projectId = this.config.get<string>('firebase.projectId');
    const clientEmail = this.config.get<string>('firebase.clientEmail');
    const privateKey = this.config.get<string>('firebase.privateKey');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase credentials not configured — push notifications are disabled (in-app notifications still work).',
      );
      return;
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }

    this.enabled = true;
  }

  /**
   * Sends a push notification to a single device token. Never throws —
   * push delivery failures must not break the calling business logic
   * (e.g. booking creation), they're just logged.
   */
  async sendToToken(
    token: string | null | undefined,
    payload: {
      title: string;
      body: string;
      data?: Record<string, string>;
      imageUrl?: string;
    },
  ): Promise<void> {
    if (!this.enabled || !token) return;

    try {
      await admin.messaging().send({
        token,
        notification: {
          title: payload.title,
          body: payload.body,
          ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
        },
        data: payload.data ?? {},
        android: {
          priority: 'high',
          ...(payload.imageUrl && {
            notification: { imageUrl: payload.imageUrl },
          }),
        },
        apns: {
          payload: { aps: { sound: 'default' } },
          ...(payload.imageUrl && {
            fcmOptions: { imageUrl: payload.imageUrl },
          }),
        },
      });
    } catch (err: any) {
      // Common benign case: token expired/uninstalled — just log, don't throw.
      this.logger.warn(`Push send failed: ${err?.message ?? err}`);
    }
  }
}
