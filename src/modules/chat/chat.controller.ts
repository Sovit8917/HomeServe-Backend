import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

@ApiTags('Chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private chatService: ChatService) {}

  @Get('bookings')
  getBookingChats(@CurrentUser() user: any) {
    return this.chatService.getBookingChats(user.id, user.role);
  }

  @Get(':bookingId/messages')
  getMessages(
    @Param('bookingId') bookingId: string,
    @Query('page') page: number,
    @Query('limit') limit: number,
  ) {
    return this.chatService.getMessages(bookingId, +page || 1, +limit || 50);
  }

  @Post(':bookingId/messages')
  sendMessage(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: any,
    @Body('message') message: string,
  ) {
    return this.chatService.sendMessage(bookingId, user.id, user.role, message);
  }

  @Get(':bookingId/unread')
  getUnreadCount(@Param('bookingId') bookingId: string, @CurrentUser('id') userId: string) {
    return this.chatService.getUnreadCount(bookingId, userId);
  }
}