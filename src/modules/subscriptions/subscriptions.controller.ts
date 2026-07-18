import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';

@ApiTags('Subscriptions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private subscriptionsService: SubscriptionsService) {}

  @Public()
  @Get('plans')
  @ApiOperation({ summary: 'List active subscription plans' })
  getActivePlans() {
    return this.subscriptionsService.getActivePlans();
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Get('my')
  @ApiOperation({ summary: "Get the customer's current active subscription" })
  getMySubscription(@CurrentUser('id') userId: string) {
    return this.subscriptionsService.getMySubscription(userId);
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Post('order')
  @ApiOperation({ summary: 'Create a Razorpay order to subscribe to a plan' })
  createOrder(@CurrentUser('id') userId: string, @Body('planId') planId: string) {
    return this.subscriptionsService.createOrder(userId, planId);
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Post('verify')
  @ApiOperation({ summary: 'Verify payment and activate the subscription' })
  verifyPayment(
    @CurrentUser('id') userId: string,
    @Body()
    dto: {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
    },
  ) {
    return this.subscriptionsService.verifyPayment(userId, dto);
  }

  @ApiBearerAuth()
  @Roles(Role.CUSTOMER)
  @Post('cancel')
  @ApiOperation({ summary: 'Cancel the active subscription' })
  cancel(@CurrentUser('id') userId: string) {
    return this.subscriptionsService.cancel(userId);
  }

  // ---------- Admin ----------

  @ApiBearerAuth()
  @Roles(Role.ADMIN)
  @Get('admin/plans')
  @ApiOperation({ summary: '[Admin] List all plans, including inactive' })
  adminListPlans() {
    return this.subscriptionsService.adminListPlans();
  }

  @ApiBearerAuth()
  @Roles(Role.ADMIN)
  @Post('admin/plans')
  @ApiOperation({ summary: '[Admin] Create a subscription plan' })
  adminCreatePlan(@Body() dto: any) {
    return this.subscriptionsService.adminCreatePlan(dto);
  }

  @ApiBearerAuth()
  @Roles(Role.ADMIN)
  @Put('admin/plans/:id')
  @ApiOperation({ summary: '[Admin] Update a subscription plan' })
  adminUpdatePlan(@Param('id') id: string, @Body() dto: any) {
    return this.subscriptionsService.adminUpdatePlan(id, dto);
  }

  @ApiBearerAuth()
  @Roles(Role.ADMIN)
  @Delete('admin/plans/:id')
  @ApiOperation({ summary: '[Admin] Deactivate a subscription plan' })
  adminDeactivatePlan(@Param('id') id: string) {
    return this.subscriptionsService.adminDeactivatePlan(id);
  }

  @ApiBearerAuth()
  @Roles(Role.ADMIN)
  @Get('admin/subscribers')
  @ApiOperation({ summary: '[Admin] List active subscribers' })
  adminListSubscribers(@Query('page') page: number, @Query('limit') limit: number) {
    return this.subscriptionsService.adminListSubscribers(+page || 1, +limit || 20);
  }
}
