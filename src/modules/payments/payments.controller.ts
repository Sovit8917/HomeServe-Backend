import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Headers,
  UseGuards,
  Req,
  BadRequestException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreateBookingDto } from '../bookings/dto/create-booking.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles, Public } from '../../common/decorators';
import { Role } from '../../common/enums';
import { ConfigService } from '@nestjs/config';

@ApiTags('Payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payments')
export class PaymentsController {
  constructor(
    private paymentsService: PaymentsService,
    private config: ConfigService,
  ) {}

  @Public()
  @Post('webhook/razorpay')
  @ApiOperation({ summary: 'Razorpay webhook endpoint (no auth)' })
  async razorpayWebhook(
    @Body() payload: any,
    @Headers('x-razorpay-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const webhookSecret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET', '');
    // Razorpay signs the raw request bytes, not the parsed/re-serialized
    // JSON object — re-stringifying `payload` can produce a different byte
    // string (key order, spacing) and make valid signatures fail to verify.
    if (!req.rawBody) {
      throw new BadRequestException('Raw body unavailable for signature verification');
    }
    return this.paymentsService.handleRazorpayWebhook(req.rawBody, payload, signature, webhookSecret);
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Post('create-order')
  @ApiOperation({
    summary: 'Create a Razorpay order for a NEW booking (booking is created only after payment succeeds)',
  })
  createOrderForNewBooking(@Body() dto: CreateBookingDto, @CurrentUser('id') userId: string) {
    return this.paymentsService.createOrderForNewBooking(userId, dto);
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Post('create-order/:bookingId')
  @ApiOperation({ summary: '[Legacy] Create Razorpay order for an existing booking' })
  createOrder(@Param('bookingId') bookingId: string, @CurrentUser('id') userId: string) {
    return this.paymentsService.createOrder(bookingId, userId);
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Post('verify')
  @ApiOperation({ summary: 'Verify Razorpay payment signature' })
  verifyPayment(@Body() dto: any) {
    return this.paymentsService.verifyPayment(dto);
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Post('cash/:bookingId')
  @ApiOperation({ summary: 'Select cash as payment method' })
  payCash(@Param('bookingId') bookingId: string, @CurrentUser('id') userId: string) {
    return this.paymentsService.payCash(bookingId, userId);
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Post('wallet/:bookingId')
  @ApiOperation({ summary: 'Pay booking from wallet balance' })
  payFromWallet(@Param('bookingId') bookingId: string, @CurrentUser('id') userId: string) {
    return this.paymentsService.payFromWallet(bookingId, userId);
  }

  @ApiBearerAuth()
  @Get(':bookingId')
  @ApiOperation({ summary: 'Get payment details for a booking' })
  getPaymentDetails(@Param('bookingId') bookingId: string) {
    return this.paymentsService.getPaymentDetails(bookingId);
  }

  @ApiBearerAuth()
  @Roles(Role.ADMIN)
  @Post('refund/:bookingId')
  @ApiOperation({ summary: 'Initiate refund (admin only)' })
  initiateRefund(@Param('bookingId') bookingId: string, @Body('amount') amount?: number) {
    return this.paymentsService.initiateRefund(bookingId, amount);
  }
}