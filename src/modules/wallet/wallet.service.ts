import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WalletService {
  constructor(private prisma: PrismaService) {}

  // ─── Customer Wallet ───────────────────────────────────────────

  async getCustomerWallet(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return { data: wallet };
  }

  async getCustomerTransactions(userId: string, page = 1, limit = 20) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.transaction.count({ where: { walletId: wallet.id } }),
    ]);
    return { data: { transactions, total, page, limit } };
  }

  async addMoneyToWallet(userId: string, amount: number, referenceId?: string) {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');

    const wallet = await this.prisma.wallet.update({
      where: { userId },
      data: { balance: { increment: amount } },
    });

    await this.prisma.transaction.create({
      data: {
        walletId: wallet.id,
        type: 'CREDIT',
        amount,
        description: 'Money added to wallet',
        referenceId,
      },
    });

    return { message: 'Wallet credited', data: { balance: wallet.balance } };
  }

  // ─── Worker Wallet ─────────────────────────────────────────────

  async getWorkerWallet(workerId: string) {
    const wallet = await this.prisma.workerWallet.findUnique({
      where: { workerId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return { data: wallet };
  }

  async getWorkerTransactions(workerId: string, page = 1, limit = 20) {
    const wallet = await this.prisma.workerWallet.findUnique({ where: { workerId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { workerWalletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.transaction.count({ where: { workerWalletId: wallet.id } }),
    ]);
    return { data: { transactions, total, page, limit } };
  }

  async getWorkerEarnings(workerId: string, period: 'today' | 'week' | 'month' = 'today') {
    const now = new Date();
    let from: Date;

    if (period === 'today') {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === 'week') {
      from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const earnings = await this.prisma.earning.aggregate({
      where: { workerId, date: { gte: from } },
      _sum: { amount: true, commission: true, netAmount: true },
      _count: true,
    });

    const earningList = await this.prisma.earning.findMany({
      where: { workerId, date: { gte: from } },
      orderBy: { date: 'desc' },
    });

    return {
      data: {
        period,
        totalAmount: earnings._sum.amount || 0,
        totalCommission: earnings._sum.commission || 0,
        netEarnings: earnings._sum.netAmount || 0,
        totalJobs: earnings._count,
        earnings: earningList,
      },
    };
  }

  async withdrawMoney(workerId: string, amount: number) {
    const wallet = await this.prisma.workerWallet.findUnique({ where: { workerId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.balance < amount) throw new BadRequestException('Insufficient balance');

    const bankDetail = await this.prisma.bankDetail.findUnique({ where: { workerId } });
    if (!bankDetail) throw new BadRequestException('Bank details not set up');

    const updated = await this.prisma.workerWallet.update({
      where: { workerId },
      data: { balance: { decrement: amount } },
    });

    await this.prisma.transaction.create({
      data: {
        workerWalletId: wallet.id,
        type: 'DEBIT',
        amount,
        description: `Withdrawal to ${bankDetail.bankName} ****${bankDetail.accountNumber.slice(-4)}`,
      },
    });

    return {
      message: 'Withdrawal initiated. Will be processed in 1-2 business days.',
      data: { newBalance: updated.balance },
    };
  }
}
