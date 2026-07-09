import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';

@ApiTags('Wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('wallet')
export class WalletController {
  constructor(private walletService: WalletService) {}

  // ─── Customer ──────────────────────────────────────────────────

  @Roles(Role.CUSTOMER)
  @Get()
  getCustomerWallet(@CurrentUser('id') userId: string) {
    return this.walletService.getCustomerWallet(userId);
  }

  @Roles(Role.CUSTOMER)
  @Get('transactions')
  getCustomerTransactions(
    @CurrentUser('id') userId: string,
    @Query('page') page: number,
    @Query('limit') limit: number,
  ) {
    return this.walletService.getCustomerTransactions(userId, +page || 1, +limit || 20);
  }

  @Roles(Role.CUSTOMER)
  @Post('topup/create-order')
  createTopupOrder(@CurrentUser('id') userId: string, @Body('amount') amount: number) {
    return this.walletService.createTopupOrder(userId, +amount);
  }

  @Roles(Role.CUSTOMER)
  @Post('topup/verify')
  verifyTopup(
    @CurrentUser('id') userId: string,
    @Body()
    dto: {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
      amount: number;
    },
  ) {
    return this.walletService.verifyTopup(userId, dto);
  }

  // ─── Worker ────────────────────────────────────────────────────

  @Roles(Role.WORKER)
  @Get('worker')
  getWorkerWallet(@CurrentUser('id') workerId: string) {
    return this.walletService.getWorkerWallet(workerId);
  }

  @Roles(Role.WORKER)
  @Get('worker/transactions')
  getWorkerTransactions(
    @CurrentUser('id') workerId: string,
    @Query('page') page: number,
    @Query('limit') limit: number,
  ) {
    return this.walletService.getWorkerTransactions(workerId, +page || 1, +limit || 20);
  }

  @Roles(Role.WORKER)
  @Get('worker/earnings')
  getWorkerEarnings(
    @CurrentUser('id') workerId: string,
    @Query('period') period: 'today' | 'week' | 'month',
  ) {
    return this.walletService.getWorkerEarnings(workerId, period || 'today');
  }

  @Roles(Role.WORKER)
  @Post('worker/withdraw')
  withdrawMoney(@CurrentUser('id') workerId: string, @Body('amount') amount: number) {
    return this.walletService.withdrawMoney(workerId, amount);
  }
}