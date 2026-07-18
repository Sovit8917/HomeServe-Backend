import 'dotenv/config';
import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SendOtpDto, VerifyOtpDto, AdminLoginDto } from './dto/auth.dto';
import { Role } from '../../common/enums';
import twilio from 'twilio';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  private twilioClient: twilio.Twilio;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {
    this.twilioClient = twilio(
      config.get('TWILIO_ACCOUNT_SID'),
      config.get('TWILIO_AUTH_TOKEN'),
    );
    console.log('OTP_BYPASS =', this.config.get('OTP_BYPASS'));
  }

  async sendOtp(dto: SendOtpDto) {
    const otp = this.generateOtp();
    const expiresAt = new Date(Date.now() + Number(this.config.get('OTP_EXPIRY_MINUTES', 10)) * 60 * 1000);

    // Save OTP to DB
    await this.prisma.otp.create({
      data: { phone: dto.phone, otp, expiresAt },
    });

    // Send via Twilio (skip in dev if bypass configured)
    if (this.config.get('NODE_ENV') !== 'development') {
      try {
        await this.twilioClient.messages.create({
          body: `Your OTP for Home Service is: ${otp}. Valid for ${this.config.get('OTP_EXPIRY_MINUTES', 10)} minutes.`,
          from: this.config.get('TWILIO_PHONE_NUMBER'),
          to: dto.phone,
        });
      } catch (err: any) {
        // Twilio error codes worth knowing while debugging "OTP not received":
        //  21211 - invalid 'to' phone number (missing/wrong country code)
        //  21608 - unverified number on a Twilio trial account
        //  21610 - recipient has unsubscribed from messages
        //  21614 - not a valid SMS-capable number
        // Also check DLT/sender-ID registration if targeting Indian numbers —
        // carriers block undelivered messages silently regardless of Twilio's
        // own status, and Twilio itself will not throw for that case.
        this.logger.error(
          `Twilio OTP send failed for ${dto.phone}: [${err?.code}] ${err?.message}`,
        );
        throw new BadRequestException(
          'Failed to send OTP. Please check the phone number and try again.',
        );
      }
    }

    return {
      message: 'OTP sent successfully',
      // Only expose in dev
      ...(this.config.get('NODE_ENV') === 'development' && { otp }),
    };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const role = dto.role || Role.CUSTOMER;

    // Bypass OTP for development
    const bypassOtp = this.config.get('OTP_BYPASS');
    const isValid =
      dto.otp === bypassOtp ||
      (await this.validateOtp(dto.phone, dto.otp));

    if (!isValid) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    // Mark OTP as used
    await this.prisma.otp.updateMany({
      where: { phone: dto.phone, otp: dto.otp, verified: false },
      data: { verified: true },
    });

    if (role === Role.WORKER) {
      return this.handleWorkerAuth(dto.phone);
    }
    return this.handleUserAuth(dto.phone, role);
  }

  private async handleUserAuth(phone: string, role: Role) {
    let user = await this.prisma.user.findUnique({ where: { phone } });
    let isNew = false;

    if (!user) {
      user = await this.prisma.user.create({
        data: { phone, role },
      });
      // Create wallet for new user
      await this.prisma.wallet.create({ data: { userId: user.id } });
      isNew = true;
    }

    const token = this.generateToken(user.id, user.role);
    return { message: 'Login successful', data: { token, user, isNew } };
  }

  private async handleWorkerAuth(phone: string) {
    let worker = await this.prisma.worker.findUnique({ where: { phone } });
    let isNew = false;

    if (!worker) {
      worker = await this.prisma.worker.create({ data: { phone } });
      await this.prisma.workerWallet.create({ data: { workerId: worker.id } });
      isNew = true;
    }

    const token = this.generateToken(worker.id, Role.WORKER);
    return { message: 'Login successful', data: { token, worker, isNew } };
  }

  private async validateOtp(phone: string, otp: string): Promise<boolean> {
    const record = await this.prisma.otp.findFirst({
      where: {
        phone,
        otp,
        verified: false,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return !!record;
  }

  async adminLogin(dto: AdminLoginDto) {
  const admin = await this.prisma.user.findUnique({
    where: { email: dto.email },
  });

  if (!admin || admin.role !== Role.ADMIN) {
    throw new UnauthorizedException('Invalid email or password');
  }
  if (!admin.password) {
    throw new UnauthorizedException('Invalid email or password');
  }

  const isMatch = await bcrypt.compare(dto.password, admin.password);
  if (!isMatch) {
    throw new UnauthorizedException('Invalid email or password');
  }
  if (admin.isBlocked || !admin.isActive) {
    throw new UnauthorizedException('Account is disabled');
  }

  const token = this.generateToken(admin.id, admin.role);
  return { message: 'Login successful', data: { token, user: admin } };
}

  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private generateToken(id: string, role: string): string {
    return this.jwtService.sign({ sub: id, role });
  }

  async refreshToken(userId: string, role: string) {
    const token = this.generateToken(userId, role);
    return { data: { token } };
  }
}
