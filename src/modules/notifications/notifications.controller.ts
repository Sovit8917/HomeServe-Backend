import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get()
  getMyNotifications(
    @CurrentUser() user: any,
    @Query('page') page: number,
    @Query('limit') limit: number,
  ) {
    if (user.role === 'WORKER') {
      return this.notificationsService.getWorkerNotifications(
        user.id,
        +page || 1,
        +limit || 20,
      );
    }
    return this.notificationsService.getUserNotifications(
      user.id,
      +page || 1,
      +limit || 20,
    );
  }

  @Put(':id/read')
  markAsRead(@Param('id') id: string) {
    return this.notificationsService.markAsRead(id);
  }

  @Put('read-all')
  markAllAsRead(@CurrentUser() user: any) {
    if (user.role === 'WORKER') {
      return this.notificationsService.markAllAsRead(undefined, user.id);
    }
    return this.notificationsService.markAllAsRead(user.id);
  }

  @Roles(Role.ADMIN)
  @Post('send-bulk')
  sendBulk(
    @Body()
    data: {
      title: string;
      body: string;
      type: string;
      targetRole?: string;
      imageUrl?: string;
    },
  ) {
    return this.notificationsService.sendBulk(data);
  }
}
