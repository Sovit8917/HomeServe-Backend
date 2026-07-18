import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AiSupportService, AiChatTurn } from './ai-support.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';

@ApiTags('AI Support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER)
@Controller('ai-support')
export class AiSupportController {
  constructor(private aiSupportService: AiSupportService) {}

  @Post('chat')
  @ApiOperation({ summary: 'Send a message to the AI support assistant' })
  chat(@Body() dto: { message: string; history?: AiChatTurn[] }) {
    return this.aiSupportService.chat(dto.message, dto.history);
  }

  @Post('escalate')
  @ApiOperation({ summary: 'Hand the AI conversation off to a human agent' })
  escalate(
    @CurrentUser('id') userId: string,
    @Body() dto: { history: AiChatTurn[]; subject?: string },
  ) {
    return this.aiSupportService.escalate(userId, dto.history, dto.subject);
  }
}
