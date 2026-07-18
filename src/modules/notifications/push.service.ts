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

  // FCM error codes that mean the token is permanently dead and should
  // be removed from the DB so we stop retrying it forever.
  private static readonly INVALID_TOKEN_ERROR_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
  ]);

  /**
   * Sends a push notification to a single device token.
   * Uses DATA-ONLY messages so Notifee is responsible for displaying
   * the notification and duplicate notifications are avoided.
   *
   * Returns whether the token turned out to be invalid/expired, so the
   * caller can clear it from the DB (see NotificationsService.dispatchPush).
   */
  async sendToToken(
    token: string | null | undefined,
    payload: {
      title: string;
      body: string;
      data?: Record<string, string>;
      imageUrl?: string;
    },
  ): Promise<{ sent: boolean; invalidToken: boolean }> {
    if (!this.enabled || !token) return { sent: false, invalidToken: false };

    try {
      await admin.messaging().send({
        token,

        // Data-only payload
        data: {
          title: payload.title,
          body: payload.body,
          ...(payload.imageUrl && {
            imageUrl: String(payload.imageUrl),
          }),
          ...(payload.data ?? {}),
        },

        android: {
          priority: 'high',
        },

        apns: {
          payload: {
            aps: {
              'content-available': 1,
            },
          },
        },
      });

      return { sent: true, invalidToken: false };
    } catch (err: any) {
      const code = err?.code as string | undefined;
      const invalidToken = code
        ? PushService.INVALID_TOKEN_ERROR_CODES.has(code)
        : false;

      if (invalidToken) {
        this.logger.warn(`Push token invalid/expired (${code}) — will clear it.`);
      } else {
        // Transient failure (network blip, throttling, etc.) — keep the token.
        this.logger.warn(`Push send failed: ${err?.message ?? err}`);
      }

      return { sent: false, invalidToken };
    }
  }
}
